import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { findOrCreateRobotAccount } from '../src/model.js';

// Exact LoopController.findOrCreateRobotAccount reactivates and saves existing
// accounts too. Identity and keys survive; a failed save cannot change storage.
for (const initiallyActive of [false, true]) {
  test(`existing robot account is saved and active (initially ${initiallyActive})`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'phoenix-reactivation-'));
    try {
      const file = join(dir, 'account.json');
      const store = new Store(file);
      const robot = findOrCreateRobotAccount(store, 'synthetic-reactivation-robot');
      robot.isActive = initiallyActive;
      robot.updated = 1;
      store.flush();
      let saves = 0;
      const flush = store.flush.bind(store);
      store.flush = () => { saves++; flush(); };
      const result = findOrCreateRobotAccount(store, robot.friendlyId);
      assert.equal(saves, 1);
      assert.equal(result.isActive, true);
      assert(result.updated > 1);
      for (const key of ['_id', 'friendlyId', 'accessKeyId', 'secretAccessKey', 'created']) {
        assert.equal(result[key], robot[key], key);
      }
      assert.equal(new Store(file).accounts.get(robot._id).isActive, true);
      assert.equal(store.accounts.size, 1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('failed existing robot save preserves inactive memory and durable account', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-reactivation-failure-'));
  try {
    const file = join(dir, 'account.json');
    const store = new Store(file);
    const robot = findOrCreateRobotAccount(store, 'synthetic-reactivation-failure');
    robot.isActive = false;
    store.flush();
    const before = readFileSync(file);
    store.flush = () => { throw new Error('synthetic-save-failure'); };
    assert.throws(() => findOrCreateRobotAccount(store, robot.friendlyId), /synthetic-save-failure/);
    assert.equal(store.accounts.get(robot._id), robot);
    assert.equal(robot.isActive, false);
    assert.deepEqual(readFileSync(file), before);
    assert.equal(new Store(file).accounts.get(robot._id).isActive, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('failed new robot save does not leave an uncommitted account', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-new-robot-failure-'));
  try {
    const file = join(dir, 'account.json');
    const store = new Store(file);
    store.flush();
    const before = readFileSync(file);
    store.flush = () => { throw new Error('synthetic-save-failure'); };
    assert.throws(() => findOrCreateRobotAccount(store, 'synthetic-new-failure'), /synthetic-save-failure/);
    assert.equal(store.accounts.size, 0);
    assert.deepEqual(readFileSync(file), before);
    assert.equal(new Store(file).accounts.size, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
