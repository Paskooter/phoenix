// Adoption of a robot that already holds credentials.
//
// The cases that matter are the ones a repoint script actually hits: a robot the
// server has never seen, a robot whose record came across in a store migration
// without its keys, a script re-run against a robot that is already adopted, and
// the two refusals that stop this endpoint being a way to claim someone else's
// robot.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/store.js';
import { adoptRobot } from '../src/robotAdoption.js';
import { createOwnerAccount } from '../src/model.js';

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'phx-adopt-'));
  const store = new Store(join(dir, 'store.json'));
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a robot the server has never seen is adopted with an account and a loop', () => {
  const { store, cleanup } = freshStore();
  try {
    const { status, payload } = adoptRobot(store, {
      accessKeyId: 'AKIAEXAMPLE0001',
      secretAccessKey: 'secret-one',
      friendlyId: 'Aero-Root-Okra-Knit',
    });

    assert.equal(status, 200);
    assert.equal(payload.adopted, true);
    assert.equal(payload.alreadyAdopted, false);
    assert.equal(payload.friendlyId, 'Aero-Root-Okra-Knit');
    assert.deepEqual(payload.created, { account: true, loop: true });

    // The robot must be findable by the key it signs its requests with,
    // otherwise it authenticates against nothing.
    const robot = store.accountByAccessKeyId('AKIAEXAMPLE0001');
    assert.ok(robot, 'the robot resolves by accessKeyId');
    assert.equal(robot._id, payload.robotId);
    assert.equal(robot.secretAccessKey, 'secret-one');

    // And it needs a loop: ListLoops is one of the first calls a robot makes.
    const loop = store.loops.get(payload.loopId);
    assert.ok(loop, 'a loop was created');
    assert.equal(loop.robot, payload.robotId);
  } finally {
    cleanup();
  }
});

test('re-running against an adopted robot is a no-op that reports the existing ids', () => {
  const { store, cleanup } = freshStore();
  try {
    const first = adoptRobot(store, {
      accessKeyId: 'AKIAEXAMPLE0002',
      secretAccessKey: 'secret-two',
      friendlyId: 'Some-Robot',
    });
    const accountsAfterFirst = store.accounts.size;
    const loopsAfterFirst = store.loops.size;

    const second = adoptRobot(store, {
      accessKeyId: 'AKIAEXAMPLE0002',
      secretAccessKey: 'secret-two',
      friendlyId: 'Some-Robot',
    });

    assert.equal(second.status, 200);
    assert.equal(second.payload.adopted, true);
    assert.equal(second.payload.alreadyAdopted, true);
    assert.equal(second.payload.robotId, first.payload.robotId);
    assert.equal(second.payload.loopId, first.payload.loopId);
    // A re-run must not fork the household.
    assert.equal(store.accounts.size, accountsAfterFirst);
    assert.equal(store.loops.size, loopsAfterFirst);
  } finally {
    cleanup();
  }
});

test('a migrated robot record without credentials has them bound, keeping its loop', () => {
  const { store, cleanup } = freshStore();
  try {
    // A store restored from a backup that carried the household but not the keys.
    store.accounts.set('robot-1', {
      _id: 'robot-1', id: 'robot-1', friendlyId: 'Migrated-Robot', isActive: true,
    });
    store.loops.set('loop-1', {
      _id: 'loop-1', name: 'Existing household', owner: 'owner-1', robot: 'robot-1',
      members: [{ _id: 'm1', accountId: 'owner-1', status: 'ACCEPTED' }],
    });
    store.flush();

    const { status, payload } = adoptRobot(store, {
      accessKeyId: 'AKIAEXAMPLE0003',
      secretAccessKey: 'secret-three',
      friendlyId: 'Migrated-Robot',
    });

    assert.equal(status, 200);
    assert.equal(payload.robotId, 'robot-1', 'binds to the existing record');
    assert.equal(payload.loopId, 'loop-1', 'the existing household is preserved');
    assert.equal(payload.created.credentialsBound, true);
    assert.equal(store.accounts.size, 1, 'no duplicate robot account');

    // The members must survive: losing them is losing the household.
    assert.equal(store.loops.get('loop-1').members.length, 1);
    assert.equal(store.accountByAccessKeyId('AKIAEXAMPLE0003')._id, 'robot-1');
  } finally {
    cleanup();
  }
});

test('a key already registered to a different secret is refused', () => {
  const { store, cleanup } = freshStore();
  try {
    adoptRobot(store, { accessKeyId: 'AKIASHARED', secretAccessKey: 'the-real-secret' });
    const { status, payload } = adoptRobot(store, {
      accessKeyId: 'AKIASHARED',
      secretAccessKey: 'a-guess',
    });

    assert.equal(status, 403);
    assert.match(payload.error, /different secret/);
    // The stored secret must be untouched — overwriting it would lock the real
    // robot out of its own account.
    assert.equal(store.accountByAccessKeyId('AKIASHARED').secretAccessKey, 'the-real-secret');
  } finally {
    cleanup();
  }
});

test('a friendlyId already bound to other credentials is refused', () => {
  const { store, cleanup } = freshStore();
  try {
    adoptRobot(store, {
      accessKeyId: 'AKIAFIRST', secretAccessKey: 's1', friendlyId: 'Contested-Name',
    });
    const { status, payload } = adoptRobot(store, {
      accessKeyId: 'AKIASECOND', secretAccessKey: 's2', friendlyId: 'Contested-Name',
    });

    assert.equal(status, 409);
    assert.match(payload.error, /already bound/);
    assert.equal(store.accountByAccessKeyId('AKIAFIRST').secretAccessKey, 's1');
    assert.equal(store.accountByAccessKeyId('AKIASECOND'), null);
  } finally {
    cleanup();
  }
});

test('a public friendlyId cannot bind credentials onto a robot in another Phoenix household', () => {
  const { store, cleanup } = freshStore();
  try {
    const owner = createOwnerAccount(store, {
      email: 'real-owner@example.test', password: 'real-owner-password', firstName: 'Real',
    });
    store.accounts.set('foreign-robot', {
      _id: 'foreign-robot', friendlyId: 'Protected-Robot', isActive: true,
    });
    store.loops.set('foreign-loop', {
      _id: 'foreign-loop', name: 'Real household', owner: owner._id, robot: 'foreign-robot', members: [],
    });
    store.flush();

    const result = adoptRobot(store, {
      accessKeyId: 'ABCDEFGHIJKLMNOPQRST', secretAccessKey: 'a'.repeat(40), friendlyId: 'Protected-Robot',
    });
    assert.equal(result.status, 409);
    assert.match(result.payload.error, /already linked/i);
    assert.equal(store.accounts.get('foreign-robot').accessKeyId, undefined);
  } finally {
    cleanup();
  }
});

test('missing credentials are rejected rather than creating a keyless robot', () => {
  const { store, cleanup } = freshStore();
  try {
    for (const body of [{}, { accessKeyId: 'only-key' }, { secretAccessKey: 'only-secret' }, { accessKeyId: '  ', secretAccessKey: ' ' }]) {
      const { status } = adoptRobot(store, body);
      assert.equal(status, 400, `rejected: ${JSON.stringify(body)}`);
    }
    assert.equal(store.accounts.size, 0, 'nothing was created');
  } finally {
    cleanup();
  }
});

test('adoption survives a reload, so a restart does not lose the robot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-adopt-'));
  const file = join(dir, 'store.json');
  try {
    const { payload } = adoptRobot(new Store(file), {
      accessKeyId: 'AKIAPERSIST', secretAccessKey: 'persisted', friendlyId: 'Persisted-Robot',
    });
    // A brand-new Store over the same file: what the service does on restart.
    const reloaded = new Store(file);
    const robot = reloaded.accountByAccessKeyId('AKIAPERSIST');
    assert.ok(robot, 'the adopted robot is still there after a reload');
    assert.equal(robot._id, payload.robotId);
    assert.ok(reloaded.loops.get(payload.loopId), 'and so is its loop');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
