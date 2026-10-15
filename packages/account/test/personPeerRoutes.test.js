import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccountService, Store } from '../src/index.js';
import { createLoop, createOwnerAccount } from '../src/model.js';

const TOKEN = 'synthetic-person-peer-token';

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-person-peer-'));
  const prior = process.env.ETCO_account_internalPeerToken;
  process.env.ETCO_account_internalPeerToken = TOKEN;
  const store = new Store(join(dir, 'account.json'));
  const owner = createOwnerAccount(store, { email: 'person-owner@fixture.invalid', password: 'fixture-password' });
  const { loop, robot } = createLoop(store, { owner, robotId: 'person-peer-robot' });
  loop.members.push({ accountId: 'accepted-member', status: 'accepted' });
  for (const status of ['invited', 'declined', 'removed']) loop.members.push({ accountId: `${status}-member`, status });
  store.flush();
  const server = await createAccountService({ store }).listen(0, '127.0.0.1');
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    if (prior === undefined) delete process.env.ETCO_account_internalPeerToken;
    else process.env.ETCO_account_internalPeerToken = prior;
    rmSync(dir, { recursive: true, force: true });
  });
  const get = async (route, accountId = owner._id, loopId = loop._id, token = TOKEN) => {
    const query = new URLSearchParams({ accountId, loopId });
    const response = await fetch(`http://127.0.0.1:${server.address().port}/${route}?${query}`, {
      headers: token ? { 'x-phoenix-internal-token': token } : {},
    });
    return { status: response.status, body: await response.json() };
  };
  return { store, owner, loop, robot, get };
}

for (const route of ['isLoopMember', 'isAccountOwnerOrRobot']) {
  test(`Account ${route} requires the configured internal peer token`, async (t) => {
    const f = await fixture(t);
    for (const token of [null, 'wrong-fixture-token']) assert.equal((await f.get(route, f.owner._id, f.loop._id, token)).status, 401);
    delete process.env.ETCO_account_internalPeerToken;
    assert.equal((await f.get(route)).status, 503);
  });

  test(`Account ${route} checks live household roles`, async (t) => {
    const f = await fixture(t);
    for (const id of [f.owner._id, f.robot._id]) assert.deepEqual(await f.get(route, id), { status: 200, body: { result: true } });
    assert.deepEqual(await f.get(route, 'accepted-member'), { status: 200, body: { result: route === 'isLoopMember' } });
    for (const id of ['invited-member', 'declined-member', 'removed-member', 'unrelated-account', '']) {
      assert.deepEqual(await f.get(route, id), { status: 200, body: { result: false } });
    }
    f.loop.isDeleted = true;
    for (const id of [f.owner._id, f.robot._id, 'accepted-member']) {
      assert.deepEqual(await f.get(route, id), { status: 200, body: { result: false } });
    }
    assert.deepEqual(await f.get(route, f.owner._id, 'missing-loop'), { status: 200, body: { result: false } });
  });
}
