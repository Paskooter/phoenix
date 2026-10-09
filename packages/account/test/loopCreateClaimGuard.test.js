// CreateLoop robot-takeover guard — Phoenix security divergence from source.
//
// The archived srv-account-ws LoopController.create (loop.ctrl.ts:116-158,
// jiborobot/srv-account-ws@master, read via the Jibo archive MCP) validates
// name/robotId only and then calls removeRobotFromLoops unconditionally, so
// any signed-in account could claim any robot by its friendlyId (a public
// value displayed on the robot and used in normal setup) and lock out the real
// owner. Phoenix refuses that cross-account claim at the same boundary;
// same-owner re-setup and unowned-robot claims keep the source behavior.
// All households below are invented synthetic fixtures.
//
// OLD-CODE CONTROL: the refusal assertions in this file are expected to FAIL
// on the unguarded base (ff8f592) — the attacker case demonstrably takes the
// robot there. Run this file against
// `git show ff8f592:packages/account/src/loopMembership.js` to reproduce.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { signedLoopHeaders } from './fixtures/signedLoopRequest.js';

const { createAccountService } = await import('../src/index.js');
const { Store } = await import('../src/store.js');
const { createOwnerAccount, createLoop } = await import('../src/model.js');

const dir = mkdtempSync(join(tmpdir(), 'phx-loop-claim-guard-'));
const store = new Store(join(dir, 'store.json'));
let server;
let base;

// The default RobotReadClient has no endpoint and throws; the source handler
// tolerates the lookup failure, so no registry is wired in this file.

async function post(target, body, accessKeyId) {
  const response = await fetch(`${base}/`, {
    method: 'POST',
    headers: {
      ...signedLoopHeaders(store, base, target, body, accessKeyId),
      connection: 'close',
    },
    body: JSON.stringify(body),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  let parsed = null;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch (_) { /* non-JSON */ }
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: parsed,
  };
}

function household(label) {
  const owner = createOwnerAccount(store, {
    email: `claim-${label}-owner@synthetic.invalid`,
    password: 'synthetic-password',
    firstName: 'Owner',
    lastName: label,
  });
  const { loop, robot } = createLoop(store, { owner, robotId: `claim-${label}-robot` });
  return { owner, loop, robot };
}

before(async () => {
  server = await createAccountService({ store }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections?.();
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

test('attacker CreateLoop on a foreign owned robot is refused and the victim loop is unchanged', async () => {
  const { owner: victim, loop, robot } = household('victim');
  const attacker = createOwnerAccount(store, {
    email: 'claim-attacker@synthetic.invalid',
    password: 'synthetic-password',
    firstName: 'Attacker',
  });
  const before = JSON.parse(JSON.stringify(loop));
  const memberCount = loop.members.length;
  const outboxRows = store.notificationOutbox.size;
  store.flush();

  const stolen = await post('Loop_20160324.CreateLoop', {
    name: 'Stolen Loop',
    robotId: robot.friendlyId,
  }, attacker.accessKeyId);

  assert.equal(stolen.status, 409, `expected ROBOT_ALREADY_CLAIMED, got ${JSON.stringify(stolen.body)}`);
  assert.equal(stolen.body.__type, 'ROBOT_ALREADY_CLAIMED');
  assert.equal(stolen.headers['x-amzn-errortype'], 'ROBOT_ALREADY_CLAIMED');
  assert.equal(typeof stolen.body.message, 'string');

  // The victim's loop is untouched: still active, still owns its robot, and
  // the robot is still an accepted member.
  const after = store.loops.get(loop._id);
  assert.equal(after.isSuspended, false, 'the victim loop is not suspended');
  assert.equal(after.robot, robot._id, 'the robot is not detached');
  assert.equal(after.owner, victim._id);
  assert.equal(after.members.some((m) => m.accountId === robot._id
    && String(m.status).toLowerCase() === 'accepted'), true);
  assert.equal(after.members.length, memberCount);
  assert.deepEqual({ ...after, updated: undefined }, { ...before, updated: undefined },
    'no loop field changed');

  // The attacker gets no loop at all.
  assert.equal([...store.loops.values()].some((l) => String(l.owner) === String(attacker._id)), false,
    'the attacker must not own any loop');

  // No persistence side effects: no new durable outbox row, and the durable
  // bytes on disk are unchanged apart from nothing this call caused.
  assert.equal(store.notificationOutbox.size, outboxRows, 'a refused claim emits no LoopUpdated row');

  // The victim still controls its loop afterwards.
  const rename = await post('Loop_20160324.UpdateLoop', {
    loopId: loop._id,
    name: 'Still Mine',
  }, victim.accessKeyId);
  assert.equal(rename.status, 200);
  assert.equal(store.loops.get(loop._id).name, 'Still Mine');

  // The Create alias target is guarded identically.
  const aliasAttacker = createOwnerAccount(store, {
    email: 'claim-alias-attacker@synthetic.invalid',
    password: 'synthetic-password',
    firstName: 'Alias',
  });
  const stolenAlias = await post('Loop_20160324.Create', {
    name: 'Stolen Via Alias',
    robotId: robot.friendlyId,
  }, aliasAttacker.accessKeyId);
  assert.equal(stolenAlias.status, 409);
  assert.equal(stolenAlias.body.__type, 'ROBOT_ALREADY_CLAIMED');
  assert.equal([...store.loops.values()].some((l) => String(l.owner) === String(aliasAttacker._id)), false);
});

test('the robot cannot steal its own household loop with its own credentials', async () => {
  const { loop, robot } = household('robot-credentials');
  const before = JSON.parse(JSON.stringify(loop));
  const stolen = await post('Loop_20160324.CreateLoop', {
    name: 'Robot Self Steal',
    robotId: robot.friendlyId,
  }, robot.accessKeyId);
  assert.equal(stolen.status, 409, 'the robot belongs to a loop owned by a different account');
  assert.equal(stolen.body.__type, 'ROBOT_ALREADY_CLAIMED');
  assert.equal(store.loops.get(loop._id).robot, robot._id, 'the loop keeps its robot');
  assert.deepEqual(JSON.parse(JSON.stringify(store.loops.get(loop._id))), before,
    'the loop document is byte-identical after the refusal');
});

test('owner re-CreateLoop on their own robot keeps working (re-setup/replacement)', async () => {
  const { owner, loop, robot } = household('reown');
  const second = await post('Loop_20160324.CreateLoop', {
    name: 'Replacement Loop',
    robotId: robot.friendlyId,
  }, owner.accessKeyId);
  assert.equal(second.status, 200, `expected relocation to succeed, got ${JSON.stringify(second.body)}`);
  assert.equal(second.body.owner, owner._id);
  assert.equal(second.body.robot, robot._id);
  assert.notEqual(second.body.id, loop._id, 'a fresh loop is created');
  const old = store.loops.get(loop._id);
  assert.equal(old.isSuspended, true, 'the source suspends the relocated loop');
  assert.equal(old.robot, undefined);
  assert.equal(store.loops.get(second.body.id).isSuspended, false);
});

test('unowned robot CreateLoop keeps working (fresh claim)', async () => {
  const owner = createOwnerAccount(store, {
    email: 'claim-fresh-owner@synthetic.invalid',
    password: 'synthetic-password',
    firstName: 'Fresh',
  });
  const fresh = await post('Loop_20160324.CreateLoop', {
    name: 'Fresh Loop',
    robotId: 'claim-brand-new-robot',
  }, owner.accessKeyId);
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.owner, owner._id);
  assert.equal(fresh.body.robotFriendlyId, 'claim-brand-new-robot');
  assert.equal(store.loops.get(fresh.body.id).isSuspended, false);
});

test('a suspended foreign loop still refuses a takeover; a deleted loop releases the robot', async () => {
  // A suspended household is mid-wipe awaiting its owner's re-setup; the
  // suspension is not a release of ownership, so a foreign CreateLoop is
  // still a takeover of that household.
  const { loop, robot } = household('suspended-foreign');
  loop.isSuspended = true;
  store.flush();
  const stranger = createOwnerAccount(store, {
    email: 'claim-suspended-attacker@synthetic.invalid',
    password: 'synthetic-password',
    firstName: 'Suspend',
  });
  const stolen = await post('Loop_20160324.CreateLoop', {
    name: 'Suspended Steal',
    robotId: robot.friendlyId,
  }, stranger.accessKeyId);
  assert.equal(stolen.status, 409);
  assert.equal(stolen.body.__type, 'ROBOT_ALREADY_CLAIMED');
  assert.equal(store.loops.get(loop._id).robot, robot._id, 'the suspended loop keeps its robot');
  assert.equal(store.loops.get(loop._id).isSuspended, true, 'the suspended loop is not unsuspended');

  // A soft-DELETED loop released its robot (the source remove flow clears
  // loop.robot and removes the membership), so the robot is claimable again.
  const gone = household('deleted-foreign');
  gone.loop.isDeleted = true;
  gone.loop.robot = undefined;
  gone.loop.members = [];
  store.flush();
  const claimer = createOwnerAccount(store, {
    email: 'claim-after-delete-owner@synthetic.invalid',
    password: 'synthetic-password',
    firstName: 'Reclaimer',
  });
  const reclaimed = await post('Loop_20160324.CreateLoop', {
    name: 'Reclaimed Loop',
    robotId: gone.robot.friendlyId,
  }, claimer.accessKeyId);
  assert.equal(reclaimed.status, 200, 'a robot freed by loop deletion is claimable');
  assert.equal(reclaimed.body.owner, claimer._id);
});

test('a robot member of another household\'s shared loop can still be re-homed by its own owner', async () => {
  // removeRobotFromLoops queries robot relation AND member; the guard mirrors
  // that detach predicate, so a robot that is an accepted MEMBER of a foreign
  // loop (a shared household) is only refused when the foreign loop is also
  // the one the takeover would detach. A pure shared-membership leftover —
  // robot member, robot relation absent — is cleared by the owner's own
  // CreateLoop exactly as in source, not blocked by the guard.
  const { owner, loop, robot } = household('shared-member');
  const inviter = createOwnerAccount(store, {
    email: 'claim-inviter@synthetic.invalid',
    password: 'synthetic-password',
    firstName: 'Inviter',
  });
  const inviterLoop = {
    _id: 'claim-inviter-loop',
    name: 'Inviter Loop',
    owner: inviter._id,
    robot: undefined,
    members: [
      { _id: 'claim-inviter-member', accountId: inviter._id, status: 'accepted',
        enrolled: { face: false, voice: false }, created: 1 },
      { _id: 'claim-inviter-robot-member', accountId: robot._id, status: 'accepted',
        enrolled: { face: false, voice: false }, created: 2 },
    ],
    isSuspended: false,
    created: 1,
  };
  store.loops.set(inviterLoop._id, inviterLoop);
  store.flush();

  const reown = await post('Loop_20160324.CreateLoop', {
    name: 'Rehome After Share',
    robotId: robot.friendlyId,
  }, owner.accessKeyId);
  assert.equal(reown.status, 200, 'a leftover membership in a foreign loop must not block the owner');
  assert.equal(reown.body.owner, owner._id);
  // removeRobotFromLoops is the source's one-element $or (robot relation AND
  // member), so the inviter loop — robot relation absent — is neither matched
  // nor modified by the relocation. The guard must not be broader than that.
  const inviterAfter = store.loops.get(inviterLoop._id);
  assert.equal(inviterAfter.isSuspended, false, 'the shared loop is untouched');
  assert.equal(inviterAfter.members.some((m) => m.accountId === robot._id), true,
    'the source AND-semantics detach query leaves a member-only row alone');
  assert.equal(store.loops.get(loop._id).isSuspended, true, 'the owner relocation suspends its own prior loop');
});

test('an anonymous CreateLoop on a foreign owned robot is not an oracle', async () => {
  // An unsigned request never reaches the controller (401 MISSING_AUTH_HEADER
  // at the shared boundary), so the guard adds no new disclosure; this pins
  // that the takeover refusal requires an authenticated caller.
  const { robot } = household('anon');
  const stolen = await post('Loop_20160324.CreateLoop', {
    name: 'Anon Steal',
    robotId: robot.friendlyId,
  });
  assert.equal(stolen.status, 401);
  assert.equal(stolen.body.__type, 'MISSING_AUTH_HEADER');
});