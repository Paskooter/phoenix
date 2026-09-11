// H-10 acceptance item 4: the original signed CreateHubToken -> Bearer-upgrade sequence,
// pinned end to end against the real Account issuer, the real Classic entrypoint and a
// real Hub upgrade - including the native single 401 refetch/retry.
//
// This is the sequence the robot performs; it is modelled from the pinned native client,
// not invented here:
//   jibohub-client/src/Authentication.cpp:33-73,167-257   get_authenticated_token
//     - signs an EMPTY StandardHttpRequest, then attaches  body `{}`,
//       `Content-Type: application/json`, `Content-Length: 2`,
//       `X-Amz-Target: Account_20151111.CreateHubToken`, and POSTs it to
//       `https://<entrypoint_hostname>/` (port 443, TLS).
//     - caches (token, expires) in process statics; refetches when the cache is empty or
//       `now_ms > expires`.
//   jibohub-client/src/ClientCloudConnection.cpp:59-103   authenticateAndOpen
//     - attempt 1 with the cached token; on the handshake status 401 ->
//       `Authentication::invalidateToken()` -> EXACTLY ONE refetch and ONE retry.
// The native request shape is the one already reproduced byte-for-byte by
// packages/account/tools/originalClientCompat.wire-corrected.evidence.js:126-149
// (`native-sign-before-body`: explicit x-amz-content-sha256 over an empty signed body).
//
// Observed live on the real robot (this work, docs/parity/evidence/2026-09-11/h10-native-bearer-upgrade):
//   GET /v1/listen  Authorization: Bearer <CreateHubToken JWT>  -> 401 Unauthorized
//     body `JsonWebTokenError: invalid signature`
//   native log `Jibohub_client.Connection: Authorization error connecting to: 192.168.1.182, re-fetching token.`
//   one refetch of the signed CreateHubToken, one retry -> 101 Switching Protocols.
//
// Sources: pegasus@5c0a7390539663ba749d360de348a428c088505c
//   packages/utils/src/service/BaseService.ts:58-78,170-192
//   packages/hub/src/HubService.ts:58-80
//   packages/hub/src/utils/MessagePreProcessor.ts:19-40, MessageValidator.ts:10-36

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { WebSocket } from 'ws';
import { jwt, signSigV4 } from '@phoenix/common';

const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');
const TARGET = 'Account_20151111.CreateHubToken';
const S0 = 'h10-sequence-secret-0';
const S1 = 'h10-sequence-secret-1';

const dir = mkdtempSync(join(tmpdir(), 'phx-h10-seq-'));
const storeFile = join(dir, 'store.json');
const previousSecret = process.env.ETCO_server_hubTokenSecret;
const previousHubSecret = process.env.HUB_TOKEN_SECRET;
const previousAccountNet = process.env.NET_account;
delete process.env.HUB_TOKEN_SECRET;
process.env.ETCO_server_hubTokenSecret = S0;
process.env.ETCO_account_dataFile = storeFile;

const { createAccountService, Store } = await import('../../account/src/index.js');
const { createOwnerAccount, createLoop } = await import('../../account/src/model.js');
const { createClassicEntrypoint } = await import('../../classic/src/index.js');
const { createGateway } = await import('@phoenix/gateway');

let accountService;
let classic;
let entrypointHost;
let robot;
const closers = [];

before(async () => {
  const store = new Store(storeFile);
  const owner = createOwnerAccount(store, { email: 'h10-sequence@fixture.test', password: 'H10-safe-pass-1' });
  ({ robot } = createLoop(store, { owner, robotId: 'h10-sequence-robot' }));
  accountService = await createAccountService({ store }).listen(0);
  process.env.NET_account = `localhost:${accountService.address().port}`;
  classic = createClassicEntrypoint();
  await new Promise((resolve) => classic.server.listen(0, resolve));
  entrypointHost = `localhost:${classic.server.address().port}`;
});

after(async () => {
  for (const close of closers.reverse()) await close();
  await new Promise((resolve) => classic.server.close(resolve));
  await new Promise((resolve) => accountService.close(resolve));
  if (previousSecret === undefined) delete process.env.ETCO_server_hubTokenSecret;
  else process.env.ETCO_server_hubTokenSecret = previousSecret;
  if (previousHubSecret === undefined) delete process.env.HUB_TOKEN_SECRET;
  else process.env.HUB_TOKEN_SECRET = previousHubSecret;
  if (previousAccountNet === undefined) delete process.env.NET_account;
  else process.env.NET_account = previousAccountNet;
  delete process.env.ETCO_account_dataFile;
  rmSync(dir, { recursive: true, force: true });
});

// --- the native client's own request construction (Authentication.cpp) -----------------

/**
 * POST exactly what `Authentication::get_token` posts: a request signed while its body was
 * still empty (so `x-amz-content-sha256` is the empty-string digest), carrying `{}` as the
 * wire body plus the target/content headers the native code attaches after signing.
 */
async function signedCreateHubToken({ body = '{}', date = new Date() } = {}) {
  const signed = signSigV4({
    method: 'POST',
    path: '/',
    body: '',
    headers: { Host: entrypointHost, 'x-amz-content-sha256': EMPTY_SHA256 },
    accessKeyId: robot.accessKeyId,
    secretAccessKey: robot.secretAccessKey,
    region: 'global',
    service: 'jibo',
    date,
  });
  const response = await fetch(`http://${entrypointHost}/`, {
    method: 'POST',
    headers: {
      ...signed.headers,
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(body)),
      'X-Amz-Target': TARGET,
    },
    body,
  });
  const raw = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { /* keep null */ }
  return { status: response.status, body: parsed, raw };
}

// --- raw upgrade / frame helpers (same shape as hubAuth.runtime.test.js) ---------------

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
      resolve({ status: Number(status[1]), reason: status[2], body: bytes.subarray(separator + 4).toString('utf8') });
      socket.destroy();
    };
    // A 101 leaves the socket open as a WebSocket, so completion is decided by the
    // response head (plus content-length bytes for a rejected upgrade), not by close.
    const complete = () => {
      const bytes = Buffer.concat(chunks);
      const separator = bytes.indexOf('\r\n\r\n');
      if (separator < 0) return false;
      const head = bytes.subarray(0, separator).toString('latin1').split('\r\n');
      if (/^HTTP\/1\.1 101 /.test(head[0])) return true;
      const match = head.find((line) => /^content-length:/i.test(line));
      const declared = match ? Number(match.split(':')[1].trim()) : 0;
      return bytes.length - (separator + 4) >= declared;
    };
    socket.on('connect', () => {
      const lines = ['GET ' + path + ' HTTP/1.1', 'Host: 127.0.0.1', 'Upgrade: websocket', 'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13'];
      if (authorization !== undefined) lines.push('Authorization: ' + authorization);
      socket.write(lines.join('\r\n') + '\r\n\r\n');
    });
    socket.on('data', (chunk) => { chunks.push(chunk); if (complete()) finish(); });
    socket.on('end', finish);
    socket.on('close', finish);
    socket.on('error', (error) => { if (!settled && chunks.length === 0) { settled = true; clearTimeout(timer); reject(error); } });
  });
}

function drive(port, path, frames, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    const messages = [];
    let settled = false;
    const finish = () => { if (settled) return; settled = true; try { ws.close(); } catch { /* already closed */ } resolve(messages); };
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

async function withGateway(secret, run) {
  const gateway = await createGateway({
    hubTokenSecret: secret, disableAuth: false, accountUrl: '',
    parserURL: 'http://127.0.0.1:9', historyURL: 'http://127.0.0.1:9', skills: [],
  });
  await gateway.service.listen(0);
  closers.push(() => new Promise((resolve) => { gateway.wss.close(() => resolve()); }));
  const port = gateway.service.server.address().port;
  closers.push(() => new Promise((resolve, reject) => gateway.service.server.close((error) => (error ? reject(error) : resolve()))));
  return run(port);
}

/**
 * ClientCloudConnection::authenticateAndOpen (native). Returns the observable exchange so a
 * regression in either the 401 contract or the single-retry contract is visible.
 */
async function nativeAuthenticateAndOpen({ hubPort, path = '/v1/listen', cachedToken }) {
  const exchange = { attempts: [], refetches: 0, tokenUsed: cachedToken };
  const open = async () => {
    const response = await rawUpgrade(hubPort, path, `Bearer ${exchange.tokenUsed}`);
    exchange.attempts.push({ status: response.status, body: response.body });
    return response;
  };
  let response = await open();
  if (response.status === 401) {
    // Authentication::invalidateToken() then one re-fetch through the signed CreateHubToken.
    const refetched = await signedCreateHubToken();
    assert.equal(refetched.status, 200, 'the re-fetch must reach the Account issuer');
    exchange.refetches += 1;
    exchange.tokenUsed = refetched.body.token;
    response = await open();
  }
  return exchange;
}

// --- the sequence ----------------------------------------------------------------------

test('the native signed CreateHubToken issues a token the Hub accepts as a Bearer credential', async () => {
  const issued = await signedCreateHubToken();
  assert.equal(issued.status, 200, issued.raw);
  assert.equal(typeof issued.body.token, 'string');
  assert.deepEqual(Object.keys(jwt.verify(issued.body.token, S0)), [
    'accessKeyId', 'email', 'friendlyId', 'id', 'payload', 'secretAccessKey', 'iat', 'exp',
  ], 'the Account CreateHubToken claim object, in source order');
  assert.equal(jwt.verify(issued.body.token, S0).payload, null, 'an empty {} body becomes payload null');

  await withGateway(S0, async (port) => {
    for (const path of ['/listen', '/v1/listen', '/proactive', '/v1/proactive']) {
      const response = await rawUpgrade(port, path, `Bearer ${issued.body.token}`);
      assert.equal(response.status, 101, `${path}: the issued token must upgrade`);
    }
    // Layer 1 runs first (credentials), layer 2 is the registered-path allow-list.
    const noCredentials = await rawUpgrade(port, '/v1/listen');
    assert.equal(noCredentials.status, 401);
    assert.equal(noCredentials.body, 'Authorization is required');
    const unknownPath = await rawUpgrade(port, '/v1/unknown', `Bearer ${issued.body.token}`);
    assert.equal(unknownPath.status, 404, 'a valid token does not widen the path allow-list');
  });
});

test('a rotated Hub secret is a 401 on the cached token and the native client recovers with exactly one refetch and one retry', async () => {
  const stale = await signedCreateHubToken();
  assert.equal(stale.status, 200);

  // Rotation: the issuer now signs with S1, so the cached S0 token is no longer admissible.
  process.env.ETCO_server_hubTokenSecret = S1;
  try {
    await withGateway(S1, async (port) => {
      const response = await rawUpgrade(port, '/v1/listen', `Bearer ${stale.body.token}`);
      assert.equal(response.status, 401, 'a stale token must be refused at the upgrade boundary');
      assert.equal(response.body, 'JsonWebTokenError: invalid signature',
        'the native client decides to refetch on this body/status pair');

      const exchange = await nativeAuthenticateAndOpen({ hubPort: port, cachedToken: stale.body.token });
      assert.deepEqual(exchange.attempts.map((attempt) => attempt.status), [401, 101]);
      assert.equal(exchange.refetches, 1, 'the native client refetches exactly once');
      assert.notEqual(exchange.tokenUsed, stale.body.token, 'the retry must carry a freshly issued token');
      assert.deepEqual(exchange.attempts[0].body, 'JsonWebTokenError: invalid signature');

      // A second failure is NOT retried into a third attempt: the retry is single-shot.
      const stillStale = await rawUpgrade(port, '/v1/listen', `Bearer ${stale.body.token}`);
      assert.equal(stillStale.status, 401);
    });
  } finally {
    process.env.ETCO_server_hubTokenSecret = S0;
  }
});

test('an expired CreateHubToken is refused with the source 401 body', async () => {
  const issued = await signedCreateHubToken();
  const claims = jwt.verify(issued.body.token, S0);
  const now = Math.floor(Date.now() / 1000);
  const expired = jwt.sign({ ...claims, iat: now - 7200, exp: now - 3600 }, S0);
  await withGateway(S0, async (port) => {
    const response = await rawUpgrade(port, '/v1/listen', `Bearer ${expired}`);
    assert.equal(response.status, 401);
    assert.equal(response.body, 'TokenExpiredError: jwt expired');
  });
});

test('CONTEXT identity is checked against the CreateHubToken identity, on both Hub paths', async () => {
  const issued = await signedCreateHubToken();
  const claims = jwt.verify(issued.body.token, S0);
  const contextFrame = (general) => ({ type: 'CONTEXT', data: { general, runtime: { loop: {} } } });

  await withGateway(S0, async (port) => {
    for (const path of ['/listen', '/proactive']) {
      const mismatch = await drive(port, path, [contextFrame({ accountID: 'someone-else', robotID: claims.friendlyId, release: '1.8.0' })], issued.body.token);
      assert.equal(mismatch.length, 1, path);
      assert.equal(mismatch[0].type, 'ERROR');
      assert.deepEqual(mismatch[0].data, { message: 'data.general.accountID is not equal to socket accountID' }, path);
      assert.equal(Object.hasOwn(mismatch[0].data, 'code'), false);
    }
    // The identity the token carries is the identity that is accepted.
    const accepted = await drive(port, '/listen', [
      { type: 'LISTEN', data: { lang: 'en-US', mode: 'CLIENT_NLU', hotphrase: false, rules: ['launch'] } },
      contextFrame({ accountID: claims.id, robotID: claims.friendlyId, release: '1.8.0' }),
      { type: 'CLIENT_NLU', data: { intent: 'no-such-intent', rules: ['launch'], entities: {} } },
    ], issued.body.token);
    assert.deepEqual(accepted.map((message) => message.type), ['SOS', 'EOS', 'LISTEN']);
    assert.equal(accepted.at(-1).final, true);
  });
});
