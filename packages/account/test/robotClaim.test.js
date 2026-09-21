// Signed-in portal claim + physical-robot credential proof for legacy Jibos.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'phx-robot-claim-'));
process.env.ETCO_account_dataFile = join(dir, 'store.json');

const { Store } = await import('../src/store.js');
const { createAccountService } = await import('../src/index.js');

let server; let base; let store;
const jars = new Map();

async function call(method, path, body, jar = 'owner') {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(jars.get(jar) ? { cookie: jars.get(jar) } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) jars.set(jar, setCookie.split(';')[0]);
  return { status: response.status, body: await response.json().catch(() => null) };
}

function robotCredentials(suffix) {
  return {
    accessKeyId: `ABCDEFGHIJKLMNOPQRS${suffix}`,
    secretAccessKey: `${'a'.repeat(39)}${suffix}`,
  };
}

before(async () => {
  store = new Store(process.env.ETCO_account_dataFile);
  server = await createAccountService({ store, repointHost: '203.0.113.7' }).listen(0);
  base = `http://localhost:${server.address().port}`;
  assert.equal((await call('POST', '/api/signup', {
    email: 'new-owner@example.test', password: 'new-owner-password', firstName: 'New',
  }, 'owner')).status, 200);
  assert.equal((await call('POST', '/api/signup', {
    email: 'other-owner@example.test', password: 'other-owner-password', firstName: 'Other',
  }, 'other')).status, 200);
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

test('a portal claim binds an existing robot to its new Phoenix account and is one-time', async () => {
  const issued = await call('POST', '/api/robots/claim-code', {}, 'owner');
  assert.equal(issued.status, 200);
  assert.match(issued.body.code, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(issued.body.repointHost, '203.0.113.7');
  assert.equal(issued.body.adoptionPath, '/api/adopt-robot');
  assert.ok(issued.body.expires > Date.now());
  assert.ok(!JSON.stringify([...store.tokens.values()]).includes(issued.body.code), 'the redeemable code is never stored');

  const credentials = robotCredentials('1');
  const claimed = await call('POST', '/api/adopt-robot', {
    ...credentials, friendlyId: 'legacy-claim-robot', claimCode: issued.body.code,
  }, 'no-session');
  assert.equal(claimed.status, 200);
  assert.equal(claimed.body.linked, true);
  assert.equal(claimed.body.ownerEmail, 'new-owner@example.test');

  const owner = store.accountByEmail('new-owner@example.test');
  const robot = store.accountByAccessKeyId(credentials.accessKeyId);
  const loop = store.loops.get(claimed.body.loopId);
  assert.equal(loop.owner, owner._id);
  assert.equal(loop.robot, robot._id);
  assert.deepEqual(loop.members.map((member) => member.accountId), [owner._id, robot._id]);
  assert.equal((await call('GET', '/api/robots', undefined, 'owner')).body[0].friendlyId, 'legacy-claim-robot');

  const replay = await call('POST', '/api/adopt-robot', {
    ...credentials, friendlyId: 'legacy-claim-robot', claimCode: issued.body.code,
  }, 'no-session');
  assert.equal(replay.status, 403, 'the code cannot be replayed');
});

test('an unclaimed bootstrap can be linked later, while a real existing owner cannot be taken over', async () => {
  const credentials = robotCredentials('2');
  const bootstrap = await call('POST', '/api/adopt-robot', {
    ...credentials, friendlyId: 'previously-repointed-robot',
  }, 'no-session');
  assert.equal(bootstrap.status, 200);
  const robot = store.accountByAccessKeyId(credentials.accessKeyId);
  const bootstrapLoop = store.loops.get(bootstrap.body.loopId);
  assert.equal(bootstrapLoop.owner, robot._id, 'unclaimed migration has no synthetic human owner');

  const code = await call('POST', '/api/robots/claim-code', {}, 'other');
  const linked = await call('POST', '/api/adopt-robot', {
    ...credentials, friendlyId: 'previously-repointed-robot', claimCode: code.body.code,
  }, 'no-session');
  assert.equal(linked.status, 200);
  assert.equal(linked.body.loopId, bootstrap.body.loopId, 'the robot keeps its one loop');
  assert.equal(store.loops.get(bootstrap.body.loopId).owner, store.accountByEmail('other-owner@example.test')._id);

  const attemptedTakeoverCode = await call('POST', '/api/robots/claim-code', {}, 'owner');
  const attemptedTakeover = await call('POST', '/api/adopt-robot', {
    ...credentials, friendlyId: 'previously-repointed-robot', claimCode: attemptedTakeoverCode.body.code,
  }, 'no-session');
  assert.equal(attemptedTakeover.status, 409);
  assert.match(attemptedTakeover.body.error, /already linked/i);
  assert.ok([...store.tokens.values()].some((token) => token.kind === 'robot-claim-v1'),
    'an unsuccessful transfer does not consume the claimant code');

  // The administrator-only route is intentionally the exceptional transfer
  // path. It must require an explicit confirmation flag, rather than claiming
  // success while leaving the old loop owner in place.
  store.accountByEmail('new-owner@example.test').isAdmin = true;
  store.flush();
  const refusedAdminTransfer = await call('POST', '/api/admin/adopt', {
    friendlyId: 'previously-repointed-robot', ownerEmail: 'new-owner@example.test',
  }, 'owner');
  assert.equal(refusedAdminTransfer.status, 409);
  const adminTransfer = await call('POST', '/api/admin/adopt', {
    friendlyId: 'previously-repointed-robot', ownerEmail: 'new-owner@example.test', transferExisting: true,
  }, 'owner');
  assert.equal(adminTransfer.status, 200);
  assert.equal(adminTransfer.body.transferred, true);
  assert.equal(store.loops.get(bootstrap.body.loopId).owner, store.accountByEmail('new-owner@example.test')._id);
});

test('a signed-out caller cannot mint a claim code', async () => {
  assert.equal((await call('POST', '/api/robots/claim-code', {}, 'signed-out')).status, 401);
});
