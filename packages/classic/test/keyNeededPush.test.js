// KeyNeeded push — the robot's immediate wake-up when a sibling requests the loop key.
//
// Original cloud: `Key_20160201.CreateRequest` makes srv-key-ws send an SNS `KeyNeeded` event to
// the loop's sibling machines (A-01 operation map: "EventSender.send KeyNeeded to sibling
// accountIds"). The robot's NotificationSubsystem consumed it and jibo-sts answered the request
// immediately (jibo-sts exchange/Exchange.js:299 subscribes `KeyNeeded` -> handleKeyNeeded).
//
// Phoenix has no SNS. The equivalent channel is the one the robot already holds open:
// Notification_20150505.NewRobotToken -> websocket to `{region}-socket.jibo.com/{token}` ->
// jibo-server-service -> local `ws://127.0.0.1:8888/server/notifications` -> jibo-sts. These
// tests pin that CreateRequest enqueues a KeyNeeded frame on that socket, that the requester's
// own account is not woken, that an unresolvable loop falls back to the sibling fan-out, and
// that the wake-up carries no key material and never fails the key request.
//
// Identity arrives through the forwarded-credentials seam (`x-amz-credentials`), the precedence
// keyCallerAccountId uses before the SigV4 access key; tokens are minted per deviceId, the
// fallback the notification handler uses when the caller signature carries no Credential.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { createClassicEntrypoint } from '../src/index.js';
import { makeKeyHandler, KeyStore } from '../src/key.js';

const LOOP = 'loop-keyneeded';
const ROBOT = 'acct-robot';
const PHONE = 'acct-phone';
const OTHER = 'acct-other';

const NOW = new Date();
const DATE = `${NOW.getUTCFullYear()}${String(NOW.getUTCMonth() + 1).padStart(2, '0')}${String(NOW.getUTCDate()).padStart(2, '0')}`;

/** One AMZ call with the identity in the forwarded-credentials header. */
async function amz(base, accountId, target, body) {
  const res = await fetch(`${base}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': target,
      'x-amz-credentials': JSON.stringify({ id: accountId }),
    },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, errType: res.headers.get('x-amzn-errortype'), body: await res.json().catch(() => null) };
}

let ep; let server; let httpBase; let wsBase; let dataDir; let prevKeyFile;
const openSockets = new Set();
const closeAll = () => {
  for (const ws of openSockets) {
    try { ws.close(); ws.terminate?.(); } catch { /* already gone */ }
  }
  openSockets.clear();
};

function connectSocket(wsBaseUrl, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBaseUrl}/socket/${token}`);
    openSockets.add(ws);
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
/** Resolve with the next frame from the socket buffer, or null when none arrives in `ms`. */
const nextFrame = (ws, ms = 2000) => Promise.race([
  new Promise((resolve) => {
    if (ws._buf.length) return resolve(ws._buf.shift());
    ws._waiters.push(resolve);
  }),
  new Promise((resolve) => setTimeout(() => resolve(null), ms)),
]);
const noFrame = (ws, ms = 250) => nextFrame(ws, ms).then((msg) => {
  assert.equal(msg, null, `no frame expected on this socket, got ${JSON.stringify(msg)}`);
});

/** The notification handler mints per deviceId when the caller has no signed Credential. */
const mintToken = async (base, accountId) => {
  const t = await amz(base, accountId, 'Notification_20150505.NewRobotToken', { deviceId: accountId });
  assert.equal(t.status, 200, `token mint for ${accountId}`);
  return t.body.token;
};

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'phoenix-key-needed-'));
  prevKeyFile = process.env.ETCO_classic_keyFile;
  process.env.ETCO_classic_keyFile = join(dataDir, 'keys.json');
  ep = createClassicEntrypoint({
    notificationFile: join(dataDir, 'notifications.json'),
    notificationPollIntervalMs: 20,
    keyMembership: {
      memberIds: async () => [ROBOT, PHONE, OTHER],
      loop: async () => ({ owner: PHONE, robot: ROBOT }),
    },
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
  if (prevKeyFile === undefined) delete process.env.ETCO_classic_keyFile;
  else process.env.ETCO_classic_keyFile = prevKeyFile;
});

test('CreateRequest wakes the loop robot with KeyNeeded and never the requester', async () => {
  const robotWs = await connectSocket(wsBase, await mintToken(httpBase, ROBOT));
  const phoneWs = await connectSocket(wsBase, await mintToken(httpBase, PHONE));

  const res = await amz(httpBase, PHONE, 'Key_20160201.CreateRequest', { loopId: LOOP, publicKey: 'PUBKEY-PHONE' });
  assert.equal(res.status, 200, 'a member request is accepted');
  assert.match(res.body.id, /^[a-f0-9]{24}$/);

  const frame = await nextFrame(robotWs);
  assert.ok(frame, 'the robot socket receives the wake-up');
  assert.equal(frame.payload.name, 'KeyNeeded');
  assert.deepEqual(frame.payload.payload, { loopId: LOOP }, 'the frame carries the loopId and nothing else');
  assert.equal(frame.skillId, '-1', 'source Notification payload boundary default');

  await noFrame(phoneWs);

  // BLIND RELAY: the wake-up is the loopId only; the request still holds no key material.
  const stored = ep.keys.get(res.body.id);
  assert.ok(stored, 'the request is stored');
  assert.equal(stored.encryptedKey, undefined, 'no key material is created server-side');
});

test('an unresolvable loop fans KeyNeeded out to every sibling except the requester', async () => {
  // `membership.loop` returning undefined is the source's own "could not resolve" path; the
  // sibling list is still known, so the fan-out is the source's SNS semantics (all siblings).
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-key-needed-lan-'));
  const lan = createClassicEntrypoint({
    notificationFile: join(dir, 'notifications.json'),
    notificationPollIntervalMs: 20,
    keyMembership: { memberIds: async () => [ROBOT, PHONE, OTHER], loop: async () => undefined },
  });
  const lanServer = await lan.listen(0);
  const lanHttp = `http://localhost:${lanServer.address().port}`;
  const lanWs = `ws://localhost:${lanServer.address().port}`;
  const lanSockets = [];
  const lanNext = (ws, ms = 2000) => Promise.race([
    new Promise((resolve) => {
      if (ws._buf.length) return resolve(ws._buf.shift());
      ws._waiters.push(resolve);
    }),
    new Promise((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
  try {
    const robotWs = await connectSocket(lanWs, await mintToken(lanHttp, ROBOT));
    const otherWs = await connectSocket(lanWs, await mintToken(lanHttp, OTHER));
    const phoneWs = await connectSocket(lanWs, await mintToken(lanHttp, PHONE));
    lanSockets.push(robotWs, otherWs, phoneWs);

    const res = await amz(lanHttp, PHONE, 'Key_20160201.CreateRequest', { loopId: LOOP, publicKey: 'PUBKEY-LAN' });
    assert.equal(res.status, 200);

    const robotFrame = await lanNext(robotWs);
    assert.equal(robotFrame?.payload?.name, 'KeyNeeded');
    assert.deepEqual(robotFrame.payload.payload, { loopId: LOOP });
    const otherFrame = await lanNext(otherWs);
    assert.equal(otherFrame?.payload?.name, 'KeyNeeded', 'every sibling gets the sibling wake-up');
    assert.equal(await lanNext(phoneWs, 250), null, 'the requester is excluded');
  } finally {
    for (const ws of lanSockets) { try { ws.close(); ws.terminate?.(); } catch { /* gone */ } }
    await new Promise((resolve) => lanServer.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with no injected membership the wake-up resolves the loop through the Account peer route', async () => {
  // The production shape: the entrypoint is built WITHOUT keyMembership, so the key handler uses
  // the default Account peer-route seam. The wake-up must resolve `loop.robot` through that SAME
  // seam — building it from the raw (absent) option fanned KeyNeeded out to every sibling instead
  // of the key-holding robot (observed on Moth 2026-09-10).
  const peer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/loop') return res.end(JSON.stringify({ id: LOOP, robot: ROBOT, owner: PHONE, isSuspended: false }));
    if (url.pathname === '/loopMembers') return res.end(JSON.stringify({ id: LOOP, members: [ROBOT, PHONE, OTHER] }));
    res.statusCode = 404;
    return res.end('{}');
  });
  const prevNet = process.env.NET_account;
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-key-needed-peer-'));
  const peerEp = createClassicEntrypoint({
    notificationFile: join(dir, 'notifications.json'),
    notificationPollIntervalMs: 20,
  });
  const peerServer = await peerEp.listen(0);
  const peerHttp = `http://localhost:${peerServer.address().port}`;
  const peerWs = `ws://localhost:${peerServer.address().port}`;
  const sockets = [];
  const peersNext = (ws, ms = 2000) => Promise.race([
    new Promise((resolve) => {
      if (ws._buf.length) return resolve(ws._buf.shift());
      ws._waiters.push(resolve);
    }),
    new Promise((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
  try {
    await new Promise((resolve) => peer.listen(0, '127.0.0.1', resolve));
    process.env.NET_account = `127.0.0.1:${peer.address().port}`;

    const robotWs = await connectSocket(peerWs, await mintToken(peerHttp, ROBOT));
    const otherWs = await connectSocket(peerWs, await mintToken(peerHttp, OTHER));
    sockets.push(robotWs, otherWs);

    const res = await amz(peerHttp, PHONE, 'Key_20160201.CreateRequest', { loopId: LOOP, publicKey: 'PUBKEY-PEER' });
    assert.equal(res.status, 200, 'membership resolved through the peer routes');

    const robotFrame = await peersNext(robotWs);
    assert.equal(robotFrame?.payload?.name, 'KeyNeeded', 'the robot is woken');
    assert.deepEqual(robotFrame.payload.payload, { loopId: LOOP });
    assert.equal(await peersNext(otherWs, 250), null, 'no sibling fan-out when loop.robot resolves');
  } finally {
    for (const ws of sockets) { try { ws.close(); ws.terminate?.(); } catch { /* gone */ } }
    if (prevNet === undefined) delete process.env.NET_account;
    else process.env.NET_account = prevNet;
    await new Promise((resolve) => peerServer.close(resolve));
    await new Promise((resolve) => peer.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failing wake-up never fails the key request', async () => {
  const store = new KeyStore();
  const handler = makeKeyHandler(store, {
    membership: { memberIds: async () => [ROBOT, PHONE], loop: async () => ({ owner: PHONE, robot: ROBOT }) },
    notifyKeyNeeded: async () => { throw new Error('hub down'); },
  });
  const res = { status: 0, body: '', writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
  const warnings = [];
  await handler({
    req: { headers: { 'x-amz-credentials': JSON.stringify({ id: PHONE }) } },
    res,
    body: { loopId: LOOP, publicKey: 'PUBKEY-FAIL' },
    op: 'CreateRequest',
    log: { info() {}, warn(...args) { warnings.push(args); } },
  });
  assert.equal(res.status, 200, 'the request still succeeds');
  assert.match(JSON.parse(res.body).id, /^[a-f0-9]{24}$/);
  assert.equal(warnings.length, 1, 'the failed wake-up is reported, not swallowed silently');
});
