// A-04 gate 3 injection point 2: sever the Account→Classic publication path
// while Classic reconnects, then compare durable loop state, pending outbox
// rows, LoopCreated/LoopUpdated delivery counts, and the next valid request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { signSigV4 } from '@phoenix/common';
import {
  Store,
  createAccountService,
  InvitationEventOutbox,
  model,
} from '@phoenix/account';

const { createOwnerAccount, createLoop, newId } = model;
import {
  createClassicEntrypoint,
  createVerifiedNotificationAccountResolver,
} from '../src/index.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function waitFor(predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail('timed out waiting for Account/Classic interruption state');
}

function signedRequest({ host, target, payload, credentials }) {
  const body = JSON.stringify(payload);
  const signed = signSigV4({
    method: 'POST',
    path: '/',
    body,
    headers: {
      Host: host,
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': target,
    },
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
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
  let parsed = null;
  try { parsed = JSON.parse(rawBody); } catch { /* empty Classic success bodies are allowed */ }
  return { status: response.status, body: parsed, rawBody };
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
    ws.once('unexpected-response', (_request, response) => {
      reject(new Error(`${label} socket HTTP ${response.statusCode}`));
    });
  });
}

function nextMessage(ws, timeoutMS = 2000) {
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

function loopUpdatedCount(messages) {
  return messages.filter((message) => message?.payload?.name === 'LoopUpdated').length;
}

async function issueToken(classicBase, robot) {
  const issued = await post(classicBase, signedRequest({
    host: new URL(classicBase).host,
    target: 'Notification_20150505.NewRobotToken',
    payload: { deviceId: `device-${robot._id}` },
    credentials: robot,
  }));
  assert.equal(issued.status, 200);
  assert.match(issued.body.token, /^[a-f0-9]{128}$/);
  return issued.body.token;
}

test('socket reconnect during Account→Classic publication delivers one LoopUpdated and the next UpdateLoop', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'phx-a04-reconnect-socket-'));
  const accountFile = join(directory, 'account.json');
  const notificationFile = join(directory, 'notifications.json');
  const eventFile = join(directory, 'events.json');
  const store = new Store(accountFile);
  const owner = createOwnerAccount(store, {
    email: `owner-${newId()}@synthetic.invalid`,
    password: 'synthetic-password',
    firstName: 'Reconnect',
  });
  const { loop, robot } = createLoop(store, { owner, robotId: `reconnect-${newId()}` });

  let accountService;
  let accountServer;
  let classic;
  let classicServer;
  let socket;
  try {
    const createdEvents = [];
    const eventSender = new InvitationEventOutbox(eventFile, {
      publisher: async (event) => { createdEvents.push(event.payload.eventKey); },
    });
    accountService = createAccountService({
      store,
      invitationProviders: { eventSender },
    });
    accountServer = await accountService.listen(0);
    const accountBase = `http://127.0.0.1:${accountServer.address().port}`;

    classic = createClassicEntrypoint({
      notificationFile,
      notificationAccountResolver: createVerifiedNotificationAccountResolver({
        resolveCredentials: (accessKeyId) => store.accountByAccessKeyId(accessKeyId),
      }),
      notificationPollIntervalMs: 60_000,
    });
    classicServer = await classic.listen(0);
    const classicBase = `http://127.0.0.1:${classicServer.address().port}`;
    accountService.loopUpdatedOutbox.publisher = ({ accountId, skillId, notification }) =>
      classic.hub.deliverNotification({ accountId, skillId, notification });
    await accountService.loopUpdatedOutbox.recover();

    const token = await issueToken(classicBase, robot);
    socket = await openSocket(classicBase, token, 'live');
    socket.terminate();
    await waitFor(() => classic.hub.sockets.size === 0);

    const update = await post(accountBase, signedRequest({
      host: new URL(accountBase).host,
      target: 'Loop_20160324.UpdateLoop',
      payload: { loopId: loop._id, name: 'Name while socket down' },
      credentials: owner,
    }));
    assert.equal(update.status, 200);
    await waitFor(() => accountService.loopUpdatedOutbox.draining === null
      && accountService.loopUpdatedOutbox.pending().length === 0);
    const tokenDoc = classic.hub.store.findTokenByKey(token);
    assert.equal(classic.hub.store.findNotificationsByTokenIds([tokenDoc._id]).length, 1,
      'Classic retains the Notification document until a successful socket send');
    assert.equal(store.loops.get(loop._id).name, 'Name while socket down');
    assert.deepEqual(createdEvents, []);

    socket = await openSocket(classicBase, token, 'reconnect');
    const first = await nextMessage(socket);
    assert.equal(first.skillId, '-1');
    assert.equal(first.payload.name, 'LoopUpdated');
    assert.equal(first.payload.payload.id, loop._id);
    assert.equal(first.payload.payload.name, 'Name while socket down');
    assert.equal(first.payload.payload.robot, robot._id);
    await waitFor(() => classic.hub.store.findNotificationsByTokenIds([tokenDoc._id]).length === 0);
    await assert.rejects(nextMessage(socket, 150), /message timeout/);
    assert.equal(loopUpdatedCount([first]), 1);
    assert.equal(accountService.loopUpdatedOutbox.pending().length, 0);

    const following = await post(accountBase, signedRequest({
      host: new URL(accountBase).host,
      target: 'Loop_20160324.UpdateLoop',
      payload: { loopId: loop._id, name: 'Following valid reconnect name' },
      credentials: owner,
    }));
    assert.equal(following.status, 200);
    const second = await nextMessage(socket);
    assert.equal(second.payload.payload.name, 'Following valid reconnect name');
    await waitFor(() => accountService.loopUpdatedOutbox.pending().length === 0);
    assert.equal(new Store(accountFile).loops.get(loop._id).name, 'Following valid reconnect name');
  } finally {
    socket?.terminate();
    classic?.hub.stopDelivery();
    classic?.wss?.close();
    await closeServer(classicServer);
    await closeServer(accountServer);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Classic restart while the publisher is severed recovers one LoopUpdated and no LoopCreated duplicate', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'phx-a04-reconnect-publisher-'));
  const accountFile = join(directory, 'account.json');
  const notificationFile = join(directory, 'notifications.json');
  const eventFile = join(directory, 'events.json');
  const store = new Store(accountFile);
  const owner = createOwnerAccount(store, {
    email: `owner-${newId()}@synthetic.invalid`,
    password: 'synthetic-password',
    firstName: 'Publisher',
  });
  const { loop, robot } = createLoop(store, { owner, robotId: `publisher-${newId()}` });

  let accountService;
  let accountServer;
  let classic;
  let classicServer;
  let reopenedAccountServer;
  let socket;
  try {
    const createdEvents = [];
    accountService = createAccountService({
      store,
      invitationProviders: {
        eventSender: new InvitationEventOutbox(eventFile, {
          publisher: async (event) => { createdEvents.push(event.payload.eventKey); },
        }),
      },
    });
    accountServer = await accountService.listen(0);
    const accountBase = `http://127.0.0.1:${accountServer.address().port}`;

    classic = createClassicEntrypoint({
      notificationFile,
      notificationAccountResolver: createVerifiedNotificationAccountResolver({
        resolveCredentials: (accessKeyId) => store.accountByAccessKeyId(accessKeyId),
      }),
      notificationPollIntervalMs: 60_000,
    });
    classicServer = await classic.listen(0);
    let classicBase = `http://127.0.0.1:${classicServer.address().port}`;
    const token = await issueToken(classicBase, robot);

    accountService.loopUpdatedOutbox.publisher = async () => {
      throw new Error('classic publisher reconnecting');
    };
    const update = await post(accountBase, signedRequest({
      host: new URL(accountBase).host,
      target: 'Loop_20160324.UpdateLoop',
      payload: { loopId: loop._id, name: 'Name during classic outage' },
      credentials: owner,
    }));
    assert.equal(update.status, 200);
    await waitFor(() => accountService.loopUpdatedOutbox.draining === null
      && accountService.loopUpdatedOutbox.pending().length === 1);
    assert.equal(store.loops.get(loop._id).name, 'Name during classic outage');
    assert.equal(accountService.loopUpdatedOutbox.pending()[0].notification.name, 'LoopUpdated');
    assert.equal(classic.hub.store.notifications.size, 0, 'a rejected publisher must not create a Classic document');
    assert.deepEqual(createdEvents, []);

    classic.hub.stopDelivery();
    await closeServer(classicServer);
    await closeServer(accountServer);

    const reopenedStore = new Store(accountFile);
    assert.equal(reopenedStore.loops.get(loop._id).name, 'Name during classic outage');
    assert.equal(reopenedStore.notificationOutbox.size, 1);
    const reopenedAccount = createAccountService({ store: reopenedStore });
    reopenedAccountServer = await reopenedAccount.listen(0);
    const reopenedAccountBase = `http://127.0.0.1:${reopenedAccountServer.address().port}`;
    classic = createClassicEntrypoint({
      notificationFile,
      notificationAccountResolver: createVerifiedNotificationAccountResolver({
        resolveCredentials: (accessKeyId) => reopenedStore.accountByAccessKeyId(accessKeyId),
      }),
      notificationPollIntervalMs: 60_000,
    });
    classicServer = await classic.listen(0);
    classicBase = `http://127.0.0.1:${classicServer.address().port}`;
    reopenedAccount.loopUpdatedOutbox.publisher = ({ accountId, skillId, notification }) =>
      classic.hub.deliverNotification({ accountId, skillId, notification });
    const recovered = await reopenedAccount.loopUpdatedOutbox.recover();
    assert.equal(recovered.published, 1);
    assert.equal(reopenedAccount.loopUpdatedOutbox.pending().length, 0);

    socket = await openSocket(classicBase, token, 'recovered');
    const message = await nextMessage(socket);
    assert.equal(message.payload.name, 'LoopUpdated');
    assert.equal(message.payload.payload.name, 'Name during classic outage');
    await assert.rejects(nextMessage(socket, 150), /message timeout/, 'recovery must not duplicate the held row');

    const following = await post(reopenedAccountBase, signedRequest({
      host: new URL(reopenedAccountBase).host,
      target: 'Loop_20160324.UpdateLoop',
      payload: { loopId: loop._id, name: 'Name after classic recovery' },
      credentials: owner,
    }));
    assert.equal(following.status, 200);
    const next = await nextMessage(socket);
    assert.equal(next.payload.payload.name, 'Name after classic recovery');
    assert.equal(new Store(accountFile).loops.get(loop._id).name, 'Name after classic recovery');
    assert.equal(reopenedAccount.loopUpdatedOutbox.pending().length, 0);
    assert.deepEqual(createdEvents, []);
  } finally {
    socket?.terminate();
    classic?.hub.stopDelivery();
    classic?.wss?.close();
    await closeServer(classicServer);
    await closeServer(accountServer);
    await closeServer(reopenedAccountServer);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a Classic persist that outruns outbox acknowledgement is delivered at least once on recover', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'phx-a04-reconnect-duplicate-'));
  const accountFile = join(directory, 'account.json');
  const notificationFile = join(directory, 'notifications.json');
  const store = new Store(accountFile);
  const owner = createOwnerAccount(store, {
    email: `owner-${newId()}@synthetic.invalid`,
    password: 'synthetic-password',
    firstName: 'Duplicate',
  });
  const { loop, robot } = createLoop(store, { owner, robotId: `duplicate-${newId()}` });

  let accountService;
  let accountServer;
  let classic;
  let classicServer;
  let socket;
  try {
    accountService = createAccountService({ store });
    accountServer = await accountService.listen(0);
    const accountBase = `http://127.0.0.1:${accountServer.address().port}`;
    classic = createClassicEntrypoint({
      notificationFile,
      notificationAccountResolver: createVerifiedNotificationAccountResolver({
        resolveCredentials: (accessKeyId) => store.accountByAccessKeyId(accessKeyId),
      }),
      notificationPollIntervalMs: 60_000,
    });
    classicServer = await classic.listen(0);
    const classicBase = `http://127.0.0.1:${classicServer.address().port}`;
    const token = await issueToken(classicBase, robot);

    const originalFlush = store.flush.bind(store);
    let failAck = false;
    store.flush = (...args) => {
      if (failAck) throw new Error('injected outbox acknowledgement interrupt');
      return originalFlush(...args);
    };
    accountService.loopUpdatedOutbox.publisher = ({ accountId, skillId, notification }) => {
      const record = classic.hub.deliverNotification({ accountId, skillId, notification });
      failAck = true;
      return record;
    };

    const update = await post(accountBase, signedRequest({
      host: new URL(accountBase).host,
      target: 'Loop_20160324.UpdateLoop',
      payload: { loopId: loop._id, name: 'Ack-interrupted name' },
      credentials: owner,
    }));
    assert.equal(update.status, 200);
    await waitFor(() => accountService.loopUpdatedOutbox.draining === null);
    failAck = false;
    store.flush = originalFlush;
    assert.equal(store.loops.get(loop._id).name, 'Ack-interrupted name');
    assert.equal(accountService.loopUpdatedOutbox.pending().length, 1,
      'publication succeeded; acknowledgement did not, so the row is retained');
    assert.equal(classic.hub.store.notifications.size, 1);

    accountService.loopUpdatedOutbox.publisher = ({ accountId, skillId, notification }) =>
      classic.hub.deliverNotification({ accountId, skillId, notification });
    const recovered = await accountService.loopUpdatedOutbox.recover();
    assert.equal(recovered.published, 1);
    assert.equal(accountService.loopUpdatedOutbox.pending().length, 0);
    assert.equal(classic.hub.store.notifications.size, 2, 'at-least-once republish creates a second Classic document');

    socket = await openSocket(classicBase, token, 'duplicate');
    const first = await nextMessage(socket);
    const second = await nextMessage(socket);
    assert.equal(first.payload.name, 'LoopUpdated');
    assert.equal(second.payload.name, 'LoopUpdated');
    assert.equal(first.payload.payload.name, 'Ack-interrupted name');
    assert.equal(second.payload.payload.name, 'Ack-interrupted name');
    assert.notEqual(first._id, second._id);
    await tick();
    const tokenDoc = classic.hub.store.findTokenByKey(token);
    assert.equal(classic.hub.store.findNotificationsByTokenIds([tokenDoc._id]).length, 0);
  } finally {
    socket?.terminate();
    classic?.hub.stopDelivery();
    classic?.wss?.close();
    await closeServer(classicServer);
    await closeServer(accountServer);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('CreateLoop across a Classic reconnect recovers LoopUpdated once and LoopCreated from the event outbox', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'phx-a04-reconnect-create-'));
  const accountFile = join(directory, 'account.json');
  const notificationFile = join(directory, 'notifications.json');
  const eventFile = join(directory, 'events.json');
  const store = new Store(accountFile);
  const owner = createOwnerAccount(store, {
    email: `owner-${newId()}@synthetic.invalid`,
    password: 'synthetic-password',
    firstName: 'CreateReconnect',
  });
  const { robot } = createLoop(store, { owner, robotId: `seed-${newId()}` });

  let accountService;
  let accountServer;
  let classic;
  let classicServer;
  let socket;
  try {
    const createdEvents = [];
    const eventSender = new InvitationEventOutbox(eventFile);
    accountService = createAccountService({
      store,
      invitationProviders: { eventSender },
      robotReadClient: { async getRobot() { return { payload: { suspended: false } }; } },
    });
    accountServer = await accountService.listen(0);
    const accountBase = `http://127.0.0.1:${accountServer.address().port}`;
    classic = createClassicEntrypoint({
      notificationFile,
      notificationAccountResolver: createVerifiedNotificationAccountResolver({
        resolveCredentials: (accessKeyId) => store.accountByAccessKeyId(accessKeyId),
      }),
      notificationPollIntervalMs: 60_000,
    });
    classicServer = await classic.listen(0);
    const classicBase = `http://127.0.0.1:${classicServer.address().port}`;
    const token = await issueToken(classicBase, robot);

    let classicLive = false;
    accountService.loopUpdatedOutbox.publisher = async (request) => {
      if (!classicLive) throw new Error('classic reconnecting during create');
      return classic.hub.deliverNotification(request);
    };
    eventSender.publisher = async (event) => {
      createdEvents.push(event.payload.eventKey);
    };

    const created = await post(accountBase, signedRequest({
      host: new URL(accountBase).host,
      target: 'Loop_20160324.CreateLoop',
      payload: { name: 'Reconnect create', robotId: robot.friendlyId },
      credentials: owner,
    }));
    assert.equal(created.status, 200);
    await waitFor(() => accountService.loopUpdatedOutbox.draining === null
      && eventSender.draining === null);
    const newLoopId = created.body._id || created.body.id;
    assert.ok(newLoopId);
    assert.equal(store.loops.get(newLoopId).name, 'Reconnect create');
    assert.equal(accountService.loopUpdatedOutbox.pending().length, 1);
    await waitFor(() => createdEvents.length === 1 || eventSender.pending().length === 0);
    if (eventSender.pending().length) {
      assert.deepEqual(await eventSender.recover(), { published: 1, retained: 0 });
    }
    assert.deepEqual(createdEvents, ['LoopCreated']);
    assert.equal(eventSender.pending().length, 0);

    classicLive = true;
    const recovered = await accountService.loopUpdatedOutbox.recover();
    assert.equal(recovered.published, 1);
    assert.equal(accountService.loopUpdatedOutbox.pending().length, 0);

    socket = await openSocket(classicBase, token, 'create-reconnect');
    const message = await nextMessage(socket);
    assert.equal(message.payload.name, 'LoopUpdated');
    assert.equal(message.payload.payload.id, newLoopId);
    assert.equal(message.payload.payload.robot, robot._id);
    await assert.rejects(nextMessage(socket, 150), /message timeout/, 'LoopUpdated recovery is one-shot after a held publisher');
    assert.deepEqual(createdEvents, ['LoopCreated']);

    const listed = await post(accountBase, signedRequest({
      host: new URL(accountBase).host,
      target: 'Loop_20160324.ListLoops',
      payload: { loopId: newLoopId },
      credentials: owner,
    }));
    assert.equal(listed.status, 200);
    const listedLoop = Array.isArray(listed.body) ? listed.body[0] : listed.body;
    assert.equal(listedLoop.name, 'Reconnect create');
  } finally {
    socket?.terminate();
    classic?.hub.stopDelivery();
    classic?.wss?.close();
    await closeServer(classicServer);
    await closeServer(accountServer);
    rmSync(directory, { recursive: true, force: true });
  }
});
