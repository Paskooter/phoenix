import { signedLoopHeaders } from './fixtures/signedLoopRequest.js';
// A-04 membership lifecycle through the Phoenix AWS-JSON face.
// Source: srv-account-ws@6cea4347 loop.handler.ts / loop.ctrl.ts / errors/loop.ts.
// Original runtime was not executed; expected codes and shapes are controller-sourced.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { createAccountService } = await import('../src/index.js');
const { Store } = await import('../src/store.js');
const { createOwnerAccount, createLoop, MEMBER_STATUS } = await import('../src/model.js');

const dir = mkdtempSync(join(tmpdir(), 'phx-a04-membership-'));
const store = new Store(join(dir, 'store.json'));
let server;
let base;


async function post(target, body, accessKeyId, extraHeaders = {}) {
  const response = await fetch(`${base}/`, {
    method: 'POST',
    headers: signedLoopHeaders(store, base, target, body, accessKeyId, extraHeaders),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  let parsed = null;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch (_) { /* empty or non-JSON */ }
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: parsed,
    rawBody: bytes.toString('utf8'),
  };
}

function validationCases(field) {
  return [
    { suffix: 'missing', body: {}, message: `child "${field}" fails because ["${field}" is required]` },
    { suffix: 'empty', body: { [field]: '' }, message: `child "${field}" fails because ["${field}" is not allowed to be empty]` },
    { suffix: 'null', body: { [field]: null }, message: `child "${field}" fails because ["${field}" must be a string]` },
    { suffix: 'number', body: { [field]: 42 }, message: `child "${field}" fails because ["${field}" must be a string]` },
  ];
}

before(async () => {
  server = await createAccountService({ store }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

test('CreateLoop matches source owner/robot members, name, persistence, and validation', async () => {
  const owner = createOwnerAccount(store, {
    email: 'a04-create-owner@example.test',
    password: 'owner-password',
    firstName: 'Ada',
  });
  const other = createOwnerAccount(store, {
    email: 'a04-create-other@example.test',
    password: 'other-password',
    firstName: 'Other',
  });
  store.flush();

  const created = await post('Loop_20160324.CreateLoop', { name: 'Ada Loop', robotId: 'a04-create-robot' }, owner.accessKeyId);
  assert.equal(created.status, 200);
  assert.equal(created.body.name, 'Ada Loop');
  assert.equal(created.body.owner, owner._id);
  assert.equal(created.body.robotFriendlyId, 'a04-create-robot');
  assert.equal(created.body.isSuspended, false);
  assert.equal(typeof created.body.id, 'string');
  assert.equal(typeof created.body.created, 'number');
  assert.equal(typeof created.body.updated, 'number');
  assert.equal(created.body.members.length, 2);

  const ownerMember = created.body.members.find((m) => m.accountId === owner._id);
  const robotMember = created.body.members.find((m) => m.accountId !== owner._id);
  assert.ok(ownerMember);
  assert.ok(robotMember);
  assert.equal(ownerMember.status, MEMBER_STATUS.ACCEPTED);
  assert.equal(ownerMember.type, 'incoming');
  assert.equal(ownerMember.loopId, created.body.id);
  assert.equal(ownerMember.memberId, owner._id);
  assert.deepEqual(ownerMember.enrolled, { face: false, voice: false });
  assert.equal(ownerMember.account.firstName, 'Ada');
  assert.equal(ownerMember.account.email, 'a04-create-owner@example.test');
  assert.equal(robotMember.status, MEMBER_STATUS.ACCEPTED);
  assert.equal(robotMember.type, 'outgoing');
  assert.equal(created.body.robot, robotMember.accountId);
  assert.equal(ownerMember.memberProperties, undefined);

  const persisted = store.loops.get(created.body.id);
  assert.equal(persisted.name, 'Ada Loop');
  assert.equal(persisted.owner, owner._id);
  assert.equal(persisted.members[0].status, MEMBER_STATUS.ACCEPTED);
  assert.ok(persisted.members[0]._id);
  assert.ok(persisted.members[0].invitationCode === undefined || persisted.members[0].invitationCode);

  const reopened = new Store(join(dir, 'store.json'));
  assert.equal(reopened.loops.get(created.body.id).name, 'Ada Loop');
  assert.equal(reopened.loops.get(created.body.id).members.length, 2);

  const alias = await post('Loop_20160324.Create', { name: 'Alias Loop', robotId: 'a04-create-alias-robot' }, owner.accessKeyId);
  assert.equal(alias.status, 200);
  assert.equal(alias.body.name, 'Alias Loop');

  const stolen = await post(
    'Loop_20160324.CreateLoop',
    { name: 'Stolen', robotId: 'a04-create-stolen-robot' },
    owner.accessKeyId,
    { 'x-amz-credentials': JSON.stringify({ id: other._id, isAdmin: true }) },
  );
  assert.equal(stolen.status, 200);
  assert.equal(stolen.body.owner, owner._id, 'public face identity is the access key, not x-amz-credentials');

  const anon = await post('Loop_20160324.CreateLoop', { name: 'Anon', robotId: 'a04-create-anon-robot' });
  assert.equal(anon.status, 401);
  assert.equal(anon.body.__type, 'MISSING_AUTH_HEADER');
  assert.equal(anon.headers['x-amzn-errortype'], 'MISSING_AUTH_HEADER');

  for (const item of validationCases('name')) {
    const invalid = await post('Loop_20160324.CreateLoop', { ...item.body, robotId: 'x' }, owner.accessKeyId);
    assert.equal(invalid.status, 422, `CreateLoop/name/${item.suffix}`);
    assert.deepEqual(invalid.body, {
      statusCode: 422,
      error: 'Unprocessable Entity',
      message: item.message,
    });
  }
  const missingRobot = await post('Loop_20160324.CreateLoop', { name: 'No robot' }, owner.accessKeyId);
  assert.equal(missingRobot.status, 422);
  assert.equal(missingRobot.body.message, 'child "robotId" fails because ["robotId" is required]');

  const notObject = await post('Loop_20160324.CreateLoop', ['Ada Loop'], owner.accessKeyId);
  assert.equal(notObject.status, 422);
  assert.equal(notObject.body.message, '"value" must be an object');
});

test('CreateLoop relocates an existing robot and suspends the prior loop', async () => {
  const owner = createOwnerAccount(store, {
    email: 'a04-move-owner@example.test',
    password: 'owner-password',
    firstName: 'Move',
  });
  const first = await post('Loop_20160324.CreateLoop', { name: 'First', robotId: 'a04-move-robot' }, owner.accessKeyId);
  assert.equal(first.status, 200);
  const second = await post('Loop_20160324.CreateLoop', { name: 'Second', robotId: 'a04-move-robot' }, owner.accessKeyId);
  assert.equal(second.status, 200);
  assert.notEqual(second.body.id, first.body.id);
  assert.equal(second.body.robot, first.body.robot);
  const old = store.loops.get(first.body.id);
  assert.equal(old.isSuspended, true);
  assert.equal(old.robot, undefined);
  assert.equal(old.members.some((m) => m.accountId === first.body.robot), false);
  assert.equal(store.loops.get(second.body.id).isSuspended, false);
  assert.equal(store.loops.get(second.body.id).robot, second.body.robot);
});

test('InviteLoopMember enforces owner access, statuses, and source errors', async () => {
  const owner = createOwnerAccount(store, {
    email: 'a04-invite-owner@example.test',
    password: 'owner-password',
    firstName: 'Owner',
  });
  const guest = createOwnerAccount(store, {
    email: 'a04-invite-guest@example.test',
    password: 'guest-password',
    firstName: 'Guest',
    lastName: 'User',
  });
  const stranger = createOwnerAccount(store, {
    email: 'a04-invite-stranger@example.test',
    password: 'stranger-password',
    firstName: 'Stranger',
  });
  const created = await post('Loop_20160324.CreateLoop', { name: 'Invite Loop', robotId: 'a04-invite-robot' }, owner.accessKeyId);
  const loopId = created.body.id;
  const robot = store.accountByFriendlyId('a04-invite-robot');

  const invited = await post('Loop_20160324.InviteLoopMember', {
    loopId,
    email: 'a04-invite-guest@example.test',
    firstName: ' Guest ',
    lastName: ' User ',
  }, owner.accessKeyId);
  assert.equal(invited.status, 200);
  const guestMember = invited.body.members.find((m) => m.accountId === guest._id);
  assert.ok(guestMember);
  assert.equal(guestMember.status, MEMBER_STATUS.INVITED);
  assert.equal(guestMember.type, 'outgoing');
  assert.equal(guestMember.account.email, 'a04-invite-guest@example.test');
  assert.equal(guestMember.account.firstName, 'Guest');
  assert.equal(guestMember.invitationCode, undefined, 'invitationCode is stripped from the wire member');
  const storedGuest = store.loops.get(loopId).members.find((m) => m.accountId === guest._id);
  assert.ok(storedGuest.invitationCode);
  assert.equal(storedGuest.status, MEMBER_STATUS.INVITED);

  const duplicate = await post('Loop_20160324.InviteLoopMember', {
    loopId,
    email: 'A04-INVITE-GUEST@example.test',
  }, owner.accessKeyId);
  assert.equal(duplicate.status, 200, 're-invite of a non-accepted member updates the invite');
  assert.equal(store.loops.get(loopId).members.find((m) => m.accountId === guest._id).status, MEMBER_STATUS.INVITED);

  const denied = await post('Loop_20160324.InviteLoopMember', {
    loopId,
    email: 'a04-invite-stranger@example.test',
  }, stranger.accessKeyId);
  assert.equal(denied.status, 403);
  assert.equal(denied.body.__type, 'CAN_BE_ACCESSED_BY_OWNER');
  assert.equal(store.loops.get(loopId).members.some((m) => m.accountId === stranger._id), false);

  const asRobot = await post('Loop_20160324.InviteLoopMember', {
    loopId,
    email: 'a04-invite-stranger@example.test',
  }, robot.accessKeyId);
  assert.equal(asRobot.status, 403);
  assert.equal(asRobot.body.__type, 'CAN_BE_ACCESSED_BY_OWNER');

  const missingLoop = await post('Loop_20160324.InviteLoopMember', {
    loopId: 'missing-loop',
    email: 'a04-invite-stranger@example.test',
  }, owner.accessKeyId);
  assert.equal(missingLoop.status, 404);
  assert.equal(missingLoop.body.__type, 'LOOP_NOT_FOUND');

  const crew = await post('Loop_20160324.InviteLoopMember', {
    loopId,
    firstName: 'Crew',
    lastName: 'Member',
  }, owner.accessKeyId);
  assert.equal(crew.status, 200);
  const crewMember = crew.body.members.find((m) => m.account && m.account.firstName === 'Crew');
  assert.ok(crewMember);
  assert.equal(crewMember.status, MEMBER_STATUS.ACCEPTED, 'adult without email is accepted immediately');
  assert.equal(crewMember.accountId, undefined);

  const child = await post('Loop_20160324.InviteLoopMember', {
    loopId,
    firstName: 'Child',
    isChild: true,
  }, owner.accessKeyId);
  assert.equal(child.status, 200);
  const childMember = child.body.members.find((m) => m.account && m.account.firstName === 'Child');
  assert.equal(childMember.status, MEMBER_STATUS.INVITED);

  const acceptedAgain = await post('Loop_20160324.InviteLoopMember', {
    loopId,
    email: owner.email,
  }, owner.accessKeyId);
  assert.equal(acceptedAgain.status, 409);
  assert.equal(acceptedAgain.body.__type, 'MEMBER_EXISTS');

  const badEmail = await post('Loop_20160324.InviteLoopMember', {
    loopId,
    email: 'not-an-email',
  }, owner.accessKeyId);
  assert.equal(badEmail.status, 422);
  assert.match(badEmail.body.message, /email/);

  const localhostEmail = await post('Loop_20160324.InviteLoopMember', {
    loopId,
    email: 'user@localhost',
  }, owner.accessKeyId);
  assert.equal(localhostEmail.status, 422);

  const badGender = await post('Loop_20160324.InviteLoopMember', {
    loopId,
    gender: 'unknown',
  }, owner.accessKeyId);
  assert.equal(badGender.status, 422);
  assert.match(badGender.body.message, /must be one of \[male, female, other, they\]/);

  const missingLoopId = await post('Loop_20160324.InviteLoopMember', { email: 'ok@example.test' }, owner.accessKeyId);
  assert.equal(missingLoopId.status, 422);
  assert.equal(missingLoopId.body.message, 'child "loopId" fails because ["loopId" is required]');

  const many = await post('Loop_20160324.CreateLoop', { name: 'Limit Loop', robotId: 'a04-limit-robot' }, owner.accessKeyId);
  for (let i = 0; i < 20; i += 1) {
    const extra = await post('Loop_20160324.InviteLoopMember', {
      loopId: many.body.id,
      firstName: `Extra${i}`,
    }, owner.accessKeyId);
    assert.equal(extra.status, 200, `source compares the member array with MAX_SIZE, so invite ${i} is not ACTIVE_LIMIT_REACHED`);
  }
});

test('InviteLoopMember rejects mutation of a suspended or deleted loop', async () => {
  const owner = createOwnerAccount(store, {
    email: 'a04-invite-suspended@example.test',
    password: 'owner-password',
    firstName: 'Owner',
  });
  const created = await post('Loop_20160324.CreateLoop', { name: 'Suspended Invite', robotId: 'a04-invite-susp-robot' }, owner.accessKeyId);
  const robot = store.accountByFriendlyId('a04-invite-susp-robot');
  const suspended = await post('Loop_20160324.SuspendLoop', { loopId: created.body.id }, robot.accessKeyId);
  assert.equal(suspended.status, 200);
  const invite = await post('Loop_20160324.InviteLoopMember', {
    loopId: created.body.id,
    firstName: 'Nope',
  }, owner.accessKeyId);
  assert.equal(invite.status, 403);
  assert.equal(invite.body.__type, 'LOOP_SUSPENDED');
  assert.equal(store.loops.get(created.body.id).members.length, 2);

  const other = await post('Loop_20160324.CreateLoop', { name: 'Deleted Invite', robotId: 'a04-invite-del-robot' }, owner.accessKeyId);
  store.loops.get(other.body.id).isDeleted = true;
  store.flush();
  const deleted = await post('Loop_20160324.InviteLoopMember', {
    loopId: other.body.id,
    firstName: 'Nope',
  }, owner.accessKeyId);
  assert.equal(deleted.status, 404);
  assert.equal(deleted.body.__type, 'LOOP_NOT_FOUND');
});

test('AcceptLoopInvitation and DeclineLoopInvitation follow controller membership rules', async () => {
  const owner = createOwnerAccount(store, {
    email: 'a04-accept-owner@example.test',
    password: 'owner-password',
    firstName: 'Owner',
  });
  const guest = createOwnerAccount(store, {
    email: 'a04-accept-guest@example.test',
    password: 'guest-password',
    firstName: 'Guest',
  });
  const other = createOwnerAccount(store, {
    email: 'a04-accept-other@example.test',
    password: 'other-password',
    firstName: 'Other',
  });
  const created = await post('Loop_20160324.CreateLoop', { name: 'Accept Loop', robotId: 'a04-accept-robot' }, owner.accessKeyId);
  const loopId = created.body.id;
  await post('Loop_20160324.InviteLoopMember', { loopId, email: guest.email }, owner.accessKeyId);

  const asOwner = await post('Loop_20160324.AcceptLoopInvitation', { loopId }, owner.accessKeyId);
  assert.equal(asOwner.status, 404);
  assert.equal(asOwner.body.__type, 'INVITE_NOT_FOUND');
  assert.equal(store.loops.get(loopId).members.find((m) => m.accountId === guest._id).status, MEMBER_STATUS.INVITED);

  const accepted = await post('Loop_20160324.AcceptLoopInvitation', { loopId }, guest.accessKeyId);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.id, loopId);
  const acceptedGuest = accepted.body.members.find((m) => m.accountId === guest._id);
  assert.equal(acceptedGuest.status, MEMBER_STATUS.ACCEPTED);
  assert.equal(acceptedGuest.type, undefined, 'AcceptInvitation returns the unpopulated Loop document');
  assert.equal(acceptedGuest.loopId, undefined);
  assert.ok(acceptedGuest.memberProperties);
  assert.equal(store.loops.get(loopId).members.find((m) => m.accountId === guest._id).status, MEMBER_STATUS.ACCEPTED);

  const already = await post('Loop_20160324.AcceptLoopInvitation', { loopId }, guest.accessKeyId);
  assert.equal(already.status, 404);
  assert.equal(already.body.__type, 'INVITE_NOT_FOUND');

  const noInvite = await post('Loop_20160324.AcceptLoopInvitation', { loopId }, other.accessKeyId);
  assert.equal(noInvite.status, 404);
  assert.equal(noInvite.body.__type, 'INVITE_NOT_FOUND');

  const unknownEmail = await post('Loop_20160324.InviteLoopMember', {
    loopId,
    email: 'a04-never-created@example.test',
    firstName: 'Ghost',
  }, owner.accessKeyId);
  assert.equal(unknownEmail.status, 200);
  const ghost = unknownEmail.body.members.find((m) => m.account && m.account.email === 'a04-never-created@example.test');
  assert.equal(ghost.accountId, undefined);
  const ghostAccept = await post('Loop_20160324.AcceptLoopInvitation', { loopId }, other.accessKeyId);
  assert.equal(ghostAccept.status, 404);
  assert.equal(ghostAccept.body.__type, 'INVITE_NOT_FOUND');

  const declineTarget = createOwnerAccount(store, {
    email: 'a04-decline-guest@example.test',
    password: 'guest-password',
    firstName: 'Decliner',
  });
  await post('Loop_20160324.InviteLoopMember', { loopId, email: declineTarget.email }, owner.accessKeyId);
  const declined = await post('Loop_20160324.DeclineLoopInvitation', { loopId }, declineTarget.accessKeyId);
  assert.equal(declined.status, 200);
  const declinedMember = declined.body.members.find((m) => m.accountId === declineTarget._id);
  assert.equal(declinedMember.status, MEMBER_STATUS.DECLINED);
  assert.equal(declinedMember.type, 'outgoing', 'DeclineInvitation returns populateLoop output');
  assert.equal(declinedMember.loopId, loopId);
  assert.equal(store.loops.get(loopId).members.find((m) => m.accountId === declineTarget._id).status, MEMBER_STATUS.DECLINED);

  const declineMissing = await post('Loop_20160324.DeclineLoopInvitation', { loopId }, other.accessKeyId);
  assert.equal(declineMissing.status, 404);
  assert.equal(declineMissing.body.__type, 'INVITE_NOT_FOUND');

  const declineAccepted = await post('Loop_20160324.DeclineLoopInvitation', { loopId }, guest.accessKeyId);
  assert.equal(declineAccepted.status, 200, 'source declineInvitation does not require INVITED status');
  assert.equal(store.loops.get(loopId).members.find((m) => m.accountId === guest._id).status, MEMBER_STATUS.DECLINED);

  const missingLoopId = await post('Loop_20160324.AcceptLoopInvitation', {}, guest.accessKeyId);
  assert.equal(missingLoopId.status, 422);
  assert.equal(missingLoopId.body.message, 'child "loopId" fails because ["loopId" is required]');

  const robot = store.accountByFriendlyId('a04-accept-robot');
  const third = createOwnerAccount(store, {
    email: 'a04-accept-third@example.test',
    password: 'third-password',
    firstName: 'Third',
  });
  await post('Loop_20160324.InviteLoopMember', { loopId, email: third.email }, owner.accessKeyId);
  await post('Loop_20160324.SuspendLoop', { loopId }, robot.accessKeyId);
  const acceptSuspended = await post('Loop_20160324.AcceptLoopInvitation', { loopId }, third.accessKeyId);
  assert.equal(acceptSuspended.status, 403);
  assert.equal(acceptSuspended.body.__type, 'LOOP_SUSPENDED');
  assert.equal(store.loops.get(loopId).members.find((m) => m.accountId === third._id).status, MEMBER_STATUS.INVITED);
  const declineSuspended = await post('Loop_20160324.DeclineLoopInvitation', { loopId }, third.accessKeyId);
  assert.equal(declineSuspended.status, 403);
  assert.equal(declineSuspended.body.__type, 'LOOP_SUSPENDED');
});

test('ListLoopMembers filters by status/type and uses source loop visibility', async () => {
  const owner = createOwnerAccount(store, {
    email: 'a04-list-owner@example.test',
    password: 'owner-password',
    firstName: 'Owner',
  });
  const guest = createOwnerAccount(store, {
    email: 'a04-list-guest@example.test',
    password: 'guest-password',
    firstName: 'Guest',
  });
  const outsider = createOwnerAccount(store, {
    email: 'a04-list-outsider@example.test',
    password: 'outsider-password',
    firstName: 'Outsider',
  });
  const created = await post('Loop_20160324.CreateLoop', { name: 'List Loop', robotId: 'a04-list-robot' }, owner.accessKeyId);
  const loopId = created.body.id;
  await post('Loop_20160324.InviteLoopMember', { loopId, email: guest.email }, owner.accessKeyId);
  await post('Loop_20160324.AcceptLoopInvitation', { loopId }, guest.accessKeyId);

  const all = await post('Loop_20160324.ListLoopMembers', {}, owner.accessKeyId);
  assert.equal(all.status, 200);
  assert.ok(Array.isArray(all.body));
  const mine = all.body.filter((m) => m.loopId === loopId);
  assert.ok(mine.length >= 3);
  assert.ok(mine.some((m) => m.type === 'incoming' && m.accountId === owner._id));
  assert.ok(mine.every((m) => m.enrolled && typeof m.enrolled.face === 'boolean'));

  const invitedOnly = await post('Loop_20160324.ListLoopMembers', { statusList: ['invited'] }, owner.accessKeyId);
  assert.equal(invitedOnly.status, 200);
  assert.equal(invitedOnly.body.filter((m) => m.loopId === loopId).every((m) => m.status === 'invited'), true);

  const incoming = await post('Loop_20160324.ListLoopMembers', { typeList: ['incoming'] }, owner.accessKeyId);
  assert.ok(incoming.body.filter((m) => m.loopId === loopId).every((m) => m.type === 'incoming'));
  assert.ok(incoming.body.filter((m) => m.loopId === loopId).some((m) => m.accountId === owner._id));

  const asGuest = await post('Loop_20160324.ListLoopMembers', {}, guest.accessKeyId);
  assert.equal(asGuest.status, 200);
  assert.ok(asGuest.body.some((m) => m.loopId === loopId && m.accountId === owner._id));

  const asOutsider = await post('Loop_20160324.ListLoopMembers', {}, outsider.accessKeyId);
  assert.equal(asOutsider.status, 200);
  assert.equal(asOutsider.body.some((m) => m.loopId === loopId), false);

  const robot = store.accountByFriendlyId('a04-list-robot');
  const asRobot = await post('Loop_20160324.ListLoopMembers', {}, robot.accessKeyId);
  assert.equal(asRobot.status, 200);
  assert.ok(asRobot.body.some((m) => m.loopId === loopId));

  await post('Loop_20160324.SuspendLoop', { loopId }, robot.accessKeyId);
  const robotAfter = await post('Loop_20160324.ListLoopMembers', {}, robot.accessKeyId);
  assert.equal(robotAfter.body.some((m) => m.loopId === loopId), false, 'robot list skips suspended loops');
  const ownerAfter = await post('Loop_20160324.ListLoopMembers', {}, owner.accessKeyId);
  assert.ok(ownerAfter.body.some((m) => m.loopId === loopId), 'owner still lists members of a suspended loop');

  const badStatus = await post('Loop_20160324.ListLoopMembers', { statusList: ['nope'] }, owner.accessKeyId);
  assert.equal(badStatus.status, 422);
  assert.match(badStatus.body.message, /must be one of \[accepted, declined, removed, invited\]/);

  const notArray = await post('Loop_20160324.ListLoopMembers', { statusList: 'accepted' }, owner.accessKeyId);
  assert.equal(notArray.status, 422);
  assert.equal(notArray.body.message, 'child "statusList" fails because ["statusList" must be an array]');

  const emptyFilters = await post('Loop_20160324.ListLoopMembers', { statusList: [], typeList: [] }, owner.accessKeyId);
  assert.equal(emptyFilters.status, 200);
});

test('RemoveLoopMember is owner-or-self, soft-deletes, and keeps persistence', async () => {
  const owner = createOwnerAccount(store, {
    email: 'a04-remove-owner@example.test',
    password: 'owner-password',
    firstName: 'Owner',
  });
  const guest = createOwnerAccount(store, {
    email: 'a04-remove-guest@example.test',
    password: 'guest-password',
    firstName: 'Guest',
  });
  const other = createOwnerAccount(store, {
    email: 'a04-remove-other@example.test',
    password: 'other-password',
    firstName: 'Other',
  });
  const created = await post('Loop_20160324.CreateLoop', { name: 'Remove Loop', robotId: 'a04-remove-robot' }, owner.accessKeyId);
  const loopId = created.body.id;
  await post('Loop_20160324.InviteLoopMember', { loopId, email: guest.email }, owner.accessKeyId);
  await post('Loop_20160324.AcceptLoopInvitation', { loopId }, guest.accessKeyId);
  await post('Loop_20160324.InviteLoopMember', { loopId, email: other.email }, owner.accessKeyId);
  await post('Loop_20160324.AcceptLoopInvitation', { loopId }, other.accessKeyId);

  const listed = await post('Loop_20160324.ListLoopMembers', { statusList: ['accepted'] }, owner.accessKeyId);
  const guestMember = listed.body.find((m) => m.accountId === guest._id && m.loopId === loopId);
  const otherMember = listed.body.find((m) => m.accountId === other._id && m.loopId === loopId);
  assert.ok(guestMember);
  assert.ok(otherMember);

  const strangerRemove = await post('Loop_20160324.RemoveLoopMember', { loopId, id: guestMember.id }, other.accessKeyId);
  assert.equal(strangerRemove.status, 403);
  assert.equal(strangerRemove.body.__type, 'CAN_BE_ACCESSED_BY_OWNER_OR_SELF');
  assert.equal(store.loops.get(loopId).members.find((m) => m._id === guestMember.id).status, MEMBER_STATUS.ACCEPTED);

  const selfRemove = await post('Loop_20160324.RemoveLoopMember', { loopId, id: guestMember.id }, guest.accessKeyId);
  assert.equal(selfRemove.status, 200);
  const removedSelf = selfRemove.body.members.find((m) => m.id === guestMember.id);
  assert.equal(removedSelf.status, MEMBER_STATUS.REMOVED);
  assert.ok(store.loops.get(loopId).members.find((m) => m._id === guestMember.id));

  const ownerRemove = await post('Loop_20160324.RemoveLoopMember', { loopId, id: otherMember.id }, owner.accessKeyId);
  assert.equal(ownerRemove.status, 200);
  assert.equal(store.loops.get(loopId).members.find((m) => m._id === otherMember.id).status, MEMBER_STATUS.REMOVED);

  const missingMember = await post('Loop_20160324.RemoveLoopMember', { loopId, id: 'missing-member' }, owner.accessKeyId);
  assert.equal(missingMember.status, 404);
  assert.equal(missingMember.body.__type, 'MEMBER_NOT_FOUND');

  for (const item of validationCases('id')) {
    const invalid = await post('Loop_20160324.RemoveLoopMember', { ...item.body, loopId }, owner.accessKeyId);
    assert.equal(invalid.status, 422, `RemoveLoopMember/id/${item.suffix}`);
    assert.equal(invalid.body.message, item.message);
  }
  const missingLoopId = await post('Loop_20160324.RemoveLoopMember', { id: guestMember.id }, owner.accessKeyId);
  assert.equal(missingLoopId.status, 422);
  assert.equal(missingLoopId.body.message, 'child "loopId" fails because ["loopId" is required]');

  const robot = store.accountByFriendlyId('a04-remove-robot');
  const extra = createOwnerAccount(store, {
    email: 'a04-remove-extra@example.test',
    password: 'extra-password',
    firstName: 'Extra',
  });
  await post('Loop_20160324.InviteLoopMember', { loopId, email: extra.email }, owner.accessKeyId);
  const extraListed = await post('Loop_20160324.ListLoopMembers', { statusList: ['invited'] }, owner.accessKeyId);
  const extraMember = extraListed.body.find((m) => m.accountId === extra._id && m.loopId === loopId);
  await post('Loop_20160324.SuspendLoop', { loopId }, robot.accessKeyId);
  const removeSuspended = await post('Loop_20160324.RemoveLoopMember', { loopId, id: extraMember.id }, owner.accessKeyId);
  assert.equal(removeSuspended.status, 403);
  assert.equal(removeSuspended.body.__type, 'LOOP_SUSPENDED');
  assert.equal(store.loops.get(loopId).members.find((m) => m._id === extraMember.id).status, MEMBER_STATUS.INVITED);

  const durable = new Store(join(dir, 'store.json'));
  assert.equal(durable.loops.get(loopId).members.find((m) => m._id === guestMember.id).status, MEMBER_STATUS.REMOVED);
});

test('Existing ListLoops/SuspendLoop handlers remain unchanged and record ops dispatch', async () => {
  const owner = createOwnerAccount(store, {
    email: 'a04-preserve-owner@example.test',
    password: 'owner-password',
    firstName: 'Owner',
  });
  const { loop, robot } = createLoop(store, { owner, robotId: 'a04-preserve-robot' });
  store.flush();

  const listed = await post('Loop_20160324.ListLoops', {}, robot.accessKeyId);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.length, 1);
  assert.equal(listed.body[0].id, loop._id);
  // Source member status values are lowercase (schemes/member.status.ts:
  // ACCEPTED = "accepted"), and the mongoose toJSON transform renames _id to id
  // and adds memberId as a 2.x fallback (schemes/loop.ts). ListLoops emits that
  // shape, so this asserts the source contract rather than Phoenix's earlier
  // uppercase spelling.
  assert.equal(listed.body[0].members[0].status, 'accepted');
  assert.ok(listed.body[0].members[0].id);
  assert.equal(listed.body[0].members[0].memberId, listed.body[0].members[0].accountId);

  const suspended = await post('Loop_20160324.SuspendLoop', { loopId: loop._id }, robot.accessKeyId);
  assert.equal(suspended.status, 200);
  assert.deepEqual(suspended.body, { result: 'Command accepted' });
  assert.equal(store.loops.get(loop._id).isSuspended, true);

  const remove = await post('Loop_20160324.Remove', { loopId: loop._id }, robot.accessKeyId);
  assert.equal(remove.status, 400);
  assert.equal(remove.body.__type, 'UnknownOperationException');

  const update = await post('Loop_20160324.UpdateLoop', { loopId: loop._id, name: 'Nope' }, owner.accessKeyId);
  assert.equal(update.status, 403);
  assert.equal(update.body.__type, 'LOOP_SUSPENDED');
});
