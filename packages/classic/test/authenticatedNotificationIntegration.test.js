// A-10 colocated launcher bridge controls. The source notification handler
// authenticates through @parseCredentials, validates the payload with Joi,
// and only then rotates/reads the Token document. These controls exercise the
// Phoenix Account -> Classic path over real local HTTP and WebSocket sockets;
// all accounts, keys, and files are synthetic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { signSigV4 } from '@phoenix/common';
import { Store, createAccountService } from '@phoenix/account';
import { createClassicEntrypoint, createVerifiedNotificationAccountResolver } from '../src/index.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tick = () => new Promise((resolve) => setImmediate(resolve));

function account(id, accessKeyId) {
  return {
    _id: id,
    email: `${id}@fixture.test`,
    friendlyId: id,
    accessKeyId,
    secretAccessKey: `${accessKeyId}-secret`,
    isActive: true,
    isDeleted: false,
  };
}

function loop(id, robot, owner) {
  return {
    _id: id,
    name: `${id} loop`,
    owner,
    robot,
    members: [{ accountId: owner, status: 'ACCEPTED' }, { accountId: robot, status: 'ACCEPTED' }],
    isSuspended: false,
    created: Date.now(),
  };
}

function signedRequest({ host, target, payload, credentials, accessKeyId = credentials.accessKeyId, secretAccessKey = credentials.secretAccessKey }) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const signed = signSigV4({
    method: 'POST',
    path: '/',
    body,
    headers: {
      Host: host,
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': target,
    },
    accessKeyId,
    secretAccessKey,
    region: 'global',
    service: 'jibo',
    date: new Date(),
  });
  return { headers: signed.headers, body };
}

async function post(base, request) {
  const response = await fetch(`${base}/`, {
    method: 'POST',
    headers: request.headers,
    body: request.body,
  });
  const rawBody = await response.text();
  let body = null;
  try { body = JSON.parse(rawBody); } catch { /* preserve a raw response if one occurs */ }
  return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body, rawBody };
}

function openSocket(base, token, label = 'socket') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base}/socket/${token}`);
    ws._label = label;
    ws._messages = [];
    ws._waiters = [];
    ws.on('message', (encoded) => {
      const message = JSON.parse(String(encoded));
      const waiter = ws._waiters.shift();
      if (waiter) waiter.resolve(message);
      else ws._messages.push(message);
    });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    ws.once('unexpected-response', (_request, response) => reject(new Error(`socket HTTP ${response.statusCode}`)));
  });
}

function nextMessage(ws, timeoutMS = 1500) {
  if (ws._messages.length) return Promise.resolve(ws._messages.shift());
  return new Promise((resolve, reject) => {
    const waiter = {
      resolve: (message) => { clearTimeout(timer); resolve(message); },
      reject,
    };
    const timer = setTimeout(() => {
      const index = ws._waiters.indexOf(waiter);
      if (index >= 0) ws._waiters.splice(index, 1);
      reject(new Error(`${ws._label} message timeout after ${timeoutMS}ms`));
    }, timeoutMS);
    ws._waiters.push(waiter);
  });
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

test('signed notification validation, shared Account outbox, account isolation, and restart recovery', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'phoenix-a10-integration-'));
  const accountFile = join(directory, 'account.json');
  const notificationFile = join(directory, 'notifications.json');
  const store = new Store(accountFile);
  const robotA = account('robot-a-document', 'A10-ACCESS-A');
  const robotB = account('robot-b-document', 'A10-ACCESS-B');
  const robotC = account('robot-c-document', 'A10-ACCESS-C');
  const loopA = loop('loop-a', robotA._id, robotA._id);
  const loopB = loop('loop-b', robotB._id, robotB._id);
  const loopC = loop('loop-c', robotC._id, robotC._id);
  for (const value of [robotA, robotB, robotC]) store.accounts.set(value._id, value);
  for (const value of [loopA, loopB, loopC]) store.loops.set(value._id, value);
  store.flush();

  let accountService;
  let classic;
  let accountServer;
  let classicServer;
  let reopenedAccountServer;
  let socketA;
  let socketB;
  let socketC;
  try {
    accountService = createAccountService({ store });
    accountServer = await accountService.listen(0);
    const accountBase = `http://127.0.0.1:${accountServer.address().port}`;

    const resolver = createVerifiedNotificationAccountResolver({
      resolveCredentials: (accessKeyId) => store.accountByAccessKeyId(accessKeyId),
    });
    classic = createClassicEntrypoint({
      notificationFile,
      notificationAccountResolver: resolver,
      notificationPollIntervalMs: 60_000,
    });
    classicServer = await classic.listen(0);
    const classicBase = `http://127.0.0.1:${classicServer.address().port}`;
    accountService.loopUpdatedOutbox.publisher = ({ accountId, skillId, notification }) =>
      classic.hub.deliverNotification({ accountId, skillId, notification });
    await accountService.loopUpdatedOutbox.recover();

    const notificationTarget = 'Notification_20150505.NewRobotToken';
    const notificationHost = new URL(classicBase).host;
    const notify = (payload, credentials = robotA, options = {}) => post(classicBase, signedRequest({
      host: notificationHost,
      target: options.target || notificationTarget,
      payload,
      credentials,
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    }));

    const first = await notify({ deviceId: 'device-a' });
    assert.equal(first.status, 200);
    assert.match(first.body.token, /^[a-f0-9]{128}$/);
    const priorToken = first.body.token;
    for (const deviceId of [{ bad: true }, ['bad'], true, null]) {
      const invalid = await notify({ deviceId });
      assert.equal(invalid.status, 422, `invalid deviceId ${JSON.stringify(deviceId)}`);
      assert.deepEqual(Object.keys(invalid.body), ['statusCode', 'error', 'message']);
      assert.equal(invalid.body.statusCode, 422);
      assert.equal(invalid.body.error, 'Unprocessable Entity');
      assert.match(invalid.body.message, /deviceId/);
      assert.ok(classic.hub.findByToken(priorToken), 'Joi rejection must not rotate the prior token');
    }
    // Original Hapi supplies null for a missing HTTP entity. Keep the route
    // boundary intact: an absent body must not become a valid empty object.
    for (const payload of ['', null, [], false, 0, '"scalar"']) {
      const invalid = await notify(payload);
      assert.equal(invalid.status, 422);
      assert.equal(invalid.body.statusCode, 422);
      assert.ok(classic.hub.findByToken(priorToken), 'invalid HTTP body must retain the token');
    }
    const recovered = await notify({ deviceId: 'device-a-recovered', unknown: 'allowed' });
    assert.equal(recovered.status, 200);
    assert.equal(classic.hub.findByToken(priorToken), null, 'a valid request rotates the source token');
    const tokenA = recovered.body.token;

    const getStatusTarget = 'Notification_20150505.GetStatus';
    const getStatus = (payload, credentials = robotA) => notify(payload, credentials, { target: getStatusTarget });
    for (const payload of [{}, { accountId: null }, { accountId: 7 }, { accountId: '' }]) {
      const invalid = await getStatus(payload);
      assert.equal(invalid.status, 422, `invalid GetStatus ${JSON.stringify(payload)}`);
      assert.equal(invalid.body.statusCode, 422);
      assert.match(invalid.body.message, /accountId/);
    }
    for (const payload of ['', null, [], false, 0]) {
      const invalid = await getStatus(payload);
      assert.equal(invalid.status, 422);
      assert.equal(invalid.body.statusCode, 422);
    }
    const statusBefore = await getStatus({ accountId: robotB._id, extra: true });
    assert.equal(statusBefore.status, 200);
    assert.equal(statusBefore.body.connected, false, 'unknown fields remain allowed by source Joi options');

    const issuedB = await notify({ deviceId: 'device-b' }, robotB);
    assert.equal(issuedB.status, 200);
    const tokenB = issuedB.body.token;
    socketA = await openSocket(classicBase, tokenA, 'account-a');
    socketB = await openSocket(classicBase, tokenB, 'account-b');
    const statusConnectedOther = await getStatus({ accountId: robotB._id });
    assert.equal(statusConnectedOther.status, 200);
    assert.equal(statusConnectedOther.body.connected, true, 'source GetStatus intentionally has no ownership check');

    const rejected = await notify({ deviceId: 'forged' }, robotA, {
      accessKeyId: 'A10-UNKNOWN',
      secretAccessKey: 'unknown-secret',
    });
    assert.equal(rejected.status, 401);
    assert.equal(rejected.headers['x-amzn-errortype'], 'ACCESS_KEY_NOT_FOUND');
    assert.ok(classic.hub.findByToken(tokenA), 'rejected caller cannot rotate another account token');

    const rejectedSuspend = await post(accountBase, signedRequest({
      host: new URL(accountBase).host,
      target: 'Loop_20160324.SuspendLoop',
      payload: { loopId: loopA._id },
      credentials: robotA,
      accessKeyId: 'A10-UNKNOWN',
      secretAccessKey: 'unknown-secret',
    }));
    assert.equal(rejectedSuspend.status, 403);
    assert.equal(loopA.isSuspended, false);
    assert.equal(accountService.loopUpdatedOutbox.pending().length, 0);

    const eventA = nextMessage(socketA);
    const suspendA = await post(accountBase, signedRequest({
      host: new URL(accountBase).host,
      target: 'Loop_20160324.SuspendLoop',
      payload: { loopId: loopA._id },
      credentials: robotA,
    }));
    assert.equal(suspendA.status, 200);
    const messageA = await eventA;
    assert.equal(messageA.skillId, '-1');
    assert.equal(messageA.payload.name, 'LoopUpdated');
    assert.equal(messageA.payload.payload.id, loopA._id);
    assert.equal(messageA.payload.payload.robot, robotA._id);
    assert.equal(messageA.payload.payload.isSuspended, true);
    await assert.rejects(nextMessage(socketB, 150), /message timeout/);
    assert.equal(accountService.loopUpdatedOutbox.pending().length, 0);

    const eventB = nextMessage(socketB);
    const suspendB = await post(accountBase, signedRequest({
      host: new URL(accountBase).host,
      target: 'Loop_20160324.SuspendLoop',
      payload: { loopId: loopB._id },
      credentials: robotB,
    }));
    assert.equal(suspendB.status, 200);
    const messageB = await eventB;
    assert.equal(messageB.payload.payload.id, loopB._id);
    assert.equal(messageB.payload.payload.robot, robotB._id);
    assert.equal(messageB.payload.payload.isSuspended, true);

    // Exercise the outbox's durable failure/restart seam. The account change
    // succeeds while the bridge is unavailable; the row is retained, then a
    // reopened Account Store and Classic notification store recover it.
    const issuedC = await notify({ deviceId: 'device-c' }, robotC);
    assert.equal(issuedC.status, 200);
    const tokenC = issuedC.body.token;
    socketA.terminate();
    socketB.terminate();
    await wait(10);
    classic.hub.stopDelivery();
    await closeServer(classicServer);
    accountService.loopUpdatedOutbox.publisher = () => { throw new Error('synthetic bridge offline'); };
    const offlineSuspend = await post(accountBase, signedRequest({
      host: new URL(accountBase).host,
      target: 'Loop_20160324.SuspendLoop',
      payload: { loopId: loopC._id },
      credentials: robotC,
    }));
    assert.equal(offlineSuspend.status, 200);
    await tick();
    await wait(10);
    assert.equal(accountService.loopUpdatedOutbox.pending().length, 1);
    assert.equal(accountService.loopUpdatedOutbox.pending()[0].accountId, robotC._id);

    await closeServer(accountServer);
    const reopenedStore = new Store(accountFile);
    const reopenedAccount = createAccountService({ store: reopenedStore });
    reopenedAccountServer = await reopenedAccount.listen(0);
    classic = createClassicEntrypoint({
      notificationFile,
      notificationAccountResolver: createVerifiedNotificationAccountResolver({
        resolveCredentials: (accessKeyId) => reopenedStore.accountByAccessKeyId(accessKeyId),
      }),
      notificationPollIntervalMs: 60_000,
    });
    classicServer = await classic.listen(0);
    const reopenedClassicBase = `http://127.0.0.1:${classicServer.address().port}`;
    reopenedAccount.loopUpdatedOutbox.publisher = ({ accountId, skillId, notification }) =>
      classic.hub.deliverNotification({ accountId, skillId, notification });
    const recoveredRows = await reopenedAccount.loopUpdatedOutbox.recover();
    assert.equal(recoveredRows.published, 1);
    assert.equal(reopenedAccount.loopUpdatedOutbox.pending().length, 0);
    socketC = await openSocket(reopenedClassicBase, tokenC, 'account-c');
    const messageC = await nextMessage(socketC);
    assert.equal(messageC.payload.name, 'LoopUpdated');
    assert.equal(messageC.payload.payload.id, loopC._id);
    assert.equal(messageC.payload.payload.robot, robotC._id);
    assert.equal(messageC.payload.payload.isSuspended, true);
    await tick();
    assert.equal(classic.hub.store.findNotificationsByTokenIds([
      classic.hub.store.findTokenByKey(tokenC)._id,
    ]).length, 0, 'successful socket callback removes the recovered row');

    await closeServer(reopenedAccountServer);
    reopenedAccountServer = null;
    accountServer = null;
  } finally {
    socketA?.terminate();
    socketB?.terminate();
    socketC?.terminate();
    classic?.hub.stopDelivery();
    classic?.wss?.close();
    await closeServer(classicServer);
    await closeServer(accountServer);
    await closeServer(reopenedAccountServer);
    rmSync(directory, { recursive: true, force: true });
  }
});
