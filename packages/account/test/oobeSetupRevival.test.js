// A-05 — OOBE setup lifecycle: suspended-loop robot replacement, the
// not-deleted loop/account gates, per-owner getLoopName, the new-loop create()
// sequence, and the OOBE @validatePayload envelope.
//
// Pinned source: jiborobot/srv-account-ws@6cea43470825657d6a5722162f28c8f233153ee2
//   src/handlers/oobe.handler.ts     — mapping + @parseCredentials/@validatePayload
//   src/controllers/oobe.ctrl.ts     — setupRobot / getServiceToken
//   src/controllers/loop.ctrl.ts     — create, getRobot, findOrCreateRobotAccount,
//                                      removeRobotFromLoops
//   src/controllers/token.ctrl.ts    — create/findById/deleteToken
//   src/controllers/base.loop.ctrl.ts— findById -> LOOP_NOT_FOUND
//   src/errors/{loop,account,token}.ts — {code, message, statusCode}
//   src/schemes/{loop,member.status}.ts — member defaults, stored status values
// API shapes: jiborobot/srv-jibo-server-client
//   apis/oobe-2016-10-26.normal.json, apis/oobeadmin-2016-10-26.normal.json
//
// Gateway admissibility (jiborobot/srv-security-gw src/controllers/auth.ctrl.ts
// `unauthorizedMethods`): OOBE_20161026.GetStatus and OOBE_20161026.SetupRobot
// accept an absent Authorization; PrepareRobot, ReconnectRobot and GetServiceToken
// do not, and GetServiceToken is additionally @parseCredentials({adminOnly:true}).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'phx-oobe-setup-'));
process.env.ETCO_account_dataFile = join(dir, 'store.json');
delete process.env.NET_robotread;

const { createAccountService, getStore, Store } = await import('../src/index.js');
const { createOwnerAccount, createLoop, mintSetupToken, ACCESS_TOKEN_LIFETIME_MS } = await import('../src/model.js');

// Robot registry stub. A missing id rejects, which the source tolerates
// (`try { robot = await robotClient.getRobot(robotId) } catch { warn }`); a
// present id returns the registry document.
const registry = new Map();
const robotReadClient = {
  async getRobot(friendlyId) {
    if (!registry.has(friendlyId)) throw new Error('Robot read service is not configured');
    return registry.get(friendlyId);
  },
};

let server; let base;
const sig = (keyId) => `AWS4-HMAC-SHA256 Credential=${keyId}/20260612/us-east-1/account/aws4_request, SignedHeaders=host, Signature=feedface`;

async function amz(target, body, headers = {}) {
  const res = await fetch(`${base}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': target,
      ...headers,
      connection: 'close',
    },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    errType: res.headers.get('x-amzn-errortype'),
    contentType: res.headers.get('content-type'),
    body: await res.json().catch(() => null),
  };
}

let seq = 0;
const nextId = (label) => `${label}-${seq += 1}`;
function owner(label, firstName) {
  return createOwnerAccount(getStore(), {
    email: `${nextId(label)}@synthetic.invalid`,
    password: 'synthetic-password',
    firstName: firstName === undefined ? label : firstName,
  });
}

before(async () => {
  server = await createAccountService({ robotReadClient }).listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
// suspended-loop robot replacement
// ---------------------------------------------------------------------------

test('SetupRobot replaces the robot on the owner\'s suspended loop and unsuspends it', async () => {
  const store = getStore();
  const o = owner('replacement-owner', 'Replacer');
  const created = createLoop(store, { owner: o, robotId: nextId('old-robot') });
  const oldRobot = store.accountByFriendlyId(created.robot.friendlyId);
  created.loop.isSuspended = true;
  store.flush();

  const token = mintSetupToken(store, o._id, created.loop._id);
  const outboxBefore = store.notificationOutbox.size;

  const r = await amz('OOBE_20161026.SetupRobot', { token: token._id, id: 'oobe-replacement-robot' });
  assert.equal(r.status, 200);
  assert.equal(r.errType, null);

  const replacement = store.accountByFriendlyId('oobe-replacement-robot');
  assert.ok(replacement, 'the replacement robot account exists');
  // RobotCredentials from loopCtrl.getRobot(loop.robot) — the NEW robot's keys.
  assert.equal(r.body.accessKeyId, replacement.accessKeyId);
  assert.equal(r.body.secretAccessKey, replacement.secretAccessKey);
  assert.equal(replacement.accessKeyId === oldRobot.accessKeyId, false, 'not the old robot keys');
  assert.ok(!('serviceMode' in r.body) || r.body.serviceMode == null, 'a normal owner leaves serviceMode absent');

  // ONE-TIME: the setup token is consumed exactly here (tokenCtrl.deleteToken).
  assert.equal(store.tokens.has(token._id), false, 'the setup token is consumed');
  const replay = await amz('OOBE_20161026.SetupRobot', { token: token._id, id: 'oobe-replacement-robot' });
  assert.equal(replay.status, 404);
  assert.equal(replay.body.__type, 'TOKEN_NOT_FOUND');

  const loop = store.loops.get(created.loop._id);
  assert.equal(loop.isSuspended, false, 'the loop is unsuspended');
  assert.equal(loop.robot, replacement._id, 'the loop now points at the replacement');
  assert.equal(loop.members.some((m) => m.accountId === oldRobot._id), false, 'old robot membership is gone');
  const stuck = loop.members.filter((m) => m.accountId === replacement._id);
  assert.equal(stuck.length, 1, 'exactly one replacement membership');
  // memberSchema defaults applied by Mongoose to the pushed {accountId, status}.
  assert.equal(stuck[0].status, 'accepted');
  assert.equal(typeof stuck[0].created, 'number');
  assert.deepEqual(stuck[0].enrolled, { face: false, voice: false });
  assert.equal(stuck[0].invitedAsLegalGuardian, false);
  assert.deepEqual(stuck[0].memberProperties, { isChild: false });

  // Persisted, not just in-process. The LoopUpdated outbox has exactly one new
  // row: the detach saved a robot-less (therefore unroutable) loop with no row.
  assert.equal(store.notificationOutbox.size, outboxBefore + 1, 'one LoopUpdated row for the replacement save');
  const row = [...store.notificationOutbox.values()].pop();
  assert.equal(row.notification.payload.robot, replacement._id);
  assert.equal(row.notification.payload.isSuspended, false);
  assert.equal(row.accountId, replacement._id);

  const reopened = new Store(store.file).loops.get(created.loop._id);
  assert.equal(reopened.robot, replacement._id);
  assert.equal(reopened.isSuspended, false);
  assert.deepEqual(reopened.members.find((m) => m.accountId === replacement._id), stuck[0],
    'member defaults survive a Store reopen');
});

test('SetupRobot detaches the replacement robot from the loop it already owned', async () => {
  const store = getStore();
  const o = owner('roamer-owner', 'Roamer');
  // The replacement robot already lives on its own loop.
  const first = createLoop(store, { owner: o, robotId: 'oobe-roamer-robot' });
  const roamer = store.accountByFriendlyId('oobe-roamer-robot');
  assert.equal(first.loop.isSuspended, false);

  // A second, suspended loop of the same owner is being handed to that robot.
  const second = createLoop(store, { owner: o, robotId: nextId('handover-robot') });
  second.loop.isSuspended = true;
  store.flush();
  const token = mintSetupToken(store, o._id, second.loop._id);

  const r = await amz('OOBE_20161026.SetupRobot', { token: token._id, id: 'oobe-roamer-robot' });
  assert.equal(r.status, 200);
  assert.equal(r.body.accessKeyId, roamer.accessKeyId, 'the roaming robot keeps and re-receives its own keys');

  // loop.ctrl.ts create/removeRobotFromLoops: the robot's previous loop loses the
  // association and is suspended, and its robot membership is removed.
  const vacated = store.loops.get(first.loop._id);
  assert.equal(vacated.robot, undefined, 'the previous loop has no robot');
  assert.equal(vacated.isSuspended, true, 'the previous loop is suspended');
  assert.equal(vacated.members.some((m) => m.accountId === roamer._id), false);

  const handedOver = store.loops.get(second.loop._id);
  assert.equal(handedOver.robot, roamer._id);
  assert.equal(handedOver.isSuspended, false);
});

test('SetupRobot refuses a different robot on a live loop with the exact source message', async () => {
  const store = getStore();
  const o = owner('live-loop-owner', 'Liveoak');
  const created = createLoop(store, { owner: o, robotId: nextId('incumbent-robot') });
  const before = JSON.parse(JSON.stringify(created.loop));
  const token = mintSetupToken(store, o._id, created.loop._id);

  const r = await amz('OOBE_20161026.SetupRobot', { token: token._id, id: 'oobe-intruder-robot' });
  assert.equal(r.status, 409);
  assert.equal(r.body.__type, 'LOOP_MUST_BE_SUSPENDED');
  // errors/loop.ts LOOP_MUST_BE_SUSPENDED.message, verbatim.
  assert.equal(r.body.message, 'Loop must be suspended prior to robot change');
  assert.equal(r.errType, 'LOOP_MUST_BE_SUSPENDED');
  assert.ok(store.tokens.has(token._id), 'a refused re-setup does not consume the token');
  assert.equal(store.accountByFriendlyId('oobe-intruder-robot'), null, 'no robot account is minted on refusal');
  assert.deepEqual(store.loops.get(created.loop._id), before, 'the live loop is untouched');
});

test('SetupRobot re-issues the incumbent credentials to the same robot on a live loop', async () => {
  const store = getStore();
  const o = owner('same-robot-owner', 'Sammy');
  const created = createLoop(store, { owner: o, robotId: nextId('same-robot') });
  const token = mintSetupToken(store, o._id, created.loop._id);

  const r = await amz('OOBE_20161026.SetupRobot', { token: token._id, id: created.robot.friendlyId });
  assert.equal(r.status, 200);
  assert.equal(r.body.accessKeyId, created.robot.accessKeyId, 'same robot keeps its keys');
  assert.equal(store.tokens.has(token._id), false, 'token consumed');
  assert.equal(store.loops.get(created.loop._id).isSuspended, false);
});

test('SetupRobot treats a token bound to a soft-deleted loop as LOOP_NOT_FOUND', async () => {
  const store = getStore();
  const o = owner('deleted-loop-owner', 'Deleted');
  const created = createLoop(store, { owner: o, robotId: nextId('deleted-loop-robot') });
  created.loop.isDeleted = true;
  store.flush();
  const token = mintSetupToken(store, o._id, created.loop._id);

  const r = await amz('OOBE_20161026.SetupRobot', { token: token._id, id: created.robot.friendlyId });
  assert.equal(r.status, 404);
  assert.equal(r.body.__type, 'LOOP_NOT_FOUND');
  // errors/loop.ts LOOP_NOT_FOUND.message — BaseLoopController.findById throws it;
  // the schema's not-deleted find middleware excludes the soft-deleted row.
  assert.equal(r.body.message, 'Loop does not exist');
  assert.equal(r.errType, 'LOOP_NOT_FOUND');
  assert.ok(store.tokens.has(token._id), 'token survives');
  assert.equal(store.loops.get(created.loop._id).isDeleted, true);
});

test('SetupRobot reports a deleted token account as ACCOUNT_IS_DELETED', async () => {
  const store = getStore();
  const o = owner('deleted-account-owner', 'Gone');
  const token = mintSetupToken(store, o._id, null);
  o.isDeleted = true;
  store.flush();

  const r = await amz('OOBE_20161026.SetupRobot', { token: token._id, id: 'oobe-after-delete-robot' });
  assert.equal(r.status, 404);
  assert.equal(r.body.__type, 'ACCOUNT_IS_DELETED');
  assert.equal(r.body.message, 'Account is removed');
  assert.ok(store.tokens.has(token._id), 'token survives');
  assert.equal(store.accountByFriendlyId('oobe-after-delete-robot'), null, 'nothing is created');
});

test('SetupRobot reports a deleted incumbent robot on a live loop as ACCOUNT_IS_DELETED', async () => {
  const store = getStore();
  const o = owner('deleted-robot-owner', 'Doomed');
  const created = createLoop(store, { owner: o, robotId: nextId('doomed-robot') });
  created.robot.isDeleted = true;
  store.flush();
  const token = mintSetupToken(store, o._id, created.loop._id);

  const r = await amz('OOBE_20161026.SetupRobot', { token: token._id, id: created.robot.friendlyId });
  assert.equal(r.status, 404);
  assert.equal(r.body.__type, 'ACCOUNT_IS_DELETED');
  assert.ok(store.tokens.has(token._id), 'token survives');
});

// ---------------------------------------------------------------------------
// the new-loop create() path
// ---------------------------------------------------------------------------

test('SetupRobot mints a second loop for a re-added robot and leaves the first one suspended', async () => {
  const store = getStore();
  const o = owner('readd-owner', 'Readd');
  const first = createLoop(store, { owner: o, robotId: 'oobe-readd-robot' });

  // The portal mints a fresh, unbound token for the same robot.
  const token = mintSetupToken(store, o._id, null);
  const r = await amz('OOBE_20161026.SetupRobot', { token: token._id, id: 'oobe-readd-robot' });
  assert.equal(r.status, 200);

  const loops = [...store.loops.values()].filter((l) => l.owner === o._id);
  assert.equal(loops.length, 2, 'a second loop, not a reused one');
  const original = store.loops.get(first.loop._id);
  assert.equal(original.isSuspended, true, 'the first loop is suspended by removeRobotFromLoops');
  assert.equal(original.robot, undefined);
  const fresh = loops.find((l) => l._id !== first.loop._id);
  assert.equal(fresh.robot, first.robot._id);
  // getLoopName({account}) -> listOwnerLoops: only the owner's own loops dedupe.
  assert.equal(fresh.name, 'Readd\'s 2 Jibo');
  assert.equal(r.body.accessKeyId, first.robot.accessKeyId);
});

test('getLoopName dedupes against the owner\'s loops only, not every loop in the store', async () => {
  const store = getStore();
  // Another household already has a loop named "Dee's Jibo".
  const stranger = owner('stranger-owner', 'Stranger');
  const theirLoop = createLoop(store, { owner: stranger, robotId: nextId('stranger-robot') });
  theirLoop.loop.name = 'Dee\'s Jibo';
  store.flush();

  const dee = owner('dee-owner', 'Dee');
  const token = mintSetupToken(store, dee._id, null);
  const r = await amz('OOBE_20161026.SetupRobot', { token: token._id, id: 'oobe-dee-robot' });
  assert.equal(r.status, 200);
  const deeRobot = store.accountByFriendlyId('oobe-dee-robot');
  const mine = [...store.loops.values()].find((l) => l.robot === deeRobot._id);
  assert.ok(mine, 'the new loop exists');
  assert.equal(mine.name, 'Dee\'s Jibo', 'another owner\'s loop must not push the suffix');
});

test('SetupRobot returns ROBOT_DISABLED when the robot registry reports the robot suspended', async () => {
  const store = getStore();
  const o = owner('disabled-robot-owner', 'Disabled');
  registry.set('oobe-suspended-robot', { id: 'oobe-suspended-robot', payload: { suspended: true } });
  const token = mintSetupToken(store, o._id, null);
  const loopsBefore = store.loops.size;

  const r = await amz('OOBE_20161026.SetupRobot', { token: token._id, id: 'oobe-suspended-robot' });
  assert.equal(r.status, 409);
  assert.equal(r.body.__type, 'ROBOT_DISABLED');
  assert.equal(r.body.message, 'Robot disabled');
  assert.equal(store.loops.size, loopsBefore, 'no loop is created for a disabled robot');
  assert.ok(store.tokens.has(token._id), 'token survives');
  registry.delete('oobe-suspended-robot');
});

// ---------------------------------------------------------------------------
// validation envelope (@validatePayload -> Boom.badData -> 422)
// ---------------------------------------------------------------------------

test('the normal OOBE payload validations use the 422 Hapi/Joi envelope', async () => {
  const store = getStore();
  const o = owner('validation-owner', 'Val');
  const token = mintSetupToken(store, o._id, null);

  // SetupRobot requires both id and token (@validatePayload({id, token}) required).
  const missingId = await amz('OOBE_20161026.SetupRobot', { token: token._id });
  assert.equal(missingId.status, 422);
  assert.equal(missingId.body.statusCode, 422);
  assert.equal(missingId.body.error, 'Unprocessable Entity');
  assert.equal(missingId.body.message, 'child "id" fails because ["id" is required]');
  assert.equal(missingId.errType, null);
  assert.ok(store.tokens.has(token._id), 'validation precedes token consumption');

  const badToken = await amz('OOBE_20161026.SetupRobot', { token: 7, id: 'oobe-validation-robot' });
  assert.equal(badToken.status, 422);
  assert.equal(badToken.body.message, 'child "token" fails because ["token" must be a string]');

  const emptyToken = await amz('OOBE_20161026.SetupRobot', { token: '', id: 'oobe-validation-robot' });
  assert.equal(emptyToken.status, 422);
  assert.equal(emptyToken.body.message, 'child "token" fails because ["token" is not allowed to be empty]');

  assert.equal(store.accountByFriendlyId('oobe-validation-robot'), null);

  // GetStatus requires token.
  const status = await amz('OOBE_20161026.GetStatus', {});
  assert.equal(status.status, 422);
  assert.equal(status.body.message, 'child "token" fails because ["token" is required]');

  // PrepareRobot's own schema only constrains loopId (after credentials).
  const prepared = await amz('OOBE_20161026.PrepareRobot', { loopId: 123 }, { authorization: sig(o.accessKeyId) });
  assert.equal(prepared.status, 422);
  assert.equal(prepared.body.message, 'child "loopId" fails because ["loopId" must be a string]');

  // ReconnectRobot: credentials are checked before the payload; id is optional.
  const reconnect = await amz('OOBE_20161026.ReconnectRobot', { token: token._id, id: 9 },
    { authorization: sig(o.accessKeyId) });
  assert.equal(reconnect.status, 422);
  assert.equal(reconnect.body.message, 'child "id" fails because ["id" must be a string]');
  assert.ok(store.tokens.has(token._id), 'validation precedes the reconnect checks');
});

// ---------------------------------------------------------------------------
// the complete happy-path sequence, served over the wire
// ---------------------------------------------------------------------------

test('the full setup sequence is served: PrepareRobot -> SetupRobot -> GetStatus -> token expiry', async () => {
  const store = getStore();
  const o = owner('sequence-owner', 'Sequence');
  const prepared = await amz('OOBE_20161026.PrepareRobot', {}, { authorization: sig(o.accessKeyId) });
  assert.equal(prepared.status, 200);
  assert.equal(typeof prepared.body.token, 'string');
  assert.ok(prepared.body.expires > Date.now(), 'expires = now + 15 minutes');

  // GetStatus over the still-live token.
  const pending = await amz('OOBE_20161026.GetStatus', { token: prepared.body.token });
  assert.equal(pending.status, 200);
  assert.equal(pending.body.complete, false);

  const setup = await amz('OOBE_20161026.SetupRobot', { token: prepared.body.token, id: 'oobe-sequence-robot' });
  assert.equal(setup.status, 200);
  assert.match(setup.body.accessKeyId, /^[A-Za-z0-9]{20}$/);
  assert.match(setup.body.secretAccessKey, /^[A-Za-z0-9]{40}$/);

  // Setup complete: the OOBE app polls the same token and now sees complete.
  const done = await amz('OOBE_20161026.GetStatus', { token: prepared.body.token });
  assert.equal(done.status, 200);
  assert.equal(done.body.complete, true);

  // An expired token is reported, not deleted (token.ctrl.ts findById).
  const stale = mintSetupToken(store, o._id, null);
  store.tokens.get(stale._id).created = Date.now() - ACCESS_TOKEN_LIFETIME_MS - 1;
  const expired = await amz('OOBE_20161026.SetupRobot', { token: stale._id, id: 'oobe-sequence-robot-2' });
  assert.equal(expired.status, 401);
  assert.equal(expired.body.__type, 'TOKEN_EXPIRED');
  assert.ok(store.tokens.has(stale._id), 'expiry does not delete the token');
});
