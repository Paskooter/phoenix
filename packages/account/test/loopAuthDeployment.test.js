// A-04 gate 6: signed Account→Classic sequences after Account/Classic restart,
// configured local SMTP/HTTP invitation transports, and the source callback
// exception (UpdateAgreementStatus) kept separate from ordinary Loop calls.
// Source: srv-security-gw@43a692fe auth.ctrl.ts unauthorizedMethods and
// srv-account-ws@6cea434 loop.ctrl.ts setLegalGuardian/updateAgreementStatus.
// Synthetic households and local transports only.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { signedLoopHeaders } from './fixtures/signedLoopRequest.js';

const { createAccountService } = await import('../src/index.js');
const { createClassicEntrypoint } = await import('../../classic/src/index.js');
const { Store } = await import('../src/store.js');
const { createOwnerAccount } = await import('../src/model.js');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function closeServer(server) {
  if (!server?.listening) return;
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

async function eventually(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('timed out waiting for configured local transport');
}

function smtpFixture() {
  const messages = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    let dataMode = false;
    let message = '';
    const reply = (line) => socket.write(`${line}\r\n`);
    reply('220 fixture.smtp ESMTP');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (dataMode) {
        const end = buffer.indexOf('\r\n.\r\n');
        if (end < 0) return;
        message += buffer.slice(0, end);
        buffer = buffer.slice(end + 5);
        dataMode = false;
        messages.push(message);
        message = '';
        reply('250 queued');
      }
      while (!dataMode) {
        const end = buffer.indexOf('\r\n');
        if (end < 0) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) reply('250-fixture.smtp\r\n250 OK');
        else if (upper.startsWith('MAIL FROM') || upper.startsWith('RCPT TO')) reply('250 OK');
        else if (upper === 'DATA') {
          dataMode = true;
          reply('354 End data with <CR><LF>.<CR><LF>');
          return;
        } else if (upper === 'QUIT') reply('221 Bye');
        else reply('250 OK');
      }
    });
  });
  return { server, messages };
}

function eventFixture() {
  const events = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      events.push({
        method: req.method,
        path: req.url,
        headers: { ...req.headers },
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ accepted: true }));
    });
  });
  return { server, events };
}

function household(prefix) {
  const directory = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const storeFile = join(directory, 'store.json');
  const store = new Store(storeFile);
  const owner = createOwnerAccount(store, {
    email: `${prefix}-owner@fixture.test`,
    password: 'fixture-password',
    firstName: 'Owner',
    lastName: 'Person',
  });
  const acceptGuest = createOwnerAccount(store, {
    email: `${prefix}-accept@fixture.test`,
    password: 'fixture-password',
    firstName: 'Accept',
    lastName: 'Guest',
  });
  const outsider = createOwnerAccount(store, {
    email: `${prefix}-outsider@fixture.test`,
    password: 'fixture-password',
    firstName: 'Out',
    lastName: 'Sider',
  });
  store.flush();
  return { directory, storeFile, store, owner, acceptGuest, outsider };
}

function memberByAccount(body, accountId) {
  const members = Array.isArray(body) ? body : body?.members || [];
  return members.find((member) => member.accountId === accountId || member.memberId === accountId) || null;
}

function statusOf(loop, accountId) {
  return String((loop?.members || []).find((member) => member.accountId === accountId)?.status || '').toLowerCase();
}

async function waitDrained(outbox) {
  await new Promise((resolve) => setImmediate(resolve));
  await outbox.drain();
  await new Promise((resolve) => setImmediate(resolve));
}

async function post(base, store, target, body, accessKeyId, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  const headers = accessKeyId
    ? signedLoopHeaders(store, base, target, body, accessKeyId, extraHeaders)
    : {
      host: new URL(base).host,
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': target,
      ...extraHeaders,
    };
  const response = await fetch(`${base}/`, {
    method: 'POST',
    signal: AbortSignal.timeout(5000),
    headers: { ...headers, connection: 'close' },
    body: payload,
  });
  const raw = await response.text();
  return { status: response.status, rawBody: raw, body: raw ? JSON.parse(raw) : null };
}

async function startFaces(state, transports, agreementProvider) {
  const prior = process.env.NET_account;
  const published = [];
  let classic;
  const robotReadClient = {
    async getRobot() { return { payload: { suspended: false } }; },
  };
  const store = new Store(state.storeFile);
  const account = createAccountService({
    store,
    agreementProvider,
    robotReadClient,
    invitationProviders: { portalUrl: transports.portalUrl },
    invitationSmtp: { host: '127.0.0.1', port: transports.smtpPort, ignoreTLS: true },
    invitationMailFrom: 'local-sender@fixture.test',
    invitationEventFile: join(state.directory, 'invitation-events.json'),
    invitationEventUrl: transports.eventUrl,
    notificationPublisher: async (request) => {
      published.push({
        accountId: request.accountId,
        skillId: request.skillId,
        name: request.notification?.name,
        payloadRobot: request.notification?.payload?.robot ?? null,
      });
      classic.hub.enqueueNotification(request);
      return { accepted: true };
    },
  });
  const accountServer = await account.listen(0);
  const accountBase = `http://127.0.0.1:${accountServer.address().port}`;
  process.env.NET_account = accountBase;
  classic = createClassicEntrypoint({
    notificationFile: join(state.directory, 'classic-notifications.json'),
    notificationPollIntervalMs: 60_000,
  });
  const classicServer = await classic.listen(0);
  const classicBase = `http://127.0.0.1:${classicServer.address().port}`;
  state.store = store;
  state.owner = store.accountByEmail(state.owner.email);
  state.acceptGuest = store.accountByEmail(state.acceptGuest.email);
  state.outsider = store.accountByEmail(state.outsider.email);
  return {
    prior,
    account,
    classic,
    accountServer,
    classicServer,
    accountBase,
    classicBase,
    published,
    store,
  };
}

async function stopFaces(faces) {
  await closeServer(faces.classicServer);
  await closeServer(faces.accountServer);
  if (faces.prior === undefined) delete process.env.NET_account;
  else process.env.NET_account = faces.prior;
}

describe('A-04 gate 6 authentication and deployment restart', { concurrency: 1 }, () => {
test('Invite→Accept→list state and the next valid invite survive Account/Classic restart', async () => {
  const state = household('a04-gate6-seq');
  const smtp = smtpFixture();
  const event = eventFixture();
  const agreementProvider = {
    async refreshToken() {},
    async send() { return 'unused-agreement'; },
    async isSigned() { return false; },
  };
  let faces;
  try {
    const smtpPort = await listen(smtp.server);
    const eventPort = await listen(event.server);
    const transports = {
      smtpPort,
      portalUrl: 'http://portal.fixture.test',
      eventUrl: `http://127.0.0.1:${eventPort}/events`,
    };
    faces = await startFaces(state, transports, agreementProvider);
    const { store, owner, acceptGuest } = state;
    const created = await post(faces.classicBase, store, 'Loop_20160324.CreateLoop', {
      name: 'Restart Sequence', robotId: 'gate6-seq-robot',
    }, owner.accessKeyId);
    assert.equal(created.status, 200);
    const loopId = created.body.id;
    const robotId = created.body.robot;
    await waitDrained(faces.account.loopUpdatedOutbox);
    const invited = await post(faces.classicBase, store, 'Loop_20160324.InviteLoopMember', {
      loopId, email: acceptGuest.email, firstName: 'Accept', lastName: 'Guest',
    }, owner.accessKeyId);
    assert.equal(invited.status, 200);
    await eventually(() => smtp.messages.length >= 1 && event.events.length >= 1);
    const accepted = await post(faces.classicBase, store, 'Loop_20160324.AcceptLoopInvitation', {
      loopId,
    }, acceptGuest.accessKeyId);
    assert.equal(accepted.status, 200);
    await waitDrained(faces.account.loopUpdatedOutbox);
    assert.equal(statusOf(store.loops.get(loopId), acceptGuest._id), 'accepted');
    const listed = await post(faces.classicBase, store, 'Loop_20160324.ListLoopMembers', {}, owner.accessKeyId);
    assert.equal(listed.status, 200);
    assert.equal(memberByAccount(listed.body, acceptGuest._id).status, 'accepted');
    const smtpBeforeRestart = smtp.messages.length;
    const eventsBeforeRestart = event.events.length;

    await stopFaces(faces);
    faces = await startFaces(state, transports, agreementProvider);
    const reopened = new Store(state.storeFile);
    assert.equal(statusOf(reopened.loops.get(loopId), acceptGuest._id), 'accepted');
    assert.equal(reopened.loops.get(loopId).owner, owner._id);
    assert.equal(reopened.loops.get(loopId).robot, robotId);
    const listedAfter = await post(faces.classicBase, faces.store, 'Loop_20160324.ListLoopMembers', {}, owner.accessKeyId);
    assert.equal(listedAfter.status, 200);
    assert.equal(memberByAccount(listedAfter.body, acceptGuest._id).status, 'accepted');
    const next = await post(faces.classicBase, faces.store, 'Loop_20160324.InviteLoopMember', {
      loopId, email: 'post-restart@fixture.test', firstName: 'Post', lastName: 'Restart',
    }, owner.accessKeyId);
    assert.equal(next.status, 200);
    await waitDrained(faces.account.loopUpdatedOutbox);
    await eventually(() => smtp.messages.length > smtpBeforeRestart && event.events.length > eventsBeforeRestart);
    const listedNext = await post(faces.classicBase, faces.store, 'Loop_20160324.ListLoopMembers', {}, owner.accessKeyId);
    const invitedRow = (listedNext.body || []).find((member) => member.account?.email === 'post-restart@fixture.test'
      || member.memberProperties?.email === 'post-restart@fixture.test');
    assert.equal(invitedRow.status, 'invited');
    assert.equal(faces.published.at(-1).skillId, '-1');
    assert.equal(faces.published.at(-1).accountId, robotId);
    assert.equal(faces.account.loopUpdatedOutbox.pending().length, 0);
  } finally {
    if (faces) await stopFaces(faces);
    await closeServer(smtp.server);
    await closeServer(event.server);
    rmSync(state.directory, { recursive: true, force: true });
  }
});

test('configured local SMTP and HTTP invitation providers keep working after restart', async () => {
  const state = household('a04-gate6-transport');
  const smtp = smtpFixture();
  const event = eventFixture();
  const agreementProvider = {
    async refreshToken() {},
    async send() { return 'unused-agreement'; },
    async isSigned() { return false; },
  };
  let faces;
  try {
    const smtpPort = await listen(smtp.server);
    const eventPort = await listen(event.server);
    const transports = {
      smtpPort,
      portalUrl: 'http://portal.fixture.test',
      eventUrl: `http://127.0.0.1:${eventPort}/events`,
    };
    faces = await startFaces(state, transports, agreementProvider);
    const { owner } = state;
    const created = await post(faces.accountBase, faces.store, 'Loop_20160324.CreateLoop', {
      name: 'Transport Sequence', robotId: 'gate6-transport-robot',
    }, owner.accessKeyId);
    assert.equal(created.status, 200);
    const loopId = created.body.id;
    const invitedBefore = await post(faces.accountBase, faces.store, 'Loop_20160324.InviteLoopMember', {
      loopId, email: 'before-restart@fixture.test', firstName: 'Before',
    }, owner.accessKeyId);
    assert.equal(invitedBefore.status, 200);
    await eventually(() => smtp.messages.some((message) => /before-restart@fixture\.test/.test(message))
      && event.events.some((row) => row.headers['x-phoenix-event-key'] === 'InvitedToJoinLoop'));
    const beforeMail = smtp.messages.find((message) => /before-restart@fixture\.test/.test(message));
    assert.match(beforeMail, /^From: local-sender@fixture\.test\r?\n/m);
    assert.match(beforeMail, /^To: before-restart@fixture\.test\r?\n/m);
    const beforeEvent = event.events.find((row) => row.headers['x-phoenix-event-key'] === 'InvitedToJoinLoop');
    assert.equal(beforeEvent.method, 'POST');
    assert.equal(beforeEvent.path, '/events');

    await stopFaces(faces);
    faces = await startFaces(state, transports, agreementProvider);
    const invitedAfter = await post(faces.classicBase, faces.store, 'Loop_20160324.InviteLoopMember', {
      loopId, email: 'after-restart@fixture.test', firstName: 'After',
    }, owner.accessKeyId);
    assert.equal(invitedAfter.status, 200);
    await eventually(() => smtp.messages.some((message) => /after-restart@fixture\.test/.test(message))
      && event.events.some((row) => {
        try { return JSON.parse(row.body).payload?.email === 'after-restart@fixture.test'; } catch { return false; }
      }));
    const afterMail = smtp.messages.find((message) => /after-restart@fixture\.test/.test(message));
    assert.match(afterMail, /^From: local-sender@fixture\.test\r?\n/m);
    assert.match(afterMail, /^To: after-restart@fixture\.test\r?\n/m);
    const afterEvent = event.events.find((row) => {
      try { return JSON.parse(row.body).payload?.email === 'after-restart@fixture.test'; } catch { return false; }
    });
    assert.equal(JSON.parse(afterEvent.body).payload.eventKey, 'InvitedToJoinLoop');
  } finally {
    if (faces) await stopFaces(faces);
    await closeServer(smtp.server);
    await closeServer(event.server);
    rmSync(state.directory, { recursive: true, force: true });
  }
});

test('unsigned UpdateAgreementStatus stays isolated from ordinary Loop calls after restart', async () => {
  const state = household('a04-gate6-auth');
  const smtp = smtpFixture();
  const event = eventFixture();
  const sent = new Set();
  const agreementProvider = {
    async refreshToken() {},
    async send() {
      const id = `gate6-agreement-${sent.size + 1}`;
      sent.add(id);
      return id;
    },
    async isSigned(id) { return sent.has(id); },
  };
  let faces;
  try {
    const smtpPort = await listen(smtp.server);
    const eventPort = await listen(event.server);
    const transports = {
      smtpPort,
      portalUrl: 'http://portal.fixture.test',
      eventUrl: `http://127.0.0.1:${eventPort}/events`,
    };
    faces = await startFaces(state, transports, agreementProvider);
    const { owner, outsider } = state;
    const created = await post(faces.classicBase, faces.store, 'Loop_20160324.CreateLoop', {
      name: 'Auth Sequence', robotId: 'gate6-auth-robot',
    }, owner.accessKeyId);
    const loopId = created.body.id;
    const parentId = created.body.members.find((member) => member.accountId === owner._id).id;
    const child = await post(faces.classicBase, faces.store, 'Loop_20160324.InviteLoopMember', {
      loopId, firstName: 'Child', lastName: 'Fixture', isChild: true,
    }, owner.accessKeyId);
    assert.equal(child.status, 200);
    const childId = child.body.members.find((member) => member.account?.isChild).id;
    const guardian = await post(faces.classicBase, faces.store, 'Loop_20160324.SetLegalGuardian', {
      loopId, childId, parentId,
    }, owner.accessKeyId);
    assert.equal(guardian.status, 200);
    const agreementId = faces.store.loops.get(loopId).members.find((member) => member._id === childId).agreementId;
    assert.ok(agreementId);

    await stopFaces(faces);
    faces = await startFaces(state, transports, agreementProvider);

    const unsignedAgreement = await post(faces.classicBase, faces.store, 'Loop_20160324.UpdateAgreementStatus', {
      agreementId,
    }, null);
    assert.equal(unsignedAgreement.status, 200);
    assert.deepEqual(unsignedAgreement.body, { result: 'Command accepted' });
    const acceptedChild = faces.store.loops.get(loopId).members.find((member) => member._id === childId);
    assert.equal(String(acceptedChild.status).toLowerCase(), 'accepted');

    const forgedAgreement = await post(faces.accountBase, faces.store, 'Loop_20160324.UpdateAgreementStatus', {
      agreementId,
    }, null, { 'x-amz-credentials': JSON.stringify({ id: owner._id, isAdmin: true }) });
    assert.equal(forgedAgreement.status, 404);
    assert.equal(forgedAgreement.body.__type, 'AGREEMENT_NOT_FOUND');

    for (const [target, body] of [
      ['Loop_20160324.ListLoops', {}],
      ['Loop_20160324.InviteLoopMember', { loopId, email: 'leak@fixture.test' }],
      ['Loop_20160324.SetLegalGuardian', { loopId, childId, parentId }],
    ]) {
      for (const base of [faces.accountBase, faces.classicBase]) {
        const unsigned = await post(base, faces.store, target, body, null);
        assert.equal(unsigned.status, 401, target);
        assert.equal(unsigned.body.__type, 'MISSING_AUTH_HEADER', target);
        const forged = await post(base, faces.store, target, body, null, {
          'x-amz-credentials': JSON.stringify({ id: owner._id, isAdmin: true }),
        });
        assert.equal(forged.status, 401, `${target} forged`);
        assert.equal(forged.body.__type, 'MISSING_AUTH_HEADER', `${target} forged`);
      }
    }

    const signedOutsider = await post(faces.classicBase, faces.store, 'Loop_20160324.InviteLoopMember', {
      loopId, email: 'should-not-apply@fixture.test',
    }, outsider.accessKeyId, {
      'x-amz-credentials': JSON.stringify({ id: owner._id, isAdmin: true }),
    });
    assert.equal(signedOutsider.status, 403);
    assert.equal(signedOutsider.body.__type, 'CAN_BE_ACCESSED_BY_OWNER');
  } finally {
    if (faces) await stopFaces(faces);
    await closeServer(smtp.server);
    await closeServer(event.server);
    rmSync(state.directory, { recursive: true, force: true });
  }
});
});
