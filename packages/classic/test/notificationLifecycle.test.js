// A-10 notification socket delivery lifecycle vs the original consumer.
//
// The original robot consumer (srv-jibo-server-client lib/services/notification.js)
// connects with NewRobotToken -> wsEndpoint + '/' + token, and on ANY close/error
// reconnects with the SAME token after reconnectInterval (default 10s). The server
// must therefore keep the token valid across socket cycles and redeliver only the
// un-acked pending rows (acked rows are removed by the send callback), exactly once.
//
// These tests drive the real HTTP+WebSocket entrypoint in LAN (standalone) mode
// (same binding as notification.test.js) to pin: exact-once redelivery across a
// same-token reconnect, status transitions through the connect/disconnect window,
// multi-account isolation under concurrent sockets, and the socket-upgrade
// rejection code for unknown / rotated-away tokens.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { createClassicEntrypoint } from '../src/index.js';

let ep; let server; let httpBase; let wsBase;
let dataDir;
const openSockets = new Set();
const track = (ws) => { openSockets.add(ws); return ws; };
const closeAll = () => {
  for (const ws of openSockets) {
    try {
      ws.close();
      if (typeof ws.terminate === 'function') ws.terminate();
    } catch { /* already gone */ }
  }
  openSockets.clear();
};

async function amz(target, body, accessKeyId) {
  const res = await fetch(`${httpBase}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': target,
      ...(accessKeyId ? { authorization: `Foo4-Hmac-Sha256 Credential=${accessKeyId}/20260909/us-east-1/notification/aws4_request, SignedHeaders=host, Signature=ff` } : {}),
    },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const notify = (accountId, payload) => fetch(`${httpBase}/notify`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountId, payload }),
}).then((r) => r.json());

async function getStatus(accountId) {
  const r = await amz('Notification_20150505.GetStatus', { accountId });
  return r.body && r.body.connected;
}

// Buffer messages from connect-time so connect delivery isn't missed by a late
// listener; nextMessage drains the buffer or waits for the next frame.
function connectSocket(token) {
  return new Promise((resolve, reject) => {
    const ws = track(new WebSocket(`${wsBase}/socket/${token}`));
    ws._buf = [];
    ws._waiters = [];
    ws._frames = 0;
    ws.on('message', (d) => {
      ws._frames += 1;
      const msg = JSON.parse(String(d));
      if (ws._waiters.length) ws._waiters.shift()(msg);
      else ws._buf.push(msg);
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    ws.on('unexpected-response', (_q, res) => reject(new Error(`socket ${res.statusCode}`)));
  });
}
const nextMessage = (ws) => new Promise((resolve) => {
  if (ws._buf.length) return resolve(ws._buf.shift());
  ws._waiters.push(resolve);
});
const tick = () => new Promise((resolve) => setImmediate(resolve));

function waitFor(predicate, timeoutMs = 5000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - started >= timeoutMs) return reject(new Error('timed out waiting for lifecycle state'));
      setTimeout(check, 5);
    };
    check();
  });
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'phoenix-notification-lifecycle-'));
  ep = createClassicEntrypoint({
    notificationFile: join(dataDir, 'notifications.json'),
    notificationPollIntervalMs: 20,
  });
  server = await ep.listen(0);
  const port = server.address().port;
  httpBase = `http://localhost:${port}`;
  wsBase = `ws://localhost:${port}`;
});
after(async () => {
  closeAll();
  await new Promise((resolve) => server.close(resolve));
  rmSync(dataDir, { recursive: true, force: true });
});

test('reconnect with the same token redelivers only un-acked rows, exactly once', async () => {
  // The robot consumer reuses the same token across socket cycles. A row that
  // was already acked (removed by the successful send callback) must NOT be
  // replayed on reconnect; a row that was never acked must be, exactly once.
  const t = await amz('Notification_20150505.NewRobotToken', { deviceId: 'reconnect-1' }, 'robot-reconnect');
  const token = t.body.token;

  const first = await connectSocket(token);
  const acked = nextMessage(first);
  await notify('robot-reconnect', { name: 'LoopUpdated', payload: { kind: 'acked' } });
  const ackedMsg = await acked;
  assert.equal(ackedMsg.payload.payload.kind, 'acked');
  await tick(); // let the send callback's durable delete settle
  assert.equal(ep.hub.store.findNotificationsByTokenIds([ep.hub.store.findTokenByKey(token)._id]).length, 0);

  // disconnect; enqueue a row while offline
  first.close();
  await waitFor(() => ep.hub.store.getStatus({ accountId: 'robot-reconnect' }).connected === false);
  await notify('robot-reconnect', { name: 'LoopUpdated', payload: { kind: 'unacked' } });
  await tick();
  assert.equal(await getStatus('robot-reconnect'), false, 'disconnected once the socket closed');

  // reconnect with the SAME token
  const second = await connectSocket(token);
  assert.equal(await getStatus('robot-reconnect'), true, 'reconnected');
  const replay = nextMessage(second);
  const replayed = await replay;
  assert.equal(replayed.payload.payload.kind, 'unacked', 'only the un-acked row is redelivered');
  await tick();
  // guard: a short quiet window must not deliver anything further (no double-send)
  const quiet = await Promise.race([
    nextMessage(second).then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 60)),
  ]);
  assert.equal(quiet, false, 'no duplicate replay of an already-delivered row');
  assert.equal(second._frames, 1, 'exactly one frame crossed the reconnect socket');
  second.close();
});

test('rotation makes the old token unreachable for new sockets; new token still works', async () => {
  const first = await amz('Notification_20150505.NewRobotToken', { deviceId: 'rotate-1' }, 'robot-rotate');
  const oldKey = first.body.token;
  // a second NewRobotToken for the same account rotates the key on the SAME
  // Token document (source controller.newToken): old key must reject.
  const second = await amz('Notification_20150505.NewRobotToken', { deviceId: 'rotate-2' }, 'robot-rotate');
  assert.notEqual(second.body.token, oldKey);
  await assert.rejects(() => connectSocket(oldKey), /socket 401/, 'rotated-away key rejected at the socket');
  const ws = await connectSocket(second.body.token);
  assert.equal(await getStatus('robot-rotate'), true);
  ws.close();
});

test('socket upgrade rejects an unknown token with 401 (source uses 404 TOKEN_NOT_FOUND)', async () => {
  // Source srv-notification-ws errors.TOKEN_NOT_FOUND has statusCode 404, and
  // entrypoint-socket-ws closes a bad setup with that code. Phoenix writes
  // HTTP 401. Both are a hard upgrade rejection the robot consumer retries
  // identically, but the wire code differs — pinned here so the divergence is
  // explicit and stays visible. (Recorded as a candidate divergence.)
  await assert.rejects(() => connectSocket('a'.repeat(128)), /socket 401/);
});

test('the consumer URL shape \'/{token}\' (no /socket prefix) attaches and receives pending delivery', async () => {
  // Both original consumers put the token at the LAST path segment with no
  // fixed prefix: native mints `wss://{region}-socket.jibo.com:443/{token}`,
  // and srv-jibo-server-client connects to `wsEndpoint + '/' + result.token`.
  // attachNotificationSocket keys on the last segment, so the root-segment
  // shape must work on the same server.
  const t = await amz('Notification_20150505.NewRobotToken', { deviceId: 'root-token' }, 'robot-roottoken');
  const token = t.body.token;
  await notify('robot-roottoken', { name: 'LoopUpdated', payload: { style: 'root-path' } });
  const ws = track(new WebSocket(`${wsBase}/${token}`));
  const received = new Promise((resolve, reject) => {
    ws.once('error', reject);
    ws.once('unexpected-response', (_q, res) => reject(new Error(`socket ${res.statusCode}`)));
    ws.once('message', (d) => resolve(JSON.parse(String(d))));
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const msg = await received;
  assert.equal(msg.payload.payload.style, 'root-path', 'root-segment token URL delivered');
  assert.equal(msg.skillId, '-1');
  ws.close();
});

test('multi-account isolation: concurrent sockets never cross-deliver, even across reconnects', async () => {
  const a = await amz('Notification_20150505.NewRobotToken', { deviceId: 'iso-a' }, 'iso-acct-a');
  const b = await amz('Notification_20150505.NewRobotToken', { deviceId: 'iso-b' }, 'iso-acct-b');
  const socketA = await connectSocket(a.body.token);
  const socketB = await connectSocket(b.body.token);

  const incomingA = nextMessage(socketA);
  await notify('iso-acct-a', { habit: 'widget' });
  const msgA = await incomingA;
  assert.equal(msgA.payload.habit, 'widget');
  assert.equal(socketB._frames, 0, 'account B receives nothing for account A');

  // Now account B reconnects (its client cycle); its own pending rows must not
  // include anything from A.
  const incomingB = nextMessage(socketB);
  await notify('iso-acct-b', { habit: 'gadget' });
  const msgB = await incomingB;
  assert.equal(msgB.payload.habit, 'gadget');
  socketB.close();

  const bReconnect = await connectSocket(b.body.token);
  await notify('iso-acct-b', { habit: 'gadget-2' });
  const replayedB = nextMessage(bReconnect);
  assert.equal((await replayedB).payload.habit, 'gadget-2');
  assert.equal(socketA._frames, 1, 'account A never receives account B rows');
  bReconnect.close();
  socketA.close();
});
