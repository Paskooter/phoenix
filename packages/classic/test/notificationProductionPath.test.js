// A-10 production-path control for the notification socket.
//
// The earlier controls split the production path across two files: the TLS
// control minted a token over signed REST and then called
// `hub.enqueueNotification()` in process, while the HTTP producer route
// (`POST /notify`, packages/classic/src/index.js:161) was only exercised in the
// resolver-less LAN binding. Neither drove the whole chain the deployed stack
// actually runs:
//
//   signed NewRobotToken (SNI <region>.jibo.com)
//     -> wss upgrade carrying the token (SNI <region>-socket.jibo.com)
//     -> POST /notify (the real producer route)
//     -> frame on the socket
//     -> durable row removed by the send callback (acked, queue 1 -> 0)
//
// and neither pinned the region name the ROBOT builds. The native
// jibo-server-service config is `serverURLSuffix: "-socket.jibo.com"` with
// region `api`, so the socket host is `api-socket.jibo.com` — not the `phx`
// synthetic region an earlier fixture used. `regionsFrom()` already defaults to
// `api` (scripts/ensure-tls-certs.mjs:27), so this file pins the DEFAULT names
// and drives the socket under the real robot SNI.
//
// Design intent, from the Jibo archive MCP (Confluence
// /confluence/display/SER/Notifications, "Robot to Server interaction"):
//   "every time robot gets online it establishes WebScoket connection using
//    URL like wss://<SERVER>.jibo.com/<robotWebSocketToken>"
//   "If same robot requested new robotWebSocketToken for same owner, old token
//    will become invalid."
// The pinned consumer implements that URL as `wsendpoint + '/' + token`
// (jiborobot/srv-jibo-server-client lib/services/notification.js).
//
// All accounts, keys and files are synthetic. The robot firmware itself is not
// available, so nothing here drives a real device; this is the same wire shape
// the robot's native client produces, over TLS with the robot's real names.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import https from 'node:https';
import { WebSocket } from 'ws';
import { signSigV4 } from '@phoenix/common';
import { createClassicEntrypoint, createVerifiedNotificationAccountResolver } from '../src/index.js';
import { ensureTlsCertificates, regionsFrom } from '../../../scripts/ensure-tls-certs.mjs';

const hasOpenssl = (() => {
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();
const skip = hasOpenssl ? false : 'openssl is required to build the robot TLS certificate fixture';

const REGION = 'api';
const REST_SNI = `${REGION}.jibo.com`;
const SOCKET_SNI = `${REGION}-socket.jibo.com`;

const ACCOUNTS = {
  'A10-PROD-A': { _id: 'a10-prod-a', id: 'a10-prod-a', accessKeyId: 'A10-PROD-A', secretAccessKey: 'prod-a-secret', isActive: true, isDeleted: false },
  'A10-PROD-B': { _id: 'a10-prod-b', id: 'a10-prod-b', accessKeyId: 'A10-PROD-B', secretAccessKey: 'prod-b-secret', isActive: true, isDeleted: false },
};

const tempDir = () => mkdtempSync(join(tmpdir(), 'phoenix-a10-prod-'));
const tick = () => new Promise((resolve) => setImmediate(resolve));
function waitFor(predicate, timeoutMs = 4000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - started >= timeoutMs) return reject(new Error('timed out waiting for the live socket'));
      setTimeout(check, 5);
    };
    check();
  });
}

function signHeaders({ target, body, account, host = REST_SNI }) {
  return signSigV4({
    method: 'POST',
    path: '/',
    body,
    headers: { Host: host, 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': target },
    accessKeyId: account.accessKeyId,
    secretAccessKey: account.secretAccessKey,
    region: 'us-east-1',
    service: 'notification',
    date: new Date(),
  }).headers;
}

function tlsRequest({ port, ca, servername = REST_SNI, path = '/', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null
      : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const request = https.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path,
      servername,
      ca,
      rejectUnauthorized: true,
      headers: { ...headers, ...(payload ? { 'content-length': payload.length } : {}) },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* keep rawBody */ }
        resolve({ status: response.statusCode, body: parsed, rawBody: text });
      });
    });
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

async function startTlsEntrypoint(directory) {
  const paths = ensureTlsCertificates({
    dir: join(directory, 'tls'),
    // A fresh env with no PHOENIX_TLS_REGIONS override: the DEFAULT region must
    // be what lands on the certificate.
    env: { PHOENIX_TLS_EXTRA_NAMES: '' },
    log: () => {},
  });
  const entrypoint = createClassicEntrypoint({
    notificationFile: join(directory, 'notifications.json'),
    notificationPollIntervalMs: 25,
    tls: { cert: readFileSync(paths.cert), key: readFileSync(paths.key) },
    notificationAccountResolver: createVerifiedNotificationAccountResolver({
      resolveCredentials: (accessKeyId) => ACCOUNTS[accessKeyId],
    }),
  });
  const server = await entrypoint.listen(0, '127.0.0.1');
  return {
    entrypoint,
    server,
    port: server.address().port,
    ca: readFileSync(paths.caCert),
    totem: paths,
  };
}

async function stop(entry) {
  entry?.entrypoint?.hub?.stopDelivery();
  entry?.entrypoint?.wss?.close();
  if (entry?.server?.listening) await new Promise((resolve) => entry.server.close(resolve));
}

async function mintToken(entry, account, deviceId) {
  const body = JSON.stringify({ deviceId });
  const headers = signHeaders({ target: 'Notification_20150505.NewRobotToken', body, account });
  const response = await tlsRequest({ port: entry.port, ca: entry.ca, headers, body });
  assert.equal(response.status, 200, 'signed NewRobotToken is served over TLS');
  return response.body.token;
}

async function enqueueViaHttp(entry, accountId, payload) {
  return tlsRequest({
    port: entry.port,
    ca: entry.ca,
    servername: REST_SNI,
    path: '/notify',
    headers: { 'content-type': 'application/json' },
    body: { accountId, payload },
  });
}

function openRobotSocket(entry, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://127.0.0.1:${entry.port}/${token}`, {
      servername: SOCKET_SNI,
      ca: entry.ca,
      rejectUnauthorized: true,
    });
    ws._frames = [];
    ws.on('message', (data) => ws._frames.push(JSON.parse(String(data))));
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, response) => reject(new Error(`socket HTTP ${response.statusCode}`)));
  });
}

test('the default serving certificate carries the robot region names, and a non-robot region is not covered', { skip }, async () => {
  const directory = tempDir();
  try {
    assert.deepEqual(regionsFrom({}), [REGION], 'the default TLS region is the robot region `api`, not a synthetic one');
    const paths = ensureTlsCertificates({ dir: join(directory, 'tls'), env: { PHOENIX_TLS_EXTRA_NAMES: '' }, log: () => {} });
    assert.ok(paths.names.dns.includes(REST_SNI), `${REST_SNI} is a required name`);
    assert.ok(paths.names.dns.includes(SOCKET_SNI), `${SOCKET_SNI} is a required name`);
    const san = execFileSync('openssl', ['x509', '-in', paths.cert, '-noout', '-ext', 'subjectAltName']).toString();
    assert.match(san, new RegExp(`DNS:${REST_SNI.replace(/\./g, '\\.')}`));
    assert.match(san, new RegExp(`DNS:${SOCKET_SNI.replace(/\./g, '\\.')}`));
    // `phx` is not a Jibo region; a certificate that carried it would pass a
    // fixture that never exercised the robot's real hostname.
    assert.doesNotMatch(san, /DNS:phx(-socket)?\.jibo\.com/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the production path: HTTPS /notify is queued offline (1) and consumed+acked by the signed robot socket (0)', { skip }, async () => {
  const directory = tempDir();
  const account = ACCOUNTS['A10-PROD-A'];
  let entry;
  let ws;
  try {
    entry = await startTlsEntrypoint(directory);
    const token = await mintToken(entry, account, 'moth-production');
    const tokenId = entry.entrypoint.hub.store.findTokenByKey(token)._id;

    // The producer route, exactly as a system producer calls it. The robot
    // socket is not connected yet, so the row must be durable.
    const queued = await enqueueViaHttp(entry, account._id, { name: 'LoopUpdated', payload: { seq: 'production' } });
    assert.equal(queued.status, 200);
    assert.match(queued.body.queued, /^[a-f0-9]{24}$/, 'POST /notify returns the queued notification id');
    assert.equal(entry.entrypoint.hub.store.findNotificationsByTokenIds([tokenId]).length, 1, 'queue is 1 while the socket is offline');
    assert.equal(entry.entrypoint.hub.store.getStatus({ accountId: account._id }).connected, false);

    // The robot connects on its own hostname and receives the full document.
    ws = await openRobotSocket(entry, token);
    await waitFor(() => ws._frames.length >= 1);
    const frame = ws._frames[0];
    assert.equal(frame.payload.name, 'LoopUpdated');
    assert.equal(frame.payload.payload.seq, 'production');
    assert.equal(frame.skillId, '-1');
    assert.deepEqual(Object.keys(frame).sort(), ['_id', 'created', 'payload', 'skillId', 'tokenId'].sort(), 'the whole Notification document is framed');

    await tick(); // let the send callback's durable delete settle
    assert.equal(entry.entrypoint.hub.store.findNotificationsByTokenIds([tokenId]).length, 0, 'the send callback consumed the row: queue 1 -> 0');
    assert.equal(entry.entrypoint.hub.store.getStatus({ accountId: account._id }).connected, true);
  } finally {
    ws?.close();
    await stop(entry);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a socket for a different account never receives another account notification frame', { skip }, async () => {
  const directory = tempDir();
  const accountA = ACCOUNTS['A10-PROD-A'];
  const accountB = ACCOUNTS['A10-PROD-B'];
  let entry;
  let wsA;
  let wsB;
  try {
    entry = await startTlsEntrypoint(directory);
    const tokenA = await mintToken(entry, accountA, 'moth-a');
    const tokenB = await mintToken(entry, accountB, 'moth-b');
    assert.notEqual(tokenA, tokenB);
    wsA = await openRobotSocket(entry, tokenA);
    wsB = await openRobotSocket(entry, tokenB);

    const queued = await enqueueViaHttp(entry, accountA._id, { name: 'LoopUpdated', payload: { seq: 'isolated' } });
    assert.equal(queued.status, 200);
    await waitFor(() => wsA._frames.length >= 1);
    await tick();

    assert.equal(wsA._frames[0].payload.payload.seq, 'isolated', 'the subscribed account receives its frame');
    assert.equal(wsB._frames.length, 0, 'the other account receives nothing');
    const tokenIdA = entry.entrypoint.hub.store.findTokenByKey(tokenA)._id;
    assert.equal(entry.entrypoint.hub.store.findNotificationsByTokenIds([tokenIdA]).length, 0, 'A\'s row was acked');
  } finally {
    wsA?.close();
    wsB?.close();
    await stop(entry);
    rmSync(directory, { recursive: true, force: true });
  }
});
