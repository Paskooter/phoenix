// GQA behind the verified caller boundary: Question and ListAttribution take the caller identity
// from the account the signed access key resolves to, never from a client-supplied
// x-amz-credentials header.
//
// All accounts, keys, secrets and tokens are SYNTHETIC test values.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAccountService, Store } from '../../account/src/index.js';
import { createLoop, createOwnerAccount } from '../../account/src/model.js';
import { createClassicEntrypoint } from '../src/index.js';
import { SYNTHETIC_PEER_TOKEN, setEnv, signedAmz, storeCallerBoundary } from './fixtures/signedClassic.js';

const CLOCK = 1700000000000;

async function closeServer(server) {
  server?.closeAllConnections?.();
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function syntheticOwner(store, name) {
  const owner = createOwnerAccount(store, {
    email: `${name}@synthetic.invalid`,
    password: `${name}-synthetic-password`,
  });
  owner.accessKeyId = `AKSYNTH${name.toUpperCase()}`;
  owner.secretAccessKey = `synthetic-secret-${name}`;
  const { loop } = createLoop(store, { owner, robotId: `${name}-synthetic-robot` });
  return { owner, loop, credentials: { accessKeyId: owner.accessKeyId, secretAccessKey: owner.secretAccessKey } };
}

async function harness(t) {
  const directory = mkdtempSync(join(tmpdir(), 'phoenix-gqa-verified-'));
  const store = new Store(join(directory, 'account.json'));
  const alice = syntheticOwner(store, 'alice');
  const mallory = syntheticOwner(store, 'mallory');
  store.flush();
  const restoreToken = setEnv({ ETCO_account_internalPeerToken: SYNTHETIC_PEER_TOKEN });
  const account = await createAccountService({ store }).listen(0, '127.0.0.1');
  const restoreNet = setEnv({ NET_account: `127.0.0.1:${account.address().port}` });
  const providerLoops = [];
  const classic = createClassicEntrypoint({
    publicUrl: 'https://classic.synthetic.test',
    callerBoundary: storeCallerBoundary(store),
    notificationFile: join(directory, 'notifications.json'),
    gqa: {
      attributionFile: join(directory, 'gqa-attribution.json'),
      clock: () => CLOCK,
      gqaProvider: async ({ loopId, queryText }) => {
        providerLoops.push(loopId);
        return {
          source: 'Bing',
          type: 'Facts',
          url: 'https://fixture.invalid/synthetic',
          response: { type: 'string', payload: `Synthetic answer for ${queryText}` },
        };
      },
    },
  });
  const server = await classic.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await closeServer(server);
    await closeServer(account);
    restoreNet();
    restoreToken();
    rmSync(directory, { recursive: true, force: true });
  });
  const call = (target, body, who, headers = {}) => signedAmz(base, target, body, who.credentials, { headers });
  return { alice, mallory, providerLoops, call };
}

const ask = (input) => ({ Intent: 'GQA', Input: input, Country: 'usa' });

test('a signed ListAttribution naming another account in x-amz-credentials gets only the signer\'s history', async (t) => {
  const { alice, mallory, call } = await harness(t);
  const asked = await call('GQA_20160930.Question', ask('alice synthetic question'), alice);
  assert.equal(asked.status, 200);

  const forged = await call('GQA_20160930.ListAttribution', { Service: 'Bing' }, mallory, {
    'x-amz-credentials': JSON.stringify({ id: alice.owner._id }),
  });
  assert.equal(forged.status, 200);
  assert.deepEqual(forged.body, { data: [] });
  assert.ok(!JSON.stringify(forged.body).includes(alice.loop._id));
});

test('a signed caller still sees its own attribution history', async (t) => {
  const { alice, call } = await harness(t);
  await call('GQA_20160930.Question', ask('alice own history'), alice);
  const listed = await call('GQA_20160930.ListAttribution', { Service: 'Bing' }, alice);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.data.length, 1);
  assert.equal(listed.body.data[0].loop_id, alice.loop._id);
  assert.equal(listed.body.data[0].query, 'Synthetic answer for alice own history.');
});

test('a signed Question attributes to the verified caller even with a forged x-amz-credentials header', async (t) => {
  const { alice, mallory, providerLoops, call } = await harness(t);
  const asked = await call('GQA_20160930.Question', ask('mallory forged question'), mallory, {
    'x-amz-credentials': JSON.stringify({ id: alice.owner._id }),
  });
  assert.equal(asked.status, 200);
  assert.deepEqual(providerLoops, [mallory.loop._id]);

  const aliceHistory = await call('GQA_20160930.ListAttribution', { Service: 'Bing' }, alice);
  assert.deepEqual(aliceHistory.body, { data: [] }, 'nothing was written to the other account\'s loop');
  const malloryHistory = await call('GQA_20160930.ListAttribution', { Service: 'Bing' }, mallory);
  assert.deepEqual(malloryHistory.body.data.map((row) => row.loop_id), [mallory.loop._id]);
});

test('gqaCredentials reads the header only when no caller boundary is configured', async () => {
  const { gqaCredentials } = await import('../src/gqa.js');
  const forged = () => ({ headers: { 'x-amz-credentials': JSON.stringify({ id: 'synthetic-other' }) } });
  assert.deepEqual(gqaCredentials(forged(), { required: true }), { id: 'synthetic-other' });
  assert.throws(() => gqaCredentials(forged(), { required: true, requireVerified: true }), /no verified caller/);
});
