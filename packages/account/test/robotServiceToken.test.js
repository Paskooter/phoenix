import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, createAccountService } from '../src/index.js';
import { createOwnerAccount, mintSetupToken, verifyPassword, ACCESS_TOKEN_LIFETIME_MS } from '../src/model.js';
import { signedLoopHeaders } from './fixtures/signedLoopRequest.js';
import { createServiceSetupToken } from '../src/serviceToken.js';

async function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-synthetic-service-token-'));
  const store = new Store(join(dir, 'store.json'));
  const admin = createOwnerAccount(store, { email: 'admin@synthetic.invalid', password: 'synthetic-password' });
  const server = await createAccountService({ store }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (op, body = {}, signed = true) => {
    const target = `OOBE_20161026.${op}`;
    const response = await fetch(base, { method: 'POST',
      headers: signedLoopHeaders(store, base, target, body, signed ? admin.accessKeyId : undefined,
        { connection: 'close', 'x-amz-credentials': JSON.stringify({ id: admin._id, isAdmin: true }) }),
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  try { await run({ store, admin, request }); }
  finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}

test('only a signed administrator can issue fresh service tokens and complete service-mode setup', async () => fixture(async ({ store, admin, request }) => {
  const denied = await request('GetServiceToken');
  assert.equal(denied.status, 401);
  assert.equal(denied.body.__type, 'AUTHORIZED_UNDER_ADMIN');
  assert.equal(store.accounts.size, 1);
  assert.equal(store.tokens.size, 0);
  assert.equal((await request('GetServiceToken', {}, false)).body.__type, 'MISSING_AUTH_HEADER');
  admin.isAdmin = true; store.flush();
  const first = await request('GetServiceToken');
  const second = await request('GetServiceToken');
  assert.equal(first.status, 200); assert.equal(second.status, 200);
  assert.notEqual(first.body.token, second.body.token);
  const token = store.tokens.get(first.body.token);
  const account = store.accounts.get(token.accountId);
  assert.notEqual(account._id, store.tokens.get(second.body.token).accountId);
  assert.match(account.email, /^service-mode-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}@jibo\.com$/);
  assert.equal(account.isActive, true);
  assert.equal(!!account.isAdmin, false);
  assert(verifyPassword(account.email.slice('service-mode-'.length, -'@jibo.com'.length), account.password));
  assert.equal(first.body.expires, token.created + ACCESS_TOKEN_LIFETIME_MS);
  assert.equal(token.loopId, null);
  const setup = await request('SetupRobot', { token: first.body.token, id: 'synthetic-service-mode-robot' }, false);
  assert.equal(setup.status, 200); assert.equal(setup.body.serviceMode, true);
  const reopened = new Store(store.file);
  assert.equal(reopened.tokens.has(token._id), false);
  assert.equal(reopened.accountByFriendlyId('synthetic-service-mode-robot').accessKeyId, setup.body.accessKeyId);
}));

for (const failAt of [1, 2]) test(`service-token save failure ${failAt} preserves only earlier committed state`, async () => fixture(async ({ store, admin, request }) => {
  admin.isAdmin = true; store.flush();
  const flush = store.flush.bind(store);
  let calls = 0;
  store.flush = () => { if (++calls === failAt) throw new Error('synthetic persistence failure'); return flush(); };
  const response = await request('GetServiceToken');
  store.flush = flush;
  assert.equal(response.status, 500);
  assert.equal(store.accounts.size, failAt === 1 ? 1 : 2);
  assert.equal(store.tokens.size, 0);
  const reopened = new Store(store.file);
  assert.deepEqual([...reopened.accounts], [...store.accounts]);
  assert.deepEqual([...reopened.tokens], [...store.tokens]);
}));

test('failed token refresh preserves timestamp and source reuse excludes the exact expiry boundary', async () => fixture(async ({ store, admin }) => {
  const now = Date.now;
  let clock = now(); Date.now = () => clock;
  const flush = store.flush.bind(store);
  try {
    const token = mintSetupToken(store, admin._id);
    clock += 1;
    store.flush = () => { throw new Error('synthetic refresh failure'); };
    assert.throws(() => mintSetupToken(store, admin._id), /synthetic refresh failure/);
    assert.deepEqual(store.tokens.get(token._id), token);
    assert.deepEqual(new Store(store.file).tokens.get(token._id), token);
    store.flush = flush;
    clock = token.created + ACCESS_TOKEN_LIFETIME_MS;
    const replacement = mintSetupToken(store, admin._id);
    assert.notEqual(replacement._id, token._id);
  } finally { Date.now = now; store.flush = flush; }
}));

test('service account creation binds only the first matching invitation without Loop save hooks', async () => fixture(async ({ store, admin }) => {
  const uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const email = `service-mode-${uuid}@jibo.com`;
  for (const id of ['synthetic-first-loop', 'synthetic-second-loop']) {
    store.loops.set(id, { _id: id, owner: admin._id, updated: 100,
      members: [{ _id: `${id}-member`, status: 'invited', memberProperties: { email } }] });
  }
  store.flush();
  const token = createServiceSetupToken(store, { uuid: () => uuid });
  const reopened = new Store(store.file);
  assert.equal(reopened.loops.get('synthetic-first-loop').members[0].accountId, token.accountId);
  assert.equal(reopened.loops.get('synthetic-second-loop').members[0].accountId, undefined);
  assert.equal(reopened.loops.get('synthetic-first-loop').updated, 100);
  assert.equal(reopened.notificationOutbox.size, 0);
}));
