// A-04 gate 2: source-reachable membership transition races.
// Source: jiborobot/srv-account-ws@6cea43470825657d6a5722162f28c8f233153ee2
//   LoopController.addMember / inviteMember / acceptInvitation / declineInvitation / removeMember.
// Synthetic households and local SMTP/HTTP peers only. No robot, no live mail.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { signedLoopHeaders } from './fixtures/signedLoopRequest.js';

const { createAccountService } = await import('../src/index.js');
const { createClassicEntrypoint } = await import('../../classic/src/index.js');
const { Store } = await import('../src/store.js');
const { createOwnerAccount, createLoop, MEMBER_STATUS } = await import('../src/model.js');
const { LoopUpdatedOutbox } = await import('../src/loopUpdatedOutbox.js');
const {
  inviteMember,
  acceptInvitation,
  declineInvitation,
  removeMember,
  updateMember,
} = await import('../src/loopMembership.js');

function makeProviders() {
  const mail = [];
  const events = [];
  return {
    mail,
    events,
    invitationProviders: {
      portalUrl: 'https://portal.fixture.test',
      invitation: {
        send(to, options) {
          mail.push({ template: 'invitation', to, options: { ...options } });
          return Promise.resolve();
        },
      },
      invitationExistingUser: {
        send(to, options) {
          mail.push({ template: 'invitationExistingUser', to, options: { ...options } });
          return Promise.resolve();
        },
      },
      eventSender: {
        send(event) {
          events.push({
            eventKey: event.payload?.eventKey || event.constructor?.name,
            payload: { ...event.payload },
          });
          return Promise.resolve();
        },
      },
    },
  };
}

function makeState(prefix) {
  const directory = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const store = new Store(join(directory, 'store.json'));
  const owner = createOwnerAccount(store, {
    email: `${prefix}-owner@fixture.test`,
    password: 'fixture-password',
    firstName: 'Synthetic',
  });
  const guest = createOwnerAccount(store, {
    email: `${prefix}-guest@fixture.test`,
    password: 'fixture-password',
    firstName: 'Guest',
  });
  const { loop } = createLoop(store, { owner, robotId: `${prefix}-robot` });
  return { directory, store, owner, guest, loop };
}

function emailMembers(loop, email) {
  return (loop.members || []).filter((member) => member.memberProperties?.email === email);
}

function memberProjection(loop, email) {
  return emailMembers(loop, email).map((member) => ({
    id: member._id,
    accountId: member.accountId || null,
    status: String(member.status).toLowerCase(),
    invitationCode: member.invitationCode || null,
    email: member.memberProperties?.email || null,
  }));
}

async function closeServer(server) {
  if (!server) return;
  server.closeAllConnections?.();
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function post(base, store, target, body, accessKeyId) {
  const response = await fetch(`${base}/`, {
    method: 'POST',
    signal: AbortSignal.timeout(5000),
    headers: {
      ...signedLoopHeaders(store, base, target, body, accessKeyId),
      connection: 'close',
    },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  return { status: response.status, rawBody: raw, body: raw ? JSON.parse(raw) : null };
}

async function withFaces(state, invitationProviders, run) {
  const prior = process.env.NET_account;
  let accountServer;
  let classicServer;
  try {
    const account = createAccountService({ store: state.store, invitationProviders });
    accountServer = await account.listen(0);
    const accountBase = `http://127.0.0.1:${accountServer.address().port}`;
    process.env.NET_account = accountBase;
    const classic = createClassicEntrypoint({
      notificationFile: join(state.directory, 'classic-notifications.json'),
      notificationPollIntervalMs: 60000,
    });
    classicServer = await classic.listen(0);
    const classicBase = `http://127.0.0.1:${classicServer.address().port}`;
    return await run({ accountBase, classicBase, accountServer, classicServer });
  } finally {
    await closeServer(classicServer);
    await closeServer(accountServer);
    if (prior === undefined) delete process.env.NET_account;
    else process.env.NET_account = prior;
  }
}

async function reopenClassic(state, invitationProviders) {
  const store = new Store(state.store.file);
  const prior = process.env.NET_account;
  let accountServer;
  let classicServer;
  try {
    const account = createAccountService({ store, invitationProviders });
    accountServer = await account.listen(0);
    const accountBase = `http://127.0.0.1:${accountServer.address().port}`;
    process.env.NET_account = accountBase;
    const classic = createClassicEntrypoint({
      notificationFile: join(state.directory, 'classic-notifications-reopen.json'),
      notificationPollIntervalMs: 60000,
    });
    classicServer = await classic.listen(0);
    const classicBase = `http://127.0.0.1:${classicServer.address().port}`;
    const listed = await post(classicBase, store, 'Loop_20160324.ListLoopMembers', {}, state.owner.accessKeyId);
    const loops = await post(classicBase, store, 'Loop_20160324.ListLoops', { loopId: state.loop._id }, state.owner.accessKeyId);
    return { store, listed, loops };
  } finally {
    await closeServer(classicServer);
    await closeServer(accountServer);
    if (prior === undefined) delete process.env.NET_account;
    else process.env.NET_account = prior;
  }
}

test('same-email sequential InviteLoopMember updates the pending row through Classic after restart', async () => {
  const state = makeState('a04-race-seq-invite');
  const side = makeProviders();
  const email = 'repeat-invite@fixture.test';
  try {
    const firstCodes = [];
    await withFaces(state, side.invitationProviders, async ({ classicBase }) => {
      const first = await post(classicBase, state.store, 'Loop_20160324.InviteLoopMember', {
        loopId: state.loop._id,
        email,
        firstName: 'Repeat',
      }, state.owner.accessKeyId);
      assert.equal(first.status, 200);
      const afterFirst = emailMembers(state.store.loops.get(state.loop._id), email);
      assert.equal(afterFirst.length, 1);
      assert.equal(afterFirst[0].status, MEMBER_STATUS.INVITED);
      firstCodes.push(afterFirst[0].invitationCode);

      const second = await post(classicBase, state.store, 'Loop_20160324.InviteLoopMember', {
        loopId: state.loop._id,
        email,
        firstName: 'Repeat',
      }, state.owner.accessKeyId);
      assert.equal(second.status, 200, 'source addMember updates a non-accepted row for a repeated email');
      const afterSecond = emailMembers(state.store.loops.get(state.loop._id), email);
      assert.equal(afterSecond.length, 1, 'sequential reinvite does not append a second member');
      assert.equal(afterSecond[0]._id, afterFirst[0]._id);
      assert.equal(afterSecond[0].status, MEMBER_STATUS.INVITED);
      assert.notEqual(afterSecond[0].invitationCode, firstCodes[0]);
      assert.equal(second.body.members.filter((member) => member.account?.email === email).length, 1);
    });

    assert.equal(side.mail.length, 2);
    assert.deepEqual(side.mail.map((row) => row.to), [email, email]);
    assert.equal(side.mail[0].template, 'invitation');
    assert.equal(side.events.length, 2);
    assert.deepEqual(side.events.map((row) => row.eventKey), ['InvitedToJoinLoop', 'InvitedToJoinLoop']);
    assert.equal(side.events[0].payload.email, email);
    assert.equal(side.events[0].payload.accountId, undefined);

    const reopened = await reopenClassic(state, side.invitationProviders);
    assert.equal(reopened.listed.status, 200);
    assert.equal(reopened.loops.status, 200);
    const persisted = memberProjection(reopened.store.loops.get(state.loop._id), email);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].status, MEMBER_STATUS.INVITED);
    const listed = (reopened.listed.body || []).filter((member) => member.account?.email === email);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].status, MEMBER_STATUS.INVITED);
    assert.equal(listed[0].id, persisted[0].id);
  } finally {
    rmSync(state.directory, { recursive: true, force: true });
  }
});

test('same-email concurrent InviteLoopMember appends two members when both load before save', async () => {
  const state = makeState('a04-race-dup-append');
  const side = makeProviders();
  const email = 'concurrent-invite@fixture.test';
  try {
    const outbox = new LoopUpdatedOutbox(state.store);
    const [first, second] = await Promise.all([
      inviteMember(state.store, {
        ownerId: state.owner._id,
        loopId: state.loop._id,
        email,
        firstName: 'One',
      }, outbox, { invitationProviders: side.invitationProviders }),
      inviteMember(state.store, {
        ownerId: state.owner._id,
        loopId: state.loop._id,
        email,
        firstName: 'Two',
      }, outbox, { invitationProviders: side.invitationProviders }),
    ]);
    assert.equal(first.members.filter((member) => member.account?.email === email).length >= 1, true);
    assert.equal(second.members.filter((member) => member.account?.email === email).length >= 1, true);

    const saved = state.store.loops.get(state.loop._id);
    const appended = emailMembers(saved, email);
    assert.equal(appended.length, 2, 'source $pushAll lets both independently loaded invites survive');
    assert.notEqual(appended[0]._id, appended[1]._id);
    assert.deepEqual(appended.map((member) => String(member.status).toLowerCase()), [
      MEMBER_STATUS.INVITED,
      MEMBER_STATUS.INVITED,
    ]);
    assert.equal(saved.__v, 2);
    assert.equal(side.mail.length, 2);
    assert.deepEqual(side.mail.map((row) => row.to), [email, email]);
    assert.equal(side.events.length, 2);
    assert.deepEqual(side.events.map((row) => row.payload.email), [email, email]);

    const reopened = await reopenClassic(state, side.invitationProviders);
    const persisted = memberProjection(reopened.store.loops.get(state.loop._id), email);
    assert.equal(persisted.length, 2);
    assert.deepEqual(persisted.map((row) => row.status), [MEMBER_STATUS.INVITED, MEMBER_STATUS.INVITED]);
    const listed = (reopened.listed.body || []).filter((member) => member.account?.email === email);
    assert.equal(listed.length, 2);
    assert.deepEqual(listed.map((member) => member.id).sort(), persisted.map((row) => row.id).sort());
  } finally {
    rmSync(state.directory, { recursive: true, force: true });
  }
});

test('same-email concurrent Account and Classic invites keep a source-reachable projection after restart', async () => {
  const state = makeState('a04-race-http-invite');
  const side = makeProviders();
  const email = 'http-concurrent@fixture.test';
  try {
    await withFaces(state, side.invitationProviders, async ({ accountBase, classicBase }) => {
      const body = { loopId: state.loop._id, email, firstName: 'Http' };
      const responses = await Promise.all([
        post(accountBase, state.store, 'Loop_20160324.InviteLoopMember', body, state.owner.accessKeyId),
        post(classicBase, state.store, 'Loop_20160324.InviteLoopMember', body, state.owner.accessKeyId),
      ]);
      assert.deepEqual(responses.map((row) => row.status), [200, 200]);
      const saved = emailMembers(state.store.loops.get(state.loop._id), email);
      // If both finds run before either save, source appends two members. If the
      // second find observes the first save, source updates the pending row.
      assert.ok(saved.length === 1 || saved.length === 2);
      assert.ok(saved.every((member) => String(member.status).toLowerCase() === MEMBER_STATUS.INVITED));
    });
    const reopened = await reopenClassic(state, side.invitationProviders);
    const persisted = memberProjection(reopened.store.loops.get(state.loop._id), email);
    assert.ok(persisted.length === 1 || persisted.length === 2);
    assert.ok(persisted.every((row) => row.status === MEMBER_STATUS.INVITED));
    const listed = (reopened.listed.body || []).filter((member) => member.account?.email === email);
    assert.equal(listed.length, persisted.length);
    assert.equal(side.mail.length, persisted.length === 2 ? 2 : side.mail.length);
    assert.ok(side.mail.every((row) => row.to === email));
    assert.ok(side.events.every((row) => row.payload.email === email));
  } finally {
    rmSync(state.directory, { recursive: true, force: true });
  }
});

test('declined membership sequential reinvite reopens the same row through Classic', async () => {
  const state = makeState('a04-race-seq-decline-reinvite');
  const side = makeProviders();
  try {
    let memberId;
    await withFaces(state, side.invitationProviders, async ({ classicBase }) => {
      const invited = await post(classicBase, state.store, 'Loop_20160324.InviteLoopMember', {
        loopId: state.loop._id,
        email: state.guest.email,
        firstName: 'Guest',
      }, state.owner.accessKeyId);
      assert.equal(invited.status, 200);
      memberId = state.store.loops.get(state.loop._id).members.find((member) => member.accountId === state.guest._id)._id;
      const declined = await post(classicBase, state.store, 'Loop_20160324.DeclineLoopInvitation', {
        loopId: state.loop._id,
      }, state.guest.accessKeyId);
      assert.equal(declined.status, 200);
      assert.equal(
        state.store.loops.get(state.loop._id).members.find((member) => member._id === memberId).status,
        MEMBER_STATUS.DECLINED,
      );
      const reinvited = await post(classicBase, state.store, 'Loop_20160324.InviteLoopMember', {
        loopId: state.loop._id,
        email: state.guest.email,
        firstName: 'Guest',
      }, state.owner.accessKeyId);
      assert.equal(reinvited.status, 200);
      const saved = emailMembers(state.store.loops.get(state.loop._id), state.guest.email);
      assert.equal(saved.length, 1);
      assert.equal(saved[0]._id, memberId);
      assert.equal(saved[0].status, MEMBER_STATUS.INVITED);
    });
    const reopened = await reopenClassic(state, side.invitationProviders);
    const persisted = memberProjection(reopened.store.loops.get(state.loop._id), state.guest.email);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].id, memberId);
    assert.equal(persisted[0].status, MEMBER_STATUS.INVITED);
    const inviteEvents = side.events.filter((row) => row.eventKey === 'InvitedToJoinLoop');
    const declineEvents = side.events.filter((row) => row.eventKey === 'InvitationToLoopDeclined');
    assert.equal(inviteEvents.length, 2);
    assert.equal(declineEvents.length, 1);
    assert.equal(declineEvents[0].payload.accountId, state.guest._id);
    assert.ok(side.mail.every((row) => row.to === state.guest.email));
    assert.equal(side.mail.at(-1).template, 'invitationExistingUser');
  } finally {
    rmSync(state.directory, { recursive: true, force: true });
  }
});

test('DeclineLoopInvitation raced with InviteLoopMember keeps one row and a source-reachable status', async () => {
  const state = makeState('a04-race-decline-reinvite');
  const side = makeProviders();
  try {
    const outbox = new LoopUpdatedOutbox(state.store);
    await inviteMember(state.store, {
      ownerId: state.owner._id,
      loopId: state.loop._id,
      email: state.guest.email,
      firstName: 'Guest',
    }, outbox, { invitationProviders: side.invitationProviders });
    const before = state.store.loops.get(state.loop._id).members.find((member) => member.accountId === state.guest._id);
    const priorMail = side.mail.length;
    const priorEvents = side.events.length;

    const [declined, reinvited] = await Promise.all([
      declineInvitation(state.store, {
        loopId: state.loop._id,
        accountId: state.guest._id,
      }, outbox, { invitationProviders: side.invitationProviders }),
      inviteMember(state.store, {
        ownerId: state.owner._id,
        loopId: state.loop._id,
        email: state.guest.email,
        firstName: 'Guest',
      }, outbox, { invitationProviders: side.invitationProviders }),
    ]);
    assert.equal(declined.members.find((member) => member.accountId === state.guest._id).status, MEMBER_STATUS.DECLINED);
    assert.ok(reinvited.members.find((member) => member.account?.email === state.guest.email
      || member.accountId === state.guest._id),
    'reinvite returns a populated loop that still contains the raced member');

    const saved = emailMembers(state.store.loops.get(state.loop._id), state.guest.email);
    assert.equal(saved.length, 1, 'overlapping decline and reinvite do not invent a second primary id');
    assert.equal(saved[0]._id, before._id);
    assert.ok([MEMBER_STATUS.DECLINED, MEMBER_STATUS.INVITED].includes(String(saved[0].status).toLowerCase()));
    assert.notEqual(saved[0].invitationCode, before.invitationCode, 'reinvite dirties invitationCode even if decline writes last');
    assert.equal(side.mail.length, priorMail + 1);
    assert.equal(side.mail.at(-1).to, state.guest.email);
    const newEvents = side.events.slice(priorEvents).map((row) => row.eventKey).sort();
    assert.deepEqual(newEvents, ['InvitationToLoopDeclined', 'InvitedToJoinLoop']);

    const reopened = await reopenClassic(state, side.invitationProviders);
    const persisted = memberProjection(reopened.store.loops.get(state.loop._id), state.guest.email);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].id, before._id);
    assert.ok([MEMBER_STATUS.DECLINED, MEMBER_STATUS.INVITED].includes(persisted[0].status));
    const listed = (reopened.listed.body || []).filter((member) => member.id === before._id);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].status, persisted[0].status);
  } finally {
    rmSync(state.directory, { recursive: true, force: true });
  }
});

test('RemoveLoopMember raced with InviteLoopMember keeps one row and a source-reachable status', async () => {
  const state = makeState('a04-race-remove-reinvite');
  const side = makeProviders();
  try {
    await withFaces(state, side.invitationProviders, async ({ classicBase, accountBase }) => {
      const invited = await post(classicBase, state.store, 'Loop_20160324.InviteLoopMember', {
        loopId: state.loop._id,
        email: state.guest.email,
        firstName: 'Guest',
      }, state.owner.accessKeyId);
      assert.equal(invited.status, 200);
      const target = state.store.loops.get(state.loop._id).members.find((member) => member.accountId === state.guest._id);
      const priorMail = side.mail.length;
      const responses = await Promise.all([
        post(accountBase, state.store, 'Loop_20160324.RemoveLoopMember', {
          loopId: state.loop._id,
          id: target._id,
        }, state.owner.accessKeyId),
        post(classicBase, state.store, 'Loop_20160324.InviteLoopMember', {
          loopId: state.loop._id,
          email: state.guest.email,
          firstName: 'Guest',
        }, state.owner.accessKeyId),
      ]);
      assert.deepEqual(responses.map((row) => row.status), [200, 200]);
      const saved = emailMembers(state.store.loops.get(state.loop._id), state.guest.email);
      assert.equal(saved.length, 1);
      assert.equal(saved[0]._id, target._id);
      assert.ok([MEMBER_STATUS.REMOVED, MEMBER_STATUS.INVITED].includes(String(saved[0].status).toLowerCase()));
      assert.equal(side.mail.length, priorMail + 1);
      assert.equal(side.mail.at(-1).to, state.guest.email);
    });
    const reopened = await reopenClassic(state, side.invitationProviders);
    const persisted = memberProjection(reopened.store.loops.get(state.loop._id), state.guest.email);
    assert.equal(persisted.length, 1);
    assert.ok([MEMBER_STATUS.REMOVED, MEMBER_STATUS.INVITED].includes(persisted[0].status));
    const listed = (reopened.listed.body || []).filter((member) => member.id === persisted[0].id);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].status, persisted[0].status);
  } finally {
    rmSync(state.directory, { recursive: true, force: true });
  }
});

test('AcceptLoopInvitation raced against DeclineLoopInvitation both return 200 and one durable status', async () => {
  const state = makeState('a04-race-accept-decline');
  const side = makeProviders();
  try {
    let memberId;
    await withFaces(state, side.invitationProviders, async ({ classicBase }) => {
      const invited = await post(classicBase, state.store, 'Loop_20160324.InviteLoopMember', {
        loopId: state.loop._id,
        email: state.guest.email,
        firstName: 'Guest',
      }, state.owner.accessKeyId);
      assert.equal(invited.status, 200);
      memberId = state.store.loops.get(state.loop._id).members.find((member) => member.accountId === state.guest._id)._id;
      const priorEvents = side.events.length;
      const responses = await Promise.all([
        post(classicBase, state.store, 'Loop_20160324.AcceptLoopInvitation', {
          loopId: state.loop._id,
        }, state.guest.accessKeyId),
        post(classicBase, state.store, 'Loop_20160324.DeclineLoopInvitation', {
          loopId: state.loop._id,
        }, state.guest.accessKeyId),
      ]);
      assert.deepEqual(responses.map((row) => row.status), [200, 200], 'source overlapping status writes both succeed');
      const acceptBody = responses[0].body.members.find((member) => member.accountId === state.guest._id);
      const declineBody = responses[1].body.members.find((member) => member.accountId === state.guest._id);
      assert.equal(acceptBody.status, MEMBER_STATUS.ACCEPTED, 'accept returns its request-local document');
      assert.equal(declineBody.status, MEMBER_STATUS.DECLINED, 'decline returns its request-local document');
      const saved = state.store.loops.get(state.loop._id).members.find((member) => member._id === memberId);
      assert.ok([MEMBER_STATUS.ACCEPTED, MEMBER_STATUS.DECLINED].includes(String(saved.status).toLowerCase()));
      const newEvents = side.events.slice(priorEvents).map((row) => row.eventKey).sort();
      assert.deepEqual(newEvents, ['InvitationToLoopAccepted', 'InvitationToLoopDeclined']);
      assert.ok(side.events.slice(priorEvents).every((row) => row.payload.accountId === state.guest._id));
    });
    const reopened = await reopenClassic(state, side.invitationProviders);
    const persisted = reopened.store.loops.get(state.loop._id).members.find((member) => member._id === memberId);
    assert.ok([MEMBER_STATUS.ACCEPTED, MEMBER_STATUS.DECLINED].includes(String(persisted.status).toLowerCase()));
    const listed = (reopened.listed.body || []).filter((member) => member.id === memberId);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].status, String(persisted.status).toLowerCase());
    const loopMember = reopened.loops.body[0].members.find((member) => member.id === memberId);
    assert.equal(loopMember.status, String(persisted.status).toLowerCase());
  } finally {
    rmSync(state.directory, { recursive: true, force: true });
  }
});

test('direct Accept vs Decline overlapping writes match source last-path-wins persistence', async () => {
  const state = makeState('a04-race-accept-decline-direct');
  const side = makeProviders();
  try {
    const outbox = new LoopUpdatedOutbox(state.store);
    await inviteMember(state.store, {
      ownerId: state.owner._id,
      loopId: state.loop._id,
      email: state.guest.email,
    }, outbox, { invitationProviders: side.invitationProviders });
    const results = await Promise.all([
      acceptInvitation(state.store, {
        loopId: state.loop._id,
        accountId: state.guest._id,
      }, outbox, { invitationProviders: side.invitationProviders }),
      declineInvitation(state.store, {
        loopId: state.loop._id,
        accountId: state.guest._id,
      }, outbox, { invitationProviders: side.invitationProviders }),
    ]);
    assert.equal(results[0].members.find((member) => member.accountId === state.guest._id).status, MEMBER_STATUS.ACCEPTED);
    assert.equal(results[1].members.find((member) => member.accountId === state.guest._id).status, MEMBER_STATUS.DECLINED);
    const saved = state.store.loops.get(state.loop._id);
    const member = saved.members.find((item) => item.accountId === state.guest._id);
    assert.ok([MEMBER_STATUS.ACCEPTED, MEMBER_STATUS.DECLINED].includes(String(member.status).toLowerCase()));
    assert.equal(saved.__v, 1, 'positional status writes do not increment the append version');
    assert.deepEqual(new Store(state.store.file).loops.get(state.loop._id), saved);
  } finally {
    rmSync(state.directory, { recursive: true, force: true });
  }
});

test('unchanged declined status does not version-conflict with an overlapping append', async () => {
  const state = makeState('a04-race-unchanged-decline');
  const side = makeProviders();
  try {
    const outbox = new LoopUpdatedOutbox(state.store);
    state.loop.members.push({
      _id: '111111111111111111111111',
      accountId: state.guest._id,
      status: MEMBER_STATUS.DECLINED,
      invitedAsLegalGuardian: false,
      memberProperties: { email: state.guest.email, isChild: false },
      enrolled: { face: false, voice: false },
    });
    state.store.flush();
    const results = await Promise.allSettled([
      inviteMember(state.store, {
        ownerId: state.owner._id,
        loopId: state.loop._id,
        email: 'new@synthetic.invalid',
      }, outbox, { invitationProviders: side.invitationProviders }),
      declineInvitation(state.store, {
        loopId: state.loop._id,
        accountId: state.guest._id,
      }, outbox, { invitationProviders: side.invitationProviders }),
    ]);
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[1].status, 'fulfilled', 'source unchanged status is a timestamp touch with no version predicate');
    const saved = state.store.loops.get(state.loop._id);
    assert.equal(saved.members.length, 4);
    assert.equal(saved.members.find((member) => member._id === '111111111111111111111111').status, MEMBER_STATUS.DECLINED);
    assert.equal(
      saved.members.filter((member) => member.memberProperties?.email === 'new@synthetic.invalid').length,
      1,
    );
  } finally {
    rmSync(state.directory, { recursive: true, force: true });
  }
});

test('array-removing UpdateLoopMember increments version so a queued accept cannot shift onto another member', async () => {
  const state = makeState('a04-race-array-shrink');
  const side = makeProviders();
  try {
    const outbox = new LoopUpdatedOutbox(state.store);
    state.loop.members.push(
      {
        _id: '111111111111111111111111',
        accountId: null,
        status: MEMBER_STATUS.DECLINED,
        invitedAsLegalGuardian: false,
        memberProperties: { email: 'reused@synthetic.invalid', isChild: false },
        enrolled: { face: false, voice: false },
      },
      {
        _id: '222222222222222222222222',
        accountId: state.guest._id,
        status: MEMBER_STATUS.INVITED,
        invitedAsLegalGuardian: false,
        memberProperties: { isChild: false },
        enrolled: { face: false, voice: false },
      },
      {
        _id: '333333333333333333333333',
        accountId: null,
        status: MEMBER_STATUS.INVITED,
        invitedAsLegalGuardian: false,
        memberProperties: { email: 'other@synthetic.invalid', isChild: false },
        enrolled: { face: false, voice: false },
      },
    );
    state.store.flush();
    const pending = acceptInvitation(state.store, {
      loopId: state.loop._id,
      accountId: state.guest._id,
    }, outbox, { invitationProviders: side.invitationProviders });
    updateMember(state.store, {
      ownerId: state.owner._id,
      loopId: state.loop._id,
      id: '222222222222222222222222',
      email: 'reused@synthetic.invalid',
    }, outbox, { invitationProviders: side.invitationProviders });
    const results = await Promise.allSettled([pending]);
    assert.equal(results[0].status, 'rejected');
    assert.equal(results[0].reason.code, 'LOOP_VERSION_CONFLICT');
    const saved = state.store.loops.get(state.loop._id);
    assert.equal(saved.__v, 1, 'source array replacement $set.members increments __v');
    assert.equal(saved.members.find((member) => member._id === '333333333333333333333333').status, MEMBER_STATUS.INVITED);
    assert.equal(saved.members.find((member) => member._id === '222222222222222222222222').status, MEMBER_STATUS.INVITED);
    assert.equal(saved.members.some((member) => member._id === '111111111111111111111111'), false);
  } finally {
    rmSync(state.directory, { recursive: true, force: true });
  }
});
