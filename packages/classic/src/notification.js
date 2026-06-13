// `notification` service (Notification_20150505) + the entrypoint-socket (the wss push door) —
// the transport that pushes cloud events to the robot. Faithful to srv-notification-ws +
// srv-entrypoint-socket-ws:
//
//   1. Robot calls Notification_20150505.NewRobotToken{deviceId} -> {token}.
//   2. Robot opens a WebSocket to  /socket/<token>  and holds it open.
//   3. The socket server validates the token, registers the connection, and delivers every
//      PENDING notification for that account, then any pushed live.
//   4. Notification_20150505.GetStatus{accountId} -> {connected}.
//
// Notifications are created via an internal POST /notify {accountId, payload} (the original was
// event-bus-driven from other services; Phoenix exposes a simple enqueue so the portal/system/
// tests can push). LAN-trust: the account identity is the robot's SigV4 accessKeyId (or the
// deviceId) — no signature verification, like the rest of the classic services.

import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { sendAmz, sendAmzError, accessKeyIdFromAuth, ValidationException } from './awsJson.js';

export class NotificationHub {
  constructor() {
    this.tokens = new Map();   // tokenId -> { _id, accountId, deviceId, created }
    this.pending = new Map();  // accountId -> [notification]
    this.sockets = new Map();  // tokenId -> ws (live connections)
  }

  /** NewRobotToken: mint (or reuse) a socket token for a device/account. */
  newRobotToken(accountId, deviceId) {
    const existing = [...this.tokens.values()].find((t) => t.accountId === accountId && t.deviceId === deviceId);
    if (existing) return existing;
    const token = { _id: randomBytes(16).toString('hex'), accountId, deviceId, created: Date.now() };
    this.tokens.set(token._id, token);
    return token;
  }

  findByToken(tokenId) { return this.tokens.get(tokenId) || null; }

  /** GetStatus: is any socket for this account currently connected? */
  isConnected(accountId) {
    for (const [tokenId, tok] of this.tokens) {
      if (tok.accountId === accountId && this.sockets.has(tokenId)) return true;
    }
    return false;
  }

  /** Enqueue a notification for an account; deliver live to any connected socket(s). */
  enqueue(accountId, payload) {
    const notification = { _id: randomBytes(12).toString('hex'), accountId, ...payload, delivered: false, created: Date.now() };
    const queue = this.pending.get(accountId) || [];
    queue.push(notification);
    this.pending.set(accountId, queue);
    this._deliverPending(accountId);
    return notification;
  }

  /** Register a live socket for a token and flush anything pending for its account. */
  attachSocket(tokenId, ws) {
    const token = this.tokens.get(tokenId);
    if (!token) return false;
    this.sockets.set(tokenId, ws);
    ws.on('close', () => { if (this.sockets.get(tokenId) === ws) this.sockets.delete(tokenId); });
    this._deliverPending(token.accountId);
    return true;
  }

  _deliverPending(accountId) {
    const queue = this.pending.get(accountId);
    if (!queue || !queue.length) return;
    const live = [...this.tokens.entries()]
      .filter(([id, t]) => t.accountId === accountId && this.sockets.has(id))
      .map(([id]) => this.sockets.get(id))
      .filter((ws) => ws && ws.readyState === ws.OPEN);
    if (!live.length) return; // stay pending until a socket connects
    for (const notification of queue) {
      if (notification.delivered) continue;
      const msg = JSON.stringify(notification);
      for (const ws of live) { try { ws.send(msg); } catch { /* retry next time */ } }
      notification.delivered = true;
    }
    this.pending.set(accountId, queue.filter((n) => !n.delivered));
  }
}

/** AWS-JSON handler for the Notification_* prefix (NewRobotToken, GetStatus). */
export function makeNotificationHandler(hub) {
  return function notificationHandler({ req, res, body, op }) {
    const accountId = accessKeyIdFromAuth(req) || (body && body.deviceId) || 'anon';
    switch (op.toLowerCase()) {
      case 'newrobottoken': {
        const token = hub.newRobotToken(accountId, (body && body.deviceId) || accountId);
        return void sendAmz(res, 200, { token: token._id });
      }
      case 'getstatus':
        return void sendAmz(res, 200, { connected: hub.isConnected((body && body.accountId) || accountId) });
      default:
        return void sendAmzError(res, ValidationException, `unknown Notification operation: ${op}`);
    }
  };
}

/**
 * Attach the entrypoint-socket to an http server: the robot connects to /socket/<token> (or
 * /<token>); we validate the token and register the connection. Returns the WebSocketServer.
 */
export function attachNotificationSocket(server, hub, log) {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const path = (req.url || '').split('?')[0];
    const tokenId = path.slice(path.lastIndexOf('/') + 1);
    const token = hub.findByToken(tokenId);
    if (!token) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      hub.attachSocket(tokenId, ws);
      log?.info?.('socket connected', { accountId: token.accountId });
    });
  });
  return wss;
}
