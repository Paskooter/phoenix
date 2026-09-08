// A-05 bounded OOBE recovery controls against the pinned
// srv-account-ws@6cea43470825657d6a5722162f28c8f233153ee2 source.
// These tests use synthetic accounts/loops and an in-memory Store; no robot or
// live account service is contacted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createAccountService } from '../src/index.js';
import { Store } from '../src/store.js';
import { createOwnerAccount, createLoop, mintSetupToken, ACCESS_TOKEN_LIFETIME_MS } from '../src/model.js';

async function withService(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'phx-a05-oobe-'));
  const store = new Store(join(dir, 'store.json'));
  const service = await createAccountService({ store }).listen(0);
  const base = `http://127.0.0.1:${service.address().port}`;
  try {
    await fn({ base, store });
  } finally {
    await new Promise((resolve, reject) => service.close((error) => (error ? reject(error) : resolve())));
    rmSync(dir, { recursive: true, force: true });
  }
}

async function amz(base, target, body) {
  const response = await fetch(`${base}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': target,
      connection: 'close',
    },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { /* preserve status and raw framing only */ }
  return {
    status: response.status,
    errorType: response.headers.get('x-amzn-errortype'),
    contentType: response.headers.get('content-type'),
    body: parsed,
    raw,
  };
}

test('ReconnectRobot consumes a valid token, ignores optional id, and preserves token errors', async () => {
  await withService(async ({ base, store }) => {
    const owner = createOwnerAccount(store, {
      email: 'a05-reconnect-owner@synthetic.invalid', password: 'synthetic-password', firstName: 'Reconnect',
    });
    const token = mintSetupToken(store, owner._id);

    const accepted = await amz(base, 'OOBE_20161026.ReconnectRobot', {
      token: token._id, id: 'optional-id-is-ignored',
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.errorType, null);
    assert.deepEqual(accepted.body, { result: 'Command accepted' });
    assert.equal(accepted.contentType, 'application/x-amz-json-1.1');
    assert.equal(store.tokens.has(token._id), false);

    const replay = await amz(base, 'OOBE_20161026.ReconnectRobot', { token: token._id });
    assert.equal(replay.status, 404);
    assert.equal(replay.errorType, 'TOKEN_NOT_FOUND');
    assert.equal(replay.body.__type, 'TOKEN_NOT_FOUND');

    const expired = mintSetupToken(store, owner._id);
    store.tokens.get(expired._id).created = Date.now() - ACCESS_TOKEN_LIFETIME_MS - 1;
    const expiredResponse = await amz(base, 'OOBE_20161026.ReconnectRobot', { token: expired._id });
    assert.equal(expiredResponse.status, 401);
    assert.equal(expiredResponse.errorType, 'TOKEN_EXPIRED');
    assert.equal(store.tokens.has(expired._id), true, 'expiry must not consume the token');

    const invalidOptionalId = mintSetupToken(store, owner._id);
    const invalid = await amz(base, 'OOBE_20161026.ReconnectRobot', {
      token: invalidOptionalId._id, id: 7,
    });
    assert.equal(invalid.status, 422);
    assert.equal(invalid.body.statusCode, 422);
    assert.equal(store.tokens.has(invalidOptionalId._id), true, 'validation must precede token deletion');
  });
});

test('SetupRobot checks the token account against the loop owner before any revival mutation', async () => {
  await withService(async ({ base, store }) => {
    const owner = createOwnerAccount(store, {
      email: 'a05-loop-owner@synthetic.invalid', password: 'synthetic-password', firstName: 'Owner',
    });
    const other = createOwnerAccount(store, {
      email: 'a05-other-owner@synthetic.invalid', password: 'synthetic-password', firstName: 'Other',
    });
    const created = createLoop(store, { owner, robotId: 'a05-existing-robot' });
    const before = JSON.parse(JSON.stringify(created.loop));
    const token = mintSetupToken(store, other._id, created.loop._id);

    const response = await amz(base, 'OOBE_20161026.SetupRobot', {
      token: token._id, id: created.robot.friendlyId,
    });
    assert.equal(response.status, 401);
    assert.equal(response.errorType, 'OWNER_CAN_MANIPULATE');
    assert.equal(response.body.__type, 'OWNER_CAN_MANIPULATE');
    assert.equal(response.body.message, 'Only owner can manipulate loop or members');
    assert.equal(store.tokens.has(token._id), true);
    assert.deepEqual(store.loops.get(created.loop._id), before);
  });
});

test('SetupRobot validates required token/id before consuming a token', async () => {
  await withService(async ({ base, store }) => {
    const owner = createOwnerAccount(store, {
      email: 'a05-setup-validation@synthetic.invalid', password: 'synthetic-password', firstName: 'Validation',
    });
    const token = mintSetupToken(store, owner._id);
    const response = await amz(base, 'OOBE_20161026.SetupRobot', { token: token._id });
    assert.equal(response.status, 422);
    assert.equal(response.body.statusCode, 422);
    assert.match(response.body.message, /id.*required/);
    assert.equal(store.tokens.has(token._id), true);
  });
});

test('SetupRobot replaces the robot on an owner-owned suspended loop and unsuspends it', async () => {
  await withService(async ({ base, store }) => {
    const owner = createOwnerAccount(store, {
      email: 'a05-suspended-owner@synthetic.invalid', password: 'synthetic-password', firstName: 'Suspended',
    });
    const created = createLoop(store, { owner, robotId: 'a05-old-robot' });
    created.loop.isSuspended = true;
    store.flush();
    const oldRobotId = created.robot._id;
    const token = mintSetupToken(store, owner._id, created.loop._id);

    const response = await amz(base, 'OOBE_20161026.SetupRobot', {
      token: token._id, id: 'a05-new-robot',
    });
    assert.equal(response.status, 200);
    assert.match(response.body.accessKeyId, /^[A-Za-z0-9]{20}$/);
    assert.match(response.body.secretAccessKey, /^[A-Za-z0-9]{40}$/);
    assert.equal(store.tokens.has(token._id), false);

    const loop = store.loops.get(created.loop._id);
    const replacement = store.accountByFriendlyId('a05-new-robot');
    assert.equal(loop.isSuspended, false);
    assert.equal(loop.robot, replacement._id);
    assert.equal(loop.members.some((member) => member.accountId === oldRobotId), false);
    assert.equal(loop.members.filter((member) => member.accountId === replacement._id).length, 1);
    assert.equal(loop.members.find((member) => member.accountId === replacement._id).status, 'accepted');
    assert.equal(store.notificationOutbox.size, 1, 'the successful replacement save has one LoopUpdated row');
    assert.equal(store.notificationOutbox.values().next().value.notification.payload.robot, replacement._id);
  });
});

test('SetupRobot treats a token bound to a deleted loop as LOOP_NOT_FOUND and leaves the token', async () => {
  await withService(async ({ base, store }) => {
    const owner = createOwnerAccount(store, {
      email: 'a05-deleted-owner@synthetic.invalid', password: 'synthetic-password', firstName: 'Deleted',
    });
    const created = createLoop(store, { owner, robotId: 'a05-deleted-robot' });
    created.loop.isDeleted = true;
    store.flush();
    const token = mintSetupToken(store, owner._id, created.loop._id);

    const response = await amz(base, 'OOBE_20161026.SetupRobot', {
      token: token._id, id: created.robot.friendlyId,
    });
    assert.equal(response.status, 404);
    assert.equal(response.errorType, 'LOOP_NOT_FOUND');
    assert.equal(response.body.__type, 'LOOP_NOT_FOUND');
    assert.equal(response.body.message, 'Loop does not exist');
    assert.equal(store.tokens.has(token._id), true);
    assert.equal(store.loops.get(created.loop._id).isDeleted, true);
  });
});
