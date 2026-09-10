// H-10 runtime: hub authentication and CONTEXT identity observed through a live server.
//
// Every assertion here comes from real network traffic (WebSocket upgrades and JSON
// frames on an open listen/proactive socket), not from reading source. Accept and
// reject paths are both exercised, including the negative cases.
//
// Sources: pegasus@5c0a7390539663ba749d360de348a428c088505c
//   packages/utils/src/service/BaseService.ts:58-78  (bearer matrix)
//   packages/utils/src/service/BaseService.ts:170-192 (auth-before-path upgrade order)
//   packages/hub/src/HubService.ts:58-80             (exact socket paths; HTTP routes are NOT auth-gated)
//   packages/hub/src/listen/ListenHandler.ts:32-71   (ERROR envelope on preprocess failure)
//   packages/hub/src/utils/MessagePreProcessor.ts:19-40 + MessageValidator.ts:10-36 (identity)
//   packages/utils/src/socket/Socket.ts:24-34        (client maps 401 -> UNAUTHORIZED, 404 -> INVALID_URL)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { WebSocket } from 'ws';
import { jwt } from '@phoenix/common';

const { createGateway } = await import('@phoenix/gateway');

const SECRET = 'h10-runtime-secret';
const BASE = {
  hubTokenSecret: SECRET,
  disableAuth: false,
  accountUrl: '',
  parserURL: 'http://127.0.0.1:9',
  historyURL: 'http://127.0.0.1:9',
  skills: [],
};

const token = (claims = {}, secret = SECRET) => jwt.sign({ id: 'acct-A', friendlyId: 'robot-A', ...claims }, secret);

async function withGateway(overrides, run) {
  const gateway = await createGateway({ ...BASE, ...overrides });
  await gateway.service.listen(0);
  const port = gateway.service.server.address().port;
  try {
    return await run(port);
  } finally {
    await new Promise((resolve) => gateway.wss.close(() => resolve()));
    await new Promise((resolve, reject) => gateway.service.server.close((error) => (error ? reject(error) : resolve())));
  }
}

function rawUpgrade(port, path, authorization) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const timer = setTimeout(() => { socket.destroy(); if (!settled) { settled = true; reject(new Error(`upgrade timeout ${path}`)); } }, 2000);
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const bytes = Buffer.concat(chunks);
      const separator = bytes.indexOf('\r\n\r\n');
      const head = bytes.subarray(0, separator).toString('latin1').split('\r\n');
      const status = head.shift().match(/^HTTP\/1\.1 (\d+) (.*)$/);
      const headers = Object.create(null);
      for (const line of head) {
        const colon = line.indexOf(':');
        if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
      }
      resolve({ status: Number(status[1]), reason: status[2], headers, body: bytes.subarray(separator + 4).toString('utf8') });
    };
    socket.on('connect', () => {
      const lines = ['GET ' + path + ' HTTP/1.1', 'Host: 127.0.0.1', 'Upgrade: websocket', 'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13'];
      if (authorization !== undefined) lines.push('Authorization: ' + authorization);
      socket.write(lines.join('\r\n') + '\r\n\r\n');
    });
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', finish);
    socket.on('close', finish);
    socket.on('error', (error) => { if (!settled && chunks.length === 0) { settled = true; clearTimeout(timer); reject(error); } });
  });
}

// Open a socket, send every frame on `open`, collect responses until one is final.
function drive(port, path, frames, { auth = token() } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: { Authorization: `Bearer ${auth}` } });
    const messages = [];
    let settled = false;
    const finish = () => { if (settled) return; settled = true; try { ws.close(); } catch {} resolve(messages); };
    const timer = setTimeout(finish, 1500);
    ws.on('open', () => frames.forEach((frame) => ws.send(JSON.stringify(frame))));
    ws.on('message', (data) => {
      const message = JSON.parse(data.toString());
      messages.push(message);
      if (message.final) { clearTimeout(timer); setTimeout(finish, 10); }
    });
    ws.on('unexpected-response', (_req, res) => {
      res.on('data', (chunk) => messages.push({ upgradeStatus: res.statusCode, body: chunk.toString() }));
      res.on('end', () => { clearTimeout(timer); finish(); });
    });
    ws.on('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

// Assert a WebSocket upgrade is accepted (used when no Authorization header is expected).
function assertUpgradeAccepted(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    ws.once('open', () => { ws.close(); resolve(); });
    ws.once('unexpected-response', (_req, res) => reject(new Error(`unexpected ${res.statusCode} for ${path}`)));
    ws.once('error', reject);
  });
}

const contextFrame = (general) => ({ type: 'CONTEXT', data: { general, runtime: { loop: {} } } });
const listenNlu = { type: 'LISTEN', data: { lang: 'en-US', mode: 'CLIENT_NLU', hotphrase: false, rules: ['launch'] } };
const nluNoMatch = { type: 'CLIENT_NLU', data: { intent: 'no-such-intent', rules: ['launch'], entities: {} } };

function assertErrorFrame(frame, message) {
  assert.equal(frame.type, 'ERROR');
  assert.equal(frame.final, true);
  assert.deepEqual(frame.data, { message });
  assert.equal(Object.hasOwn(frame.data, 'code'), false, 'a plain Error carries no code (source emits undefined -> dropped)');
  assert.equal(typeof frame.timings.total, 'number');
}

// --- CONTEXT identity: reject -------------------------------------------------

test('listen: a CONTEXT whose accountID differs from the socket JWT is rejected', async () => {
  await withGateway({}, async (port) => {
    const messages = await drive(port, '/listen', [contextFrame({ accountID: 'acct-B', robotID: 'robot-A', release: '1.8.0' })]);
    assert.equal(messages.length, 1);
    assertErrorFrame(messages[0], 'data.general.accountID is not equal to socket accountID');
  });
});

test('listen: a CONTEXT whose robotID differs from the socket JWT is rejected (no cross-robot substitution)', async () => {
  await withGateway({}, async (port) => {
    const messages = await drive(port, '/listen', [contextFrame({ accountID: 'acct-A', robotID: 'robot-B', release: '1.8.0' })]);
    assert.equal(messages.length, 1);
    assertErrorFrame(messages[0], 'data.general.robotID is not equal to socket robotID');
  });
});

test('proactive: a mismatched CONTEXT is rejected with the same envelope', async () => {
  await withGateway({}, async (port) => {
    const messages = await drive(port, '/proactive', [contextFrame({ accountID: 'acct-B', robotID: 'robot-B', release: '1.8.0' })]);
    assert.equal(messages.length, 1);
    assertErrorFrame(messages[0], 'data.general.accountID is not equal to socket accountID');
  });
});

// --- CONTEXT identity: accept -------------------------------------------------

test('listen: a CONTEXT matching the socket JWT is accepted and the turn completes', async () => {
  await withGateway({}, async (port) => {
    const messages = await drive(port, '/listen', [
      listenNlu,
      contextFrame({ accountID: 'acct-A', robotID: 'robot-A', release: '1.8.0' }),
      nluNoMatch,
    ]);
    assert.deepEqual(messages.map((m) => m.type), ['SOS', 'EOS', 'LISTEN']);
    assert.equal(messages.at(-1).final, true);
    assert.equal(messages.at(-1).data.match, null);
  });
});

test('listen: general defaults are filled from the authenticated socket, not the CONTEXT body', async () => {
  await withGateway({}, async (port) => {
    // The CONTEXT carries no general at all: preprocessContext must inject accountID/robotID
    // from the JWT and then validate them, so the turn proceeds instead of erroring.
    const messages = await drive(port, '/listen', [
      listenNlu,
      { type: 'CONTEXT', data: { runtime: { loop: { users: [{ firstName: '  Ada  ' }] } } } },
      nluNoMatch,
    ]);
    assert.deepEqual(messages.map((m) => m.type), ['SOS', 'EOS', 'LISTEN']);
  });
});

// --- upgrade-time authentication ---------------------------------------------

test('an empty configured secret rejects even a correctly signed token', async () => {
  await withGateway({ hubTokenSecret: '' }, async (port) => {
    const response = await rawUpgrade(port, '/listen', 'Bearer ' + token({}, SECRET));
    assert.equal(response.status, 401);
    assert.equal(response.body, 'No JWT secret set');
  });
});

test('non-HMAC algorithm headers are rejected before a socket opens', async () => {
  await withGateway({}, async (port) => {
    const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const rs256 = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ id: 'robot-A' })}.AAAA`;
    const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ id: 'robot-A' })}.`;
    assert.equal((await rawUpgrade(port, '/listen', 'Bearer ' + rs256)).body, 'JsonWebTokenError: invalid algorithm');
    assert.equal((await rawUpgrade(port, '/listen', 'Bearer ' + none)).body, 'JsonWebTokenError: jwt signature is required');
  });
});

test('disableAuth removes the credential requirement but keeps the exact path lookup', async () => {
  await withGateway({ disableAuth: true, skills: [{ id: 'sk', URL: 'http://127.0.0.1:9/v1/main', intents: [] }] }, async (port) => {
    // No Authorization header at all: the known path still upgrades.
    await assertUpgradeAccepted(port, '/listen');
    // Unknown path is still the source 404, even unauthenticated.
    const response = await rawUpgrade(port, '/unknown');
    assert.equal(response.status, 404);
    assert.equal(response.body, "WebSocket url '/unknown' has no handler");
  });
});

// --- HTTP surface: source does not auth-gate the skill-list routes ------------

test('skill-list and healthcheck HTTP routes stay reachable without credentials', async () => {
  await withGateway({ skills: [{ id: 'sk', URL: 'http://127.0.0.1:9/v1/main', intents: [] }] }, async (port) => {
    // BaseService registers /healthcheck free of auth, and HubService.ts:75-80 adds the
    // /skills + /v1/skills handlers WITHOUT authenticationRequired.
    const health = await fetch(`http://127.0.0.1:${port}/healthcheck`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), 'ok');

    for (const path of ['/skills/robot-A', '/v1/skills/robot-A', '/skills/settings/robot-A', '/v1/skills/settings/robot-A']) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      assert.equal(response.status, 200, path);
      const body = await response.json();
      assert.ok(Array.isArray(body.skills), path);
    }
  });
});
