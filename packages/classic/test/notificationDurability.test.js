import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { createClassicEntrypoint } from '../src/index.js';
import { NotificationHub, NotificationStore } from '../src/notification.js';
import { NOTIFICATION_TTL_MS, NOTIFICATIONS_LIMIT } from '../src/notificationStore.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

async function notificationRequest(base, target, body, accountId) {
  const response = await fetch(`${base}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': target,
      authorization: `AWS4-HMAC-SHA256 Credential=${accountId}/20260907/us-east-1/notification/aws4_request, SignedHeaders=host, Signature=synthetic`,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function connectAndRead(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('error', reject);
    ws.once('open', () => {
      ws.once('message', (encoded) => resolve({ ws, message: JSON.parse(String(encoded)) }));
    });
  });
}

function fakeSocket({ fail = false, throwOnSend = false } = {}) {
  const ws = new EventEmitter();
  ws.OPEN = 1;
  ws.readyState = 1;
  ws.messages = [];
  ws.send = (encoded, callback) => {
    if (throwOnSend) throw new Error('synthetic send failure');
    ws.messages.push(JSON.parse(encoded));
    queueMicrotask(() => callback?.(fail ? new Error('synthetic send failure') : undefined));
  };
  ws.close = () => {
    if (ws.readyState === 3) return;
    ws.readyState = 3;
    queueMicrotask(() => ws.emit('close'));
  };
  return ws;
}

function tempFile() {
  const directory = mkdtempSync(join(tmpdir(), 'phoenix-notification-durable-'));
  return { directory, file: join(directory, 'notifications.json') };
}

test('NotificationStore persists source token and notification documents across reopen', () => {
  const { directory, file } = tempFile();
  try {
    let now = Date.parse('2026-09-07T10:00:00.000Z');
    const clock = () => now;
    const first = new NotificationStore(file, { clock });
    const token = first.newToken({ accountId: 'account-a' });
    assert.equal(token._id.length, 24);
    assert.match(token.tokenKey, /^[a-f0-9]{128}$/);
    assert.equal(token.lastConnected, '2000-01-01T00:00:00.000Z');
    const firstNotification = first.enqueue({
      accountId: 'account-a',
      skillId: '-1',
      payload: { name: 'LoopUpdated', payload: { id: 'loop-a', robot: 'account-a' } },
    });
    const secondNotification = first.enqueue({
      accountId: 'account-a',
      skillId: 'skill-b',
      payload: { name: 'OtherEvent', payload: ['a', 'b'] },
    });

    const reopened = new NotificationStore(file, { clock });
    assert.deepEqual(reopened.findTokenByKey(token.tokenKey), token);
    assert.deepEqual(reopened.findNotificationsByTokenIds([token._id]).map((n) => n._id), [
      firstNotification._id,
      secondNotification._id,
    ]);
    assert.equal(reopened.findNotificationsByTokenIds([token._id])[0].skillId, '-1');
    assert.deepEqual(reopened.findNotificationsByTokenIds([token._id])[0].payload, firstNotification.payload);

    assert.ok(reopened.removeNotification(firstNotification._id));
    const reopenedAgain = new NotificationStore(file, { clock });
    assert.deepEqual(reopenedAgain.findNotificationsByTokenIds([token._id]).map((n) => n._id), [secondNotification._id]);

    now += NOTIFICATION_TTL_MS + 1;
    const expired = new NotificationStore(file, { clock });
    assert.deepEqual(expired.findNotificationsByTokenIds([token._id]), []);
    assert.deepEqual(new NotificationStore(file, { clock }).findNotificationsByTokenIds([token._id]), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('source token issuance rotates one account token and keeps accounts isolated', () => {
  const { directory, file } = tempFile();
  try {
    const store = new NotificationStore(file, { clock: () => Date.now() });
    const first = store.newToken({ accountId: 'account-a' });
    const rotated = store.newToken({ accountId: 'account-a' });
    const other = store.newToken({ accountId: 'account-b' });
    assert.equal(rotated._id, first._id, 'source finds and updates the existing account token');
    assert.notEqual(rotated.tokenKey, first.tokenKey, 'source issues a new 64-byte token key');
    assert.notEqual(other._id, first._id);
    assert.equal(store.findTokenByKey(first.tokenKey), null, 'rotated token key is no longer valid');
    assert.equal(store.findTokenByKey(rotated.tokenKey).accountId, 'account-a');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('send errors and synchronous send throws leave notifications pending for retry', async () => {
  const { directory, file } = tempFile();
  try {
    const store = new NotificationStore(file);
    const hub = new NotificationHub({ store, pollIntervalMs: -1 });
    const token = hub.newRobotToken('account-a', 'device-a');
    const failing = fakeSocket({ fail: true });
    assert.equal(hub.attachSocket(token.tokenKey, failing), true);
    const failed = hub.enqueueNotification({
      accountId: 'account-a',
      skillId: '-1',
      notification: { name: 'LoopUpdated', payload: { isSuspended: true } },
    });
    await tick();
    assert.equal(failing.messages.length, 1);
    assert.equal(store.findNotificationsByTokenIds([token._id]).length, 1);

    const throwing = fakeSocket({ throwOnSend: true });
    hub.attachSocket(token.tokenKey, throwing);
    await hub._deliverPending(token._id);
    assert.ok(store.findNotificationsByTokenIds([token._id]).some((n) => n._id === failed._id));

    const successful = fakeSocket();
    hub.attachSocket(token.tokenKey, successful);
    await tick();
    await tick();
    assert.equal(successful.messages.length, 1);
    assert.equal(successful.messages[0].skillId, '-1');
    assert.equal(store.findNotificationsByTokenIds([token._id]).length, 0);
    hub.stopDelivery();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('pending retrieval is source ordered, globally capped, and account isolated', () => {
  const { directory, file } = tempFile();
  try {
    let now = Date.parse('2026-09-07T10:00:00.000Z');
    const store = new NotificationStore(file, { clock: () => now });
    const a = store.newToken({ accountId: 'account-a' });
    const b = store.newToken({ accountId: 'account-b' });
    for (let i = 0; i < NOTIFICATIONS_LIMIT + 1; i += 1) {
      store.enqueue({ accountId: 'account-a', skillId: '-1', payload: { index: i } });
      now += 1;
    }
    store.enqueue({ accountId: 'account-b', skillId: '-1', payload: { index: 'other' } });
    const aRows = store.findNotificationsByTokenIds([a._id]);
    assert.equal(aRows.length, NOTIFICATIONS_LIMIT);
    assert.equal(aRows[0].payload.index, 0);
    assert.equal(aRows.at(-1).payload.index, NOTIFICATIONS_LIMIT - 1);
    assert.deepEqual(store.findNotificationsByTokenIds([b._id]).map((n) => n.payload.index), ['other']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a pending notification survives Classic restart and is removed after socket send success', async () => {
  const { directory, file } = tempFile();
  let firstServer;
  let secondServer;
  let ws;
  let queuedMessage;
  try {
    const first = createClassicEntrypoint({ notificationFile: file, notificationPollIntervalMs: 10 });
    firstServer = await first.listen(0);
    const firstBase = `http://127.0.0.1:${firstServer.address().port}`;
    const issued = await notificationRequest(
      firstBase,
      'Notification_20150505.NewRobotToken',
      { deviceId: 'device-a' },
      'account-a',
    );
    assert.equal(issued.status, 200);
    assert.match(issued.body.token, /^[a-f0-9]{128}$/);
    const queued = first.hub.enqueueNotification({
      accountId: 'account-a',
      skillId: '-1',
      notification: { name: 'LoopUpdated', payload: { id: 'loop-a', isSuspended: true } },
    });
    assert.equal(first.hub.store.findNotificationsByTokenIds([queued.tokenId]).length, 1);
    await closeServer(firstServer);

    const second = createClassicEntrypoint({ notificationFile: file, notificationPollIntervalMs: 10 });
    secondServer = await second.listen(0);
    const port = secondServer.address().port;
    ({ ws, message: queuedMessage } = await connectAndRead(`ws://127.0.0.1:${port}/socket/${issued.body.token}`));
    assert.equal(queuedMessage.skillId, '-1');
    assert.deepEqual(queuedMessage.payload, queued.payload);
    await tick();
    const token = second.hub.store.findTokenByKey(issued.body.token);
    assert.deepEqual(second.hub.store.findNotificationsByTokenIds([token._id]), []);
  } finally {
    ws?.close();
    await closeServer(secondServer);
    await closeServer(firstServer);
    rmSync(directory, { recursive: true, force: true });
  }
});
