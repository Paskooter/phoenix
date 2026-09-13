import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAccountService, Store } from '../../account/src/index.js';
import { createLoop, createOwnerAccount } from '../../account/src/model.js';
import { createClassicEntrypoint } from '../src/index.js';

const CLOCK = 1700000000000;
const ACCESS_KEY = 'q01-key-with-dashes';

async function closeServer(server) {
  server?.closeAllConnections?.();
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function post(port, target, body, { accountId, accessKeyId = ACCESS_KEY } = {}) {
  const headers = {
    'content-type': 'application/x-amz-json-1.1',
    'x-amz-target': target,
  };
  if (accountId !== undefined) {
    headers['x-amz-credentials'] = JSON.stringify({ id: accountId });
  } else {
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/20260913/us-east-1/gqa/aws4_request, SignedHeaders=host, Signature=fixture`;
  }
  const response = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    body: JSON.parse(await response.text()),
  };
}

test('Classic defaults compose source GQA with Account lookup and no provider/LLM fallback', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'phoenix-q01-gqa-default-'));
  const store = new Store(join(directory, 'account.json'));
  const owner = createOwnerAccount(store, {
    email: 'q01-default-owner@synthetic.invalid',
    password: 'q01-default-owner-password',
  });
  owner.accessKeyId = ACCESS_KEY;
  createLoop(store, { owner, robotId: 'q01-default-robot' });
  store.flush();
  const account = await createAccountService({ store }).listen(0);
  const accountRequests = [];
  account.on('request', (request) => accountRequests.push({ method: request.method, url: request.url }));
  const priorAccount = process.env.NET_account;
  const attributionFile = join(directory, 'gqa-attribution.json');
  process.env.NET_account = `127.0.0.1:${account.address().port}`;
  t.after(async () => {
    if (priorAccount === undefined) delete process.env.NET_account;
    else process.env.NET_account = priorAccount;
    await closeServer(account);
    rmSync(directory, { recursive: true, force: true });
  });

  const classic = createClassicEntrypoint({
    gqa: { attributionFile, clock: () => CLOCK },
  });
  const server = await classic.listen(0);
  t.after(() => closeServer(server));

  assert.equal(typeof classic.gqa.structQaHandler, 'function');
  assert.equal(typeof classic.gqa.accountLookup, 'function');
  assert.equal(classic.gqa.attribution.file, attributionFile);

  const question = await post(server.address().port, 'GQA_20160930.Question', {
    Intent: 'GQA',
    Input: 'what is the default fixture',
    Country: 'usa',
  });
  assert.equal(question.status, 200);
  assert.equal(question.contentType, 'application/json; charset=utf-8');
  assert.deepEqual(question.body, {
    timestamps: { receive_request: CLOCK, return_response: CLOCK },
    input: 'what is the default fixture',
    version: '5.2.15',
    success: false,
  });

  const listed = await post(server.address().port, 'GQA_20160930.ListAttribution', {
    Service: 'Bing',
  });
  assert.deepEqual(listed.body, { data: [] });
  assert.equal(classic.gqa.attribution.file, attributionFile, 'default composition selects its durable file path');
  assert.deepEqual(accountRequests.map(({ method, url }) => ({ method, url: url.split('?')[0] })), [
    { method: 'GET', url: '/api/verify' },
    { method: 'POST', url: '/listAssociatedLoops' },
    { method: 'GET', url: '/api/verify' },
    { method: 'POST', url: '/listAssociatedLoops' },
  ]);
  assert.match(accountRequests[0].url, /accessKeyId=q01-key-with-dashes/);
});

test('Classic default composition persists a provider attribution across restart', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'phoenix-q01-gqa-restart-'));
  const store = new Store(join(directory, 'account.json'));
  const owner = createOwnerAccount(store, {
    email: 'q01-restart-owner@synthetic.invalid',
    password: 'q01-restart-owner-password',
  });
  owner.accessKeyId = ACCESS_KEY;
  createLoop(store, { owner, robotId: 'q01-restart-robot' });
  store.flush();
  const account = await createAccountService({ store }).listen(0);
  const accountRequests = [];
  account.on('request', (request) => accountRequests.push({ method: request.method, url: request.url }));
  const priorAccount = process.env.NET_account;
  process.env.NET_account = `127.0.0.1:${account.address().port}`;
  const attributionFile = join(directory, 'gqa-attribution.json');
  let firstServer;
  let restartedServer;
  t.after(async () => {
    await closeServer(firstServer);
    await closeServer(restartedServer);
    if (priorAccount === undefined) delete process.env.NET_account;
    else process.env.NET_account = priorAccount;
    await closeServer(account);
    rmSync(directory, { recursive: true, force: true });
  });

  const first = createClassicEntrypoint({
    gqa: {
      attributionFile,
      clock: () => CLOCK,
      gqaProvider: async ({ loopId, queryText }) => {
        assert.equal(loopId, [...store.loops.values()][0]._id);
        assert.equal(queryText, 'what is durable fixture');
        return {
          source: 'Bing',
          type: 'Facts',
          url: 'https://fixture.invalid/q01',
          response: { type: 'string', payload: 'The durable answer' },
        };
      },
    },
  });
  firstServer = await first.listen(0);
  const question = await post(firstServer.address().port, 'GQA_20160930.Question', {
    Intent: 'GQA',
    Input: 'what is durable fixture',
    Country: 'usa',
  });
  assert.equal(question.status, 200);
  assert.equal(question.body.response.payload, 'The durable answer.');
  await closeServer(firstServer);
  firstServer = null;

  const restarted = createClassicEntrypoint({
    gqa: { attributionFile, clock: () => CLOCK },
  });
  restartedServer = await restarted.listen(0);
  const listed = await post(restartedServer.address().port, 'GQA_20160930.ListAttribution', {
    Service: 'Bing',
  });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body, {
    data: [{
      service: 'Bing',
      query: 'The durable answer.',
      url: 'https://fixture.invalid/q01',
      image_url: null,
      loop_id: [...store.loops.values()][0]._id,
      timestamp: CLOCK,
    }],
  });
  assert.deepEqual(accountRequests.map(({ method, url }) => ({ method, url: url.split('?')[0] })), [
    { method: 'GET', url: '/api/verify' },
    { method: 'POST', url: '/listAssociatedLoops' },
    { method: 'GET', url: '/api/verify' },
    { method: 'POST', url: '/listAssociatedLoops' },
  ]);
});
