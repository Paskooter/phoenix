// A-04 robot lookup operations through the Classic AWS-JSON face.
//
// Source: jiborobot/srv-account-ws@6cea43470825657d6a5722162f28c8f233153ee2
//   src/handlers/loop.handler.ts and src/controllers/{base.loop.ctrl,loop}.ts.
// API model: jiborobot/srv-jibo-server-client@155d20a8102960b2aeb89c197bdf04dc1f1fc344.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { createAccountService } = await import('../src/index.js');
const { Store } = await import('../src/store.js');
const { createOwnerAccount, findOrCreateRobotAccount } = await import('../src/model.js');
const { signSigV4 } = await import('@phoenix/common');

const dir = mkdtempSync(join(tmpdir(), 'phx-a04-robot-lookup-'));
const store = new Store(join(dir, 'store.json'));
let server;
let base;


async function post(target, body, accessKeyId, extraHeaders = {}) {
  let headers = {
    'content-type': 'application/x-amz-json-1.1',
    'x-amz-target': target,
    ...extraHeaders,
  };
  if (accessKeyId) {
    const account = store.accountByAccessKeyId(accessKeyId);
    headers = signSigV4({
      method: 'POST', path: '/',
      body: body === undefined ? '' : JSON.stringify(body),
      headers: { host: new URL(base).host, ...headers },
      accessKeyId, secretAccessKey: account.secretAccessKey,
      region: 'global', service: 'jibo',
    }).headers;
  }
  const response = await fetch(`${base}/`, {
    method: 'POST',
    // Keep these local mutation/lookup controls independent of stale
    // keep-alive sockets after synchronous fixture work. This is test-only
    // transport hygiene and intentionally does not retry a request.
    headers: { ...headers, connection: 'close' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  let parsed = null;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch (_) { /* empty response */ }
  return {
    status: response.status,
    errorType: response.headers.get('x-amzn-errortype'),
    body: parsed,
    rawBody: bytes.toString('utf8'),
  };
}

function addLoop({ id, owner, robot, members = [], isSuspended = false, isDeleted = false }) {
  const loop = {
    _id: id,
    owner: owner._id,
    robot: robot && robot._id,
    members,
    isSuspended,
    isDeleted,
    created: 1700000000000,
  };
  store.loops.set(id, loop);
  store.flush();
  return loop;
}

function member(accountId, status) {
  return { _id: `${accountId}-${status}`, accountId, status };
}

before(async () => {
  server = await createAccountService({ store }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

test('GetRobot validates, authorizes the owner, and returns the unsafe RobotAccount shape', async () => {
  const owner = createOwnerAccount(store, {
    email: 'a04-lookup-owner@example.test', password: 'owner-password', firstName: 'Owner',
  });
  const other = createOwnerAccount(store, {
    email: 'a04-lookup-other@example.test', password: 'other-password', firstName: 'Other',
  });
  const robot = findOrCreateRobotAccount(store, 'a04-lookup-robot');
  const loop = addLoop({
    id: 'a04-get-robot-loop',
    owner,
    robot,
    members: [member(owner._id, 'accepted'), member(robot._id, 'accepted')],
  });

  const result = await post('Loop_20160324.GetRobot', { loopId: loop._id }, owner.accessKeyId);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    accessKeyId: robot.accessKeyId,
    secretAccessKey: robot.secretAccessKey,
    friendlyId: robot.friendlyId,
  });
  assert.deepEqual(Object.keys(result.body).sort(), ['accessKeyId', 'friendlyId', 'secretAccessKey']);

  const forgedCredentialHeader = await post(
    'Loop_20160324.GetRobot',
    { loopId: loop._id },
    owner.accessKeyId,
    { 'x-amz-credentials': JSON.stringify({ id: other._id, isAdmin: true }) },
  );
  assert.equal(forgedCredentialHeader.status, 200);
  assert.equal(forgedCredentialHeader.body.friendlyId, robot.friendlyId);

  const denied = await post('Loop_20160324.GetRobot', { loopId: loop._id }, other.accessKeyId);
  assert.equal(denied.status, 403);
  assert.equal(denied.body.__type, 'CAN_BE_ACCESSED_BY_OWNER');
  assert.equal(denied.errorType, 'CAN_BE_ACCESSED_BY_OWNER');

  const anonymous = await post('Loop_20160324.GetRobot', { loopId: loop._id });
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.body.__type, 'MISSING_AUTH_HEADER');

  const missingLoop = await post('Loop_20160324.GetRobot', { loopId: 'a04-no-such-loop' }, other.accessKeyId);
  assert.equal(missingLoop.status, 404, 'source finds the loop before checking ownership');
  assert.equal(missingLoop.body.__type, 'LOOP_NOT_FOUND');

  for (const body of [{}, { loopId: '' }, { loopId: null }, { loopId: 4 }, { loopId: [] }]) {
    const invalid = await post('Loop_20160324.GetRobot', body, owner.accessKeyId);
    assert.equal(invalid.status, 422, `GetRobot validation: ${JSON.stringify(body)}`);
  }

  // Operation matching is case-insensitive, as the public dispatch layer is.
  const caseVariant = await post('Loop_20160324.gEtRoBoT', { loopId: loop._id }, owner.accessKeyId);
  assert.equal(caseVariant.status, 200);
  assert.equal(caseVariant.body.friendlyId, robot.friendlyId);
});

test('GetRobot keeps source stale-account failure distinct from ROBOT_NOT_FOUND', async () => {
  const owner = createOwnerAccount(store, {
    email: 'a04-stale-owner@example.test', password: 'owner-password', firstName: 'Stale',
  });
  const loop = addLoop({ id: 'a04-stale-robot-loop', owner, robot: null, members: [] });
  loop.robot = 'a04-account-that-was-deleted';
  store.flush();

  const result = await post('Loop_20160324.GetRobot', { loopId: loop._id }, owner.accessKeyId);
  assert.equal(result.status, 500);
  assert.equal(result.body.__type, 'InternalFailure');
  assert.notEqual(result.body.__type, 'ROBOT_NOT_FOUND');
});

test('FindOwner returns the first active loop owner for owner/member matches', async () => {
  const owner = createOwnerAccount(store, {
    email: 'a04-find-owner@example.test', password: 'owner-password', firstName: 'Find',
  });
  const memberAccount = createOwnerAccount(store, {
    email: 'a04-find-member@example.test', password: 'member-password', firstName: 'Member',
  });
  const removed = createOwnerAccount(store, {
    email: 'a04-find-removed@example.test', password: 'removed-password', firstName: 'Removed',
  });
  addLoop({
    id: 'a04-find-owner-loop',
    owner,
    members: [member(memberAccount._id, 'accepted'), member(removed._id, 'removed')],
  });
  addLoop({
    id: 'a04-find-deleted-loop',
    owner: removed,
    members: [member(memberAccount._id, 'accepted')],
    isDeleted: true,
  });

  const ownerResult = await post('Loop_20160324.FindOwner', { accountId: owner._id }, owner.accessKeyId);
  assert.equal(ownerResult.status, 200);
  assert.deepEqual(ownerResult.body, { id: owner._id });

  const memberResult = await post('Loop_20160324.FindOwner', { accountId: memberAccount._id }, owner.accessKeyId);
  assert.equal(memberResult.status, 200);
  assert.deepEqual(memberResult.body, { id: owner._id });

  // The source query does not filter member status; a removed member still has
  // a membership accountId and therefore resolves the containing active loop.
  const removedResult = await post('Loop_20160324.FindOwner', { accountId: removed._id }, owner.accessKeyId);
  assert.equal(removedResult.status, 200);
  assert.deepEqual(removedResult.body, { id: owner._id });

  const unknown = await post('Loop_20160324.FindOwner', { accountId: 'a04-no-loop-account' }, owner.accessKeyId);
  assert.equal(unknown.status, 200);
  assert.deepEqual(unknown.body, { id: null }, 'source Mongoose no-match preserves a null id');

  for (const body of [{}, { accountId: '' }, { accountId: null }, { accountId: 7 }, { accountId: [] }]) {
    const invalid = await post('Loop_20160324.FindOwner', body, owner.accessKeyId);
    assert.equal(invalid.status, 422, `FindOwner validation: ${JSON.stringify(body)}`);
  }
});

test('ListOwnerRobots follows source owner/member visibility, robot filtering, and ordering', async () => {
  const owner = createOwnerAccount(store, {
    email: 'a04-list-owner@example.test', password: 'owner-password', firstName: 'List',
  });
  const memberAccount = createOwnerAccount(store, {
    email: 'a04-list-member@example.test', password: 'member-password', firstName: 'Member',
  });
  const removedAccount = createOwnerAccount(store, {
    email: 'a04-list-removed-member@example.test', password: 'removed-password', firstName: 'Removed',
  });
  const robotA = findOrCreateRobotAccount(store, 'a04-list-robot-a');
  const robotB = findOrCreateRobotAccount(store, 'a04-list-robot-b');
  const robotC = findOrCreateRobotAccount(store, 'a04-list-robot-c');
  const robotRemoved = findOrCreateRobotAccount(store, 'a04-list-robot-removed');

  addLoop({
    id: 'a04-list-first',
    owner,
    robot: robotA,
    members: [member(owner._id, 'accepted'), member(robotA._id, 'accepted'), member(memberAccount._id, 'accepted')],
  });
  addLoop({
    id: 'a04-list-second',
    owner,
    robot: robotB,
    members: [member(owner._id, 'accepted'), member(robotB._id, 'accepted'), member(memberAccount._id, 'accepted')],
    isSuspended: true,
  });
  addLoop({
    id: 'a04-list-member-visible',
    owner,
    robot: robotC,
    members: [member(owner._id, 'accepted'), member(robotC._id, 'accepted'), member(memberAccount._id, 'accepted')],
  });
  addLoop({
    id: 'a04-list-invited-visible',
    owner,
    robot: null,
    members: [member(owner._id, 'accepted'), member(memberAccount._id, 'invited')],
  });
  addLoop({
    id: 'a04-list-removed-hidden',
    owner,
    robot: robotRemoved,
    members: [member(owner._id, 'accepted'), member(removedAccount._id, 'removed')],
  });
  addLoop({
    id: 'a04-list-deleted-hidden',
    owner,
    robot: findOrCreateRobotAccount(store, 'a04-list-robot-deleted'),
    members: [member(owner._id, 'accepted'), member(memberAccount._id, 'accepted')],
    isDeleted: true,
  });

  const ownerResult = await post('Loop_20160324.ListOwnerRobots', {}, owner.accessKeyId);
  assert.equal(ownerResult.status, 200);
  assert.deepEqual(ownerResult.body, [robotA.friendlyId, robotB.friendlyId, robotC.friendlyId, robotRemoved.friendlyId]);

  const memberResult = await post('Loop_20160324.ListOwnerRobots', {}, memberAccount.accessKeyId);
  assert.equal(memberResult.status, 200);
  assert.deepEqual(memberResult.body, [robotA.friendlyId, robotB.friendlyId, robotC.friendlyId]);

  // The optional accountId intentionally selects the query identity, even when
  // it differs from the signed caller, matching the source handler.
  const override = await post('Loop_20160324.ListOwnerRobots', { accountId: memberAccount._id }, owner.accessKeyId);
  assert.equal(override.status, 200);
  assert.deepEqual(override.body, memberResult.body);

  const robotResult = await post('Loop_20160324.ListOwnerRobots', {}, robotA.accessKeyId);
  assert.equal(robotResult.status, 200);
  assert.deepEqual(robotResult.body, [robotA.friendlyId]);

  const removedResult = await post('Loop_20160324.ListOwnerRobots', {}, removedAccount.accessKeyId);
  assert.equal(removedResult.status, 200);
  assert.deepEqual(removedResult.body, []);

  for (const body of [{ accountId: '' }, { accountId: null }, { accountId: 7 }, { accountId: [] }]) {
    const invalid = await post('Loop_20160324.ListOwnerRobots', body, owner.accessKeyId);
    assert.equal(invalid.status, 422, `ListOwnerRobots validation: ${JSON.stringify(body)}`);
  }
});

test('ListOwnerRobots preserves an unexpected stale robot as a 500 boundary', async () => {
  const owner = createOwnerAccount(store, {
    email: 'a04-list-stale-owner@example.test', password: 'owner-password', firstName: 'Stale',
  });
  addLoop({
    id: 'a04-list-stale-loop',
    owner,
    robot: { _id: 'a04-list-missing-robot' },
    members: [member(owner._id, 'accepted')],
  });

  const result = await post('Loop_20160324.ListOwnerRobots', {}, owner.accessKeyId);
  assert.equal(result.status, 500);
  assert.equal(result.body.__type, 'InternalFailure');
});
