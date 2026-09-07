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
    void this._deliverPending(record.tokenId);
    return record;
  }

  /** Source controller boundary used by a future Account event consumer. */
  deliverNotification({ accountId, skillId, notification } = {}) {
    return this.enqueueNotification({ accountId, skillId, notification });
  }

  /** Register a live socket for a token key and deliver its pending rows. */
  attachSocket(tokenKey, ws) {
    const token = this.store.findTokenByKey(tokenKey);
    if (!token) return false;

    const tokenId = token._id;
    const previous = this.sockets.get(tokenId);
    if (previous && previous !== ws) {
      this._forgetInflight(tokenId);
      closeSocket(previous);
    }
    this.sockets.set(tokenId, ws);
    this.tokenCache.set(tokenId, token);
    this.store.markConnected({ accountId: token.accountId });

    ws.on?.('close', () => {
      if (this.sockets.get(tokenId) !== ws) return;
      this._forgetInflight(tokenId);
      this.sockets.delete(tokenId);
      this.tokenCache.delete(tokenId);
      this.store.markDisconnected({ accountId: token.accountId });
    });
    ws.on?.('error', () => {
      // The source keeps an errored connection in the cache until close. The
      // send callback decides whether a notification remains pending.
    });
    void this._deliverPending(tokenId);
    return true;
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
    const token = this.tokenCache.get(tokenId) || this.store.findTokenById(tokenId);
    this._forgetInflight(tokenId);
    if (ws) closeSocket(ws);
    this.sockets.delete(tokenId);
    this.tokenCache.delete(tokenId);
    if (token) this.store.markDisconnected({ accountId: token.accountId });
  }

  /** Start the source-style periodic pending-notification poll. */
  startDelivery() {
    if (this.pollTimer) return this;
    const poll = () => {
      this.pollTimer = null;
      // Source startDelivery fires the active-token query/sends and schedules
      // the next poll independently; one peer that never invokes a send
      // callback must not stop retries for other tokens.
      // Its getNewNotifications query applies the 100-row limit once across
      // all connected token IDs, unlike the per-token snapshot sent on a new
      // connection.
      const tokenIds = [...this.sockets.keys()];
      const pending = this.getNewNotifications(tokenIds);
      for (const { tokenId, notification } of pending) {
        void this.deliver(tokenId, notification);
      }
      if (this.pollTimer === null) this._schedulePoll(poll);
    };
    poll();
    return this;
  }

  stopDelivery() {
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
          this.store.removeNotification(notification._id);
          if (current?.attempt === attempt) void this._deliverPending(tokenId);
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
    if (!hub.findByToken(tokenKey)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      hub.attachSocket(tokenKey, ws);
      const token = hub.findByToken(tokenKey);
      log?.info?.('socket connected', { accountId: token?.accountId });
    });
  });
  return wss;
}
