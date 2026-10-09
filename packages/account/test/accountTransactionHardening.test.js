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
