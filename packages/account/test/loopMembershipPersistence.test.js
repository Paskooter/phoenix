import { signedLoopHeaders } from './fixtures/signedLoopRequest.js';
// Synthetic failure controls for the Loop membership persistence boundary.
// All identifiers and profiles in this file are invented fixtures.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { createAccountService } = await import('../src/index.js');
const { Store } = await import('../src/store.js');
const { LoopUpdatedOutbox } = await import('../src/loopUpdatedOutbox.js');
const {
  LoopError,
  acceptInvitation,
  declineInvitation,
  inviteMember,
  listMembers,
  removeMember,
  createLoopFromApi,
} = await import('../src/loopMembership.js');
const { MEMBER_STATUS } = await import('../src/model.js');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function snapshot(store) {
  return {
    accounts: clone([...store.accounts.values()]),
    loops: clone([...store.loops.values()]),
    tokens: clone([...store.tokens.values()]),
    sessions: clone([...store.sessions.values()]),
    settings: clone([...store.settings.values()]),
    notificationOutbox: clone([...store.notificationOutbox.values()]),
  };
}

function fixture(file) {
  const store = new Store(file);
  const owner = {
    _id: 'a04-owner',
    email: 'owner@fixture.test',
    firstName: 'Fixture',
    lastName: 'Owner',
    accessKeyId: 'a04-owner-access',
    secretAccessKey: 'a04-owner-secret',
    isActive: true,
  };
  const guest = {
    _id: 'a04-guest',
    email: 'guest@fixture.test',
    firstName: 'Fixture',
    lastName: 'Guest',
    accessKeyId: 'a04-guest-access',
    secretAccessKey: 'a04-guest-secret',
    isActive: true,
  };
  const robot = {
    _id: 'a04-robot-account',
    friendlyId: 'robot-fixture',
    email: null,
    accessKeyId: 'a04-robot-access',
    secretAccessKey: 'a04-robot-secret',
    isActive: true,
  };
  const loop = {
    _id: 'a04-loop',
    name: 'Fixture Loop',
    owner: owner._id,
    robot: robot._id,
    members: [
      {
        _id: 'a04-owner-member',
        accountId: owner._id,
        status: MEMBER_STATUS.ACCEPTED,
        enrolled: { face: true, voice: false },
        memberProperties: { firstName: 'Fixture', lastName: 'Owner' },
        created: 10,
      },
      {
        _id: 'a04-guest-member',
        accountId: guest._id,
        status: MEMBER_STATUS.INVITED,
        invitationCode: 'old-invitation',
        invitedAsLegalGuardian: false,
        enrolled: { face: false, voice: true },
        memberProperties: { email: guest.email, firstName: 'Fixture', lastName: 'Guest' },
        created: 11,
      },
      {
        _id: 'a04-robot-member',
        accountId: robot._id,
        status: MEMBER_STATUS.ACCEPTED,
        enrolled: { face: false, voice: false },
        created: 11,
      },
      {
        _id: 'a04-profile-member',
        status: MEMBER_STATUS.ACCEPTED,
        memberProperties: { firstName: 'Profile', lastName: 'Only' },
        enrolled: { face: false, voice: false },
        created: 12,
      },
    ],
    isSuspended: false,
    created: 9,
    updated: 12,
  };
  store.accounts.set(owner._id, owner);
  store.accounts.set(guest._id, guest);
  store.accounts.set(robot._id, robot);
  store.loops.set(loop._id, loop);
  store.flush();
  return { store, owner, guest, robot, loop };
}

function tempFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-a04-loop-failure-'));
  const file = join(dir, 'store.json');
  return { dir, file, ...fixture(file) };
}

function rejectingOutbox() {
  return {
    calls: 0,
    record() {
      this.calls += 1;
      throw new Error('injected loop persistence failure');
    },
  };
}

async function assertRejectedWithoutMutation(run, store, file, loop) {
  const before = snapshot(store);
  const diskBefore = readFileSync(file);
  const loopReference = loop;
  await assert.rejects(Promise.resolve().then(run), /injected loop persistence failure/);
  assert.deepEqual(snapshot(store), before);
  assert.strictEqual(store.loops.get(loop._id), loopReference, 'failed save keeps the shared document');
  assert.deepEqual(readFileSync(file), diskBefore, 'failed save does not change committed bytes');
  assert.deepEqual(new Store(file).loops.get(loop._id), loopReference);
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}


async function post(store, base, target, body, accessKeyId) {
  const response = await fetch(`${base}/`, {
    method: 'POST',
    headers: signedLoopHeaders(store, base, target, body, accessKeyId),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    body: JSON.parse(raw.toString('utf8')),
  };
}

test('Create relocation preserves its prior Account save when the Loop save fails', () => {
  const state = tempFixture();
  try {
    state.robot.isActive = false;
    state.store.flush();
    const before = JSON.parse(readFileSync(state.file));
    const outbox = rejectingOutbox();
    assert.throws(() => createLoopFromApi(state.store, {
      ownerId: state.owner._id,
      name: 'Replacement Loop',
      robotId: state.robot.friendlyId,
    }, outbox), /injected loop persistence failure/);
    const savedRobot = state.store.accounts.get(state.robot._id);
    assert.equal(savedRobot.isActive, true);
    assert(Number.isFinite(savedRobot.updated));
    // Source awaits the Account save before relocating Loops. Only that
    // successful Account change survives the later rejected Loop save.
    const expectedRobot = before.accounts.find(account => account._id === state.robot._id);
    expectedRobot.isActive = true;
    expectedRobot.updated = savedRobot.updated;
    assert.deepEqual(JSON.parse(readFileSync(state.file)), before);
    assert.deepEqual(new Store(state.file).loops.get(state.loop._id), state.loop);
    assert.equal(state.store.loops.get(state.loop._id), state.loop);
    assert.equal(outbox.calls, 1);
  } finally { rmSync(state.dir, { recursive: true, force: true }); }
});

test('Invite/Accept/Decline/Remove drafts do not leak failed loop mutations', async () => {
  const cases = [
    {
      name: 'Invite new member',
      run({ store, owner, loop }, outbox) {
        return inviteMember(store, {
          ownerId: owner._id,
          loopId: loop._id,
          email: 'new-member@fixture.test',
          firstName: 'New',
        }, outbox);
      },
    },
    {
      name: 'Invite existing member',
      run({ store, owner, guest, loop }, outbox) {
        return inviteMember(store, {
          ownerId: owner._id,
          loopId: loop._id,
          email: guest.email,
        }, outbox);
      },
    },
    {
      name: 'Accept invitation',
      run({ store, guest, loop }, outbox) {
        return acceptInvitation(store, { loopId: loop._id, accountId: guest._id }, outbox);
      },
    },
    {
      name: 'Decline invitation',
      run({ store, guest, loop }, outbox) {
        return declineInvitation(store, { loopId: loop._id, accountId: guest._id }, outbox);
      },
    },
    {
      name: 'Remove member',
      run({ store, owner, loop }, outbox) {
        return removeMember(store, {
          ownerId: owner._id,
          loopId: loop._id,
          id: 'a04-guest-member',
        }, outbox);
      },
    },
  ];

  for (const item of cases) {
    const state = tempFixture();
    try {
      const outbox = rejectingOutbox();
      await assertRejectedWithoutMutation(
        () => item.run(state, outbox),
        state.store,
        state.file,
        state.loop,
      );
      assert.equal(outbox.calls, 1, `${item.name} attempted exactly one loop save`);
    } finally {
      rmSync(state.dir, { recursive: true, force: true });
    }
  }
});

test('Create keeps a separately committed robot account when its new loop save fails', () => {
  const state = tempFixture();
  try {
    // Remove the fixture robot so Create must commit a new Account first.
    state.store.accounts.delete(state.robot._id);
    state.store.loops.clear();
    state.store.flush();
    const beforeAccounts = snapshot(state.store).accounts;
    const outbox = rejectingOutbox();
    assert.throws(() => createLoopFromApi(state.store, {
      ownerId: state.owner._id,
      name: 'New Robot Loop',
      robotId: 'new-robot-fixture',
    }, outbox), /injected loop persistence failure/);

    const createdRobot = state.store.accountByFriendlyId('new-robot-fixture');
    assert.ok(createdRobot, 'the Account save precedes the independent Loop save');
    assert.equal(state.store.loops.size, 0);
    assert.equal(state.store.notificationOutbox.size, 0);
    assert.equal(state.store.accounts.size, beforeAccounts.length + 1);
    const reloaded = new Store(state.file);
    assert.ok(reloaded.accountByFriendlyId('new-robot-fixture'));
    assert.equal(reloaded.loops.size, 0);
  } finally {
    rmSync(state.dir, { recursive: true, force: true });
  }
});

test('Create preserves earlier successful per-loop saves when a later relocation save fails', () => {
  const state = tempFixture();
  try {
    const secondLoop = clone(state.loop);
    secondLoop._id = 'a04-second-loop';
    secondLoop.name = 'Second Fixture Loop';
    secondLoop.created = 13;
    state.store.loops.set(secondLoop._id, secondLoop);
    state.store.flush();
    const beforeSecond = clone(secondLoop);
    let calls = 0;
    const outbox = {
      record() {
        calls += 1;
        if (calls === 1) state.store.flush();
        else throw new Error('injected second loop failure');
      },
    };

    assert.throws(() => createLoopFromApi(state.store, {
      ownerId: state.owner._id,
      name: 'Replacement Loop',
      robotId: state.robot.friendlyId,
    }, outbox), /injected second loop failure/);
    assert.equal(calls, 2);
    assert.equal(state.store.loops.size, 2, 'the new Loop is not created after relocation fails');
    const first = state.store.loops.get(state.loop._id);
    assert.equal(first.isSuspended, true);
    assert.equal(first.robot, undefined);
    assert.equal(first.members.some((member) => member.accountId === state.robot._id), false);
    assert.deepEqual(state.store.loops.get(secondLoop._id), beforeSecond, 'the failed save is rolled back');

    const reloaded = new Store(state.file);
    assert.equal(reloaded.loops.get(state.loop._id).isSuspended, true, 'the first source save remains committed');
    assert.deepEqual(reloaded.loops.get(secondLoop._id), beforeSecond);
  } finally {
    rmSync(state.dir, { recursive: true, force: true });
  }
});

test('ListMembers is read-only and a real outbox flush failure restores state, outbox, and reload bytes', async () => {
  const state = tempFixture();
  try {
    const before = snapshot(state.store);
    const beforeLoop = state.store.loops.get(state.loop._id);
    const listed = listMembers(state.store, { ownerId: state.owner._id });
    assert.ok(listed.some((member) => member.id === 'a04-owner-member'));
    assert.deepEqual(snapshot(state.store), before);
    assert.strictEqual(state.store.loops.get(state.loop._id), beforeLoop);

    const outbox = new LoopUpdatedOutbox(state.store);
    const diskBefore = readFileSync(state.file);
    const flush = state.store.flush.bind(state.store);
    state.store.flush = () => { throw new Error('injected flush failure'); };
    try {
      await assert.rejects(removeMember(state.store, {
        ownerId: state.owner._id,
        loopId: state.loop._id,
        id: 'a04-guest-member',
      }, outbox), /injected flush failure/);
    } finally {
      state.store.flush = flush;
    }
    assert.deepEqual(snapshot(state.store), before);
    assert.strictEqual(state.store.loops.get(state.loop._id), beforeLoop);
    assert.deepEqual(outbox.pending(), []);
    assert.deepEqual(readFileSync(state.file), diskBefore);
    assert.deepEqual(snapshot(new Store(state.file)), before);
  } finally {
    rmSync(state.dir, { recursive: true, force: true });
  }
});

test('HTTP membership failure returns its error while preserving loop state after reload', async () => {
  const state = tempFixture();
  let server;
  try {
    const service = createAccountService({ store: state.store });
    server = await service.listen(0);
    service.loopUpdatedOutbox.record = () => {
      throw new LoopError({
        code: 'INJECTED_SAVE_FAILURE',
        message: 'injected HTTP save failure',
        statusCode: 500,
      });
    };
    const before = snapshot(state.store);
    const diskBefore = readFileSync(state.file);
    const response = await post(state.store,
      `http://127.0.0.1:${server.address().port}`,
      'Loop_20160324.RemoveLoopMember',
      { loopId: state.loop._id, id: 'a04-guest-member' },
      state.owner.accessKeyId,
    );
    assert.equal(response.status, 500);
    assert.deepEqual(response.body, {
      __type: 'INJECTED_SAVE_FAILURE',
      message: 'injected HTTP save failure',
    });
    assert.deepEqual(snapshot(state.store), before);
    assert.deepEqual(readFileSync(state.file), diskBefore);
    assert.deepEqual(snapshot(new Store(state.file)), before);
  } finally {
    if (server) await close(server);
    rmSync(state.dir, { recursive: true, force: true });
  }
});
