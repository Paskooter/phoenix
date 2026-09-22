// Portal surface 1: loop members — list, edit nickname/phonetic/status, recognition status, and the
// account LINK/UNLINK that fixes the report-skill's "Missing creds for Settings request" bug
// (members without an accountId). All fixture accounts/secrets are invented.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { createAccountService, Store } = await import('../src/index.js');
const { createOwnerAccount, createLoop, newId, ensureLoopMemberIds } = await import('../src/model.js');

const dir = mkdtempSync(join(tmpdir(), 'phx-portal-members-'));
const store = new Store(join(dir, 'store.json'));
let server; let base;
let owner; let target; let loop;
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

const getFirst = (body) => body.loops[0];

before(async () => {
  owner = createOwnerAccount(store, { email: 'member-owner@fixture.test', password: 'owner-password-1', firstName: 'Owner' });
  target = createOwnerAccount(store, { email: 'member-target@fixture.test', password: 'target-password-1', firstName: 'Link' });
  ({ loop } = createLoop(store, { owner, robotId: 'member-fixture-robot' }));
  // Simulate the news-bug state: an identified speaker with NO accountId (the loop import that
  // left 16 of 20 members unlinked).
  loop.members.push({
    _id: newId(),
    accountId: undefined,
    status: 'accepted',
    enrolled: { face: false, voice: false },
    created: Date.now(),
  });
  ensureLoopMemberIds(loop);
  store.flush();
  server = await createAccountService({ store }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await call('POST', '/api/login', { email: owner.email, password: 'owner-password-1' }, 'owner');
  assert.equal(login.status, 200);
});

after(async () => {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

test('anonymous caller is rejected for loop endpoints', async () => {
  const r = await call('GET', '/api/loop', null, 'anon');
  assert.equal(r.status, 401);
});

test('list loop shows every member with their link state', async () => {
  const r = await call('GET', '/api/loop');
  assert.equal(r.status, 200);
  assert.equal(r.body.loops.length, 1);
  const l = getFirst(r.body);
  assert.equal(l.name, loop.name);
  assert.equal(l.members.length, 3); // owner + robot + unlinked speaker
  const unlinked = l.members.find((m) => m.accountId === null);
  assert.ok(unlinked, 'the speaker exists without an accountId');
  assert.equal(unlinked.account, null);
  const ownerMember = l.members.find((m) => m.accountId === owner._id);
  assert.equal(ownerMember.account.email, owner.email);
});

test('link a member to an account (THE news fix) and verify the store + view', async () => {
  const r = await call('GET', '/api/loop');
  const member = getFirst(r.body).members.find((m) => m.accountId === null && m.status === 'accepted');

  const linked = await call('POST', '/api/loop/members/link', { loopId: loop._id, id: member.id, accountId: target._id });
  assert.equal(linked.status, 200);
  const updated = linked.body.loop.members.find((m) => m.id === member.id);
  assert.equal(updated.accountId, target._id);
  assert.equal(updated.account.email, target.email);

  const stored = store.loops.get(loop._id).members.find((m) => m._id === member.id);
  assert.equal(stored.accountId, target._id, 'persisted on the loop member record');
  assert.equal(String(stored.status).toLowerCase(), 'accepted');
});

test('link requires an existing account; anonymous fails', async () => {
  const r = await call('GET', '/api/loop');
  const member = getFirst(r.body).members[0];
  const missing = await call('POST', '/api/loop/members/link', { loopId: loop._id, id: member.id, accountId: 'no-such-account' });
  assert.equal(missing.status, 404);
  const anon = await call('POST', '/api/loop/members/link', { loopId: loop._id, id: member.id, accountId: target._id }, 'anon');
  assert.equal(anon.status, 401);
});

test('unlink clears the accountId so the member is again anonymous to Settings', async () => {
  const r = await call('GET', '/api/loop');
  const member = getFirst(r.body).members.find((m) => m.accountId === target._id);
  assert.ok(member);
  const un = await call('POST', '/api/loop/members/unlink', { loopId: loop._id, id: member.id });
  assert.equal(un.status, 200);
  const after = un.body.loop.members.find((m) => m.id === member.id);
  assert.equal(after.accountId, null);
  assert.equal(after.account, null);
});

test('nickname + phonetic name edit and clear (null)', async () => {
  const r = await call('GET', '/api/loop');
  const member = getFirst(r.body).members.find((m) => m.accountId === owner._id);
  const nick = await call('POST', '/api/loop/members/nickname', { loopId: loop._id, id: member.id, nickname: 'Home-sweet' });
  assert.equal(nick.status, 200);
  const phon = await call('POST', '/api/loop/members/phonetic', { loopId: loop._id, id: member.id, phoneticName: 'Hohm-sweet' });
  assert.equal(phon.status, 200);
  let updated = phon.body.loop.members.find((m) => m.id === member.id);
  assert.equal(updated.nickname, 'Home-sweet');
  assert.equal(updated.phoneticName, 'Hohm-sweet');

  const clear = await call('POST', '/api/loop/members/nickname', { loopId: loop._id, id: member.id, nickname: null });
  assert.equal(clear.body.loop.members.find((m) => m.id === member.id).nickname, null);
});

test('status can be flipped among the member statuses', async () => {
  const r = await call('GET', '/api/loop');
  const id = getFirst(r.body).members[0].id;
  const bad = await call('POST', '/api/loop/members/status', { loopId: loop._id, id, status: 'bogus' });
  assert.equal(bad.status, 400);
  const ok = await call('POST', '/api/loop/members/status', { loopId: loop._id, id, status: 'invited' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.loop.members[0].status, 'invited');
});

test('recognition enrollment is reported by Jibo and cannot be changed in the browser', async () => {
  const r = await call('GET', '/api/loop');
  const id = getFirst(r.body).members.find((m) => m.accountId === owner._id).id;
  const member = store.loops.get(loop._id).members.find((item) => item._id === id);
  const before = structuredClone(member.enrolled);
  const response = await call('POST', '/api/loop/members/enrollment', { loopId: loop._id, id, voice: true });
  assert.equal(response.status, 404);
  assert.deepEqual(member.enrolled, before, 'a portal request must not manufacture a recognition result');
});

test('account search returns identity-only matches', async () => {
  const r = await call('GET', '/api/accounts/search?email=member-target%40fixture.test');
  assert.equal(r.status, 200);
  const found = r.body.accounts.find((a) => a.id === target._id);
  assert.ok(found);
  assert.equal(found.email, target.email);
  assert.ok(!JSON.stringify(found).includes('accessKey'));
  assert.ok(!JSON.stringify(found).includes('password'));
});
