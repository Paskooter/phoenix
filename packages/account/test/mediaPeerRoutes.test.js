import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccountService, Store } from '../src/index.js';
import { createLoop, createOwnerAccount } from '../src/model.js';

test('owned-loop peer lookup is private and returns only live loops owned by its requested account', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-media-peer-'));
  const previousToken = process.env.ETCO_account_internalPeerToken;
  process.env.ETCO_account_internalPeerToken = 'fixture-peer-token';
  const store = new Store(join(dir, 'store.json'));
  const owner = createOwnerAccount(store, { email: 'media-peer-owner@fixture.test', password: 'fixture-password' });
  const { loop } = createLoop(store, { owner, robotId: 'media-peer-robot' });
  const removed = { ...loop, _id: 'removed-loop', isDeleted: true };
  store.loops.set(removed._id, removed);
  const server = await createAccountService({ store }).listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const denied = await fetch(`${base}/ownedLoops?accountId=${encodeURIComponent(owner._id)}`);
    assert.equal(denied.status, 401);

    const allowed = await fetch(`${base}/ownedLoops?accountId=${encodeURIComponent(owner._id)}`, {
      headers: { 'x-phoenix-internal-token': 'fixture-peer-token' },
    });
    assert.equal(allowed.status, 200);
    assert.deepEqual((await allowed.json()).loops, [loop._id]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previousToken === undefined) delete process.env.ETCO_account_internalPeerToken;
    else process.env.ETCO_account_internalPeerToken = previousToken;
    rmSync(dir, { recursive: true, force: true });
  }
});
