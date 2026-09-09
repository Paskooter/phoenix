// A-04 gate 1: Account→Classic state sequences.
// Source: srv-account-ws@6cea4347 loop.handler.ts / loop.ctrl.ts / schemes/loop.ts
//         and srv-notification-ws@e42bfe0 LoopUpdatedHandler (robot account, skill "-1").
// Original Account HTTP is not executed here; Node 8 controller/client receipts
// live under .parity/reviews/a04-state-sequences-20260910/. Synthetic households only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { signedLoopHeaders } from './fixtures/signedLoopRequest.js';

const { createAccountService } = await import('../src/index.js');
const { createClassicEntrypoint } = await import('../../classic/src/index.js');
const { Store } = await import('../src/store.js');
const { createOwnerAccount } = await import('../src/model.js');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function captureHttp(server, records) {
  server.on('request', (req, res) => {
    const requestChunks = [];
    const responseChunks = [];
    const record = {
      target: req.headers['x-amz-target'] || null,
      method: req.method,
    };
    req.on('data', (chunk) => requestChunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      const body = Buffer.concat(requestChunks);
      record.requestBodySha256 = sha256(body);
      record.requestBody = body.toString('utf8');
    });
    const oldWrite = res.write;
    const oldEnd = res.end;
    res.write = function write(chunk, ...args) {
      if (chunk !== undefined && chunk !== null && typeof chunk !== 'function') {
        responseChunks.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(String(chunk)));
      }
      return oldWrite.call(this, chunk, ...args);
    };
    res.end = function end(chunk, ...args) {
      if (chunk !== undefined && chunk !== null && typeof chunk !== 'function') {
        responseChunks.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(String(chunk)));
      }
      return oldEnd.call(this, chunk, ...args);
    };
    res.on('finish', () => {
      const body = Buffer.concat(responseChunks);
      record.status = res.statusCode;
      record.responseBodySha256 = sha256(body);
      record.responseBody = body.toString('utf8');
      records.push(record);
    });
  });
}

async function post(base, store, target, body, accessKeyId) {
  const payload = JSON.stringify(body);
  const response = await fetch(`${base}/`, {
    method: 'POST',
    signal: AbortSignal.timeout(5000),
    headers: {
      ...signedLoopHeaders(store, base, target, body, accessKeyId),
      connection: 'close',
    },
    body: payload,
  });
  const raw = await response.text();
  return { status: response.status, rawBody: raw, body: raw ? JSON.parse(raw) : null };
}

async function closeServer(server) {
  if (!server?.listening) return;
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

function household(prefix) {
  const directory = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const store = new Store(join(directory, 'store.json'));
  const owner = createOwnerAccount(store, {
    email: `${prefix}-owner@fixture.test`,
    password: 'fixture-password',
    firstName: 'Owner',
  });
  const acceptGuest = createOwnerAccount(store, {
    email: `${prefix}-accept@fixture.test`,
    password: 'fixture-password',
    firstName: 'Accept',
  });
  const declineGuest = createOwnerAccount(store, {
    email: `${prefix}-decline@fixture.test`,
    password: 'fixture-password',
    firstName: 'Decline',
  });
  const admin = createOwnerAccount(store, {
    email: `${prefix}-admin@fixture.test`,
    password: 'fixture-password',
    firstName: 'Admin',
  });
  admin.isAdmin = true;
  store.flush();
  return { directory, store, owner, acceptGuest, declineGuest, admin };
}

function memberByEmail(body, email) {
  const members = Array.isArray(body) ? body : body?.members || [];
  return members.find((member) => member.account?.email === email
    || member.memberProperties?.email === email) || null;
}

function memberByAccount(loop, accountId) {
  return (loop?.members || []).find((member) => member.accountId === accountId) || null;
}

function statusOf(loop, accountId) {
  return String(memberByAccount(loop, accountId)?.status || '').toLowerCase();
}

async function waitDrained(outbox) {
  await new Promise((resolve) => setImmediate(resolve));
  await outbox.drain();
  await new Promise((resolve) => setImmediate(resolve));
}

async function withFaces(state, run) {
  const prior = process.env.NET_account;
  const events = [];
  const published = [];
  const accountRecords = [];
  const classicRecords = [];
  let accountServer;
  let classicServer;
  let classic;
  try {
    const invitationProviders = {
      portalUrl: 'https://portal.fixture.test',
      invitation: {
        send() { return Promise.resolve(); },
      },
      invitationExistingUser: {
        send() { return Promise.resolve(); },
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
    };
    const robotReadClient = {
      async getRobot() { return { payload: { suspended: false } }; },
    };
    const account = createAccountService({
      store: state.store,
      invitationProviders,
      robotReadClient,
      notificationPublisher: async (request) => {
        published.push({
          accountId: request.accountId,
          skillId: request.skillId,
          name: request.notification?.name,
          payloadRobot: request.notification?.payload?.robot ?? null,
          payloadOwner: request.notification?.payload?.owner ?? null,
        });
        classic.hub.enqueueNotification(request);
        return { accepted: true };
      },
    });
    accountServer = await account.listen(0);
    captureHttp(accountServer, accountRecords);
    const accountBase = `http://127.0.0.1:${accountServer.address().port}`;
    process.env.NET_account = accountBase;
    classic = createClassicEntrypoint({
      notificationFile: join(state.directory, 'classic-notifications.json'),
      notificationPollIntervalMs: 60_000,
    });
    classicServer = await classic.listen(0);
    captureHttp(classicServer, classicRecords);
    const classicBase = `http://127.0.0.1:${classicServer.address().port}`;
    return await run({
      accountBase,
      classicBase,
      account,
      classic,
      events,
      published,
      accountRecords,
      classicRecords,
    });
  } finally {
    await closeServer(classicServer);
    await closeServer(accountServer);
    if (prior === undefined) delete process.env.NET_account;
    else process.env.NET_account = prior;
  }
}

function classicPendingFor(classic, accountId) {
  const token = classic.hub.store.findTokenByAccountId(accountId);
  if (!token) return [];
  return classic.hub.store.findNotificationsByTokenIds([token._id]);
}

function assertForwarding(accountRecords, classicRecords, target) {
  const classicHop = [...classicRecords].reverse().find((row) => row.target === target);
  const accountHop = [...accountRecords].reverse().find((row) => row.target === target);
  assert.ok(classicHop, `classic captured ${target}`);
  assert.ok(accountHop, `account captured ${target}`);
  assert.equal(classicHop.status, accountHop.status, `${target} status forwarded`);
  assert.equal(classicHop.responseBodySha256, accountHop.responseBodySha256, `${target} body forwarded`);
  assert.equal(classicHop.requestBodySha256, accountHop.requestBodySha256, `${target} request forwarded`);
}

test('Invite→Accept/Decline→ListLoopMembers keeps lowercase status, robot LoopUpdated, skill -1, and exact Classic forwarding', async () => {
  const state = household('a04-seq-invite');
  try {
    await withFaces(state, async (faces) => {
      const { store, owner, acceptGuest, declineGuest } = state;
      const created = await post(faces.classicBase, store, 'Loop_20160324.CreateLoop', {
        name: 'Invite Sequence', robotId: 'seq-invite-robot',
      }, owner.accessKeyId);
      assert.equal(created.status, 200);
      const loopId = created.body.id;
      const robotId = created.body.robot;
      await waitDrained(faces.account.loopUpdatedOutbox);
      assert.equal(statusOf(store.loops.get(loopId), owner._id), 'accepted');
      assert.equal(statusOf(store.loops.get(loopId), robotId), 'accepted');
      assert.equal(store.loops.get(loopId).owner, owner._id);
      assert.equal(store.loops.get(loopId).robot, robotId);
      assert.equal(faces.published.at(-1).accountId, robotId);
      assert.equal(faces.published.at(-1).skillId, '-1');
      assert.equal(faces.published.at(-1).name, 'LoopUpdated');
      assert.equal(faces.account.loopUpdatedOutbox.pending().length, 0);
      const createPending = classicPendingFor(faces.classic, robotId);
      assert.ok(createPending.length >= 1);
      assert.ok(createPending.every((row) => String(row.skillId ?? '-1') === '-1'));

      const invited = await post(faces.classicBase, store, 'Loop_20160324.InviteLoopMember', {
        loopId, email: acceptGuest.email, firstName: 'Accept', lastName: 'Guest',
      }, owner.accessKeyId);
      assert.equal(invited.status, 200);
      await waitDrained(faces.account.loopUpdatedOutbox);
      assert.equal(statusOf(store.loops.get(loopId), acceptGuest._id), 'invited');
      const inviteEvent = faces.events.find((row) => row.eventKey === 'InvitedToJoinLoop');
      assert.equal(inviteEvent.payload.accountId, acceptGuest._id);
      assert.equal(inviteEvent.payload.email, acceptGuest.email);
      assert.equal(faces.published.at(-1).accountId, robotId);
      assert.equal(faces.published.at(-1).skillId, '-1');
      assert.equal(faces.account.loopUpdatedOutbox.pending().length, 0);

      const accepted = await post(faces.classicBase, store, 'Loop_20160324.AcceptLoopInvitation', {
        loopId,
      }, acceptGuest.accessKeyId);
      assert.equal(accepted.status, 200);
      await waitDrained(faces.account.loopUpdatedOutbox);
      assert.equal(statusOf(store.loops.get(loopId), acceptGuest._id), 'accepted');
      const acceptEvent = faces.events.find((row) => row.eventKey === 'InvitationToLoopAccepted');
      assert.equal(acceptEvent.payload.accountId, acceptGuest._id);
      assert.equal(acceptEvent.payload.ownerId, owner._id);
      assert.equal(faces.published.at(-1).skillId, '-1');
      assert.equal(faces.published.at(-1).accountId, robotId);

      const listedAfterAccept = await post(faces.classicBase, store, 'Loop_20160324.ListLoopMembers', {}, owner.accessKeyId);
      assert.equal(listedAfterAccept.status, 200);
      const listedAccept = memberByEmail(listedAfterAccept.body, acceptGuest.email);
      assert.equal(listedAccept.status, 'accepted');
      assert.equal(listedAccept.accountId, acceptGuest._id);

      const invitedDecline = await post(faces.classicBase, store, 'Loop_20160324.InviteLoopMember', {
        loopId, email: declineGuest.email, firstName: 'Decline', lastName: 'Guest',
      }, owner.accessKeyId);
      assert.equal(invitedDecline.status, 200);
      const declined = await post(faces.classicBase, store, 'Loop_20160324.DeclineLoopInvitation', {
        loopId,
      }, declineGuest.accessKeyId);
      assert.equal(declined.status, 200);
      await waitDrained(faces.account.loopUpdatedOutbox);
      assert.equal(statusOf(store.loops.get(loopId), declineGuest._id), 'declined');
      const declineEvent = faces.events.find((row) => row.eventKey === 'InvitationToLoopDeclined');
      assert.equal(declineEvent.payload.accountId, declineGuest._id);
      assert.equal(faces.published.at(-1).skillId, '-1');
      assert.equal(faces.published.at(-1).accountId, robotId);

      const listedAfterDecline = await post(faces.classicBase, store, 'Loop_20160324.ListLoopMembers', {}, owner.accessKeyId);
      assert.equal(listedAfterDecline.status, 200);
      assert.equal(memberByEmail(listedAfterDecline.body, declineGuest.email).status, 'declined');
      assert.equal(memberByEmail(listedAfterDecline.body, acceptGuest.email).status, 'accepted');

      for (const target of [
        'Loop_20160324.CreateLoop',
        'Loop_20160324.InviteLoopMember',
        'Loop_20160324.AcceptLoopInvitation',
        'Loop_20160324.DeclineLoopInvitation',
        'Loop_20160324.ListLoopMembers',
      ]) {
        assertForwarding(faces.accountRecords, faces.classicRecords, target);
      }
    });
  } finally {
    rmSync(state.directory, { recursive: true, force: true });
  }
});

test('RemoveLoopMember→list/read marks removed, keeps owner/robot, and forwards Classic identically', async () => {
  const state = household('a04-seq-remove');
  try {
    await withFaces(state, async (faces) => {
      const { store, owner, acceptGuest } = state;
      const created = await post(faces.classicBase, store, 'Loop_20160324.CreateLoop', {
        name: 'Remove Sequence', robotId: 'seq-remove-robot',
      }, owner.accessKeyId);
      const loopId = created.body.id;
      const robotId = created.body.robot;
      await post(faces.classicBase, store, 'Loop_20160324.InviteLoopMember', {
        loopId, email: acceptGuest.email, firstName: 'Accept',
      }, owner.accessKeyId);
      await post(faces.classicBase, store, 'Loop_20160324.AcceptLoopInvitation', {
        loopId,
      }, acceptGuest.accessKeyId);
      const memberId = memberByAccount(store.loops.get(loopId), acceptGuest._id)._id;
      const publishedBefore = faces.published.length;

      const removed = await post(faces.classicBase, store, 'Loop_20160324.RemoveLoopMember', {
        loopId, id: memberId,
      }, owner.accessKeyId);
      assert.equal(removed.status, 200);
      await waitDrained(faces.account.loopUpdatedOutbox);
      assert.equal(statusOf(store.loops.get(loopId), acceptGuest._id), 'removed');
      assert.equal(store.loops.get(loopId).owner, owner._id);
      assert.equal(store.loops.get(loopId).robot, robotId);
      const removeEvent = faces.events.find((row) => row.eventKey === 'MemberRemovedFromLoop');
      assert.equal(removeEvent.payload.accountId, acceptGuest._id);
      assert.equal(removeEvent.payload.ownerId, owner._id);
      assert.ok(removeEvent.payload.memberIds.includes(acceptGuest._id));
      assert.equal(faces.published.at(-1).accountId, robotId);
      assert.equal(faces.published.at(-1).skillId, '-1');
      assert.equal(faces.account.loopUpdatedOutbox.pending().length, 0);
      assert.ok(faces.published.length > publishedBefore);

      const listed = await post(faces.classicBase, store, 'Loop_20160324.ListLoopMembers', {
        statusList: ['removed'],
      }, owner.accessKeyId);
      assert.equal(listed.status, 200);
      const listedRemoved = (listed.body || []).filter((member) => member.accountId === acceptGuest._id);
      assert.equal(listedRemoved.length, 1);
      assert.equal(listedRemoved[0].status, 'removed');

      const loops = await post(faces.classicBase, store, 'Loop_20160324.ListLoops', {}, owner.accessKeyId);
      assert.equal(loops.status, 200);
      const listedLoop = (loops.body || []).find((item) => item.id === loopId);
      assert.ok(listedLoop);
      assert.equal(listedLoop.owner, owner._id);
      assert.equal(listedLoop.robot, robotId);
      assert.equal(listedLoop.members.find((member) => member.accountId === acceptGuest._id).status, 'removed');

      assertForwarding(faces.accountRecords, faces.classicRecords, 'Loop_20160324.RemoveLoopMember');
      assertForwarding(faces.accountRecords, faces.classicRecords, 'Loop_20160324.ListLoopMembers');
      assertForwarding(faces.accountRecords, faces.classicRecords, 'Loop_20160324.ListLoops');
    });
  } finally {
    rmSync(state.directory, { recursive: true, force: true });
  }
});

test('CreateLoop→ClearRobot/RemoveLoop→read clears the robot relation and skips unroutable LoopUpdated', async () => {
  const state = household('a04-seq-clear');
  try {
    await withFaces(state, async (faces) => {
      const { store, owner, admin } = state;

      const createdClear = await post(faces.classicBase, store, 'Loop_20160324.CreateLoop', {
        name: 'Clear Sequence', robotId: 'seq-clear-robot',
      }, owner.accessKeyId);
      assert.equal(createdClear.status, 200);
      const clearLoopId = createdClear.body.id;
      const clearRobot = createdClear.body.robot;
      await waitDrained(faces.account.loopUpdatedOutbox);
      const publishedAfterCreate = faces.published.length;
      const pendingAfterCreate = classicPendingFor(faces.classic, clearRobot).length;

      const cleared = await post(faces.classicBase, store, 'Loop_20160324.ClearRobot', {
        robotId: 'seq-clear-robot',
      }, admin.accessKeyId);
      assert.equal(cleared.status, 200);
      await waitDrained(faces.account.loopUpdatedOutbox);
      const clearedLoop = store.loops.get(clearLoopId);
      assert.equal(clearedLoop.isDeleted, true);
      assert.equal(clearedLoop.robot, undefined);
      assert.equal(clearedLoop.owner, owner._id);
      assert.equal(faces.account.loopUpdatedOutbox.pending().length, 0);
      assert.equal(faces.published.length, publishedAfterCreate, 'cleared robot is not a LoopUpdated target');
      assert.equal(classicPendingFor(faces.classic, clearRobot).length, pendingAfterCreate);

      const listedAfterClear = await post(faces.classicBase, store, 'Loop_20160324.ListLoops', {}, owner.accessKeyId);
      assert.equal(listedAfterClear.status, 200);
      assert.equal((listedAfterClear.body || []).some((item) => item.id === clearLoopId), false);
      const getAfterClear = await post(faces.classicBase, store, 'Loop_20160324.GetRobot', {
        loopId: clearLoopId,
      }, owner.accessKeyId);
      assert.equal(getAfterClear.status, 404);
      assert.equal(getAfterClear.body.__type || getAfterClear.body.code, 'LOOP_NOT_FOUND');

      const createdRemove = await post(faces.classicBase, store, 'Loop_20160324.CreateLoop', {
        name: 'RemoveLoop Sequence', robotId: 'seq-rmloop-robot',
      }, owner.accessKeyId);
      const removeLoopId = createdRemove.body.id;
      const removeRobot = createdRemove.body.robot;
      await waitDrained(faces.account.loopUpdatedOutbox);
      const publishedAfterSecondCreate = faces.published.length;

      const removed = await post(faces.classicBase, store, 'Loop_20160324.RemoveLoop', {
        loopId: removeLoopId,
      }, owner.accessKeyId);
      assert.equal(removed.status, 200);
      await waitDrained(faces.account.loopUpdatedOutbox);
      const removedLoop = store.loops.get(removeLoopId);
      assert.equal(removedLoop.isDeleted, true);
      assert.equal(removedLoop.robot, undefined);
      assert.equal(removedLoop.owner, owner._id);
      assert.equal(faces.published.length, publishedAfterSecondCreate);
      assert.equal(faces.account.loopUpdatedOutbox.pending().length, 0);

      const listedAfterRemove = await post(faces.classicBase, store, 'Loop_20160324.ListLoops', {}, owner.accessKeyId);
      assert.equal((listedAfterRemove.body || []).some((item) => item.id === removeLoopId), false);
      const getAfterRemove = await post(faces.classicBase, store, 'Loop_20160324.GetRobot', {
        loopId: removeLoopId,
      }, owner.accessKeyId);
      assert.equal(getAfterRemove.status, 404);

      assertForwarding(faces.accountRecords, faces.classicRecords, 'Loop_20160324.ClearRobot');
      assertForwarding(faces.accountRecords, faces.classicRecords, 'Loop_20160324.RemoveLoop');
      assertForwarding(faces.accountRecords, faces.classicRecords, 'Loop_20160324.ListLoops');
      assertForwarding(faces.accountRecords, faces.classicRecords, 'Loop_20160324.GetRobot');
    });
  } finally {
    rmSync(state.directory, { recursive: true, force: true });
  }
});
