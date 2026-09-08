// A-04 Loop record operations: UpdateLoop, RemoveLoop, and ClearRobot.
// Fixtures are synthetic; source behavior is pinned to srv-account-ws@6cea434.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { createAccountService } = await import('../src/index.js');
const { Store } = await import('../src/store.js');
const { createOwnerAccount, createLoop, findOrCreateRobotAccount } = await import('../src/model.js');
const { clearRobot, removeLoop, updateLoop } = await import('../src/loopMembership.js');

function authorization(accessKeyId) {
  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/20260908/us-east-1/loop/aws4_request, SignedHeaders=host, Signature=fixture`;
}

async function closeServer(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function post(base, target, body, accessKeyId, extraHeaders = {}) {
  const headers = {
    'content-type': 'application/x-amz-json-1.1',
    'x-amz-target': target,
    ...extraHeaders,
  };
  if (accessKeyId) headers.authorization = authorization(accessKeyId);
  const response = await fetch(`${base}/`, {
    method: 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const rawBody = Buffer.from(await response.arrayBuffer()).toString('utf8');
  let bodyValue;
  try { bodyValue = JSON.parse(rawBody); } catch (_) { bodyValue = undefined; }
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: bodyValue,
    rawBody,
  };
}

function fixture(label) {
  const dir = mkdtempSync(join(tmpdir(), `phx-a04-loop-record-${label}-`));
  const store = new Store(join(dir, 'store.json'));
  const owner = createOwnerAccount(store, {
    email: `owner-${label}@synthetic.invalid`,
    password: 'owner-password',
    firstName: 'Loop',
    lastName: 'Owner',
  });
  const outsider = createOwnerAccount(store, {
    email: `outsider-${label}@synthetic.invalid`,
    password: 'outsider-password',
    firstName: 'Loop',
    lastName: 'Outsider',
  });
  const admin = createOwnerAccount(store, {
    email: `admin-${label}@synthetic.invalid`,
    password: 'admin-password',
    firstName: 'Loop',
    lastName: 'Admin',
  });
  admin.isAdmin = true;
  const { loop, robot } = createLoop(store, { owner, robotId: `robot-${label}` });
  store.flush();
  return { dir, store, owner, outsider, admin, loop, robot };
}

async function withService(label, callback) {
  const state = fixture(label);
  const service = createAccountService({ store: state.store });
  const server = await service.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await callback({ ...state, service, server, base });
  } finally {
    await closeServer(server);
    rmSync(state.dir, { recursive: true, force: true });
  }
}

test('UpdateLoop is owner-only, rejects suspended loops before any durable mutation, and emits CommandResponse', async () => {
  await withService('update', async ({ store, owner, outsider, loop, service, base }) => {
    const initialName = loop.name;
    const update = await post(base, 'Loop_20160324.UpdateLoop', {
      loopId: loop._id,
      name: 'Renamed synthetic loop',
    }, owner.accessKeyId);
    assert.equal(update.status, 200);
    assert.deepEqual(update.body, { result: 'Command accepted' });
    assert.equal(store.loops.get(loop._id).name, 'Renamed synthetic loop');
    assert.equal(service.loopUpdatedOutbox.pending().length, 1);
    assert.equal(service.loopUpdatedOutbox.pending()[0].notification.payload.name, 'Renamed synthetic loop');

    const denied = await post(base, 'Loop_20160324.UpdateLoop', {
      loopId: loop._id,
      name: 'outsider mutation',
    }, outsider.accessKeyId);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.__type, 'CAN_BE_ACCESSED_BY_OWNER');
    assert.equal(store.loops.get(loop._id).name, 'Renamed synthetic loop');

    const missing = await post(base, 'Loop_20160324.UpdateLoop', {
      loopId: 'missing-loop-id',
      name: 'missing',
    }, owner.accessKeyId);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.__type, 'LOOP_NOT_FOUND');

    const suspended = store.loops.get(loop._id);
    suspended.isSuspended = true;
    store.flush();
    const rejected = await post(base, 'Loop_20160324.UpdateLoop', {
      loopId: loop._id,
      name: 'must not leak',
    }, owner.accessKeyId);
    assert.equal(rejected.status, 403);
    assert.equal(rejected.body.__type, 'LOOP_SUSPENDED');
    assert.equal(store.loops.get(loop._id).name, 'Renamed synthetic loop');
    assert.equal(service.loopUpdatedOutbox.pending().length, 1);
    assert.notEqual(initialName, 'Renamed synthetic loop');
  });
});

test('UpdateLoop validation follows the source loopId/name Joi schema', async () => {
  await withService('update-validation', async ({ owner, loop, base }) => {
    const cases = [
      [{}, 'loopId'],
      [{ loopId: loop._id }, 'name'],
      [{ loopId: loop._id, name: '' }, 'name'],
      [{ loopId: 42, name: 'x' }, 'loopId'],
      [{ loopId: loop._id, name: 42 }, 'name'],
      [['loop', 'name'], 'value'],
    ];
    for (const [body, field] of cases) {
      const result = await post(base, 'Loop_20160324.UpdateLoop', body, owner.accessKeyId);
      assert.equal(result.status, 422, JSON.stringify(body));
      if (field === 'value') assert.equal(result.body.message, '"value" must be an object');
      else assert.match(result.body.message, new RegExp(`"${field}"`));
    }
  });
});

test('RemoveLoop soft-deletes only for the owner, clears robot association, and returns the populated Loop', async () => {
  await withService('remove', async ({ store, owner, outsider, admin, loop, robot, base }) => {
    const memberIds = store.loops.get(loop._id).members.map((member) => member._id);
    const denied = await post(base, 'Loop_20160324.RemoveLoop', { loopId: loop._id }, outsider.accessKeyId);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.__type, 'CAN_BE_ACCESSED_BY_OWNER');
    assert.equal(store.loops.get(loop._id).isDeleted, undefined);
    assert.equal(store.loops.get(loop._id).robot, robot._id);

    const adminDenied = await post(base, 'Loop_20160324.RemoveLoop', { loopId: loop._id }, admin.accessKeyId);
    assert.equal(adminDenied.status, 403, 'RemoveLoop supplies isAdmin:false in the source handler');
    assert.equal(adminDenied.body.__type, 'CAN_BE_ACCESSED_BY_OWNER');

    const removed = await post(base, 'Loop_20160324.RemoveLoop', { loopId: loop._id }, owner.accessKeyId);
    assert.equal(removed.status, 200);
    assert.equal(removed.body.id, loop._id);
    assert.equal(removed.body.name, loop.name);
    assert.equal(removed.body.robot, undefined);
    assert.deepEqual(removed.body.members.map((member) => member.id), memberIds);
    assert.equal(store.loops.get(loop._id).isDeleted, true);
    assert.equal(store.loops.get(loop._id).robot, undefined);
    assert.equal(store.accounts.get(robot._id).friendlyId, `robot-remove`);
    assert.deepEqual((await post(base, 'Loop_20160324.ListLoops', {}, owner.accessKeyId)).body, []);

    // Store.file is the exact committed snapshot path, so this avoids relying
    // on the process-wide default data file.
    const reopened = new Store(store.file);
    assert.equal(reopened.loops.get(loop._id).isDeleted, true);
    const second = await post(base, 'Loop_20160324.RemoveLoop', { loopId: loop._id }, owner.accessKeyId);
    assert.equal(second.status, 404);
    assert.equal(second.body.__type, 'LOOP_NOT_FOUND');
  });
});

test('RemoveLoop does not require suspension and validates loopId before dispatch', async () => {
  await withService('remove-suspended', async ({ store, owner, loop, base }) => {
    store.loops.get(loop._id).isSuspended = true;
    store.flush();
    const removed = await post(base, 'Loop_20160324.RemoveLoop', { loopId: loop._id }, owner.accessKeyId);
    assert.equal(removed.status, 200);
    assert.equal(removed.body.isSuspended, true);
    for (const body of [{}, { loopId: '' }, { loopId: 4 }, ['loop']]) {
      const validation = await post(base, 'Loop_20160324.RemoveLoop', body, owner.accessKeyId);
      assert.equal(validation.status, 422, JSON.stringify(body));
    }
  });
});

test('ClearRobot is admin-only, finds one active loop by friendlyId, and returns the soft-removed Loop', async () => {
  await withService('clear', async ({ store, owner, admin, loop, robot, base }) => {
    const forged = await post(base, 'Loop_20160324.ClearRobot', { robotId: robot.friendlyId }, owner.accessKeyId, {
      'x-amz-credentials': JSON.stringify({ id: admin._id, isAdmin: true }),
    });
    assert.equal(forged.status, 401);
    assert.equal(forged.body.__type, 'AUTHORIZED_UNDER_ADMIN');
    assert.equal(store.loops.get(loop._id).isDeleted, undefined);

    const missingBody = await post(base, 'Loop_20160324.ClearRobot', {}, admin.accessKeyId);
    assert.equal(missingBody.status, 422);
    assert.match(missingBody.body.message, /robotId/);
    const unknown = await post(base, 'Loop_20160324.ClearRobot', { robotId: 'missing-robot' }, admin.accessKeyId);
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.__type, 'ROBOT_NOT_FOUND');

    const cleared = await post(base, 'Loop_20160324.ClearRobot', { robotId: robot.friendlyId }, admin.accessKeyId);
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.id, loop._id);
    assert.equal(cleared.body.robot, undefined);
    assert.equal(cleared.body.members.some((member) => member.accountId === robot._id), true);
    assert.equal(store.loops.get(loop._id).isDeleted, true);
    assert.equal(store.loops.get(loop._id).robot, undefined);

    const again = await post(base, 'Loop_20160324.ClearRobot', { robotId: robot.friendlyId }, admin.accessKeyId);
    assert.equal(again.status, 404);
    assert.equal(again.body.__type, 'ROBOT_NOT_FOUND');

    const accountWithoutLoop = findOrCreateRobotAccount(store, 'clear-no-loop');
    const noLoop = await post(base, 'Loop_20160324.ClearRobot', { robotId: accountWithoutLoop.friendlyId }, admin.accessKeyId);
    assert.equal(noLoop.status, 404);
    assert.equal(noLoop.body.__type, 'ROBOT_NOT_FOUND');
  });
});

test('Loop record drafts do not leak rejected UpdateLoop, RemoveLoop, or ClearRobot mutations', () => {
  const state = fixture('failure');
  try {
    const before = JSON.parse(JSON.stringify(state.store.loops.get(state.loop._id)));
    const reference = state.store.loops.get(state.loop._id);
    const rejectingOutbox = { record() { throw new Error('injected loop persistence failure'); } };

    assert.throws(() => updateLoop(state.store, {
      ownerId: state.owner._id,
      loopId: state.loop._id,
      name: 'rejected update',
    }, rejectingOutbox), /injected loop persistence failure/);
    assert.deepEqual(state.store.loops.get(state.loop._id), before);
    assert.strictEqual(state.store.loops.get(state.loop._id), reference);

    assert.throws(() => removeLoop(state.store, {
      ownerId: state.owner._id,
      loopId: state.loop._id,
    }, rejectingOutbox), /injected loop persistence failure/);
    assert.deepEqual(state.store.loops.get(state.loop._id), before);
    assert.strictEqual(state.store.loops.get(state.loop._id), reference);

    assert.throws(() => clearRobot(state.store, {
      robotId: state.robot.friendlyId,
    }, rejectingOutbox), /injected loop persistence failure/);
    assert.deepEqual(state.store.loops.get(state.loop._id), before);
    assert.strictEqual(state.store.loops.get(state.loop._id), reference);
    assert.deepEqual(JSON.parse(readFileSync(state.store.file, 'utf8')).loops[0], before);
  } finally {
    rmSync(state.dir, { recursive: true, force: true });
  }
});
