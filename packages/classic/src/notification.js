// Notification_20150505 plus the robot-facing notification socket.
//
// The original split this boundary across notification-ws (Mongo Token and
// Notification documents) and entrypoint-socket-ws (the WebSocket process).
// NotificationStore keeps those documents durable in Phoenix; NotificationHub
// owns only live socket registrations and the source delivery callbacks.

import { WebSocketServer } from 'ws';
import { sendAmz, sendAmzError, accessKeyIdFromAuth, ValidationException } from './awsJson.js';
import { NotificationStore } from './notificationStore.js';

export { NotificationStore } from './notificationStore.js';

const DEFAULT_POLL_INTERVAL_MS = 15 * 1000;

function socketIsOpen(ws) {
  const open = ws?.OPEN ?? 1;
  return !!ws && ws.readyState === open;
}

function closeSocket(ws) {
  try { ws?.close?.(); } catch { /* a closing peer is already gone */ }
}

function reportSocketError(log, message, error) {
  // Socket setup and lifecycle callbacks run outside the HTTP request promise.
  // A logger supplied by a host process must not turn a contained peer failure
  // back into an uncaught callback exception.
  try { log?.error?.(message, error); } catch { /* logging is best effort */ }
}

function reportSocketInfo(log, message, details) {
  try { log?.info?.(message, details); } catch { /* logging is best effort */ }
}

/**
 * Durable notification documents plus in-process socket delivery.
 *
 * `accountId` is intentionally an explicit API input. The eventual Account
 * LoopUpdated producer must resolve the verified account identity before
 * calling enqueueNotification; this class does not infer it from a caller's
 * access-key header.
 */
export class NotificationHub {
  /**
   * @param {{ file?: string, store?: NotificationStore, clock?: () => number|Date,
   *   notificationTtlMs?: number, pollIntervalMs?: number }} [options]
   */
  constructor(options = {}) {
    this.store = options.store || new NotificationStore(options.file, {
      clock: options.clock,
      notificationTtlMs: options.notificationTtlMs,
    });
    this.pollIntervalMs = Number.isFinite(options.pollIntervalMs)
      ? Math.max(0, Number(options.pollIntervalMs))
      : DEFAULT_POLL_INTERVAL_MS;
    this.sockets = new Map(); // token document _id -> WebSocket
    this.tokenCache = new Map(); // token document _id -> token snapshot
    this.inflight = new Map(); // notification _id -> { tokenId, attempt }
    this.pollTimer = null;
    this.deliveryGeneration = 0;
  }

  /**
   * Source NewRobotToken rotates the tokenKey on the one Token document for an
   * account. `deviceId` remains an accepted compatibility argument but is not
   * used to invent a second account identity.
   */
  newRobotToken(accountId, _deviceId) {
    const token = this.store.newToken({ accountId });
    // Controller.newToken returns populateToken(token), so callers of this
    // explicit seam can inspect the same pending notification snapshot.
    return this.store.populateToken(token._id);
  }

  /** Resolve the opaque URL token key, matching notification-ws GET /token/{id}. */
  findByToken(tokenKey) {
    const token = this.store.findTokenByKey(tokenKey);
    return token ? this.store.populateToken(token._id) : null;
  }

  /** Source getStatus uses the persisted lastConnected timestamp. */
  isConnected(accountId) {
    return this.store.getStatus({ accountId }).connected;
  }

  /**
   * Compatibility wrapper for the internal enqueue seam. New producers should
   * use enqueueNotification so the source Notification payload boundary is
   * explicit. The default skill is the source LoopUpdated value, -1.
   */
  enqueue(accountId, payload, skillId = '-1') {
    return this.enqueueNotification({ accountId, skillId, notification: payload });
  }

  /** Persist a source Notification document and begin live delivery. */
  enqueueNotification({ accountId, skillId = '-1', notification } = {}) {
    const record = this.store.enqueue({ accountId, skillId, payload: notification });
    this._beginPendingDelivery(record.tokenId);
    return record;
  }

  /** Source controller boundary used by a future Account event consumer. */
  deliverNotification({ accountId, skillId, notification } = {}) {
    return this.enqueueNotification({ accountId, skillId, notification });
  }

  /** Register a live socket for a token key and deliver its pending rows. */
  attachSocket(tokenKey, ws) {
    let token;
    try {
      token = this.store.findTokenByKey(tokenKey);
    } catch {
      // The source connection setup rejects the connection when its token
      // lookup fails. Keep that rejection inside the socket boundary so a
      // failed expiry purge/flush cannot escape an upgrade callback.
      closeSocket(ws);
      return false;
    }
    if (!token) return false;

    const tokenId = token._id;
    const previous = this.sockets.get(tokenId);
    if (previous && previous !== ws) {
      this._forgetInflight(tokenId);
      closeSocket(previous);
    }
    this.sockets.set(tokenId, ws);
    this.tokenCache.set(tokenId, token);
    let connected = false;
    try {
      this.store.markConnected({ accountId: token.accountId });
      connected = true;
      ws.on?.('close', () => {
        if (this.sockets.get(tokenId) !== ws) return;
        this._forgetInflight(tokenId);
        this.sockets.delete(tokenId);
        this.tokenCache.delete(tokenId);
        this._safeMarkDisconnected(token);
      });
      ws.on?.('error', () => {
        // The source keeps an errored connection in the cache until close. The
        // send callback decides whether a notification remains pending.
      });
      this._beginPendingDelivery(tokenId);
      return true;
    } catch {
      // A persistence failure or a peer that rejects listener registration
      // must not leave a socket in either live cache. markDisconnected is
      // best effort because the original markConnected may not have reached
      // durable storage, and a later reconnect can repair that marker.
      if (this.sockets.get(tokenId) === ws) this.sockets.delete(tokenId);
      if (this.tokenCache.get(tokenId) === token) this.tokenCache.delete(tokenId);
      if (connected) this._safeMarkDisconnected(token);
      closeSocket(ws);
      return false;
    }
  }

  /** Expose pending retrieval for the later event/socket integration seam. */
  getNewNotifications(tokenIds = []) {
    return this.store.findNotificationsByTokenIds(tokenIds)
      .map((notification) => ({ tokenId: notification.tokenId, notification }));
  }

  /** Source DELETE /notification/{id}; deletion is explicit and durable. */
  markAsDelivered(notificationId) {
    return this.store.removeNotification(notificationId);
  }

  /** Close a tracked connection while retaining all unsent rows. */
  close(tokenId) {
    const ws = this.sockets.get(tokenId);
    let token = this.tokenCache.get(tokenId);
    if (!token) {
      try { token = this.store.findTokenById(tokenId); } catch { token = null; }
    }
    this._forgetInflight(tokenId);
    if (ws) closeSocket(ws);
    this.sockets.delete(tokenId);
    this.tokenCache.delete(tokenId);
    if (token) this._safeMarkDisconnected(token);
  }

  /** Start the source-style periodic pending-notification poll. */
  startDelivery() {
    if (this.pollTimer) return this;
    const generation = ++this.deliveryGeneration;
    const poll = () => {
      this.pollTimer = null;
      // Source startDelivery fires the active-token query/sends and schedules
      // the next poll independently; one peer that never invokes a send
      // callback must not stop retries for other tokens.
      // Its getNewNotifications query applies the 100-row limit once across
      // all connected token IDs, unlike the per-token snapshot sent on a new
      // connection.
      try {
        const tokenIds = [...this.sockets.keys()];
        const pending = this.getNewNotifications(tokenIds);
        for (const { tokenId, notification } of pending) {
          this._beginDelivery(tokenId, notification);
        }
      } catch {
        // The source schedules the next poll independently of the query
        // promise. In particular, a failed expiry purge/flush must not stop
        // retries or become an uncaught timer exception.
      } finally {
        if (this.deliveryGeneration === generation && this.pollTimer === null) {
          this._schedulePoll(poll);
        }
      }
    };
    poll();
    return this;
  }

  stopDelivery() {
    this.deliveryGeneration += 1;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  _schedulePoll(poll) {
    if (this.pollIntervalMs < 0) return;
    this.pollTimer = setTimeout(poll, this.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  async _deliverPending(tokenId) {
    const token = this.tokenCache.get(tokenId) || this.store.findTokenById(tokenId);
    if (!token) return;
    const notifications = this.store.findNotificationsByTokenIds([tokenId]);
    // The source SocketServer starts one send per pending document without
    // awaiting the preceding callback. WebSocket preserves write order while
    // each callback independently controls deletion/retry.
    await Promise.all(notifications.map((notification) => this.deliver(tokenId, notification)));
  }

  _beginPendingDelivery(tokenId) {
    try {
      void this._deliverPending(tokenId).catch(() => {});
    } catch {
      // Keep a failed connect/enqueue callback contained; the durable row is
      // still available to the next poll or reconnect.
    }
  }

  _beginDelivery(tokenId, notification) {
    try {
      void Promise.resolve(this.deliver(tokenId, notification)).catch(() => {});
    } catch {
      // A send/setup failure is retried by the next poll or reconnect.
    }
  }

  _safeMarkDisconnected(token) {
    try { this.store.markDisconnected({ accountId: token.accountId }); } catch { /* reconnect can repair it */ }
  }

  /**
   * Send one complete source Notification document. Mongo deletion happens
   * only from a successful WebSocket send callback; an error, throw, or close
   * leaves the row available to the next poll/reconnect.
   */
  deliver(tokenId, notification) {
    const ws = this.sockets.get(tokenId);
    if (!socketIsOpen(ws)) return Promise.resolve(false);
    if (!notification || !notification._id || this.inflight.has(notification._id)) return Promise.resolve(false);

    let message;
    try {
      message = JSON.stringify(notification);
    } catch {
      return Promise.resolve(false);
    }

    const attempt = {};
    const state = { tokenId, attempt, finish: null, detach: null };
    return new Promise((resolve) => {
      let settled = false;
      let completed = false;
      const finish = (error) => {
        // A close releases the live attempt so a reconnect can retry. The
        // underlying ws callback may still arrive; a successful callback must
        // retain the source contract and remove that row even after close.
        if (completed) return;
        completed = true;
        const current = this.inflight.get(notification._id);
        if (current?.attempt === attempt) this.inflight.delete(notification._id);
        if (!error) {
          try {
            this.store.removeNotification(notification._id);
          } catch {
            // A successful socket write does not make a notification durable.
            // Keep the row pending when its delete cannot be committed, and
            // contain the synchronous persistence error inside the callback.
            // The next poll/reconnect can retry it.
            if (!settled) {
              settled = true;
              resolve(false);
            }
            return;
          }
          if (current?.attempt === attempt) {
            // Store reads/purge can fail too; a rejected retry must not escape
            // the WebSocket callback as an unhandled promise rejection.
            void this._deliverPending(tokenId).catch(() => {});
          }
        }
        if (!settled) {
          settled = true;
          resolve(!error);
        }
      };
      const detach = () => {
        const current = this.inflight.get(notification._id);
        if (current?.attempt === attempt) this.inflight.delete(notification._id);
        if (!settled) {
          settled = true;
          resolve(false);
        }
      };
      state.finish = finish;
      state.detach = detach;
      this.inflight.set(notification._id, state);
      try {
        ws.send(message, finish);
      } catch (error) {
        finish(error);
      }
    });
  }

  _forgetInflight(tokenId) {
    for (const [notificationId, state] of this.inflight) {
      if (state.tokenId === tokenId) state.detach?.();
    }
  }
}

/** AWS-JSON handler for Notification_20150505. */
export function makeNotificationHandler(hub) {
  return function notificationHandler({ req, res, body, op }) {
    // Authentication/account-ID resolution remains the explicit LAN-trust
    // seam. A later verified gateway/outbox integration must pass the source
    // account document id to hub.newRobotToken/deliverNotification directly.
    const accountId = accessKeyIdFromAuth(req) || (body && body.deviceId) || 'anon';
    switch (op.toLowerCase()) {
      case 'newrobottoken': {
        const token = hub.newRobotToken(accountId, body && body.deviceId);
        return void sendAmz(res, 200, { token: token.tokenKey });
      }
      case 'getstatus':
        return void sendAmz(res, 200, { connected: hub.isConnected((body && body.accountId) || accountId) });
      default:
        return void sendAmzError(res, ValidationException, `unknown Notification operation: ${op}`);
    }
  };
}

/**
 * Attach the entrypoint-socket to an HTTP server. The URL contains the source
 * tokenKey, while the store maps that key to the durable token document.
 */
export function attachNotificationSocket(server, hub, log) {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const path = (req.url || '').split('?')[0];
    const tokenKey = path.slice(path.lastIndexOf('/') + 1);
    let token;
    try {
      token = hub.findByToken(tokenKey);
    } catch (error) {
      // A store read (including expiry cleanup) belongs to the connection
      // setup promise. Close a bad peer without taking down the HTTP server.
      reportSocketError(log, 'notification socket token lookup failed', error);
      try { socket.destroy?.(); } catch { /* peer already closed */ }
      return;
    }
    if (!token) {
      try { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); } catch { /* peer already closed */ }
      try { socket.destroy?.(); } catch { /* peer already closed */ }
      return;
    }
    try {
      wss.handleUpgrade(req, socket, head, (ws) => {
        try {
          if (!hub.attachSocket(tokenKey, ws)) {
            closeSocket(ws);
            return;
          }
          reportSocketInfo(log, 'socket connected', { accountId: token.accountId });
        } catch (error) {
          // Match source SocketServer's connection-setup catch: a rejected
          // registration closes this client, while the parent server lives.
          reportSocketError(log, 'notification socket setup failed', error);
          closeSocket(ws);
        }
      });
    } catch (error) {
      reportSocketError(log, 'notification socket upgrade failed', error);
      try { socket.destroy?.(); } catch { /* peer already closed */ }
    }
  });
  return wss;
}
