// H.3 — notification + entrypoint-socket: the wss push door. NewRobotToken -> connect socket ->
// enqueue -> live delivery; pending-before-connect delivery; GetStatus connected flag.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { createClassicEntrypoint } from '../src/index.js';

let ep; let server; let httpBase; let wsBase;
let dataDir;

async function amz(target, body, accessKeyId) {
  const res = await fetch(`${httpBase}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': target,
      ...(accessKeyId ? { authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/20260613/us-east-1/notification/aws4_request, SignedHeaders=host, Signature=ff` } : {}),
    },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const notify = (accountId, payload) => fetch(`${httpBase}/notify`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountId, payload }),
}).then((r) => r.json());

// Buffer messages from connect-time so pending notifications delivered immediately on attach
// aren't missed by a late listener; nextMessage drains the buffer or waits for the next frame.
function connectSocket(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}/socket/${token}`);
    ws._buf = [];
    ws._waiters = [];
    ws.on('message', (d) => {
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

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'phoenix-notification-test-'));
  ep = createClassicEntrypoint({
    notificationFile: join(dataDir, 'notifications.json'),
    notificationPollIntervalMs: 25,
  });
  server = await ep.listen(0);
  const port = server.address().port;
  httpBase = `http://localhost:${port}`;
  wsBase = `ws://localhost:${port}`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dataDir, { recursive: true, force: true });
});

test('NewRobotToken issues a token; GetStatus is false until a socket connects', async () => {
  const t = await amz('Notification_20150505.NewRobotToken', { deviceId: 'dev-1' }, 'robot-acct-A');
  assert.equal(t.status, 200);
  assert.match(t.body.token, /^[a-f0-9]{128}$/);

  const before2 = await amz('Notification_20150505.GetStatus', { accountId: 'robot-acct-A' });
  assert.equal(before2.body.connected, false);

  const ws = await connectSocket(t.body.token);
  const after2 = await amz('Notification_20150505.GetStatus', { accountId: 'robot-acct-A' });
  assert.equal(after2.body.connected, true, 'connected once the socket is open');
  ws.close();
});

test('live delivery: enqueue after connect -> the socket receives the notification', async () => {
  const t = await amz('Notification_20150505.NewRobotToken', { deviceId: 'dev-2' }, 'robot-acct-B');
  const ws = await connectSocket(t.body.token);
  const incoming = nextMessage(ws);
  const q = await notify('robot-acct-B', { type: 'SKILL_INSTALLED', skill: 'jot' });
  assert.ok(q.queued);
  const msg = await incoming;
  assert.equal(msg.payload.type, 'SKILL_INSTALLED');
  assert.equal(msg.payload.skill, 'jot');
  assert.equal(msg.skillId, '-1');
  assert.equal(msg.tokenId, ep.hub.store.findTokenByKey(t.body.token)._id);
  assert.ok(msg._id && msg.created, 'source notification envelope: id + created');
  ws.close();
});

test('pending delivery: enqueue BEFORE connect -> delivered on connect', async () => {
  const t = await amz('Notification_20150505.NewRobotToken', { deviceId: 'dev-3' }, 'robot-acct-C');
  await notify('robot-acct-C', { type: 'REMINDER', text: 'walk the dog' });
  await notify('robot-acct-C', { type: 'REMINDER', text: 'water the plants' });

  const ws = await connectSocket(t.body.token);
  const first = await nextMessage(ws);
  const second = await nextMessage(ws);
  const texts = [first.payload.text, second.payload.text].sort();
  assert.deepEqual(texts, ['walk the dog', 'water the plants']);
  ws.close();
});

test('LoopUpdated payload is retained inside the source notification envelope', async () => {
  const t = await amz('Notification_20150505.NewRobotToken', { deviceId: 'dev-4' }, 'robot-acct-D');
  const ws = await connectSocket(t.body.token);
  const incoming = nextMessage(ws);
  await fetch(`${httpBase}/notify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      accountId: 'robot-acct-D',
      skillId: '-1',
      payload: {
        name: 'LoopUpdated',
        payload: { id: 'loop-1', robot: 'robot-acct-D', isSuspended: true },
      },
    }),
  });
  const msg = await incoming;
  assert.equal(msg.skillId, '-1');
  assert.deepEqual(msg.payload, {
    name: 'LoopUpdated',
    payload: { id: 'loop-1', robot: 'robot-acct-D', isSuspended: true },
  });
  ws.close();
});

test('socket rejects an unknown token', async () => {
  await assert.rejects(() => connectSocket('deadbeefdeadbeefdeadbeefdeadbeef'), /socket 401/);
});
