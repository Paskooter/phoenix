// A-04 public UpdateLoopMember controls.
// Source boundary: srv-account-ws@6cea43470825657d6a5722162f28c8f233153ee2
// and srv-security-gw@43a692f. Every account, key, and member in this file is
// synthetic; no household data is used.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { signSigV4 } from '@phoenix/common';

const { createAccountService } = await import('../src/index.js');
const { Store } = await import('../src/store.js');
const { createOwnerAccount, createLoop, MEMBER_STATUS } = await import('../src/model.js');
const { createClassicEntrypoint } = await import('../../classic/src/index.js');

const directory = mkdtempSync(join(tmpdir(), 'phx-a04-public-auth-'));
const store = new Store(join(directory, 'account.json'));
const target = 'Loop_20160324.UpdateLoopMember';

let accountServer;
let classicServer;
let accountBase;
let classicBase;
let owner;
let outsider;
let loop;
let targetMember;
let classicTarget;
const priorNetAccount = process.env.NET_account;

function signedRequest(base, payload, credentials, { targetName = target, mutateHeaders = {}, secretAccessKey } = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const signed = signSigV4({
    method: 'POST',
    path: '/',
    body,
    headers: {
      Host: new URL(base).host,
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': targetName,
    },
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: secretAccessKey || credentials.secretAccessKey,
    region: 'global',
    service: 'jibo',
    date: new Date(),
  });
  return { headers: { ...signed.headers, ...mutateHeaders }, body };
}

async function post(base, request, { body = request.body, headers = request.headers } = {}) {
  const response = await fetch(`${base}/`, { method: 'POST', headers, body });
  const rawBody = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(rawBody); } catch { /* preserve non-JSON response */ }
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    rawBody,
    body: parsed,
  };
}

function addInvitedMember(id) {
  const member = {
    _id: id,
    status: MEMBER_STATUS.INVITED,
    memberProperties: { firstName: 'Before', birthday: 1 },
    enrolled: { face: false, voice: false },
  };
  loop.members.push(member);
  store.flush();
  return member;
}

function assertValidation(response) {
  assert.equal(response.status, 422);
  assert.equal(response.body.statusCode, 422);
  assert.equal(response.body.error, 'Unprocessable Entity');
  assert.match(response.body.message, /value.*object/);
}

before(async () => {
  owner = createOwnerAccount(store, {
    email: 'a04-public-owner@fixture.test',
    password: 'synthetic-password',
    firstName: 'Owner',
  });
  outsider = createOwnerAccount(store, {
    email: 'a04-public-outsider@fixture.test',
    password: 'synthetic-password',
    firstName: 'Outsider',
  });
  ({ loop } = createLoop(store, { owner, robotId: 'a04-public-robot' }));
  targetMember = addInvitedMember('a04-public-target');
  classicTarget = addInvitedMember('a04-public-classic-target');

  const account = createAccountService({ store });
  accountServer = await account.listen(0);
  accountBase = `http://127.0.0.1:${accountServer.address().port}`;

  process.env.NET_account = `127.0.0.1:${accountServer.address().port}`;
  const classic = createClassicEntrypoint();
  classicServer = await classic.listen(0);
  classicBase = `http://127.0.0.1:${classicServer.address().port}`;
});

after(async () => {
  if (classicServer?.listening) await new Promise((resolve) => classicServer.close(resolve));
  if (accountServer?.listening) await new Promise((resolve) => accountServer.close(resolve));
  if (priorNetAccount === undefined) delete process.env.NET_account;
  else process.env.NET_account = priorNetAccount;
  rmSync(directory, { recursive: true, force: true });
});

test('Account verifies the signed caller before UpdateMember Joi validation', async () => {
  const before = JSON.stringify(store.loops.get(loop._id));
  const malformed = JSON.stringify({ id: targetMember._id, loopId: loop._id, birthday: 'not-a-number' });
  const unsigned = await post(accountBase, {
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': target,
    },
    body: malformed,
  });
  assert.equal(unsigned.status, 401);
  assert.equal(unsigned.body.__type, 'MISSING_AUTH_HEADER');
  assert.equal(JSON.stringify(store.loops.get(loop._id)), before);

  const signed = signedRequest(accountBase, {
    id: targetMember._id,
    loopId: loop._id,
    birthday: '42',
  }, owner);
  const accepted = await post(accountBase, signed);
  assert.equal(accepted.status, 200);
  const persisted = store.loops.get(loop._id).members.find((member) => member._id === targetMember._id);
  assert.equal(persisted.memberProperties.birthday, 42);
  assert.equal(accepted.body.members.find((member) => member.id === targetMember._id).account.birthday, 42);
});

test('UpdateMember rejects unknown and wrong-secret signatures before state changes', async () => {
  const body = { id: targetMember._id, loopId: loop._id, firstName: 'Should not apply' };
  const before = JSON.stringify(store.loops.get(loop._id));
  const unknown = { accessKeyId: 'A04-UNKNOWN-KEY', secretAccessKey: 'A04-UNKNOWN-SECRET' };
  const unknownResponse = await post(accountBase, signedRequest(accountBase, body, unknown));
  assert.equal(unknownResponse.status, 401);
  assert.equal(unknownResponse.body.__type, 'ACCESS_KEY_NOT_FOUND');

  const wrongSecret = await post(accountBase, signedRequest(accountBase, body, owner, {
    secretAccessKey: 'A04-WRONG-SECRET',
  }));
  assert.equal(wrongSecret.status, 401);
  assert.equal(wrongSecret.body.__type, 'SIGNATURE_MISMATCH');
  assert.equal(JSON.stringify(store.loops.get(loop._id)), before);
});

test('verified SigV4 identity cannot be replaced by x-amz-credentials', async () => {
  const before = JSON.stringify(store.loops.get(loop._id));
  const forged = JSON.stringify({ id: owner._id, accessKeyId: owner.accessKeyId });
  const request = signedRequest(accountBase, {
    id: targetMember._id,
    loopId: loop._id,
    firstName: 'Forged header must not authorize outsider',
  }, outsider, { mutateHeaders: { 'x-amz-credentials': forged } });
  const response = await post(accountBase, request);
  assert.equal(response.status, 403);
  assert.equal(response.body.__type, 'CAN_BE_ACCESSED_BY_OWNER_OR_ROBOT');
  assert.equal(JSON.stringify(store.loops.get(loop._id)), before);
});

test('Account preserves primitive JSON for the source Joi object error after auth', async () => {
  const request = signedRequest(accountBase, null, owner);
  const response = await post(accountBase, request);
  assertValidation(response);
  assert.equal(JSON.stringify(store.loops.get(loop._id).members.find((member) => member._id === targetMember._id)
    .memberProperties), JSON.stringify({ firstName: 'Before', birthday: 42 }));
});

test('Classic forwards a signed UpdateMember body and primitive validation to Account', async () => {
  const valid = signedRequest(classicBase, {
    id: classicTarget._id,
    loopId: loop._id,
    firstName: 'Through Classic',
  }, owner);
  const accepted = await post(classicBase, valid);
  assert.equal(accepted.status, 200);
  assert.equal(store.loops.get(loop._id).members.find((member) => member._id === classicTarget._id)
    .memberProperties.firstName, 'Through Classic');

  const primitive = signedRequest(classicBase, null, owner);
  const invalid = await post(classicBase, primitive);
  assertValidation(invalid);
});

test('Classic retains the authenticated boundary when the forwarded body is tampered', async () => {
  const request = signedRequest(classicBase, {
    id: classicTarget._id,
    loopId: loop._id,
    firstName: 'Signed value',
  }, owner);
  const before = JSON.stringify(store.loops.get(loop._id));
  const tampered = await post(classicBase, request, {
    body: JSON.stringify({ id: classicTarget._id, loopId: loop._id, firstName: 'Tampered' }),
  });
  assert.equal(tampered.status, 401);
  assert.equal(tampered.body.__type, 'SIGNATURE_MISMATCH');
  assert.equal(JSON.stringify(store.loops.get(loop._id)), before);
});
