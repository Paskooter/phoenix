import { signedLoopHeaders } from './fixtures/signedLoopRequest.js';
// A-04 invitation side-effect controls.
// Source: jiborobot/srv-account-ws@6cea43470825657d6a5722162f28c8f233153ee2
// (LoopController.sendInvitationMail/addMember/updateMember), MailController,
// and @jibo/server@4.0.12 InvitedToJoinLoop/BaseEvent.
// All accounts, addresses, and URLs below are synthetic fixtures.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { createAccountService, Store } = await import('../src/index.js');
const { createOwnerAccount, createLoop, MEMBER_STATUS } = await import('../src/model.js');

async function post(store, base, target, body, accessKeyId) {
  const response = await fetch(`${base}/`, {
    method: 'POST',
    headers: signedLoopHeaders(store, base, target, body, accessKeyId),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const rawBody = await response.text();
  let bodyValue = null;
  try { bodyValue = rawBody ? JSON.parse(rawBody) : null; } catch (_) { /* retain raw response */ }
  return { status: response.status, rawBody, body: bodyValue };
}

function addInvitedMember(store, loop, id) {
  loop.members.push({
    _id: id,
    status: MEMBER_STATUS.INVITED,
    memberProperties: { firstName: 'Pending', email: null },
    enrolled: { face: false, voice: false },
  });
  store.flush();
  return loop.members[loop.members.length - 1];
}

function providerFixture(store) {
  const calls = [];
  const errors = [];
  const rejected = new Set();
  const providers = {
    portalUrl: 'https://portal.fixture.test',
    invitation: {
      send(to, options) {
        calls.push({ kind: 'mail', template: 'invitation', to, options: { ...options }, outboxSize: store.notificationOutbox.size });
        if (rejected.has(to)) return Promise.reject(new Error(`mail-${to}`));
        return Promise.resolve({ accepted: true });
      },
    },
    invitationExistingUser: {
      send(to, options) {
        calls.push({ kind: 'mail', template: 'invitationExistingUser', to, options: { ...options }, outboxSize: store.notificationOutbox.size });
        if (rejected.has(to)) return Promise.reject(new Error(`mail-${to}`));
        return Promise.resolve({ accepted: true });
      },
    },
    eventSender: {
      send(event) {
        calls.push({ kind: 'event', event: { payload: { ...event.payload } }, outboxSize: store.notificationOutbox.size });
        if (rejected.has(event.payload.email)) return Promise.reject(new Error(`event-${event.payload.email}`));
        return Promise.resolve({ published: true });
      },
    },
    onError(error, kind) {
      errors.push({ kind, message: error.message });
    },
  };
  return { providers, calls, errors, rejected };
}

async function close(server) {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
}

test('Invite/UpdateLoopMember dispatch source-shaped mail and InvitedToJoinLoop side effects', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-a04-invitation-providers-'));
  let server;
  try {
    const store = new Store(join(dir, 'store.json'));
    const owner = createOwnerAccount(store, {
      email: 'invitation-owner@fixture.test',
      password: 'fixture-password',
      firstName: 'Synthetic',
      lastName: 'Owner',
    });
    const known = createOwnerAccount(store, {
      email: 'known-member@fixture.test',
      password: 'fixture-password',
      firstName: 'Known',
    });
    const { loop } = createLoop(store, { owner, robotId: 'invitation-robot' });
    const target = addInvitedMember(store, loop, 'invitation-update-target');
    const { providers, calls, errors, rejected } = providerFixture(store);
    server = await createAccountService({ store, invitationProviders: providers }).listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;

    const unknown = await post(store, base, 'Loop_20160324.InviteLoopMember', {
      loopId: loop._id,
      email: 'New.Person@fixture.test',
      firstName: '  New  ',
      lastName: ' Person ',
    }, owner.accessKeyId);
    assert.equal(unknown.status, 200);
    const unknownMember = store.loops.get(loop._id).members.find((member) =>
      member.memberProperties?.email === 'new.person@fixture.test');
    assert.ok(unknownMember);
    assert.deepEqual(calls.slice(0, 2).map((call) => call.kind), ['mail', 'event']);
    const unknownMail = calls[0];
    assert.equal(unknownMail.template, 'invitation');
    assert.equal(unknownMail.to, 'new.person@fixture.test');
    assert.equal(unknownMail.options.email, 'new.person@fixture.test');
    assert.equal(unknownMail.options.name, owner.email, 'source falls back from fullName to owner.email');
    assert.equal(unknownMail.options.url,
      `https://portal.fixture.test/create?email=new.person%40fixture.test&code=${encodeURIComponent(unknownMember.invitationCode)}`);
    assert.ok(Object.prototype.hasOwnProperty.call(unknownMail.options, 'photoUrl'));
    assert.equal(unknownMail.outboxSize, 1, 'Invite sends mail after the loop save');
    const unknownEvent = calls[1].event;
    assert.equal(unknownEvent.payload.eventKey, 'InvitedToJoinLoop');
    assert.equal(unknownEvent.payload.email, 'new.person@fixture.test');
    assert.equal(unknownEvent.payload.loopId, loop._id);
    assert.equal(unknownEvent.payload.ownerId, owner._id);
    assert.equal(unknownEvent.payload.accountId, undefined);
    assert.equal(unknownEvent.payload.firstName, 'New');
    assert.equal(unknownEvent.payload.lastName, 'Person');
    assert.equal(calls[1].outboxSize, 1, 'Invite event follows mail while the saved loop notification remains durable');

    const existing = await post(store, base, 'Loop_20160324.InviteLoopMember', {
      loopId: loop._id,
      email: known.email.toUpperCase(),
      firstName: 'Known',
    }, owner.accessKeyId);
    assert.equal(existing.status, 200);
    const existingCalls = calls.slice(2);
    assert.deepEqual(existingCalls.map((call) => call.kind), ['mail', 'event']);
    assert.equal(existingCalls[0].template, 'invitationExistingUser');
    assert.equal(existingCalls[0].options.url,
      'https://portal.fixture.test/home?email=known-member%40fixture.test');
    assert.equal(existingCalls[1].event.payload.accountId, known._id);
    assert.equal(new URL(existingCalls[0].options.url).searchParams.has('code'), false);

    const noEmail = await post(store, base, 'Loop_20160324.InviteLoopMember', {
      loopId: loop._id,
      firstName: 'No Email',
    }, owner.accessKeyId);
    assert.equal(noEmail.status, 200);
    const callCountBeforeUpdate = calls.length;
    const updated = await post(store, base, 'Loop_20160324.UpdateLoopMember', {
      loopId: loop._id,
      id: target._id,
      email: 'Update.Target@fixture.test',
      firstName: '  Updated  ',
    }, owner.accessKeyId);
    assert.equal(updated.status, 200);
    assert.deepEqual(calls.slice(callCountBeforeUpdate).map((call) => call.kind), ['mail', 'event']);
    const updateMail = calls[callCountBeforeUpdate];
    assert.equal(updateMail.template, 'invitation');
    assert.equal(updateMail.options.email, 'update.target@fixture.test');
    assert.equal(updateMail.outboxSize, 3, 'Update sends mail before its final saveAndPopulate');
    const updateEvent = calls[callCountBeforeUpdate + 1].event;
    assert.equal(updateEvent.payload.accountId, undefined);
    assert.equal(updateEvent.payload.firstName, 'Updated');
    assert.equal(store.loops.get(loop._id).members.find((member) => member._id === target._id)
      .memberProperties.email, 'update.target@fixture.test');

    // Email-less member mutations have no source mail or invitation event.
    assert.equal(calls.filter((call) => call.kind === 'mail').length, 3);
    assert.equal(calls.filter((call) => call.kind === 'event').length, 3);

    // Source catches rejected provider Promises, so the successful loop
    // mutation and the second provider invocation survive both failures.
    rejected.add('reject@fixture.test');
    const rejectedResponse = await post(store, base, 'Loop_20160324.InviteLoopMember', {
      loopId: loop._id,
      email: 'Reject@fixture.test',
    }, owner.accessKeyId);
    assert.equal(rejectedResponse.status, 200);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.loops.get(loop._id).members.some((member) =>
      member.memberProperties?.email === 'reject@fixture.test'), true);
    assert.deepEqual(errors.slice(-2).map((error) => error.kind), ['invitation-mail', 'invited-to-join-loop']);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a synchronous throw from a malformed provider seam fails the request', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-a04-invitation-provider-throw-'));
  let server;
  try {
    const store = new Store(join(dir, 'store.json'));
    const owner = createOwnerAccount(store, {
      email: 'throw-owner@fixture.test',
      password: 'fixture-password',
    });
    const { loop } = createLoop(store, { owner, robotId: 'throw-robot' });
    const before = JSON.stringify(store.loops.get(loop._id));
    const providers = {
      portalUrl: 'https://portal.fixture.test',
      invitation: { send() { throw new Error('synchronous mail failure'); } },
      invitationExistingUser: { send() { throw new Error('unexpected existing-mail call'); } },
      eventSender: { send() { throw new Error('event must not follow failed mail'); } },
    };
    server = await createAccountService({ store, invitationProviders: providers }).listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await post(store, base, 'Loop_20160324.InviteLoopMember', {
      loopId: loop._id,
      email: 'throw@fixture.test',
    }, owner.accessKeyId);
    assert.equal(response.status, 500);
    assert.match(response.rawBody, /synchronous mail failure/);
    assert.notEqual(JSON.stringify(store.loops.get(loop._id)), before,
      'Invite persists before the provider seam begins');
    assert.equal(store.loops.get(loop._id).members.some((member) =>
      member.memberProperties?.email === 'throw@fixture.test'), true);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});
