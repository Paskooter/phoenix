import { signedLoopHeaders } from './fixtures/signedLoopRequest.js';
// A-10 bounded LoopUpdated producer -> notification account-ID seam.
// The publisher is an explicit local seam for the later Classic/event bridge;
// no public access-key text is used as the notification account identity.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { createAccountService, Store } = await import('../src/index.js');
const { createOwnerAccount, createLoop, findOrCreateRobotAccount } = await import('../src/model.js');
const { LoopUpdatedOutbox } = await import('../src/loopUpdatedOutbox.js');


async function post(store, base, target, body, accessKeyId) {
  const response = await fetch(`${base}/`, {
    method: 'POST',
    headers: signedLoopHeaders(store, base, target, body, accessKeyId),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const rawBody = Buffer.from(await response.arrayBuffer()).toString('utf8');
  return { status: response.status, rawBody, body: rawBody ? JSON.parse(rawBody) : null };
}

async function closeServer(server) {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
}

// See loopUpdatedOutboxConcurrency: a wall-clock deadline polled on setImmediate
// is a scheduling race under full-suite concurrency, not a product signal.
async function waitFor(predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail('timed out waiting for notification producer state');
}

function setup(dir) {
  const store = new Store(join(dir, 'store.json'));
  const owner = createOwnerAccount(store, {
    email: `owner-${Date.now()}-${Math.random()}@example.test`,
    password: 'owner-password',
    firstName: 'Owner',
  });
  const admin = createOwnerAccount(store, {
    email: `admin-${Date.now()}-${Math.random()}@example.test`,
    password: 'admin-password',
    firstName: 'Admin',
  });
  admin.isAdmin = true;
  store.flush();
  return { store, owner, admin };
}

test('successful suspension publishes source LoopUpdated with the robot account ID', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-a10-loop-updated-'));
  let server;
  try {
    const { store, owner, admin } = setup(dir);
    const { loop: loopA, robot: robotA } = createLoop(store, { owner, robotId: 'a10-producer-robot-a' });
    const { loop: loopB, robot: robotB } = createLoop(store, { owner, robotId: 'a10-producer-robot-b' });
    const published = [];
    const service = createAccountService({
      store,
      notificationPublisher: async (request) => { published.push(request); },
    });
    server = await service.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;

    const denied = await post(store, base, 'Loop_20160324.SuspendLoop', { loopId: loopA._id }, owner.accessKeyId);
    assert.equal(denied.status, 403);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(published.length, 0, 'a rejected suspend does not create an event');
    assert.equal(service.loopUpdatedOutbox.pending().length, 0);

    const suspended = await post(store, base, 'Loop_20160324.SuspendLoop', { loopId: loopA._id }, robotA.accessKeyId);
    assert.equal(suspended.status, 200);
    await waitFor(() => published.length === 1);
    assert.equal(published[0].accountId, robotA._id, 'routing uses loop.robot, not the caller access key');
    assert.equal(published[0].skillId, '-1');
    assert.equal(published[0].notification.name, 'LoopUpdated');
    assert.equal(published[0].notification.payload.id, loopA._id);
    assert.equal(published[0].notification.payload.owner, owner._id);
    assert.equal(published[0].notification.payload.robot, robotA._id);
    assert.equal(published[0].notification.payload.isSuspended, true);
    assert.equal(published[0].notification.payload.updated, store.loops.get(loopA._id).updated);
    assert.deepEqual(published[0].notification.payload.members.map((member) => member.id), [owner._id, robotA._id]);
    assert.deepEqual(published[0].notification.payload.members.map((member) => member.enrolled), [
      { face: false, voice: false },
      { face: false, voice: false },
    ]);
    assert.equal(service.loopUpdatedOutbox.pending().length, 0, 'successful publisher acknowledges the outbox row');

    const adminSuspended = await post(store,
      base,
      'Loop_20160324.SuspendRobotLoop',
      { friendlyId: 'a10-producer-robot-b' },
      admin.accessKeyId,
    );
    assert.equal(adminSuspended.status, 200);
    assert.equal(adminSuspended.rawBody, '');
    await waitFor(() => published.length === 2);
    assert.equal(published[1].accountId, robotB._id, 'admin suspension still routes to the target robot');
    assert.equal(published[1].notification.payload.robot, robotB._id);

    // Source still saves an administrator's suspension when the robot relation
    // is absent; its LoopUpdated payload then has no notification account
    // target. Preserve the state without inventing one from the admin key.
    loopA.robot = undefined;
    store.flush();
    const noRobot = await post(store, base, 'Loop_20160324.SuspendLoop', { loopId: loopA._id }, admin.accessKeyId);
    assert.equal(noRobot.status, 200);
    assert.equal(store.loops.get(loopA._id).isSuspended, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(published.length, 2, 'an unroutable source payload is not sent to a guessed account');
    assert.equal(new Store(join(dir, 'store.json')).loops.get(loopA._id).isSuspended, true);
  } finally {
    await closeServer(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('failed publication is durable and recovers after an Account service restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-a10-loop-updated-recovery-'));
  let server;
  try {
    const { store, owner } = setup(dir);
    const { loop, robot } = createLoop(store, { owner, robotId: 'a10-producer-recovery-robot' });
    let attempts = 0;
    const firstService = createAccountService({
      store,
      notificationPublisher: async () => {
        attempts += 1;
        throw new Error('notification bridge unavailable');
      },
    });
    server = await firstService.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await post(store, base, 'Loop_20160324.SuspendLoop', { loopId: loop._id }, robot.accessKeyId);
    assert.equal(response.status, 200);
    await waitFor(() => attempts === 1 && firstService.loopUpdatedOutbox.draining === null);
    const pending = firstService.loopUpdatedOutbox.pending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].accountId, robot._id);
    assert.equal(pending[0].skillId, '-1');
    assert.equal(pending[0].attempts, 1);
    assert.match(pending[0].lastError, /bridge unavailable/);
    await closeServer(server);
    server = null;

    const reopened = new Store(join(dir, 'store.json'));
    assert.equal(reopened.loops.get(loop._id).isSuspended, true);
    assert.equal(reopened.notificationOutbox.size, 1, 'state and unsent event survive restart');
    const replayed = [];
    const recovery = new LoopUpdatedOutbox(reopened, {
      publisher: async (request) => { replayed.push(request); },
    });
    const result = await recovery.recover();
    assert.deepEqual(result, { published: 1, retained: 0 });
    assert.equal(replayed.length, 1);
    assert.equal(replayed[0].accountId, robot._id);
    assert.equal(replayed[0].notification.payload.id, loop._id);
    assert.equal(reopened.notificationOutbox.size, 0);
  } finally {
    await closeServer(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('LoopUpdated payload projection preserves source member-properties fallback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-a10-loop-updated-payload-'));
  try {
    const { store, owner } = setup(dir);
    const robot = findOrCreateRobotAccount(store, 'a10-payload-robot');
    const loop = {
      _id: 'loop-payload',
      name: 'Payload loop',
      owner: owner._id,
      robot: robot._id,
      members: [{
        _id: 'member-invite',
        status: 'INVITED',
        memberProperties: { email: 'invite@example.test', firstName: 'Invite' },
        enrolled: { face: true, voice: false },
      }],
      isSuspended: true,
      created: 100,
      updated: 200,
    };
    const outbox = new LoopUpdatedOutbox(store);
    const entry = outbox.record(loop);
    assert.equal(entry.accountId, robot._id);
    assert.deepEqual(entry.notification.payload.members, [{
      memberId: 'member-invite',
      status: 'INVITED',
      invitedAsLegalGuardian: false,
      legalGuardianId: undefined,
      agreementId: undefined,
      nickname: undefined,
      phoneticName: undefined,
      enrolled: { face: true, voice: false },
      memberProperties: { email: 'invite@example.test', firstName: 'Invite' },
    }]);
    assert.equal(store.notificationOutbox.size, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('outbox acknowledgement failure retains a published row for recovery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-a10-loop-updated-commit-'));
  try {
    const { store, owner } = setup(dir);
    const { loop, robot } = createLoop(store, { owner, robotId: 'a10-commit-robot' });
    loop.isSuspended = true;
    loop.updated = Date.now();
    const originalFlush = store.flush.bind(store);
    let fail = false;
    store.flush = () => {
      if (fail) throw new Error('synthetic account snapshot failure');
      return originalFlush();
    };
    const delivered = [];
    const outbox = new LoopUpdatedOutbox(store, {
      publisher: async (request) => {
        delivered.push(request);
        // Make the acknowledgement flush fail after the publisher has
        // accepted the source-shaped event.
        fail = true;
      },
    });
    const entry = outbox.record(loop);
    await outbox.draining;
    assert.equal(delivered.length, 1);
    assert.equal(outbox.pending().some((row) => row._id === entry._id), true);
    assert.equal(outbox.pending()[0].attempts, 0, 'a failed acknowledgement does not fake a publisher failure');

    fail = false;
    const recovered = [];
    outbox.publisher = async (request) => { recovered.push(request); };
    assert.deepEqual(await outbox.recover(), { published: 1, retained: 0 });
    assert.equal(recovered[0].accountId, robot._id);
    assert.equal(store.notificationOutbox.size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a rejected Account snapshot does not leave a suspended loop without its event', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-a10-loop-updated-reject-'));
  let server;
  try {
    const { store, owner } = setup(dir);
    const { loop, robot } = createLoop(store, { owner, robotId: 'a10-rejected-robot' });
    const beforeUpdated = loop.updated;
    const originalFlush = store.flush.bind(store);
    store.flush = () => { throw new Error('synthetic account snapshot failure'); };
    const service = createAccountService({ store, notificationPublisher: async () => {} });
    server = await service.listen(0);
    const response = await post(store,
      `http://127.0.0.1:${server.address().port}`,
      'Loop_20160324.SuspendLoop',
      { loopId: loop._id },
      robot.accessKeyId,
    );
    assert.equal(response.status, 500);
    assert.equal(store.loops.get(loop._id).isSuspended, false);
    assert.equal(store.loops.get(loop._id).updated, beforeUpdated);
    assert.equal(service.loopUpdatedOutbox.pending().length, 0);
    // The file remains the pre-request state and can be reopened normally.
    const reopened = new Store(join(dir, 'store.json'));
    assert.equal(reopened.loops.get(loop._id).isSuspended, false);
    assert.equal(reopened.notificationOutbox.size, 0);
    store.flush = originalFlush;
  } finally {
    await closeServer(server);
    rmSync(dir, { recursive: true, force: true });
  }
});
