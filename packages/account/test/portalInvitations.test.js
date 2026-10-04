// Synthetic accounts only. Exercise the console invitation lifecycle and its
// mailbox boundary through the actual HTTP API and persisted Account store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAccountService, Store } from '../src/index.js';
import { createOwnerAccount, createLoop } from '../src/model.js';
import { markEmailVerified } from '../src/emailVerification.js';
import { linkVerifiedInvitations } from '../src/portal/loops.js';

async function fixture(run, { verificationRequired = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'phx-console-invitations-'));
  const store = new Store(join(dir, 'account.json'));
  const sent = [];
  const provider = { send(to, options) { sent.push({ to, ...options }); return Promise.resolve(); } };
  const service = createAccountService({ store, requireEmailVerification: verificationRequired,
    identityProviders: { emailVerification: provider, portalUrl: 'https://portal.fixture.test' },
    invitationProviders: { invitation: provider, invitationExistingUser: provider, portalUrl: 'https://portal.fixture.test/' },
  });
  const server = await service.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(path, body, cookie = '', method = 'POST') {
    const response = await fetch(`${base}${path}`, { method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const owner = createOwnerAccount(store, { email: 'inviter@fixture.test', password: 'ValidPass1', firstName: 'Fixture' });
  const { loop } = createLoop(store, { owner, robotId: 'Fixture-Invitation-Robot' });
  const ownerSession = await call('/api/login', { email: owner.email, password: 'ValidPass1' });
  async function invite(email, loopId = loop._id) {
    const result = await call('/api/loop/invite', { loopId, email, firstName: 'Invited' }, ownerSession.cookie);
    assert.equal(result.status, 200);
    return store.loops.get(loopId).members.find((m) => m.memberProperties?.email === email);
  }
  try { await run({ store, base, call, invite, owner, loop, sent, dir, service }); }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); rmSync(dir, { recursive: true, force: true }); }
}

test('new console recipient verifies, signs in, reviews and explicitly accepts an invitation', async () => {
  await fixture(async ({ store, base, call, invite, loop, sent }) => {
    await invite('new-recipient@fixture.test');
    const invitation = sent.at(-1);
    const link = new URL(invitation.url);
    assert.equal(link.pathname, '/invite');
    assert.equal(link.searchParams.get('loopId'), loop._id);
    assert.equal(link.searchParams.has('code'), false);
    for (const path of ['/invite', '/create', '/home']) {
      const response = await fetch(`${base}${path}?email=new-recipient%40fixture.test`);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /id="auth-root"/);
    }
    assert.equal((await call('/api/loop/invitations/claim', {})).status, 401);
    const signup = await call('/api/signup', { email: 'new-recipient@fixture.test', password: 'ValidPass1', firstName: 'New' });
    assert.equal(signup.status, 202);
    assert.equal((await call('/api/login', { email: 'new-recipient@fixture.test', password: 'ValidPass1' })).status, 401);
    const token = new URLSearchParams(new URL(sent.at(-1).url).hash.slice(1)).get('token');
    assert.equal((await call('/api/email-verification/confirm', { token })).status, 200);
    const login = await call('/api/login', { email: 'new-recipient@fixture.test', password: 'ValidPass1' });
    assert.equal(login.status, 200);
    const listed = await call('/api/loop', null, login.cookie, 'GET');
    assert.equal(listed.body.loops.length, 1);
    const member = listed.body.loops[0].members.find((m) => m.accountId === login.body.account.id);
    assert.equal(member.status, 'invited');
    assert.equal((await call('/api/loop/accept', { loopId: loop._id }, login.cookie)).status, 200);
    const reloaded = new Store(store.file);
    assert.equal(reloaded.loops.get(loop._id).members.find((m) => m.accountId === login.body.account.id).status, 'accepted');
    assert.equal((await call('/api/loop/invitations/claim', {}, login.cookie)).body.linked, 0, 'claim is idempotent');
  });
});

test('unverified email and a different verified mailbox cannot claim an invitation', async () => {
  await fixture(async ({ store, call, invite, loop, sent }) => {
    await invite('recipient@fixture.test');
    const unverified = createOwnerAccount(store, { email: 'recipient@fixture.test', password: 'ValidPass1' });
    const session = await call('/api/login', { email: unverified.email, password: 'ValidPass1' });
    assert.equal((await call('/api/loop/invitations/claim', {}, session.cookie)).body.linked, 0);
    assert.equal((await call('/api/loop', null, session.cookie, 'GET')).body.loops.length, 0);
    const wrong = createOwnerAccount(store, { email: 'different@fixture.test', password: 'ValidPass1' });
    markEmailVerified(wrong); store.flush();
    const wrongSession = await call('/api/login', { email: wrong.email, password: 'ValidPass1' });
    assert.equal((await call('/api/loop/invitations/claim', { code: store.loops.get(loop._id).members.at(-1).invitationCode }, wrongSession.cookie)).body.linked, 0);
    assert.equal((await call('/api/loop', null, wrongSession.cookie, 'GET')).body.loops.length, 0);
    const requested = await call('/api/me/email-verification/resend', {}, session.cookie);
    assert.equal(requested.status, 200);
    const token = new URLSearchParams(new URL(sent.at(-1).url).hash.slice(1)).get('token');
    assert.equal((await call('/api/email-verification/confirm', { token })).status, 200);
    assert.equal((await call('/api/loop/invitations/claim', {}, session.cookie)).body.linked, 1);
  });
});

test('links every live invitation after verification and leaves cancelled or suspended loops alone', async () => {
  await fixture(async ({ store, call, invite, owner, loop }) => {
    const email = 'multiple@fixture.test';
    await invite(email);
    const { loop: second } = createLoop(store, { owner, robotId: 'Fixture-Second-Robot' });
    const { loop: suspended } = createLoop(store, { owner, robotId: 'Fixture-Suspended-Robot' });
    const { loop: cancelled } = createLoop(store, { owner, robotId: 'Fixture-Cancelled-Robot' });
    await invite(email, second._id); await invite(email, suspended._id); await invite(email, cancelled._id);
    store.loops.get(suspended._id).isSuspended = true;
    store.loops.get(cancelled._id).members.at(-1).status = 'removed';
    const account = createOwnerAccount(store, { email, password: 'ValidPass1' });
    markEmailVerified(account); store.flush();
    const session = await call('/api/login', { email, password: 'ValidPass1' });
    assert.equal(session.status, 200);
    for (const id of [loop._id, second._id]) {
      const member = store.loops.get(id).members.at(-1);
      assert.equal(member.accountId, account._id);
      assert.equal(member.status, 'invited');
    }
    for (const id of [suspended._id, cancelled._id]) assert.ok(!store.loops.get(id).members.at(-1).accountId);
    assert.equal((await call('/api/loop', null, session.cookie, 'GET')).body.loops.length, 2);
  });
});

test('claim rollback preserves the original membership when persistence fails', async () => {
  await fixture(async ({ store, invite, loop }) => {
    await invite('rollback@fixture.test');
    const account = createOwnerAccount(store, { email: 'rollback@fixture.test', password: 'ValidPass1' });
    markEmailVerified(account); store.flush();
    const before = structuredClone(store.loops.get(loop._id));
    assert.throws(() => linkVerifiedInvitations(store, account, { record() { throw new Error('fixture disk failure'); } }), /fixture disk failure/);
    assert.deepEqual(store.loops.get(loop._id), before);
    assert.deepEqual(new Store(store.file).loops.get(loop._id), before);
  });
});
