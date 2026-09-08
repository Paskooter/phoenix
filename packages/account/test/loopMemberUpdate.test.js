// Synthetic A-04 UpdateLoopMember controls.
// Source contract: srv-account-ws@6cea43470825657d6a5722162f28c8f233153ee2.
// No household or production identifiers are used here.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { signSigV4 } from '@phoenix/common';

const { createAccountService } = await import('../src/index.js');
const { Store } = await import('../src/store.js');
const { createOwnerAccount, createLoop, MEMBER_STATUS, newId } = await import('../src/model.js');
const { updateMember } = await import('../src/loopMembership.js');

const dir = mkdtempSync(join(tmpdir(), 'phx-a04-update-member-'));
const store = new Store(join(dir, 'store.json'));
let server;
let base;
let serial = 0;

function nextLabel(prefix) {
  serial += 1;
  return `${prefix}-${serial}`;
}

async function post(target, body, accessKeyId) {
  const account = store.accountByAccessKeyId(accessKeyId);
  assert.ok(account, `fixture account exists for ${accessKeyId}`);
  const wire = body === undefined ? '' : JSON.stringify(body);
  const signed = signSigV4({
    method: 'POST',
    path: '/',
    body: wire,
    headers: {
      Host: new URL(base).host,
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': target,
    },
    accessKeyId: account.accessKeyId,
    secretAccessKey: account.secretAccessKey,
    region: 'global',
    service: 'jibo',
    date: new Date(),
  });
  const response = await fetch(`${base}/`, {
    method: 'POST',
    headers: signed.headers,
    body: wire,
  });
  const raw = Buffer.from(await response.arrayBuffer()).toString('utf8');
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    raw,
    body: raw ? JSON.parse(raw) : null,
  };
}

function makeOwner(prefix) {
  return createOwnerAccount(store, {
    email: `${nextLabel(prefix)}@fixture.test`,
    password: 'fixture-password',
    firstName: 'Synthetic',
    lastName: 'Owner',
  });
}

function addMember(loop, member) {
  loop.members.push({
    _id: member._id || newId(),
    status: MEMBER_STATUS.INVITED,
    memberProperties: {},
    enrolled: { face: false, voice: false },
    ...member,
  });
  return loop.members[loop.members.length - 1];
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

before(async () => {
  server = await createAccountService({ store }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

test('UpdateLoopMember updates editable properties and keeps source transforms', async () => {
  const owner = makeOwner('update-basic-owner');
  const { loop, robot } = createLoop(store, { owner, robotId: nextLabel('update-basic-robot') });
  const ownerMember = loop.members[0];
  const beforeOutbox = store.notificationOutbox.size;

  const response = await post('Loop_20160324.UpdateLoopMember', {
    id: ownerMember._id,
    loopId: loop._id,
    firstName: '  Changed  ',
    lastName: '  Person  ',
    gender: 'they',
    birthday: 946684800000,
    phoneNumber: '555-0101',
    isChild: 'ignored unknown input',
  }, owner.accessKeyId);

  assert.equal(response.status, 200);
  assert.equal(response.body.id, loop._id);
  assert.equal(response.body.owner, owner._id);
  assert.equal(response.body.members.length, 2);
  assert.equal(response.body.members.find((member) => member.id === ownerMember._id).account.firstName, 'Synthetic',
    'accepted members are populated from Account, as in source populateLoop');

  const persisted = store.loops.get(loop._id);
  const updated = persisted.members.find((member) => member._id === ownerMember._id);
  assert.deepEqual(updated.memberProperties, {
    firstName: 'Changed',
    lastName: 'Person',
    gender: 'they',
    birthday: 946684800000,
    phoneNumber: '555-0101',
  });
  assert.equal(updated.status, 'ACCEPTED', 'model fixture uses uppercase but source status matching is case-insensitive at this seam');
  assert.equal(store.notificationOutbox.size, beforeOutbox + 1);
  const updates = [...store.notificationOutbox.values()]
    .filter((entry) => entry.notification?.payload?.id === loop._id);
  assert.equal(updates.length, 1);
  assert.equal(robot._id, loop.robot);
});

test('UpdateLoopMember assigns an email, reopens removed duplicates, and preserves account lookup semantics', async () => {
  const owner = makeOwner('update-email-owner');
  const existingAccount = createOwnerAccount(store, {
    email: `${nextLabel('existing-account')}@fixture.test`,
    password: 'fixture-password',
    firstName: 'Existing',
  });
  const { loop } = createLoop(store, { owner, robotId: nextLabel('update-email-robot') });
  const target = addMember(loop, {
    _id: 'update-email-target',
    status: MEMBER_STATUS.INVITED,
    memberProperties: { firstName: 'Pending', email: null },
  });
  addMember(loop, {
    _id: 'update-email-removed',
    status: MEMBER_STATUS.REMOVED,
    memberProperties: { email: existingAccount.email, firstName: 'Old record' },
  });
  store.flush();

  const response = await post('Loop_20160324.UpdateLoopMember', {
    id: target._id,
    loopId: loop._id,
    email: existingAccount.email.toUpperCase(),
    firstName: '  Reopened  ',
  }, owner.accessKeyId);

  assert.equal(response.status, 200);
  const persisted = store.loops.get(loop._id);
  const updated = persisted.members.find((member) => member._id === target._id);
  assert.ok(updated);
  assert.equal(persisted.members.some((member) => member._id === 'update-email-removed'), false);
  assert.equal(updated.accountId, existingAccount._id, 'source Account.findOne({ email }) attaches the existing account');
  assert.equal(updated.memberProperties.email, existingAccount.email);
  assert.equal(updated.memberProperties.firstName, 'Reopened');
  assert.equal(updated.memberProperties.isChild, false);
  assert.equal(updated.status, MEMBER_STATUS.INVITED);
  assert.ok(updated.invitationCode);
  assert.equal(response.body.members.find((member) => member.id === target._id).status, MEMBER_STATUS.INVITED);
});

test('UpdateLoopMember reports source duplicate and one-time-email errors without partial mutation', async () => {
  const owner = makeOwner('update-errors-owner');
  const { loop } = createLoop(store, { owner, robotId: nextLabel('update-errors-robot') });
  const target = addMember(loop, {
    _id: 'update-errors-target',
    status: MEMBER_STATUS.INVITED,
    memberProperties: { firstName: 'Before', email: null },
  });
  addMember(loop, {
    _id: 'update-errors-active-duplicate',
    status: MEMBER_STATUS.ACCEPTED,
    memberProperties: { email: 'duplicate@fixture.test' },
  });
  const beforeDuplicate = clone(store.loops.get(loop._id));
  const beforeOutbox = store.notificationOutbox.size;
  store.flush();

  const duplicate = await post('Loop_20160324.UpdateLoopMember', {
    id: target._id,
    loopId: loop._id,
    email: 'DUPLICATE@fixture.test',
  }, owner.accessKeyId);
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.__type, 'MEMBER_EMAIL_EXISTS');
  assert.deepEqual(store.loops.get(loop._id), beforeDuplicate);
  assert.equal(store.notificationOutbox.size, beforeOutbox);

  const current = store.loops.get(loop._id).members.find((member) => member._id === target._id);
  current.memberProperties.email = 'current@fixture.test';
  store.flush();
  const beforeSetOnce = clone(store.loops.get(loop._id));
  const setOnce = await post('Loop_20160324.UpdateLoopMember', {
    id: target._id,
    loopId: loop._id,
    email: 'new-address@fixture.test',
    firstName: 'Must not save',
  }, owner.accessKeyId);
  assert.equal(setOnce.status, 403);
  assert.equal(setOnce.body.__type, 'EMAIL_CAN_BE_SET_ONCE');
  assert.deepEqual(store.loops.get(loop._id), beforeSetOnce);
  assert.equal(store.notificationOutbox.size, beforeOutbox);
});

test('UpdateLoopMember applies child guardian and source failure ordering', async () => {
  const owner = makeOwner('update-auth-owner');
  const guardian = makeOwner('update-auth-guardian');
  const outsider = makeOwner('update-auth-outsider');
  const { loop, robot } = createLoop(store, { owner, robotId: nextLabel('update-auth-robot') });
  const guardianMember = addMember(loop, {
    _id: 'update-auth-guardian-member',
    accountId: guardian._id,
    status: MEMBER_STATUS.ACCEPTED,
    memberProperties: {},
  });
  const child = addMember(loop, {
    _id: 'update-auth-child',
    status: MEMBER_STATUS.ACCEPTED,
    legalGuardianId: guardianMember._id,
    memberProperties: { isChild: true, firstName: 'Child' },
  });
  const invited = addMember(loop, {
    _id: 'update-auth-invited',
    status: MEMBER_STATUS.INVITED,
    memberProperties: { firstName: 'Invited' },
  });
  const emailMember = addMember(loop, {
    _id: 'update-auth-email',
    status: MEMBER_STATUS.ACCEPTED,
    memberProperties: { email: 'locked@fixture.test' },
  });
  store.flush();

  const outsiderChild = await post('Loop_20160324.UpdateLoopMember', {
    id: child._id, loopId: loop._id, firstName: 'Denied',
  }, owner.accessKeyId);
  assert.equal(outsiderChild.status, 403);
  assert.equal(outsiderChild.body.__type, 'CAN_BE_ACCESSED_BY_LEGAL_GUARDIAN');

  const guardianUpdate = await post('Loop_20160324.UpdateLoopMember', {
    id: child._id, loopId: loop._id, firstName: '  Guarded  ',
  }, guardian.accessKeyId);
  assert.equal(guardianUpdate.status, 200);
  assert.equal(store.loops.get(loop._id).members.find((member) => member._id === child._id)
    .memberProperties.firstName, 'Guarded');

  const outsiderExisting = await post('Loop_20160324.UpdateLoopMember', {
    id: invited._id, loopId: loop._id, firstName: 'Denied',
  }, outsider.accessKeyId);
  assert.equal(outsiderExisting.status, 403);
  assert.equal(outsiderExisting.body.__type, 'CAN_BE_ACCESSED_BY_OWNER_OR_ROBOT');

  const outsiderMissing = await post('Loop_20160324.UpdateLoopMember', {
    id: 'missing-member', loopId: loop._id, firstName: 'Unknown',
  }, outsider.accessKeyId);
  assert.equal(outsiderMissing.status, 404, 'source finds the member before checking authorization');
  assert.equal(outsiderMissing.body.__type, 'MEMBER_NOT_FOUND');

  const locked = await post('Loop_20160324.UpdateLoopMember', {
    id: emailMember._id, loopId: loop._id, firstName: 'Denied',
  }, owner.accessKeyId);
  assert.equal(locked.status, 403);
  assert.equal(locked.body.__type, 'ONLY_INVITED_OR_CHILD_EDITABLE');

  // UpdateMember has no suspended-loop guard in the pinned source method.
  store.loops.get(loop._id).isSuspended = true;
  store.flush();
  const suspendedSourceCompatible = await post('Loop_20160324.UpdateLoopMember', {
    id: invited._id, loopId: loop._id, firstName: 'Still editable',
  }, robot.accessKeyId);
  assert.equal(suspendedSourceCompatible.status, 200);
  assert.equal(store.loops.get(loop._id).members.find((member) => member._id === invited._id)
    .memberProperties.firstName, 'Still editable');
});

test('UpdateLoopMember validates source fields, accepts unknown API-model fields, and handles JSON primitives', async () => {
  const owner = makeOwner('update-validation-owner');
  const { loop } = createLoop(store, { owner, robotId: nextLabel('update-validation-robot') });
  const target = addMember(loop, {
    _id: 'update-validation-target',
    status: MEMBER_STATUS.INVITED,
    memberProperties: { firstName: 'Original', birthday: 100 },
  });
  store.flush();

  const validNull = await post('Loop_20160324.UpdateLoopMember', {
    id: target._id, loopId: loop._id, birthday: null, ignored: { source: true },
  }, owner.accessKeyId);
  assert.equal(validNull.status, 200);
  assert.equal(store.loops.get(loop._id).members.find((member) => member._id === target._id)
    .memberProperties.birthday, 100, 'source `birthday || previous` preserves the existing value for null');

  const numericString = await post('Loop_20160324.UpdateLoopMember', {
    id: target._id, loopId: loop._id, birthday: '42',
  }, owner.accessKeyId);
  assert.equal(numericString.status, 200, 'Joi accepts a numeric string before the decorator discards conversion');
  assert.equal(store.loops.get(loop._id).members.find((member) => member._id === target._id)
    .memberProperties.birthday, 42, 'the persistence boundary casts the original string like Mongoose');

  const cases = [
    [{ loopId: loop._id }, 'id', 'is required'],
    [{ id: target._id }, 'loopId', 'is required'],
    [{ id: target._id, loopId: loop._id, birthday: 'old' }, 'birthday', 'must be a number'],
    [{ id: target._id, loopId: loop._id, birthday: ' ' }, 'birthday', 'must be a number'],
    [{ id: target._id, loopId: loop._id, email: 'not-an-email' }, 'email', 'must be a valid email'],
    [{ id: target._id, loopId: loop._id, gender: 'unknown' }, 'gender', 'must be one of'],
    [{ id: target._id, loopId: loop._id, phoneNumber: 7 }, 'phoneNumber', 'must be a string'],
  ];
  for (const [body, field, reason] of cases) {
    const response = await post('Loop_20160324.UpdateLoopMember', body, owner.accessKeyId);
    assert.equal(response.status, 422, field);
    assert.equal(response.body.statusCode, 422);
    assert.match(response.body.message, new RegExp(`^child "${field}" fails`));
    assert.match(response.body.message, new RegExp(reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  for (const primitive of [null, false, 0, 'text', []]) {
    const response = await post('Loop_20160324.UpdateLoopMember', primitive, owner.accessKeyId);
    assert.equal(response.status, 422, `primitive ${JSON.stringify(primitive)}`);
    assert.equal(response.body.message, '"value" must be an object');
  }
});

test('UpdateLoopMember failed outbox persistence leaves the shared loop, disk, and outbox unchanged', () => {
  const owner = makeOwner('update-failure-owner');
  const { loop } = createLoop(store, { owner, robotId: nextLabel('update-failure-robot') });
  const target = addMember(loop, {
    _id: 'update-failure-target',
    status: MEMBER_STATUS.INVITED,
    memberProperties: { firstName: 'Before' },
  });
  store.flush();
  const before = clone(store.loops.get(loop._id));
  const beforeDisk = readFileSync(store.file);
  const beforeOutbox = clone([...store.notificationOutbox.values()]);
  const reference = store.loops.get(loop._id);
  const rejectingOutbox = {
    record() {
      throw new Error('injected UpdateLoopMember persistence failure');
    },
  };

  assert.throws(() => updateMember(store, {
    ownerId: owner._id,
    loopId: loop._id,
    id: target._id,
    firstName: 'Must roll back',
  }, rejectingOutbox), /injected UpdateLoopMember persistence failure/);
  assert.deepEqual(store.loops.get(loop._id), before);
  assert.strictEqual(store.loops.get(loop._id), reference);
  assert.deepEqual(clone([...store.notificationOutbox.values()]), beforeOutbox);
  assert.deepEqual(readFileSync(store.file), beforeDisk);
});
