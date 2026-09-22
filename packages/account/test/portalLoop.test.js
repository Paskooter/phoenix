// Portal surface 5: loop record — rename, suspend/unsuspend, invite, remove member, ownership
// transfer, soft-remove. Fixture accounts only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { createAccountService, Store } = await import('../src/index.js');
const { createOwnerAccount, createLoop } = await import('../src/model.js');

const dir = mkdtempSync(join(tmpdir(), 'phx-portal-loop-'));
const store = new Store(join(dir, 'store.json'));
let server; let base;
let owner; let other; let loop;
const jars = new Map();

async function call(method, path, body, jar = 'owner') {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(jars.get(jar) ? { cookie: jars.get(jar) } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) jars.set(jar, setCookie.split(';')[0]);
  return { status: res.status, body: await res.json().catch(() => null) };
}

before(async () => {
  owner = createOwnerAccount(store, { email: 'loop-owner@fixture.test', password: 'loop-pass-1', firstName: 'Loop' });
  other = createOwnerAccount(store, { email: 'loop-other@fixture.test', password: 'loop-pass-2', firstName: 'Other' });
  ({ loop } = createLoop(store, { owner, robotId: 'loop-fixture-robot' }));
  server = await createAccountService({ store }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await call('POST', '/api/login', { email: owner.email, password: 'loop-pass-1' }, 'owner');
  assert.equal(login.status, 200);
  await call('POST', '/api/login', { email: other.email, password: 'loop-pass-2' }, 'other');
});

after(async () => {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

test('rename the loop', async () => {
  const r = await call('PUT', '/api/loop', { loopId: loop._id, name: 'Command Center' });
  assert.equal(r.status, 200);
  assert.equal(r.body.loop.name, 'Command Center');
  assert.equal(store.loops.get(loop._id).name, 'Command Center');
});

test('non-owner cannot rename', async () => {
  const r = await call('PUT', '/api/loop', { loopId: loop._id, name: 'Takeover' }, 'other');
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'CAN_BE_ACCESSED_BY_OWNER');
});

test('suspend then unsuspend', async () => {
  const suspend = await call('POST', '/api/loop/suspend', { loopId: loop._id });
  assert.equal(suspend.status, 200);
  assert.equal(suspend.body.loop.isSuspended, true);
  assert.equal(store.loops.get(loop._id).isSuspended, true);

  const unsuspend = await call('POST', '/api/loop/unsuspend', { loopId: loop._id });
  assert.equal(unsuspend.status, 200);
  assert.equal(unsuspend.body.loop.isSuspended, false);
});

test('invite a brand-new member (no account yet)', async () => {
  const r = await call('POST', '/api/loop/invite', {
    loopId: loop._id, email: 'new-person@fixture.test', firstName: 'New', lastName: 'Person',
  });
  assert.equal(r.status, 200);
  const invited = r.body.loop.members.find((m) => (m.memberProperties || {}).email === 'new-person@fixture.test');
  assert.ok(invited);
  assert.equal(invited.status, 'invited');
});

test('remove a member (owner-only)', async () => {
  const r = await call('GET', '/api/loop');
  const target = r.body.loops[0].members.find((m) => m.accountId === owner._id);
  const removed = await call('POST', '/api/loop/members/remove', { loopId: loop._id, id: target.id });
  assert.equal(removed.status, 200);
  assert.ok(!removed.body.loop.members.some((m) => m.id === target.id));
});

test('ownership transfer to another member', async () => {
  // link the "other" account as a member first, then transfer
  const r = await call('GET', '/api/loop');
  const loopId = r.body.loops[0].id;
  const invite = await call('POST', '/api/loop/invite', { loopId, email: other.email });
  assert.equal(invite.status, 200);
  // A transfer is allowed only to an accepted member. The source invitation
  // flow is explicit; an email match does not silently join an account.
  const accepted = await call('POST', '/api/loop/accept', { loopId }, 'other');
  assert.equal(accepted.status, 200);

  const transfer = await call('POST', '/api/loop/transfer', { loopId, toAccountId: other._id });
  assert.equal(transfer.status, 200);
  assert.equal(transfer.body.loop.owner, other._id);
  assert.equal(store.loops.get(loopId).owner, other._id);
  assert.equal(store.loops.get(loopId).owner, other._id);

  // the new owner is now the only one that can list it as owner
  const asOther = await call('GET', '/api/loop', null, 'other');
  assert.ok(asOther.body.loops.some((l) => l.id === loopId));
});

test('soft remove a loop removes it from the visible list', async () => {
  const fresh = createLoop(store, { owner, robotId: 'loop-removal-robot' });
  const id = fresh.loop._id;
  store.flush();
  const removed = await call('POST', '/api/loop/remove', { loopId: id });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.removed, true);
  assert.equal(store.loops.get(id).isDeleted, true);
  const list = await call('GET', '/api/loop');
  assert.ok(!list.body.loops.some((l) => l.id === id));
});

test('a removed member leaves the default household view', async () => {
  const fresh = createLoop(store, { owner, robotId: 'loop-remove-member-robot' });
  const id = fresh.loop._id;
  const victim = fresh.loop.members[1]; // the robot slot — remove the robot member
  store.flush();
  const removed = await call('POST', '/api/loop/members/remove', { loopId: id, id: victim._id });
  assert.equal(removed.status, 200);
  assert.ok(!removed.body.loop.members.some((m) => m.id === victim._id), 'removed member is gone from the view');
  const stored = store.loops.get(id).members.find((m) => m._id === victim._id);
  assert.equal(String(stored.status).toLowerCase(), 'removed', 'but the status is persisted on the record');
});

test('an invited account accepts or declines its own invitation', async () => {
  const accepted = createLoop(store, { owner, robotId: 'loop-accepted-invitation-robot' }).loop;
  const declined = createLoop(store, { owner, robotId: 'loop-declined-invitation-robot' }).loop;
  store.flush();

  const firstInvite = await call('POST', '/api/loop/invite', { loopId: accepted._id, email: other.email });
  assert.equal(firstInvite.status, 200);
  const pending = await call('GET', '/api/loop', null, 'other');
  assert.ok(pending.body.loops.some((entry) => entry.id === accepted._id
    && entry.members.some((member) => member.accountId === other._id && member.status === 'invited')));

  const joined = await call('POST', '/api/loop/accept', { loopId: accepted._id }, 'other');
  assert.equal(joined.status, 200);
  assert.equal(joined.body.loop.members.find((member) => member.accountId === other._id).status, 'accepted');

  const secondInvite = await call('POST', '/api/loop/invite', { loopId: declined._id, email: other.email });
  assert.equal(secondInvite.status, 200);
  const declinedResult = await call('POST', '/api/loop/decline', { loopId: declined._id }, 'other');
  assert.equal(declinedResult.status, 200);
  assert.equal(declinedResult.body.declined, true);
  const afterDecline = await call('GET', '/api/loop', null, 'other');
  assert.ok(!afterDecline.body.loops.some((entry) => entry.id === declined._id));
});
