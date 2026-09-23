import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../src/store.js';

test('reconciles a duplicate QR loop while preserving the original members', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-oobe-loop-'));
  try {
    const file = join(dir, 'store.json');
    const store = new Store(file);
    store.accounts.set('robot-id', { _id: 'robot-id', friendlyId: 'Aero-Root-Okra-Knit' });
    store.loops.set('original', {
      _id: 'original', owner: 'owner', name: "George's Jibo", robot: null, isSuspended: true,
      members: [{ _id: 'owner-member', accountId: 'owner', status: 'ACCEPTED' }],
    });
    store.loops.set('duplicate', {
      _id: 'duplicate', owner: 'owner', name: "George's 2 Jibo", robot: 'robot-id', isSuspended: false,
      members: [
        { _id: 'new-owner-member', accountId: 'owner', status: 'ACCEPTED' },
        { _id: 'robot-member', accountId: 'robot-id', status: 'ACCEPTED' },
      ],
    });
    store.flush();
    const command = [
      'scripts/reconcile-duplicate-oobe-loop.mjs', '--store', file, '--robot', 'Aero-Root-Okra-Knit',
      '--keep-loop', 'original', '--duplicate-loop', 'duplicate',
    ];
    const dry = spawnSync(process.execPath, command, { encoding: 'utf8' });
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(new Store(file).loops.get('original').robot, null);
    const applied = spawnSync(process.execPath, [...command, '--apply'], { encoding: 'utf8' });
    assert.equal(applied.status, 0, applied.stderr);
    const repaired = new Store(file);
    assert.equal(repaired.loops.get('original').robot, 'robot-id');
    assert.equal(repaired.loops.get('original').isSuspended, false);
    assert.deepEqual(repaired.loops.get('original').members.map((member) => member._id), ['owner-member', 'robot-member']);
    assert.equal(repaired.loops.get('duplicate').isDeleted, true);
    assert.equal(repaired.loops.get('duplicate').robot, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
