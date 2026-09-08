// A-04 local deployment controls: source invitation templates over SMTP and
// durable EventSender-compatible delivery over an explicit HTTP consumer.
// All identities, addresses, and event bodies below are synthetic fixtures.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { signedLoopHeaders } from './fixtures/signedLoopRequest.js';
import {
  createAccountService,
  createConfiguredInvitationEventSender,
  createConfiguredInvitationProviders,
  InvitationEventOutbox,
  normalizeSmtpConfig,
  InvitedToJoinLoop,
  Store,
} from '../src/index.js';
import { createLoop, createOwnerAccount } from '../src/model.js';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

async function eventually(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('timed out waiting for local invitation transport');
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

function decodeQuotedPrintable(value) {
  const text = String(value).replace(/=\r?\n/g, '');
  const bytes = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '=' && /^[0-9a-f]{2}$/i.test(text.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(text.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(text.charCodeAt(index));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function eventFixture({ status = 202 } = {}) {
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
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ accepted: status >= 200 && status < 300 }));
    });
  });
  return { server, events };
}

async function invite(store, base, owner, body) {
  const response = await fetch(`${base}/`, {
    method: 'POST',
    headers: signedLoopHeaders(store, base, 'Loop_20160324.InviteLoopMember', body, owner.accessKeyId),
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.text() };
}

function restoreEnvironment(saved) {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function sourceEvent(email = 'event@fixture.test') {
  return new InvitedToJoinLoop({
    accountId: 'account-fixture',
    email,
    firstName: 'Event',
    lastName: 'Fixture',
    loopId: 'loop-fixture',
    ownerId: 'owner-fixture',
  });
}

test('configured Account launch sends source templates to a local SMTP relay and event consumer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-a04-invitation-deployment-'));
  const keys = [
    'ETCO_account_mailSmtpUrl', 'ETCO_account_mailFrom', 'ETCO_account_portalUrl',
    'ETCO_account_invitationEventFile', 'ETCO_account_invitationEventUrl',
  ];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const smtp = smtpFixture();
  const event = eventFixture();
  let accountService;
  let smtpPort;
  let eventPort;
  try {
    smtpPort = await listen(smtp.server);
    eventPort = await listen(event.server);
    const store = new Store(join(dir, 'account.json'));
    const owner = createOwnerAccount(store, {
      email: 'deployment-owner@fixture.test',
      password: 'fixture-password',
      firstName: 'Deployment',
      lastName: 'Owner',
    });
    const known = createOwnerAccount(store, {
      email: 'known-member@fixture.test',
      password: 'fixture-password',
      firstName: 'Known',
    });
    const { loop } = createLoop(store, { owner, robotId: 'deployment-robot' });
    process.env.ETCO_account_mailSmtpUrl = `smtp://127.0.0.1:${smtpPort}`;
    process.env.ETCO_account_mailFrom = 'local-sender@fixture.test';
    process.env.ETCO_account_portalUrl = 'https://portal.fixture.test';
    process.env.ETCO_account_invitationEventFile = join(dir, 'invitation-events.json');
    process.env.ETCO_account_invitationEventUrl = `http://127.0.0.1:${eventPort}/events`;

    accountService = await createAccountService({ store }).listen(0);
    const base = `http://127.0.0.1:${accountService.address().port}`;
    const response = await invite(store, base, owner, {
      loopId: loop._id,
      email: 'New.Person@fixture.test',
      firstName: '  New  ',
      lastName: ' Person ',
    });
    assert.equal(response.status, 200);
    await eventually(() => smtp.messages.length === 1 && event.events.length === 1);

    const message = smtp.messages[0];
    const decodedMessage = decodeQuotedPrintable(message);
    assert.match(message, /^From: local-sender@fixture\.test\r?\n/m);
    assert.match(message, /^To: new\.person@fixture\.test\r?\n/m);
    assert.match(message, /^Subject: Invitation\r?\n/m);
    assert.match(decodedMessage, /deployment-owner@fixture\.test added you to their Loop/);
    assert.match(decodedMessage, /https:\/\/portal\.fixture\.test\/create\?email=new\.person%40fixture\.test&code=/);
    // MailController substitutes only HTML; source text content remains the
    // literal template text, which is useful for checking the body split.
    assert.match(decodedMessage, /\{name\} sent you an invite/);
    assert.match(decodedMessage, /Don't have an account\?[^\r\n]*new\.person@fixture\.test/);

    const existingResponse = await invite(store, base, owner, {
      loopId: loop._id,
      email: known.email.toUpperCase(),
      firstName: 'Known',
    });
    assert.equal(existingResponse.status, 200);
    await eventually(() => smtp.messages.length === 2 && event.events.length === 2);
    const existingMessage = smtp.messages[1];
    const decodedExistingMessage = decodeQuotedPrintable(existingMessage);
    assert.match(existingMessage, /^To: known-member@fixture\.test\r?\n/m);
    assert.match(decodedExistingMessage, /deployment-owner@fixture\.test added you to their Loop/);
    assert.match(decodedExistingMessage, /https:\/\/portal\.fixture\.test\/home\?email=known-member%40fixture\.test/);
    assert.doesNotMatch(decodedExistingMessage, /\/home\?email=known-member%40fixture\.test&code=/);

    assert.equal(event.events[0].method, 'POST');
    assert.equal(event.events[0].path, '/events');
    assert.equal(event.events[0].headers['x-phoenix-event-key'], 'InvitedToJoinLoop');
    const receivedEvent = JSON.parse(event.events[0].body);
    assert.deepEqual(receivedEvent.payload, {
      email: 'new.person@fixture.test',
      firstName: 'New',
      lastName: 'Person',
      loopId: loop._id,
      ownerId: owner._id,
      eventKey: 'InvitedToJoinLoop',
    });
    const receivedExistingEvent = JSON.parse(event.events[1].body);
    assert.equal(receivedExistingEvent.payload.accountId, known._id);
    assert.equal(receivedExistingEvent.payload.email, known.email);
    const eventFile = join(dir, 'invitation-events.json');
    assert.equal(JSON.parse(readFileSync(eventFile, 'utf8')).events.length, 0);
    assert.equal(statSync(eventFile).mode & 0o777, 0o600);
  } finally {
    restoreEnvironment(saved);
    await close(accountService);
    await close(smtp.server);
    await close(event.server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('durable event sender retains failed local consumers and recovers after reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-a04-event-outbox-'));
  const file = join(dir, 'events.json');
  const event = sourceEvent();
  const failures = [];
  let first = true;
  try {
    const sender = createConfiguredInvitationEventSender({
      file,
      publisher: async () => {
        if (first) {
          first = false;
          throw new Error('local consumer unavailable');
        }
        return { accepted: true };
      },
    });
    await assert.rejects(sender.send(event), /local consumer unavailable/);
    assert.equal(sender.pending().length, 1);
    assert.equal(sender.pending()[0].attempts, 1);
    assert.ok(existsSync(file));

    const reopened = new InvitationEventOutbox(file, {
      publisher: async (received) => {
        failures.push(received);
        return { accepted: true };
      },
    });
    const result = await reopened.recover();
    assert.deepEqual(result, { published: 1, retained: 0 });
    assert.equal(failures.length, 1);
    assert.deepEqual(failures[0], JSON.parse(JSON.stringify(event)));
    assert.deepEqual(new InvitationEventOutbox(file).pending(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('event sender turns synchronous validation and persistence failures into rejected promises', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-a04-event-promise-boundary-'));
  try {
    const validationSender = new InvitationEventOutbox(join(dir, 'validation.json'));
    const invalid = {
      payload: { eventKey: 'InvitedToJoinLoop' },
      validate() {
        throw new Error('synthetic event validation failed');
      },
    };
    const validationResult = validationSender.send(invalid);
    assert.equal(validationResult instanceof Promise, true);
    await assert.rejects(validationResult, /synthetic event validation failed/);

    const persistenceSender = new InvitationEventOutbox(join(dir, 'persistence.json'), {
      persistence: {
        rename() {
          throw new Error('synthetic event commit failed');
        },
      },
    });
    const persistenceResult = persistenceSender.send(sourceEvent('persist@fixture.test'));
    assert.equal(persistenceResult instanceof Promise, true);
    await assert.rejects(persistenceResult, /synthetic event commit failed/);
    assert.deepEqual(persistenceSender.pending(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('configured providers expose an explicit unavailable boundary and reject partial SMTP configuration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-a04-provider-config-'));
  const envKeys = [
    'ETCO_account_mailSmtpUrl', 'ETCO_account_mailSmtpHost', 'ETCO_account_mailSmtpPort',
    'ETCO_account_mailSmtpSecure', 'ETCO_account_mailSmtpUser', 'ETCO_account_mailSmtpPassword',
    'ETCO_account_mailSmtpIgnoreTLS', 'ETCO_account_mailSmtpRequireTLS',
    'ETCO_account_mailSmtpAuthMethod', 'ETCO_account_mailSmtpTimeoutMs', 'ETCO_account_mailSmtpServername',
    'ETCO_account_mailSmtpRejectUnauthorized',
  ];
  const saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  try {
    for (const key of envKeys) delete process.env[key];
    const noConfig = createConfiguredInvitationProviders({ store: { file: join(dir, 'account.json') } });
    assert.equal(noConfig.invitation, null);
    assert.equal(noConfig.invitationExistingUser, null);
    assert.equal(noConfig.eventSender, null);

    process.env.ETCO_account_mailSmtpPort = '2525';
    assert.throws(() => createConfiguredInvitationProviders({ store: { file: join(dir, 'account.json') } }),
      /ETCO_account_mailSmtpHost/);

    const parsed = normalizeSmtpConfig({
      host: 'fixture.smtp', secure: 'false', rejectUnauthorized: 'false', timeoutMs: '12',
    });
    assert.equal(parsed.secure, false);
    assert.equal(parsed.rejectUnauthorized, false);
    assert.equal(parsed.timeoutMs, 12);
    const urlOverride = normalizeSmtpConfig({
      url: 'smtps://fixture.smtp:465', rejectUnauthorized: 'false', timeoutMs: '17',
    });
    assert.equal(urlOverride.secure, true);
    assert.equal(urlOverride.rejectUnauthorized, false);
    assert.equal(urlOverride.timeoutMs, 17);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
