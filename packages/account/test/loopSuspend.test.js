import { signedLoopHeaders } from './fixtures/signedLoopRequest.js';
// A-04 bounded suspend contract through the Phoenix AWS-JSON face.
// Original Node 8 client/gateway differential controls are separately pinned in
// the parity evidence; this unit suite requires only declared workspace dependencies.

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
} = await import('../src/model.js');

const dir = mkdtempSync(join(tmpdir(), 'phx-a04-suspend-'));
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
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch (_) { /* zero-length source output */ }
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: parsed,
    rawBody: bytes.toString('utf8'),
  };
}

before(async () => {
  server = await createAccountService({ store }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

test('SuspendLoop/SuspendRobotLoop match source lookup, authorization, output, and durable state', async () => {
  const owner = createOwnerAccount(store, {
    email: 'a04-owner@example.test',
    password: 'owner-password',
    firstName: 'Owner',
  });
  const other = createOwnerAccount(store, {
    email: 'a04-other@example.test',
    password: 'other-password',
    firstName: 'Other',
  });
  const admin = createOwnerAccount(store, {
    email: 'a04-admin@example.test',
    password: 'admin-password',
    firstName: 'Admin',
  });
  admin.isAdmin = true;
  const { loop, robot } = createLoop(store, { owner, robotId: 'a04-known-robot' });
  const noLoopRobot = findOrCreateRobotAccount(store, 'a04-no-loop-robot');
  store.flush();

  // Source BaseLoopController.findById runs before the ownership check.
  const unknown = await post('Loop_20160324.SuspendLoop', { loopId: 'missing-loop' }, robot.accessKeyId);
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.__type, 'LOOP_NOT_FOUND');
  assert.equal(store.loops.get(loop._id).isSuspended, false);

  // Source suspendLoop permits only loop.robot or an administrator; owner is denied.
  const denied = await post('Loop_20160324.SuspendLoop', { loopId: loop._id }, owner.accessKeyId);
  assert.equal(denied.status, 403);
  assert.equal(denied.body.__type, 'ONLY_ADMIN_OR_ROBOT_CAN_SUSPEND');
  assert.equal(store.loops.get(loop._id).isSuspended, false);

  // A valid robot caller can suspend, and the source Loop pre-save hook writes updated.
  const command = await post('Loop_20160324.SuspendLoop', { loopId: loop._id }, robot.accessKeyId);
  assert.equal(command.status, 200);
  assert.deepEqual(command.body, { result: 'Command accepted' });
  assert.equal(store.loops.get(loop._id).isSuspended, true);
  assert.equal(typeof store.loops.get(loop._id).updated, 'number');

  const deniedAfterSuspend = await post('Loop_20160324.SuspendLoop', { loopId: loop._id }, owner.accessKeyId);
  assert.equal(deniedAfterSuspend.status, 403);
  assert.equal(deniedAfterSuspend.body.__type, 'ONLY_ADMIN_OR_ROBOT_CAN_SUSPEND');

  // State survives a new Store instance and is exposed through the source Loop list shape.
  const reopened = new Store(join(dir, 'store.json'));
  assert.equal(reopened.loops.get(loop._id).isSuspended, true);
  assert.equal(typeof reopened.loops.get(loop._id).updated, 'number');
  const ownerList = await post('Loop_20160324.ListLoops', {}, owner.accessKeyId);
  assert.equal(ownerList.status, 200);
  const listed = ownerList.body.find((item) => item.id === loop._id);
  assert.ok(listed);
  assert.equal(listed.isSuspended, true);
  assert.equal(typeof listed.updated, 'number');
  const suspendedRobotList = await post('Loop_20160324.ListLoops', {}, robot.accessKeyId);
  assert.equal(suspendedRobotList.status, 200);
  assert.deepEqual(suspendedRobotList.body, []);

  // SuspendRobotLoop is admin-only before its friendlyId lookup and the source handler
  // returns no command payload (the API model declares a null output).
  const nonAdminRobotLookup = await post(
    'Loop_20160324.SuspendRobotLoop',
    { friendlyId: 'missing-friendly-id' },
    owner.accessKeyId,
  );
  assert.equal(nonAdminRobotLookup.status, 401);
  assert.equal(nonAdminRobotLookup.body.__type, 'AUTHORIZED_UNDER_ADMIN');
  const missingRobot = await post('Loop_20160324.SuspendRobotLoop', { friendlyId: 'missing-friendly-id' }, admin.accessKeyId);
  assert.equal(missingRobot.status, 404);
  assert.equal(missingRobot.body.__type, 'ROBOT_NOT_FOUND');
  const missingLoop = await post('Loop_20160324.SuspendRobotLoop', { friendlyId: noLoopRobot.friendlyId }, admin.accessKeyId);
  assert.equal(missingLoop.status, 404);
  assert.equal(missingLoop.body.__type, 'LOOP_NOT_FOUND');
  const adminSuspend = await post('Loop_20160324.SuspendRobotLoop', { friendlyId: robot.friendlyId }, admin.accessKeyId);
  assert.equal(adminSuspend.status, 200);
  assert.equal(adminSuspend.rawBody, '');
  assert.equal(store.loops.get(loop._id).isSuspended, true);

  // Deleted loops are filtered by the source schema's find middleware.
  loop.isDeleted = true;
  store.flush();
  const deleted = await post('Loop_20160324.SuspendLoop', { loopId: loop._id }, robot.accessKeyId);
  assert.equal(deleted.status, 404);
  assert.equal(deleted.body.__type, 'LOOP_NOT_FOUND');

  // Both handlers use the source @validatePayload/Joi contract. The
  // validation decorator returns Boom.badData (HTTP 422) before lookup or
  // mutation, so the public response is Hapi's JSON envelope rather than the
  // AWS-JSON controller envelope used by lookup/authorization failures.
  const validationLoop = createLoop(store, { owner, robotId: 'a04-validation-robot' });
  store.flush();
  const validationCases = [
    { suffix: 'missing', value: undefined, message: 'child "FIELD" fails because ["FIELD" is required]' },
    { suffix: 'empty', value: '', message: 'child "FIELD" fails because ["FIELD" is not allowed to be empty]' },
    { suffix: 'null', value: null, message: 'child "FIELD" fails because ["FIELD" must be a string]' },
    { suffix: 'number', value: 42, message: 'child "FIELD" fails because ["FIELD" must be a string]' },
    { suffix: 'object', value: {}, message: 'child "FIELD" fails because ["FIELD" must be a string]' },
    { suffix: 'array', value: [], message: 'child "FIELD" fails because ["FIELD" must be a string]' },
  ];
  for (const operation of [
    { name: 'SuspendLoop', field: 'loopId', accessKeyId: validationLoop.robot.accessKeyId },
    { name: 'SuspendRobotLoop', field: 'friendlyId', accessKeyId: admin.accessKeyId },
  ]) {
    for (const item of validationCases) {
      const body = item.value === undefined ? {} : { [operation.field]: item.value };
      const invalid = await post(`Loop_20160324.${operation.name}`, body, operation.accessKeyId);
      assert.equal(invalid.status, 422, `${operation.name}/${item.suffix}`);
      assert.deepEqual(invalid.body, {
        statusCode: 422,
        error: 'Unprocessable Entity',
        message: item.message.replaceAll('FIELD', operation.field),
      }, `${operation.name}/${item.suffix}`);
      assert.equal(store.loops.get(validationLoop.loop._id).isSuspended, false);
    }
  }
  const validationFollowing = await post(
    'Loop_20160324.SuspendLoop',
    { loopId: validationLoop.loop._id },
    validationLoop.robot.accessKeyId,
  );
  assert.equal(validationFollowing.status, 200);
  assert.deepEqual(validationFollowing.body, { result: 'Command accepted' });
  assert.equal(store.loops.get(validationLoop.loop._id).isSuspended, true);

  // An x-amz-credentials JSON header is not a caller identity on this public face.
  const forgedAdmin = await fetch(`${base}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': 'Loop_20160324.SuspendRobotLoop',
      'x-amz-credentials': JSON.stringify({ isAdmin: true, id: admin._id }),
    },
    body: JSON.stringify({ friendlyId: robot.friendlyId }),
  });
  assert.equal(forgedAdmin.status, 401);
});
