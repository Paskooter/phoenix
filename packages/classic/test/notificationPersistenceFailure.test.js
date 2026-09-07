import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { attachNotificationSocket, NotificationHub, NotificationStore } from '../src/notification.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

function tempFile() {
  const directory = mkdtempSync(join(tmpdir(), 'phoenix-notification-failure-'));
  return { directory, file: join(directory, 'private', 'nested', 'notifications.json') };
}

function persistence(failure) {
  const shouldFail = (kind) => {
    if (failure.kind !== kind) return false;
    if (failure.once) {
      failure.kind = null;
      failure.once = false;
    }
    return true;
  };
  return {
    chmod: chmodSync,
    exists: (path) => {
      try {
        statSync(path);
        return true;
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    },
    mkdir: (...args) => mkdirSync(...args),
    readFile: (path, ...args) => readFileSync(path, ...args),
    rename: (from, to) => {
      if (shouldFail('rename')) throw new Error('synthetic rename failure');
      return renameSync(from, to);
    },
    unlink: (path) => {
      try { unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    },
    writeFile: (path, ...args) => {
      if (shouldFail('write')) throw new Error('synthetic write failure');
      return writeFileSync(path, ...args);
    },
  };
}

function fakeSocket() {
  const ws = new EventEmitter();
  ws.OPEN = 1;
  ws.readyState = 1;
  ws.messages = [];
  ws.send = (encoded, callback) => {
    ws.messages.push(JSON.parse(encoded));
    queueMicrotask(() => callback?.());
  };
  ws.close = () => { ws.readyState = 3; queueMicrotask(() => ws.emit('close')); };
  return ws;
}

function waitFor(predicate, timeoutMs = 500) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - started >= timeoutMs) {
        return reject(new Error('timed out waiting for notification lifecycle control'));
      }
      setTimeout(check, 2);
    };
    check();
  });
}

test('failed notification persistence rolls back live maps and disk, with private modes', () => {
  const { directory, file } = tempFile();
  const failure = { kind: null };
  try {
    const store = new NotificationStore(file, { persistence: persistence(failure) });
    const token = store.newToken({ accountId: 'account-a' });
    const row = store.enqueue({ accountId: 'account-a', payload: { name: 'LoopUpdated' } });
    const before = readFileSync(file, 'utf8');

    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(directory, 'private')).mode & 0o777, 0o700);
    assert.equal(statSync(join(directory, 'private', 'nested')).mode & 0o777, 0o700);

    failure.kind = 'write';
    assert.throws(() => store.newToken({ accountId: 'account-a' }), /synthetic write failure/);
    assert.deepEqual(store.findTokenByAccountId('account-a'), token, 'failed rotation restores the old live token');
    assert.equal(readFileSync(file, 'utf8'), before, 'failed rotation preserves the old file');
    assert.deepEqual(new NotificationStore(file).findTokenByAccountId('account-a'), token);

    failure.kind = 'rename';
    assert.throws(() => store.enqueue({ accountId: 'account-a', payload: { second: true } }), /synthetic rename failure/);
    assert.deepEqual(store.findNotificationsByTokenIds([token._id]).map((n) => n._id), [row._id]);
    assert.deepEqual(new NotificationStore(file).findNotificationsByTokenIds([token._id]).map((n) => n._id), [row._id]);
    assert.equal(readFileSync(file, 'utf8'), before, 'failed enqueue preserves the old file');

    failure.kind = 'write';
    assert.throws(() => store.removeNotification(row._id), /synthetic write failure/);
    assert.equal(store.findNotificationsByTokenIds([token._id]).length, 1, 'failed delete retains the live row');
    assert.equal(new NotificationStore(file).findNotificationsByTokenIds([token._id]).length, 1);

    failure.kind = 'rename';
    assert.throws(() => store.markConnected({ accountId: 'account-a' }), /synthetic rename failure/);
    assert.equal(store.getStatus({ accountId: 'account-a' }).connected, false, 'failed status update restores live state');
    assert.equal(new NotificationStore(file).getStatus({ accountId: 'account-a' }).connected, false);

    failure.kind = null;
    assert.ok(store.removeNotification(row._id));
    assert.equal(store.findNotificationsByTokenIds([token._id]).length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a send callback contains notification-delete persistence failures and leaves the row retryable', async () => {
  const { directory, file } = tempFile();
  const failure = { kind: null };
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    const store = new NotificationStore(file, { persistence: persistence(failure) });
    const hub = new NotificationHub({ store, pollIntervalMs: -1 });
    const token = hub.newRobotToken('account-a');
    const ws = fakeSocket();
    assert.equal(hub.attachSocket(token.tokenKey, ws), true);
    const row = store.enqueue({ accountId: 'account-a', payload: { name: 'LoopUpdated' } });
    failure.kind = 'rename';

    const delivered = await hub.deliver(token._id, row);
    await tick();
    assert.equal(delivered, false, 'a callback whose durable delete fails is not reported complete');
    assert.equal(unhandled.length, 0, 'persistence errors do not escape the callback');
    assert.equal(store.findNotificationsByTokenIds([token._id]).length, 1);

    failure.kind = null;
    assert.equal(await hub.deliver(token._id, row), true);
    assert.equal(store.findNotificationsByTokenIds([token._id]).length, 0);
    ws.close();
  } finally {
    process.off('unhandledRejection', onUnhandled);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a failed expiry purge in the poll is contained and the next scheduled poll retries', async () => {
  const { directory, file } = tempFile();
  const failure = { kind: null, once: false };
  let now = Date.parse('2026-09-07T10:00:00.000Z');
  const clock = () => now;
  const unhandled = [];
  const uncaught = [];
  const onUnhandled = (error) => unhandled.push(error);
  const onUncaught = (error) => uncaught.push(error);
  process.on('unhandledRejection', onUnhandled);
  process.on('uncaughtException', onUncaught);
  let hub;
  try {
    const store = new NotificationStore(file, {
      clock,
      notificationTtlMs: 5000,
      persistence: persistence(failure),
    });
    hub = new NotificationHub({ store, clock, notificationTtlMs: 5000, pollIntervalMs: 5 });
    const token = hub.newRobotToken('account-poll');
    const ws = fakeSocket();
    assert.equal(hub.attachSocket(token.tokenKey, ws), true);
    await tick();

    // Seed one expired and one live row at the committed boundary. The first
    // poll must fail while atomically purging the old row; the retry then
    // commits that purge and delivers the still-live row.
    store.notifications.set('expired-row', {
      _id: 'expired-row',
      created: new Date(now - 6000).toISOString(),
      payload: { kind: 'expired' },
      skillId: '-1',
      tokenId: token._id,
    });
    store.notifications.set('live-row', {
      _id: 'live-row',
      created: new Date(now).toISOString(),
      payload: { kind: 'live' },
      skillId: '-1',
      tokenId: token._id,
    });
    store.flush();
    now += 4000;
    failure.kind = 'rename';
    failure.once = true;

    hub.startDelivery();
    await waitFor(() => ws.messages.some((message) => message._id === 'live-row'));
    await tick();
    assert.equal(ws.messages.filter((message) => message._id === 'live-row').length, 1);
    assert.deepEqual(store.findNotificationsByTokenIds([token._id]), []);
    assert.deepEqual(unhandled, []);
    assert.deepEqual(uncaught, []);
    hub.stopDelivery();
    ws.close();
  } finally {
    hub?.stopDelivery();
    process.off('unhandledRejection', onUnhandled);
    process.off('uncaughtException', onUncaught);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('connection setup contains markConnected failure, closes the peer, and reconnect retries pending rows', async () => {
  const { directory, file } = tempFile();
  const failure = { kind: null, once: false };
  const uncaught = [];
  const onUncaught = (error) => uncaught.push(error);
  process.on('uncaughtException', onUncaught);
  try {
    const store = new NotificationStore(file, { persistence: persistence(failure) });
    const hub = new NotificationHub({ store, pollIntervalMs: -1 });
    const token = hub.newRobotToken('account-connect');
    const row = store.enqueue({ accountId: 'account-connect', payload: { kind: 'retry' } });
    failure.kind = 'rename';
    failure.once = true;

    const rejected = fakeSocket();
    assert.equal(hub.attachSocket(token.tokenKey, rejected), false);
    await tick();
    assert.equal(rejected.readyState, 3);
    assert.equal(hub.sockets.size, 0);
    assert.equal(hub.tokenCache.size, 0);
    assert.deepEqual(store.findNotificationsByTokenIds([token._id]).map((item) => item._id), [row._id]);

    const accepted = fakeSocket();
    assert.equal(hub.attachSocket(token.tokenKey, accepted), true);
    await waitFor(() => accepted.messages.some((message) => message._id === row._id));
    await tick();
    assert.deepEqual(store.findNotificationsByTokenIds([token._id]), []);
    assert.deepEqual(uncaught, []);
    accepted.close();
  } finally {
    process.off('uncaughtException', onUncaught);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('close callback contains markDisconnected failure and leaves a clean reconnect path', async () => {
  const { directory, file } = tempFile();
  const failure = { kind: null, once: false };
  const uncaught = [];
  const onUncaught = (error) => uncaught.push(error);
  process.on('uncaughtException', onUncaught);
  try {
    const store = new NotificationStore(file, { persistence: persistence(failure) });
    const hub = new NotificationHub({ store, pollIntervalMs: -1 });
    const token = hub.newRobotToken('account-close');
    const first = fakeSocket();
    assert.equal(hub.attachSocket(token.tokenKey, first), true);
    assert.equal(store.getStatus({ accountId: 'account-close' }).connected, true);

    failure.kind = 'rename';
    failure.once = true;
    assert.doesNotThrow(() => first.emit('close'));
    assert.equal(hub.sockets.size, 0);
    assert.equal(hub.tokenCache.size, 0);
    assert.equal(store.getStatus({ accountId: 'account-close' }).connected, true,
      'failed disconnect remains the committed connected marker until a retry');

    const second = fakeSocket();
    assert.equal(hub.attachSocket(token.tokenKey, second), true);
    second.emit('close');
    await tick();
    assert.equal(store.getStatus({ accountId: 'account-close' }).connected, false);
    assert.deepEqual(uncaught, []);
  } finally {
    process.off('uncaughtException', onUncaught);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('upgrade token lookup failure closes only that peer and keeps the HTTP server usable', async () => {
  const server = createServer((_req, res) => res.end('ok'));
  const hub = {
    findByToken() { throw new Error('synthetic expiry flush failure'); },
  };
  attachNotificationSocket(server, hub);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const closed = new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('error', reject);
    socket.once('close', resolve);
    socket.once('connect', () => {
      socket.write([
        'GET /socket/broken HTTP/1.1',
        'Host: 127.0.0.1',
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGVzdC1rZXk=',
        '',
        '',
      ].join('\r\n'));
    });
  });
  try {
    await closed;
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'ok');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
