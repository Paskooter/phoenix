import { signedLoopHeaders } from './fixtures/signedLoopRequest.js';
// KB household bootstrap: ListLoops must emit LoopController.populateLoop so
// SSM LoopManager can sync /jibo/loop. Account.Get is the empty-KB fallback
// that returns the caller's account as data[0].id.
//
// Source: jiborobot/srv-account-ws@6cea43470825657d6a5722162f28c8f233153ee2
// LoopController.populateLoop / AccountHandler.Get. Does not invent household
// people beyond the stored owner and robot.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { createAccountService } = await import('../src/index.js');
const { Store } = await import('../src/store.js');
const {
  createOwnerAccount,
  createLoop,
  findOrCreateRobotAccount,
  populateLoop,
  ensureLoopMemberIds,
} = await import('../src/model.js');

const dir = mkdtempSync(join(tmpdir(), 'phx-kb-household-'));
const store = new Store(join(dir, 'store.json'));
let server;
let base;


async function post(target, body, accessKeyId) {
  const response = await fetch(`${base}/`, {
    method: 'POST',
    headers: signedLoopHeaders(store, base, target, body, accessKeyId),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  let parsed = null;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch { /* empty */ }
  return { status: response.status, body: parsed, headers: Object.fromEntries(response.headers) };
}

before(async () => {
  server = await createAccountService({ store }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

test('ListLoops populateLoop: member id/account nested/status lowercase, owner+robot only', async () => {
  const owner = createOwnerAccount(store, {
    email: 'kb-owner@example.test',
    password: 'owner-password',
    firstName: 'Owner',
    lastName: 'Jetson',
  });
  const { loop, robot } = createLoop(store, { owner, robotId: 'kb-bootstrap-robot' });
  store.flush();

  const listed = await post('Loop_20160324.ListLoops', {}, robot.accessKeyId);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.length, 1);
  const wire = listed.body[0];
  assert.equal(wire.id, loop._id);
  assert.equal(wire.owner, owner._id);
  assert.equal(wire.robot, robot._id);
  assert.equal(wire.robotFriendlyId, 'kb-bootstrap-robot');
  assert.equal(wire.members.length, 2, 'owner and robot only; no invented household people');

  const ownerMember = wire.members.find((member) => member.accountId === owner._id);
  const robotMember = wire.members.find((member) => member.accountId === robot._id);
  assert.ok(ownerMember);
  assert.ok(robotMember);

  const storedOwner = loop.members.find((member) => member.accountId === owner._id);
  const storedRobot = loop.members.find((member) => member.accountId === robot._id);
  assert.equal(ownerMember.id, storedOwner._id);
  assert.equal(ownerMember.memberId, owner._id);
  assert.equal(ownerMember.loopId, loop._id);
  assert.equal(ownerMember.status, 'accepted');
  assert.equal(ownerMember.type, 'incoming');
  assert.deepEqual(ownerMember.enrolled, { face: false, voice: false });
  assert.equal(ownerMember.account.firstName, 'Owner');
  assert.equal(ownerMember.account.lastName, 'Jetson');
  assert.equal(ownerMember.account.email, 'kb-owner@example.test');
  assert.equal(ownerMember.account.isChild, undefined);

  assert.equal(robotMember.id, storedRobot._id);
  assert.equal(robotMember.memberId, robot._id);
  assert.equal(robotMember.status, 'accepted');
  assert.equal(robotMember.type, 'outgoing');
  assert.equal(robotMember.account.firstName, '');
  assert.ok(robotMember.account, 'LoopManager._filterOutInvitedChildren reads member.account.isChild');
  assert.equal(robotMember.account.email, undefined);

  // Stored status remains Phoenix-internal ACCEPTED so settings membership still matches.
  assert.equal(store.loops.get(loop._id).members[0].status, 'ACCEPTED');
});

test('ListLoops assigns stable member ids on legacy loops that only had accountId', async () => {
  const owner = createOwnerAccount(store, {
    email: 'kb-legacy@example.test',
    password: 'owner-password',
    firstName: 'Legacy',
  });
  const robot = findOrCreateRobotAccount(store, 'kb-legacy-robot');
  const loop = {
    _id: 'legacy-loop-id',
    name: "Legacy's Jibo",
    owner: owner._id,
    robot: robot._id,
    members: [
      { accountId: owner._id, status: 'ACCEPTED' },
      { accountId: robot._id, status: 'ACCEPTED' },
    ],
    isSuspended: false,
    created: 1,
  };
  store.loops.set(loop._id, loop);
  store.flush();

  const first = await post('Loop_20160324.ListLoops', {}, robot.accessKeyId);
  assert.equal(first.status, 200);
  const firstIds = first.body[0].members.map((member) => member.id);
  assert.equal(firstIds.length, 2);
  assert.ok(firstIds[0]);
  assert.ok(firstIds[1]);
  assert.notEqual(firstIds[0], firstIds[1]);
  assert.equal(store.loops.get(loop._id).members[0]._id, firstIds[0]);

  const second = await post('Loop_20160324.ListLoops', {}, robot.accessKeyId);
  assert.deepEqual(second.body[0].members.map((member) => member.id), firstIds);
});

test('LoopManager _isLoopGood contract: one loop, members with accountId, owner and robot in members', async () => {
  const owner = createOwnerAccount(store, {
    email: 'kb-good@example.test',
    password: 'owner-password',
    firstName: 'Good',
  });
  const { loop, robot } = createLoop(store, { owner, robotId: 'kb-good-robot' });
  const listed = await post('Loop_20160324.ListLoops', {}, robot.accessKeyId);
  const data = listed.body;
  assert.ok(Number.isInteger(data.length) && data.length === 1);
  const members = data[0].members;
  assert.ok(Number.isInteger(members.length) && members.length > 0);
  const accountIds = members.map((element) => element.accountId);
  assert.ok(accountIds.includes(data[0].owner));
  assert.ok(accountIds.includes(data[0].robot));
  assert.ok(members.every((member) => member.id && member.account && typeof member.account === 'object'));
  // Invited-child filter must not throw: member.account.isChild is readable.
  assert.doesNotThrow(() => {
    members.filter((member) => !(member.account.isChild && member.status === 'invited'));
  });
  assert.equal(loop._id, data[0].id);
});

test('Account.Get empty ids returns the caller as data[0].id for LoopManager fallback', async () => {
  const owner = createOwnerAccount(store, {
    email: 'kb-get@example.test',
    password: 'owner-password',
    firstName: 'Getter',
  });
  const { robot } = createLoop(store, { owner, robotId: 'kb-get-robot' });

  const self = await post('Account_20151111.Get', {}, robot.accessKeyId);
  assert.equal(self.status, 200);
  assert.equal(self.body.length, 1);
  assert.equal(self.body[0].id, robot._id);
  assert.equal(self.body[0].friendlyId, 'kb-get-robot');
  assert.ok(!('secretAccessKey' in self.body[0]));
  assert.ok(!('password' in self.body[0]));
  assert.ok(!('accessKeyId' in self.body[0]));

  const ownerSelf = await post('Account_20151111.Get', { ids: [] }, owner.accessKeyId);
  assert.equal(ownerSelf.status, 200);
  assert.equal(ownerSelf.body[0].id, owner._id);
  assert.equal(ownerSelf.body[0].email, 'kb-get@example.test');

  const outsider = createOwnerAccount(store, {
    email: 'kb-outsider@example.test',
    password: 'other-password',
    firstName: 'Out',
  });
  const denied = await post('Account_20151111.Get', { ids: [outsider._id] }, owner.accessKeyId);
  assert.equal(denied.status, 401);
  assert.equal(denied.body.__type, 'MEMBER_CAN_REQUEST');

  const unauth = await post('Account_20151111.Get', {});
  assert.equal(unauth.status, 401);
  assert.equal(unauth.body.__type, 'CREDENTIALS_REQUIRED');
});

test('populateLoop does not invent members that are not on the stored loop', () => {
  const owner = { _id: 'o1', firstName: 'A', email: 'a@example.test' };
  const robot = { _id: 'r1', firstName: '', friendlyId: 'robot' };
  const memory = new Store(join(dir, 'populate-only.json'));
  memory.accounts.set(owner._id, owner);
  memory.accounts.set(robot._id, robot);
  const loop = {
    _id: 'loop-1',
    owner: owner._id,
    robot: robot._id,
    members: [{ _id: 'm-owner', accountId: owner._id, status: 'ACCEPTED' }],
  };
  const wire = populateLoop(memory, loop, { isRobotRequesting: true });
  assert.equal(wire.members.length, 1);
  assert.equal(wire.members[0].accountId, owner._id);
  assert.equal(ensureLoopMemberIds(loop), false);
});
