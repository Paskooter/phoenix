// Account durability and transaction boundaries (re-ported from the September week-review
// hardening). Synthetic accounts, robots, tokens and hosts only; flush failures are injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';

import { createAccountService } from '../src/index.js';
import {
  createLoop,
  createOwnerAccount,
  deleteToken,
  findOrCreateRobotAccount,
  mintSetupToken,
  sweepTokens,
} from '../src/model.js';
import { updatePhoto } from '../src/accountIdentity.js';
import { updateMemberPhoto } from '../src/loopMemberPhotos.js';
import { LoopUpdatedOutbox } from '../src/loopUpdatedOutbox.js';
import { Store } from '../src/store.js';

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

function selectedState(store) {
  return JSON.stringify({
    accounts: [...store.accounts],
    loops: [...store.loops],
    tokens: [...store.tokens],
    notificationOutbox: [...store.notificationOutbox],
  });
}

test('token deletion restores memory when its durable flush fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phoenix-token-atomic-'));
  try {
    const file = join(directory, 'store.json');
    const store = new Store(file);
    const token = mintSetupToken(store, 'account-atomic');
    const originalFlush = store.flush.bind(store);
    store.flush = () => { throw new Error('synthetic disk failure'); };

    assert.throws(() => deleteToken(store, token._id), /synthetic disk failure/);
    assert.equal(store.tokens.has(token._id), true, 'failed consumption remains replay-protected in memory');

    store.flush = originalFlush;
    assert.equal(new Store(file).tokens.has(token._id), true, 'the committed token remains available after restart');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('token sweep restores expired tokens in memory and after reopen when flush fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phoenix-token-sweep-atomic-'));
  try {
    const file = join(directory, 'store.json');
    const store = new Store(file);
    const token = mintSetupToken(store, 'account-sweep-atomic');
    store.tokens.get(token._id).created = Date.now() - 16 * 60 * 1000;
    store.flush();
    const before = selectedState(store);
    const originalFlush = store.flush.bind(store);
    store.flush = () => { throw new Error('synthetic sweep snapshot failure'); };

    assert.throws(() => sweepTokens(store), /synthetic sweep snapshot failure/);
    assert.equal(selectedState(store), before, 'failed sweep leaves the in-memory token present');

    store.flush = originalFlush;
    assert.equal(selectedState(new Store(file)), before, 'failed sweep leaves the durable token after reopen');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('suspended SetupRobot replacement rolls back the full topology on final flush failure and retries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phoenix-oobe-replacement-atomic-'));
  let service;
  try {
    const file = join(directory, 'store.json');
    const store = new Store(file);
    const owner = createOwnerAccount(store, { email: 'oobe-replacement-atomic@example.test', password: 'ValidPass1' });
    const { loop, robot: oldRobot } = createLoop(store, { owner, robotId: 'oobe-replacement-old-robot' });
    loop.isSuspended = true;
    store.flush();
    const setup = mintSetupToken(store, owner._id, loop._id);
    const before = selectedState(store);
    const originalFlush = store.flush.bind(store);
    let failed = false;
    store.flush = () => {
      const candidate = store.loops.get(loop._id);
      const isFinalReplacement = candidate
        && candidate.robot !== oldRobot._id
        && candidate.isSuspended === false;
      if (!failed && isFinalReplacement) {
        failed = true;
        throw new Error('synthetic final SetupRobot save failure');
      }
      return originalFlush();
    };
    service = await createAccountService({ store }).listen(0);
    const base = `http://127.0.0.1:${service.address().port}`;
    const request = () => fetch(`${base}/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': 'OOBE_20161026.SetupRobot',
        connection: 'close',
      },
      body: JSON.stringify({ token: setup._id, id: 'oobe-replacement-new-robot' }),
    });

    const failedResponse = await request();
    assert.equal(failedResponse.status, 500);
    assert.equal(failed, true, 'the injected failure reached the final replacement save');
    store.flush = originalFlush;
    assert.equal(selectedState(store), before, 'failed replacement restores every in-memory collection');
    assert.equal(selectedState(new Store(file)), before, 'failed replacement restores the durable topology');
    assert.equal(store.tokens.get(setup._id).claimedAt, undefined, 'the setup token remains retryable');

    const retry = await request();
    assert.equal(retry.status, 200, await retry.text());
    const replacement = store.accountByFriendlyId('oobe-replacement-new-robot');
    assert.ok(replacement, 'retry creates the replacement robot');
    assert.equal(store.loops.get(loop._id).robot, replacement._id);
    assert.equal(store.loops.get(loop._id).isSuspended, false);
    assert.equal(store.tokens.has(setup._id), false, 'successful retry consumes the setup token');
  } finally {
    await closeServer(service);
    await rm(directory, { recursive: true, force: true });
  }
});

test('loop creation commits its LoopUpdated row with the new loop', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phoenix-loop-atomic-'));
  try {
    const file = join(directory, 'store.json');
    const store = new Store(file);
    const owner = createOwnerAccount(store, { email: 'loop-atomic@example.test', password: 'ValidPass1' });
    const robot = findOrCreateRobotAccount(store, 'loop-atomic-robot');
    const outbox = new LoopUpdatedOutbox(store);
    const originalFlush = store.flush.bind(store);
    let flushes = 0;
    store.flush = () => {
      flushes += 1;
      if (flushes === 2) throw new Error('synthetic loop snapshot failure');
      return originalFlush();
    };

    assert.throws(
      () => createLoop(store, { owner, robotId: robot.friendlyId }, outbox),
      /synthetic loop snapshot failure/,
    );
    assert.equal(store.loops.size, 0, 'a rejected atomic create leaves no in-memory loop');
    assert.equal(outbox.pending().length, 0, 'a rejected atomic create leaves no in-memory event');
    assert.equal(new Store(file).loops.size, 0, 'a rejected atomic create leaves no durable loop');

    store.flush = originalFlush;
    const committed = createLoop(store, { owner, robotId: robot.friendlyId }, outbox);
    assert.equal(outbox.pending().length, 1);
    const reopened = new Store(file);
    assert.ok(reopened.loops.has(committed.loop._id));
    assert.equal(reopened.notificationOutbox.size, 1, 'the loop and event share one committed snapshot');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('OOBE setup does not persist a loop without its required LoopUpdated row', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phoenix-oobe-loop-atomic-'));
  let service;
  try {
    const file = join(directory, 'store.json');
    const store = new Store(file);
    const owner = createOwnerAccount(store, { email: 'oobe-atomic@example.test', password: 'ValidPass1' });
    const setup = mintSetupToken(store, owner._id);
    const originalFlush = store.flush.bind(store);
    let failed = false;
    store.flush = () => {
      // Robot-account creation commits on its own; fail the first snapshot that
      // contains the new loop, which must also be the one carrying its event.
      if (!failed && store.loops.size > 0) {
        failed = true;
        throw new Error('synthetic OOBE snapshot failure');
      }
      return originalFlush();
    };
    service = await createAccountService({ store }).listen(0);
    const response = await fetch(`http://127.0.0.1:${service.address().port}/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': 'OOBE_20161026.SetupRobot',
        connection: 'close',
      },
      body: JSON.stringify({ token: setup._id, id: 'oobe-atomic-robot' }),
    });
    assert.equal(response.status, 500);
    assert.equal(failed, true, 'the injected failure reached the loop snapshot');
    store.flush = originalFlush;
    assert.equal(store.loops.size, 0, 'no in-memory loop survives the rejected snapshot');
    assert.equal(store.notificationOutbox.size, 0);
    const reopened = new Store(file);
    assert.equal(reopened.loops.size, 0);
    assert.equal(reopened.notificationOutbox.size, 0);
    assert.equal(reopened.tokens.has(setup._id), true, 'failed setup leaves the setup token retryable');
  } finally {
    await closeServer(service);
    await rm(directory, { recursive: true, force: true });
  }
});
