import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAccountService, Store } from '../src/index.js';
import { createOwnerAccount, createLoop, newId } from '../src/model.js';
import { createPhoenixGqaAccountLookup } from '../../skills/src/index.js';

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

async function post(base, body) {
  const response = await fetch(`${base}/listAssociatedLoops`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: JSON.parse(await response.text()) };
}

async function postRaw(base, rawBody) {
  const response = await fetch(`${base}/listAssociatedLoops`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: rawBody,
  });
  const raw = await response.text();
  return { status: response.status, body: JSON.parse(raw), rawBody: raw };
}

test('listAssociatedLoops preserves accepted, deleted, suspended, and unknown semantics', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-q01-account-loop-'));
  const store = new Store(join(dir, 'account.json'));
  const owner = createOwnerAccount(store, {
    email: 'q01-loop-owner@synthetic.invalid',
    password: 'q01-loop-owner-password',
  });
  const invited = createOwnerAccount(store, {
    email: 'q01-loop-invited@synthetic.invalid',
    password: 'q01-loop-invited-password',
  });
  const removed = createOwnerAccount(store, {
    email: 'q01-loop-removed@synthetic.invalid',
    password: 'q01-loop-removed-password',
  });
  const suspended = createOwnerAccount(store, {
    email: 'q01-loop-suspended@synthetic.invalid',
    password: 'q01-loop-suspended-password',
  });

  const accepted = createLoop(store, { owner, robotId: 'q01-loop-accepted-robot' }).loop;
  accepted.members.push({ _id: newId(), accountId: invited._id, status: 'invited' });
  accepted.members.push({ _id: newId(), accountId: removed._id, status: 'removed' });

  const suspendedLoop = createLoop(store, { owner, robotId: 'q01-loop-suspended-robot' }).loop;
  suspendedLoop.members.push({ _id: newId(), accountId: suspended._id, status: 'accepted' });
  suspendedLoop.isSuspended = true;

  const deletedLoop = createLoop(store, { owner, robotId: 'q01-loop-deleted-robot' }).loop;
  deletedLoop.members.push({ _id: newId(), accountId: suspended._id, status: 'accepted' });
  deletedLoop.isDeleted = true;
  store.flush();

  const service = await createAccountService({ store }).listen(0);
  const base = `http://127.0.0.1:${service.address().port}`;
  try {
    const result = await post(base, {
      accountsIds: [owner._id, invited._id, removed._id, suspended._id, 'unknown-account'],
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, {
      [owner._id]: [accepted._id],
      [invited._id]: [],
      [removed._id]: [],
      [suspended._id]: [],
      'unknown-account': [],
    });

    // The internal endpoint is also source-shaped for direct robot/access-key
    // callers; the route itself receives Account IDs, while the reusable
    // resolver below performs the access-key verification step.
    const robot = [...store.accounts.values()].find((account) => account.friendlyId === 'q01-loop-accepted-robot');
    const robotResult = await post(base, { accountsIds: [robot._id] });
    assert.deepEqual(robotResult.body, { [robot._id]: [accepted._id] });

    const lookup = createPhoenixGqaAccountLookup({ baseUrl: base });
    assert.equal(await lookup(owner._id), accepted._id, 'Account _id goes directly to the peer POST');
    assert.equal(
      await lookup({ accessKeyId: owner.accessKeyId }),
      accepted._id,
      'Classic direct accessKeyId is verified before the peer POST',
    );
  } finally {
    await closeServer(service);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listAssociatedLoops uses source Joi boundaries without mutating state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-q01-account-loop-validation-'));
  const store = new Store(join(dir, 'account.json'));
  const owner = createOwnerAccount(store, {
    email: 'q01-loop-validation-owner@synthetic.invalid',
    password: 'q01-loop-validation-owner-password',
  });
  const { loop } = createLoop(store, { owner, robotId: 'q01-loop-validation-robot' });
  const service = await createAccountService({ store }).listen(0);
  const base = `http://127.0.0.1:${service.address().port}`;
  const before = readFileSync(store.file, 'utf8');
  try {
    for (const body of [null, [], ['account-id'], 'account-id', 7, false]) {
      const result = await post(base, body);
      assert.equal(result.status, 422, JSON.stringify(body));
      assert.equal(result.body.statusCode, 422);
      assert.equal(result.body.message, '"value" must be an object', JSON.stringify(body));
    }

    const missing = await post(base, {});
    assert.equal(missing.status, 422);
    assert.equal(missing.body.message, 'child "accountsIds" fails because ["accountsIds" is required]');

    for (const accountsIds of [null, 'account-id', 7, {}]) {
      const result = await post(base, { accountsIds });
      assert.equal(result.status, 422, JSON.stringify(accountsIds));
      assert.equal(result.body.message, 'child "accountsIds" fails because ["accountsIds" must be an array]');
    }

    const valid = await post(base, { accountsIds: [owner._id] });
    assert.equal(valid.status, 200);
    assert.deepEqual(valid.body, { [owner._id]: [loop._id] });
    assert.equal(readFileSync(store.file, 'utf8'), before);
  } finally {
    await closeServer(service);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listAssociatedLoops keeps malformed JSON at the transport 400 boundary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-q01-account-loop-malformed-'));
  const store = new Store(join(dir, 'account.json'));
  const owner = createOwnerAccount(store, {
    email: 'q01-loop-malformed-owner@synthetic.invalid',
    password: 'q01-loop-malformed-owner-password',
  });
  createLoop(store, { owner, robotId: 'q01-loop-malformed-robot' });
  const service = await createAccountService({ store }).listen(0);
  const base = `http://127.0.0.1:${service.address().port}`;
  try {
    const result = await postRaw(base, '{');
    assert.equal(result.status, 400);
    assert.deepEqual(result.body.data, { message: 'Unexpected end of JSON input' });
  } finally {
    await closeServer(service);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Phoenix GQA resolver sends Account IDs directly and verifies direct access keys only when needed', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), method: options?.method || 'GET', body: options?.body });
    if (String(url).startsWith('http://account.test/api/verify')) {
      return { json: async () => ({ valid: true, id: 'account-from-key' }) };
    }
    return { json: async () => ({ 'account-from-id': ['loop-direct'], 'account-from-key': ['loop-verified'] }) };
  };
  const lookup = createPhoenixGqaAccountLookup({
    baseUrl: 'http://account.test',
    fetchImpl,
  });

  assert.equal(await lookup('account-from-id'), 'loop-direct');
  assert.deepEqual(calls, [{
    url: 'http://account.test/listAssociatedLoops',
    method: 'POST',
    body: '{"accountsIds": ["account-from-id"]}',
  }]);

  assert.equal(await lookup({ accessKeyId: 'direct-access-key' }), 'loop-verified');
  assert.deepEqual(calls.slice(1), [
    {
      url: 'http://account.test/api/verify?accessKeyId=direct-access-key',
      method: 'GET',
      body: undefined,
    },
    {
      url: 'http://account.test/listAssociatedLoops',
      method: 'POST',
      body: '{"accountsIds": ["account-from-key"]}',
    },
  ]);
});

test('Phoenix GQA resolver falls back to the raw access-key candidate after verify failure', async () => {
  const calls = [];
  const lookup = createPhoenixGqaAccountLookup({
    endpoint: 'http://account.test/listAssociatedLoops',
    verifyEndpoint: 'http://account.test/api/verify',
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), method: options?.method || 'GET', body: options?.body });
      if (options?.method === 'GET') return { json: async () => ({ valid: false }) };
      return { json: async () => ({ 'raw-access-key': ['loop-fallback'] }) };
    },
  });

  assert.equal(await lookup({ accessKeyId: 'raw-access-key' }), 'loop-fallback');
  assert.deepEqual(calls.map((call) => call.method), ['GET', 'POST']);
  assert.equal(calls[1].body, '{"accountsIds": ["raw-access-key"]}');
});

test('StructQA identity context verifies a nonstandard direct SigV4 access key', async () => {
  const calls = [];
  const lookup = createPhoenixGqaAccountLookup({
    baseUrl: 'http://account.test',
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), method: options?.method || 'GET', body: options?.body });
      if (options?.method === 'GET') return { json: async () => ({ valid: true, id: 'account-from-key' }) };
      return { json: async () => ({ 'account-from-key': ['loop-verified'] }) };
    },
  });

  assert.equal(await lookup('short-key', {
    credentials: { id: 'short-key', accessKeyId: 'short-key' },
  }), 'loop-verified');
  assert.deepEqual(calls, [
    {
      url: 'http://account.test/api/verify?accessKeyId=short-key',
      method: 'GET',
      body: undefined,
    },
    {
      url: 'http://account.test/listAssociatedLoops',
      method: 'POST',
      body: '{"accountsIds": ["account-from-key"]}',
    },
  ]);
});
