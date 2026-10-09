import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccountService, Store } from '../src/index.js';

// Synthetic ids and peer token only.
test('private loop peer lookup carries the robot and each member account id and status', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-loop-peer-'));
  const previousToken = process.env.ETCO_account_internalPeerToken;
  process.env.ETCO_account_internalPeerToken = 'synthetic-loop-peer-token';
  const store = new Store(join(dir, 'store.json'));
  store.loops.set('synthetic-loop', {
    _id: 'synthetic-loop', owner: 'synthetic-owner', robot: 'synthetic-robot', isSuspended: false,
    members: [
      { accountId: 'synthetic-owner', status: 'accepted', invitationCode: 'synthetic-code' },
      { accountId: 'synthetic-invitee', status: 'invited' },
      { email: 'pending@synthetic.test', status: 'invited' },
    ],
  });
  const server = await createAccountService({ store }).listen(0, '127.0.0.1');
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${base}/loop?loopId=synthetic-loop`)).status, 401);

    const res = await fetch(`${base}/loop?loopId=synthetic-loop`, {
      headers: { 'x-phoenix-internal-token': 'synthetic-loop-peer-token' },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      id: 'synthetic-loop', robot: 'synthetic-robot', owner: 'synthetic-owner', isSuspended: false,
      members: [
        { accountId: 'synthetic-owner', status: 'accepted' },
        { accountId: 'synthetic-invitee', status: 'invited' },
      ],
    });

    const missing = await fetch(`${base}/loop?loopId=synthetic-missing`, {
      headers: { 'x-phoenix-internal-token': 'synthetic-loop-peer-token' },
    });
    assert.equal(missing.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previousToken === undefined) delete process.env.ETCO_account_internalPeerToken;
    else process.env.ETCO_account_internalPeerToken = previousToken;
    rmSync(dir, { recursive: true, force: true });
  }
});
