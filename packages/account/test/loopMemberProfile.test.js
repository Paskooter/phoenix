import { signedLoopHeaders } from './fixtures/signedLoopRequest.js';
// A-04 bounded profile/enrollment operations through the source Loop face.
// The fixtures use synthetic accounts and member ids; no live account store is
// involved. Source Node 8 controls for these methods remain a separate seam.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { createAccountService } = await import('../src/index.js');
const { Store } = await import('../src/store.js');
const { createOwnerAccount, createLoop } = await import('../src/model.js');

const dir = mkdtempSync(join(tmpdir(), 'phx-a04-member-profile-'));
const store = new Store(join(dir, 'store.json'));
let server;
let base;


async function post(target, body, accessKeyId) {
  const response = await fetch(`${base}/`, {
    method: 'POST',
    headers: signedLoopHeaders(store, base, target, body, accessKeyId),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const rawBody = Buffer.from(await response.arrayBuffer()).toString('utf8');
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    rawBody,
    body: rawBody ? JSON.parse(rawBody) : null,
  };
}

function memberIn(body, id) {
  return body.members.find((member) => member.id === id);
}

before(async () => {
  server = await createAccountService({ store }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

test('SetEnrollment preserves omitted fields and returns the populated Loop', async () => {
  const owner = createOwnerAccount(store, {
    email: 'a04-profile-enrollment-owner@example.test',
    password: 'owner-password',
    firstName: 'Enrollment',
  });
  const { loop, robot } = createLoop(store, { owner, robotId: 'a04-profile-enrollment-robot' });
  const ownerMember = loop.members[0];
  store.flush();

  const first = await post('Loop_20160324.SetEnrollment', {
    face: true,
    id: ownerMember._id,
    loopId: loop._id,
  }, owner.accessKeyId);
  assert.equal(first.status, 200);
  assert.deepEqual(memberIn(first.body, ownerMember._id).enrolled, { face: true, voice: false });
  assert.deepEqual(store.loops.get(loop._id).members[0].enrolled, { face: true, voice: false });
  assert.equal(typeof store.loops.get(loop._id).updated, 'number');

  // The source only assigns a field when its value is a boolean. A robot caller
  // may update the other enrollment dimension without resetting face.
  const second = await post('Loop_20160324.SetEnrollment', {
    id: ownerMember._id,
    loopId: loop._id,
    voice: true,
  }, robot.accessKeyId);
  assert.equal(second.status, 200);
  assert.deepEqual(memberIn(second.body, ownerMember._id).enrolled, { face: true, voice: true });

  const noChange = await post('Loop_20160324.SetEnrollment', {
    id: ownerMember._id,
    loopId: loop._id,
  }, owner.accessKeyId);
  assert.equal(noChange.status, 200);
  assert.deepEqual(memberIn(noChange.body, ownerMember._id).enrolled, { face: true, voice: true });
  assert.equal(noChange.body.id, loop._id);
  assert.equal(noChange.body.members.length, 2);
});

test('UpdateNickname and UpdatePhoneticName assign strings/null and publish LoopUpdated state', async () => {
  const owner = createOwnerAccount(store, {
    email: 'a04-profile-names-owner@example.test',
    password: 'owner-password',
    firstName: 'Names',
  });
  const { loop, robot } = createLoop(store, { owner, robotId: 'a04-profile-names-robot' });
  const ownerMember = loop.members[0];
  store.flush();

  const nickname = await post('Loop_20160324.UpdateNickname', {
    id: ownerMember._id,
    loopId: loop._id,
    nickname: 'Home name',
  }, owner.accessKeyId);
  assert.equal(nickname.status, 200);
  assert.deepEqual(nickname.body, { result: 'Command accepted' });

  const phonetic = await post('Loop_20160324.UpdatePhoneticName', {
    id: ownerMember._id,
    loopId: loop._id,
    phoneticName: 'Ho-meh',
  }, robot.accessKeyId);
  assert.equal(phonetic.status, 200);
  assert.deepEqual(phonetic.body, { result: 'Command accepted' });

  const visible = await post('Loop_20160324.ListLoops', {}, owner.accessKeyId);
  const visibleMember = memberIn(visible.body.find((item) => item.id === loop._id), ownerMember._id);
  assert.equal(visibleMember.nickname, 'Home name');
  assert.equal(visibleMember.phoneticName, 'Ho-meh');

  const clearNickname = await post('Loop_20160324.UpdateNickname', {
    id: ownerMember._id,
    loopId: loop._id,
    nickname: null,
  }, robot.accessKeyId);
  const clearPhonetic = await post('Loop_20160324.UpdatePhoneticName', {
    id: ownerMember._id,
    loopId: loop._id,
    phoneticName: null,
  }, owner.accessKeyId);
  assert.equal(clearNickname.status, 200);
  assert.equal(clearPhonetic.status, 200);

  const cleared = await post('Loop_20160324.ListLoops', {}, owner.accessKeyId);
  const clearedMember = memberIn(cleared.body.find((item) => item.id === loop._id), ownerMember._id);
  assert.equal(clearedMember.nickname, null);
  assert.equal(clearedMember.phoneticName, null);

  const pending = [...store.notificationOutbox.values()]
    .filter((entry) => entry.notification?.payload?.id === loop._id);
  assert.equal(pending.length, 4);
  const lastMembers = pending[pending.length - 1].notification.payload.members;
  const eventMember = lastMembers.find((member) => member.memberId === ownerMember._id);
  assert.equal(eventMember.nickname, null);
  assert.equal(eventMember.phoneticName, null);
});

test('profile operations preserve source authorization and failure ordering', async () => {
  const owner = createOwnerAccount(store, {
    email: 'a04-profile-order-owner@example.test',
    password: 'owner-password',
    firstName: 'Order',
  });
  const outsider = createOwnerAccount(store, {
    email: 'a04-profile-order-outsider@example.test',
    password: 'outsider-password',
    firstName: 'Outsider',
  });
  const { loop, robot } = createLoop(store, { owner, robotId: 'a04-profile-order-robot' });
  const ownerMember = loop.members[0];
  store.flush();

  const operations = [
    ['SetEnrollment', { face: true }],
    ['UpdateNickname', { nickname: 'Denied' }],
    ['UpdatePhoneticName', { phoneticName: 'Denied' }],
  ];
  for (const [operation, field] of operations) {
    const denied = await post(`Loop_20160324.${operation}`, {
      ...field,
      id: ownerMember._id,
      loopId: loop._id,
    }, outsider.accessKeyId);
    assert.equal(denied.status, 403, operation);
    assert.equal(denied.body.__type, 'CAN_BE_ACCESSED_BY_OWNER_OR_ROBOT', operation);

    const deniedUnknownMember = await post(`Loop_20160324.${operation}`, {
      ...field,
      id: 'missing-member',
      loopId: loop._id,
    }, outsider.accessKeyId);
    assert.equal(deniedUnknownMember.status, 403, `${operation}/unknown-member`);
    assert.equal(deniedUnknownMember.body.__type, 'CAN_BE_ACCESSED_BY_OWNER_OR_ROBOT');

    const missingMember = await post(`Loop_20160324.${operation}`, {
      ...field,
      id: 'missing-member',
      loopId: loop._id,
    }, owner.accessKeyId);
    assert.equal(missingMember.status, 404, `${operation}/missing-member`);
    assert.equal(missingMember.body.__type, 'MEMBER_NOT_FOUND');
  }

  const missingLoop = await post('Loop_20160324.UpdateNickname', {
    id: ownerMember._id,
    loopId: 'missing-loop',
    nickname: 'No loop',
  }, owner.accessKeyId);
  assert.equal(missingLoop.status, 404);
  assert.equal(missingLoop.body.__type, 'LOOP_NOT_FOUND');

  const suspended = await post('Loop_20160324.SuspendLoop', { loopId: loop._id }, robot.accessKeyId);
  assert.equal(suspended.status, 200);
  const before = JSON.stringify(store.loops.get(loop._id).members);
  const suspendedUpdate = await post('Loop_20160324.UpdateNickname', {
    id: ownerMember._id,
    loopId: loop._id,
    nickname: 'Must not persist',
  }, owner.accessKeyId);
  assert.equal(suspendedUpdate.status, 403);
  assert.equal(suspendedUpdate.body.__type, 'LOOP_SUSPENDED');
  assert.equal(JSON.stringify(store.loops.get(loop._id).members), before);
});

test('profile payloads use source Joi presence and nullable rules', async () => {
  const owner = createOwnerAccount(store, {
    email: 'a04-profile-validation-owner@example.test',
    password: 'owner-password',
    firstName: 'Validation',
  });
  const { loop } = createLoop(store, { owner, robotId: 'a04-profile-validation-robot' });
  const ownerMember = loop.members[0];
  store.flush();

  const cases = [
    ['SetEnrollment', {}, 'id', 'is required'],
    ['SetEnrollment', { id: ownerMember._id }, 'loopId', 'is required'],
    ['SetEnrollment', { id: ownerMember._id, loopId: loop._id, face: null }, 'face', 'must be a boolean'],
    ['SetEnrollment', { id: ownerMember._id, loopId: loop._id, voice: 'yes' }, 'voice', 'must be a boolean'],
    ['UpdateNickname', { loopId: loop._id }, 'id', 'is required'],
    ['UpdateNickname', { id: ownerMember._id }, 'loopId', 'is required'],
    ['UpdateNickname', { id: ownerMember._id, loopId: loop._id, nickname: 7 }, 'nickname', 'must be a string'],
    ['UpdateNickname', { id: ownerMember._id, loopId: loop._id, nickname: '' }, 'nickname', 'is not allowed to be empty'],
    ['UpdatePhoneticName', { loopId: loop._id }, 'id', 'is required'],
    ['UpdatePhoneticName', { id: ownerMember._id }, 'loopId', 'is required'],
    ['UpdatePhoneticName', { id: ownerMember._id, loopId: loop._id, phoneticName: 7 }, 'phoneticName', 'must be a string'],
    ['UpdatePhoneticName', { id: ownerMember._id, loopId: loop._id, phoneticName: '' }, 'phoneticName', 'is not allowed to be empty'],
  ];
  for (const [operation, body, field, reason] of cases) {
    const response = await post(`Loop_20160324.${operation}`, body, owner.accessKeyId);
    assert.equal(response.status, 422, `${operation}/${field}`);
    assert.equal(response.body.statusCode, 422);
    assert.equal(response.body.error, 'Unprocessable Entity');
    assert.equal(response.body.message, `child "${field}" fails because ["${field}" ${reason}]`);
  }

  // Source schemas explicitly allow null for these two fields.
  const nickname = await post('Loop_20160324.UpdateNickname', {
    id: ownerMember._id,
    loopId: loop._id,
    nickname: null,
  }, owner.accessKeyId);
  const phonetic = await post('Loop_20160324.UpdatePhoneticName', {
    id: ownerMember._id,
    loopId: loop._id,
    phoneticName: null,
  }, owner.accessKeyId);
  assert.equal(nickname.status, 200);
  assert.equal(phonetic.status, 200);
});


test('failed persistence keeps member fields, timestamps and outbox unchanged', async () => {
  const owner = createOwnerAccount(store, { email: 'failure-owner@example.test', password: 'fixture-password' });
  const { loop } = createLoop(store, { owner, robotId: 'failure-robot' });
  store.flush();
  const beforeLoop = JSON.parse(JSON.stringify(store.loops.get(loop._id)));
  const beforeOutbox = JSON.parse(JSON.stringify([...store.notificationOutbox]));
  const beforeDisk = readFileSync(store.file);
  const realFlush = store.flush;
  try {
    store.flush = () => { throw new Error('injected disk failure'); };
    for (const [operation, fields] of [
      ['SetEnrollment', { voice: true }],
      ['UpdateNickname', { nickname: 'Failed name' }],
      ['UpdatePhoneticName', { phoneticName: 'Failed phonetic' }],
    ]) {
      const response = await post('Loop_20160324.' + operation,
        { loopId: loop._id, id: loop.members[0]._id, ...fields }, owner.accessKeyId);
      assert.equal(response.status, 500);
      assert.deepEqual(JSON.parse(JSON.stringify(store.loops.get(loop._id))), beforeLoop);
      assert.deepEqual(JSON.parse(JSON.stringify([...store.notificationOutbox])), beforeOutbox);
      assert.deepEqual(readFileSync(store.file), beforeDisk);
    }
  } finally { store.flush = realFlush; }
  store.flush();
  assert.deepEqual(new Store(store.file).loops.get(loop._id), beforeLoop);
});


test('source-valid string booleans save without changing enrollment values', async () => {
  const owner = createOwnerAccount(store, { email: 'string-boolean-owner@example.test', password: 'fixture-password' });
  const { loop } = createLoop(store, { owner, robotId: 'string-boolean-robot' });
  loop.members[0].enrolled = { face: false, voice: true };
  store.flush();
  for (const [face, voice] of [['true','false'],['TRUE','FALSE'],['True','False']]) {
    const beforeEvents = store.notificationOutbox.size;
    const response = await post('Loop_20160324.SetEnrollment',
      { loopId: loop._id, id: loop.members[0]._id, face, voice }, owner.accessKeyId);
    assert.equal(response.status, 200);
    assert.deepEqual(memberIn(response.body, loop.members[0]._id).enrolled, { face: false, voice: true });
    assert.equal(store.notificationOutbox.size, beforeEvents + 1);
    assert.equal(typeof store.loops.get(loop._id).updated, 'number');
  }
  assert.deepEqual(new Store(store.file).loops.get(loop._id).members[0].enrolled, { face: false, voice: true });
});

test('valid JSON primitives reach profile validation without changing state', async () => {
  const caller = createOwnerAccount(store, { email: 'primitive-auth@fixture.test', password: 'fixture-password' });
  const beforeDisk = readFileSync(store.file);
  const beforeOutbox = JSON.parse(JSON.stringify([...store.notificationOutbox]));
  for (const operation of ['SetEnrollment', 'UpdateNickname', 'UpdatePhoneticName']) {
    for (const payload of [null, false, true, 0, 7, 'text', []]) {
      const response = await post('Loop_20160324.' + operation, payload, caller.accessKeyId);
      assert.equal(response.status, 422);
    }
  }
  const malformed = await fetch(`${base}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'Loop_20160324.SetEnrollment' },
    body: '{',
  });
  assert.equal(malformed.status, 400, 'invalid JSON remains a parser error');
  await malformed.arrayBuffer();
  assert.deepEqual(readFileSync(store.file), beforeDisk);
  assert.deepEqual(JSON.parse(JSON.stringify([...store.notificationOutbox])), beforeOutbox);
});
