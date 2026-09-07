import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
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
import { NotificationHub, NotificationStore } from '../src/notification.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

function tempFile() {
  const directory = mkdtempSync(join(tmpdir(), 'phoenix-notification-failure-'));
  return { directory, file: join(directory, 'private', 'nested', 'notifications.json') };
}

function persistence(failure) {
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
      if (failure.kind === 'rename') throw new Error('synthetic rename failure');
      return renameSync(from, to);
    },
    unlink: (path) => {
      try { unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    },
    writeFile: (path, ...args) => {
      if (failure.kind === 'write') throw new Error('synthetic write failure');
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
