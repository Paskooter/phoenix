import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import WebSocket from 'ws';
import { setTimeout as delay } from 'node:timers/promises';
import { createClassicEntrypoint } from '../src/index.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotificationHub, NotificationStore, makeNotificationHandler } from '../src/notification.js';

const HOUR = 60 * 60 * 1000;

function socket() {
  const ws = new EventEmitter();
  ws.OPEN = 1;
  ws.readyState = 1;
  // Keep close asynchronous so a replaced peer can emit a late close event.
  ws.close = () => { ws.readyState = 2; };
  ws.finishClose = () => { ws.readyState = 3; ws.emit('close'); };
  return ws;
}

function fixture(t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2026-10-22T12:00:00Z') });
  const directory = mkdtempSync(join(tmpdir(), 'phoenix-notification-presence-'));
  const file = join(directory, 'notifications.json');
  const store = new NotificationStore(file);
  const hub = new NotificationHub({ store });
  const token = hub.newRobotToken('account-a');
  t.after(() => { hub.stopDelivery(); rmSync(directory, { recursive: true, force: true }); });
  return { hub, store, token, file };
}

async function getStatus(hub, accountId) {
  let status;
  let payload;
  const res = {
    setHeader() {},
    writeHead(code) { status = code; },
    end(body) { payload = JSON.parse(body); },
  };
  await makeNotificationHandler(hub)({ req: { headers: {} }, res,
    body: { accountId }, op: 'GetStatus', target: 'Notification_20150505.GetStatus' });
  assert.equal(status, 200);
  return payload;
}

test('GetStatus stays connected after 25 hours with an open notification socket', async (t) => {
  const { hub, store, token } = fixture(t);
  assert.deepEqual(await getStatus(hub, 'account-a'), { connected: false });
  const ws = socket();
  assert.equal(hub.attachSocket(token.tokenKey, ws), true);
  assert.deepEqual(await getStatus(hub, 'account-a'), { connected: true });
  t.mock.timers.tick(25 * HOUR);
  assert.equal(store.getStatus({ accountId: 'account-a' }).connected, false,
    'the source persisted-marker window has expired');
  assert.deepEqual(await getStatus(hub, 'account-a'), { connected: true });
  ws.finishClose();
  assert.deepEqual(await getStatus(hub, 'account-a'), { connected: false });
});

test('notification presence excludes connecting, closing and closed sockets before close callbacks', (t) => {
  const { hub, token } = fixture(t);
  const ws = socket();
  assert.equal(hub.attachSocket(token.tokenKey, ws), true);
  for (const state of [0, 2, 3]) {
    ws.readyState = state;
    assert.equal(hub.isConnected('account-a'), false, `readyState ${state} is not OPEN`);
  }
  ws.readyState = ws.OPEN;
  assert.equal(hub.isConnected('account-a'), true);
  ws.finishClose();
  assert.equal(hub.isConnected('account-a'), false);
});

test('notification presence keeps an account connected until its last open token closes', (t) => {
  const { hub, store, token } = fixture(t);
  // Historical stores can contain multiple token documents for one account,
  // although NewRobotToken still rotates a single document in normal use.
  const second = { ...token, _id: '222222222222222222222222', tokenKey: '2'.repeat(128) };
  delete second.notifications;
  store.tokens.set(second._id, second);
  store.flush();
  const firstSocket = socket();
  const secondSocket = socket();
  assert.equal(hub.attachSocket(token.tokenKey, firstSocket), true);
  assert.equal(hub.attachSocket(second.tokenKey, secondSocket), true);
  assert.equal(hub.isConnected('account-a'), true);
  assert.equal(hub.isConnected('account-b'), false);
  firstSocket.finishClose();
  assert.equal(store.getStatus({ accountId: 'account-a' }).connected, false,
    'source disconnect updates every persisted token for the account');
  assert.equal(hub.isConnected('account-a'), true, 'the second socket is still open');
  t.mock.timers.tick(25 * HOUR);
  assert.equal(hub.isConnected('account-a'), true);
  secondSocket.finishClose();
  assert.equal(hub.isConnected('account-a'), false);
});

test('notification presence survives replacement and ignores the previous socket late close', (t) => {
  const { hub, token } = fixture(t);
  const previous = socket();
  const replacement = socket();
  assert.equal(hub.attachSocket(token.tokenKey, previous), true);
  t.mock.timers.tick(HOUR);
  assert.equal(hub.attachSocket(token.tokenKey, replacement), true);
  assert.equal(previous.readyState, 2, 'the old peer was asked to close');
  previous.finishClose();
  assert.equal(hub.sockets.get(token._id), replacement);
  assert.equal(hub.isConnected('account-a'), true);
  t.mock.timers.tick(25 * HOUR);
  assert.equal(hub.isConnected('account-a'), true);
  replacement.finishClose();
  assert.equal(hub.isConnected('account-a'), false);
});

test('notification presence after restart ignores a recent persisted marker until reattach', (t) => {
  const { hub, token, file } = fixture(t);
  assert.equal(hub.attachSocket(token.tokenKey, socket()), true);
  t.mock.timers.tick(1000);
  const reopened = new NotificationStore(file);
  assert.equal(reopened.getStatus({ accountId: 'account-a' }).connected, true);
  const restarted = new NotificationHub({ store: reopened });
  assert.equal(restarted.isConnected('account-a'), false, 'no socket survived process restart');
  assert.equal(restarted.attachSocket(token.tokenKey, socket()), true);
  assert.equal(restarted.isConnected('account-a'), true);
  restarted.close(token._id);
  assert.equal(restarted.isConnected('account-a'), false);
});

test('source-style delivery polling adds zero presence refresh writes over 25 hours', (t) => {
  const { hub, store, token } = fixture(t);
  const ws = socket();
  assert.equal(hub.attachSocket(token.tokenKey, ws), true);
  const attachedAt = store.findTokenByKey(token.tokenKey).lastConnected;
  const flush = store.flush.bind(store);
  let writes = 0;
  store.flush = (...args) => { writes += 1; return flush(...args); };
  const getPending = hub.getNewNotifications.bind(hub);
  let polls = 0;
  hub.getNewNotifications = (...args) => { polls += 1; return getPending(...args); };
  hub.startDelivery();
  // Step each timer deadline: Node's fake timers do not recursively catch up
  // newly scheduled timeouts when one large tick leaps over all deadlines.
  for (let elapsed = 0; elapsed < 25 * HOUR; elapsed += 15000) t.mock.timers.tick(15000);
  assert.equal(polls, 6001, 'the real delivery timer kept polling');
  assert.equal(writes, 0, 'the archive has no timestamp-refresh heartbeat to reproduce');
  assert.equal(store.findTokenByKey(token.tokenKey).lastConnected, attachedAt);
  hub.stopDelivery();
  t.mock.timers.tick(HOUR);
  assert.equal(polls, 6001, 'stopDelivery cancels the timer');
  ws.finishClose();
  assert.equal(writes, 1, 'disconnect still persists its source marker once');
});

test('notification presence is disconnected even when saving the disconnect marker fails', (t) => {
  const { hub, store, token } = fixture(t);
  const ws = socket();
  assert.equal(hub.attachSocket(token.tokenKey, ws), true);
  store.markDisconnected = () => { throw new Error('synthetic persistence failure'); };
  ws.finishClose();
  assert.equal(store.getStatus({ accountId: 'account-a' }).connected, true,
    'the durable marker is stale after the simulated failure');
  assert.equal(hub.isConnected('account-a'), false);
});

test('Classic HTTP GetStatus follows a real WebSocket across 25 fake-clock hours and close', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'phoenix-notification-presence-wire-'));
  let now = Date.parse('2026-10-22T12:00:00Z');
  const classic = createClassicEntrypoint({ notificationFile: join(directory, 'notifications.json'),
    notificationClock: () => now });
  t.after(async () => {
    classic.hub.stopDelivery();
    for (const peer of classic.wss.clients) peer.terminate();
    await new Promise((resolve) => classic.wss.close(resolve));
    classic.server.closeAllConnections();
    await new Promise((resolve) => classic.server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  await classic.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${classic.server.address().port}`;
  const status = async () => {
    const response = await fetch(base, { method: 'POST', headers: {
      'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'Notification_20150505.GetStatus',
    }, body: JSON.stringify({ accountId: 'account-wire' }) });
    assert.equal(response.status, 200);
    return response.json();
  };
  const token = classic.hub.newRobotToken('account-wire');
  assert.deepEqual(await status(), { connected: false });
  const client = new WebSocket(`${base.replace('http:', 'ws:')}/socket/${token.tokenKey}`);
  await once(client, 'open');
  assert.deepEqual(await status(), { connected: true });
  now += 25 * HOUR;
  assert.equal(classic.hub.store.getStatus({ accountId: 'account-wire' }).connected, false);
  assert.deepEqual(await status(), { connected: true });
  client.close();
  await once(client, 'close');
  for (let attempt = 0; attempt < 100 && classic.hub.sockets.size; attempt++) await delay(10);
  assert.equal(classic.hub.sockets.size, 0);
  assert.deepEqual(await status(), { connected: false });
});
