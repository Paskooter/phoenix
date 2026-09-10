// A-10 source-contract controls for the Notification boundary.
//
// Three things the pinned source fixes that the earlier notification tests did not
// pin end to end:
//
//   1. OPERATION COVERAGE. The pinned client model
//      jiborobot/srv-jibo-server-client:apis/notification-2015-05-05.normal.json
//      (targetPrefix Notification_20150505, jsonVersion 1.1) declares exactly TWO
//      operations, NewRobotToken and GetStatus. Both must answer at their wire
//      target, and an operation the model does not declare must not be quietly
//      served by the classic prefix router.
//   2. THE GATEWAY LAYER. The pinned srv-notification-ws handler authenticates with
//      @parseCredentials, and the pinned srv-security-gw allow-lists
//      (unauthorizedMethods / unsignedMethods) contain NEITHER Notification target —
//      so every Notification call must carry a valid SigV4 signature. The exact
//      status code and error type per rejection come from
//      srv-security-gw:src/errors/account.ts. A rejected call must not rotate the
//      account's token (the source validates before the controller mutates).
//   3. THE SOCKET HOST, SEPARATELY FROM HTTP DISCOVERY. A robot builds a SECOND
//      hostname for the notification socket (`<region>` + serverURLSuffix, default
//      `-socket.jibo.com`) and verifies it against the serving certificate. The
//      socket must complete a real TLS upgrade under that SNI and deliver a frame,
//      while the REST face on the same port keeps answering service discovery.
//
// All accounts, keys and files are synthetic. The robot firmware itself is not
// available, so nothing here drives a real device.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import https from 'node:https';
import { WebSocket } from 'ws';
import { signSigV4 } from '@phoenix/common';
import { createClassicEntrypoint, createVerifiedNotificationAccountResolver } from '../src/index.js';
import { ensureTlsCertificates } from '../../../scripts/ensure-tls-certs.mjs';

// The pinned model's complete operation list. Keep this literal in step with
// apis/notification-2015-05-05.normal.json: targetPrefix + '.' + operation key.
const DECLARED_NOTIFICATION_TARGETS = [
  'Notification_20150505.NewRobotToken',
  'Notification_20150505.GetStatus',
];

const hasOpenssl = (() => {
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

const ACCOUNTS = {
  'A10-CONTRACT-A': { _id: 'a10-contract-a', id: 'a10-contract-a', accessKeyId: 'A10-CONTRACT-A', secretAccessKey: 'contract-a-secret', isActive: true, isDeleted: false },
  'A10-CONTRACT-B': { _id: 'a10-contract-b', id: 'a10-contract-b', accessKeyId: 'A10-CONTRACT-B', secretAccessKey: 'contract-b-secret', isActive: true, isDeleted: false },
  'A10-CONTRACT-OFF': { _id: 'a10-contract-off', id: 'a10-contract-off', accessKeyId: 'A10-CONTRACT-OFF', secretAccessKey: 'contract-off-secret', isActive: false, isDeleted: false },
};

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function startEntrypoint({ directory, ...options } = {}) {
  const ep = createClassicEntrypoint({
    notificationFile: join(directory || tempDir('phoenix-a10-contract-'), 'notifications.json'),
    notificationPollIntervalMs: 25,
    notificationAccountResolver: createVerifiedNotificationAccountResolver({
      resolveCredentials: (accessKeyId) => ACCOUNTS[accessKeyId],
    }),
    ...options,
  });
  const server = await ep.listen(0, '127.0.0.1');
  return {
    ep,
    server,
    port: server.address().port,
    base: `http://127.0.0.1:${server.address().port}`,
    host: `127.0.0.1:${server.address().port}`,
  };
}

async function stopEntrypoint(entry) {
  if (!entry) return;
  entry.ep?.hub?.stopDelivery();
  entry.ep?.wss?.close();
  if (entry.server?.listening) await new Promise((resolve) => entry.server.close(resolve));
}

function signedHeaders({ host, target, body, accessKeyId = 'A10-CONTRACT-A', secretAccessKey = 'contract-a-secret', service = 'notification', date = new Date() }) {
  return signSigV4({
    method: 'POST',
    path: '/',
    body,
    headers: { Host: host, 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': target },
    accessKeyId,
    secretAccessKey,
    region: 'us-east-1',
    service,
    date,
  }).headers;
}

async function post(base, { target, payload, host, ...credentials }) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const headers = credentials.unsigned
    ? { 'content-type': 'application/x-amz-json-1.1', ...(target ? { 'x-amz-target': target } : {}) }
    : signedHeaders({ host, target, body, ...credentials });
  const response = await fetch(`${base}/`, { method: 'POST', headers, body });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* keep rawBody for a non-JSON response */ }
  return {
    status: response.status,
    errortype: response.headers.get('x-amzn-errortype'),
    body: parsed,
    rawBody: text,
  };
}

function openSocket(url, options = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    ws._frames = [];
    ws.on('message', (data) => ws._frames.push(JSON.parse(String(data))));
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, response) => reject(new Error(`socket HTTP ${response.statusCode}`)));
  });
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('both operations the pinned Notification client model declares are served at their wire target', async () => {
  const directory = tempDir('phoenix-a10-coverage-');
  const entry = await startEntrypoint({ directory });
  try {
    // Runtime dispatch check: send each declared target as the pinned client does.
    const issued = await post(entry.base, {
      target: 'Notification_20150505.NewRobotToken',
      payload: { deviceId: 'contract-device' },
      host: entry.host,
    });
    assert.equal(issued.status, 200, 'NewRobotToken served');
    assert.match(issued.body.token, /^[a-f0-9]{128}$/);
    assert.deepEqual(Object.keys(issued.body), ['token'], 'model output shape Token has only `token`');

    const status = await post(entry.base, {
      target: 'Notification_20150505.GetStatus',
      payload: { accountId: ACCOUNTS['A10-CONTRACT-A']._id },
      host: entry.host,
    });
    assert.equal(status.status, 200, 'GetStatus served');
    assert.deepEqual(Object.keys(status.body), ['connected'], 'model output shape GetStatusResponse has only `connected`');
    assert.equal(status.body.connected, false);

    // The served set is the declared set: nothing else is answered on this prefix.
    for (const target of DECLARED_NOTIFICATION_TARGETS) {
      const served = await post(entry.base, {
        target,
        payload: target.endsWith('GetStatus') ? { accountId: ACCOUNTS['A10-CONTRACT-A']._id } : {},
        host: entry.host,
      });
      assert.equal(served.status, 200, `${target} must be served`);
    }
    const undeclared = await post(entry.base, {
      target: 'Notification_20150505.DeleteAll',
      payload: {},
      host: entry.host,
    });
    assert.equal(undeclared.status, 400);
    assert.equal(undeclared.errortype, 'ValidationException');
    assert.equal(undeclared.body.__type, 'ValidationException');
    assert.match(undeclared.body.message, /unknown Notification operation/);

    // A different (undeclared) prefix is not routed to Notification at all.
    const otherPrefix = await post(entry.base, {
      target: 'Notifier_20150505.NewRobotToken',
      payload: {},
      host: entry.host,
    });
    assert.equal(otherPrefix.status, 400);
    assert.equal(otherPrefix.errortype, 'UnknownOperationException');
  } finally {
    await stopEntrypoint(entry);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the gateway layer refuses an unsigned or invalid Notification call, and refuses it before any token mutation', async () => {
  const directory = tempDir('phoenix-a10-auth-');
  const entry = await startEntrypoint({ directory });
  const target = 'Notification_20150505.NewRobotToken';
  const untouched = 'Notification_20150505.GetStatus';
  try {
    const issued = await post(entry.base, { target, payload: { deviceId: 'auth-device' }, host: entry.host });
    assert.equal(issued.status, 200);
    const tokenBefore = issued.body.token;

    // Neither Notification target appears in the pinned gateway allow-lists
    // (unauthorizedMethods / unsignedMethods), so no call may be anonymous.
    const unsigned = await post(entry.base, { target, payload: { deviceId: 'anonymous' }, host: entry.host, unsigned: true });
    assert.equal(unsigned.status, 401);
    assert.equal(unsigned.errortype, 'MISSING_AUTH_HEADER');
    assert.equal(unsigned.body.__type, 'MISSING_AUTH_HEADER');

    const unsignedStatus = await post(entry.base, { target: untouched, payload: {}, host: entry.host, unsigned: true });
    assert.equal(unsignedStatus.status, 401, 'GetStatus is not anonymous either');
    assert.equal(unsignedStatus.errortype, 'MISSING_AUTH_HEADER');

    const unknownKey = await post(entry.base, {
      target, payload: { deviceId: 'forged' }, host: entry.host, accessKeyId: 'A10-CONTRACT-MISSING', secretAccessKey: 'nope',
    });
    assert.equal(unknownKey.status, 401);
    assert.equal(unknownKey.errortype, 'ACCESS_KEY_NOT_FOUND');

    const badSignature = await post(entry.base, {
      target, payload: { deviceId: 'wrong-secret' }, host: entry.host, secretAccessKey: 'not-the-secret',
    });
    assert.equal(badSignature.status, 401);
    assert.equal(badSignature.errortype, 'SIGNATURE_MISMATCH');

    const inactive = await post(entry.base, {
      target, payload: { deviceId: 'inactive' }, host: entry.host, accessKeyId: 'A10-CONTRACT-OFF', secretAccessKey: 'contract-off-secret',
    });
    assert.equal(inactive.status, 403);
    assert.equal(inactive.errortype, 'ACCOUNT_NOT_ACTIVE');

    const skewed = await post(entry.base, {
      target, payload: { deviceId: 'skewed' }, host: entry.host, date: new Date(Date.now() - 30 * 60 * 1000),
    });
    assert.equal(skewed.status, 401);
    assert.equal(skewed.errortype, 'CLOCK_SKEW_TOO_LONG');

    // "authorization present, date missing": the pinned gateway reads the
    // authorization header before the date header, so this must be the date
    // error, not the missing-auth error.
    const authOnly = await fetch(`${entry.base}/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': target,
        authorization: 'AWS4-HMAC-SHA256 Credential=A10-CONTRACT-A/20260910/us-east-1/notification/aws4_request, SignedHeaders=host;x-amz-date, Signature=00',
      },
      body: '{"deviceId":"no-date"}',
    });
    assert.equal(authOnly.status, 401);
    assert.equal(authOnly.headers.get('x-amzn-errortype'), 'MISSING_DATE_HEADER');
    await authOnly.text();

    // Every rejection above happened before the controller ran: the one Token
    // document for the account still holds the original key.
    assert.equal(entry.ep.hub.store.findTokenByKey(tokenBefore).tokenKey, tokenBefore);
    assert.equal(entry.ep.hub.store.getStatus({ accountId: ACCOUNTS['A10-CONTRACT-A']._id }).connected, false);

    const stillWorks = await post(entry.base, { target, payload: { deviceId: 'auth-device-2' }, host: entry.host });
    assert.equal(stillWorks.status, 200);
    assert.equal(entry.ep.hub.store.findTokenByKey(tokenBefore), null, 'a valid call rotates the source token');
  } finally {
    await stopEntrypoint(entry);
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  'the robot socket hostname is served over TLS with SNI and delivers, separately from REST service discovery',
  { skip: hasOpenssl ? false : 'openssl is required to build the robot TLS certificate fixture' },
  async () => {
    const directory = tempDir('phoenix-a10-tls-');
    const tlsDirectory = join(directory, 'tls');
    let entry;
    let ws;
    try {
      const paths = ensureTlsCertificates({
        dir: tlsDirectory,
        env: { ...process.env, PHOENIX_TLS_REGIONS: 'phx', PHOENIX_TLS_EXTRA_NAMES: '' },
        log: () => {},
      });
      const san = execFileSync('openssl', ['x509', '-in', paths.cert, '-noout', '-ext', 'subjectAltName']).toString();
      assert.match(san, /DNS:phx\.jibo\.com/, 'the REST hostname is on the serving certificate');
      assert.match(san, /DNS:phx-socket\.jibo\.com/, 'the notification socket hostname is on the serving certificate');

      entry = await startEntrypoint({
        directory,
        tls: { cert: readFileSync(paths.cert), key: readFileSync(paths.key) },
      });
      const ca = readFileSync(paths.caCert);
      const socketTokenOf = (body) => {
        const parsed = JSON.parse(body);
        return parsed.token;
      };

      // HTTP service discovery over TLS under the REST hostname.
      const discoveryBody = JSON.stringify({ deviceId: 'tls-contract' });
      const discovery = await new Promise((resolve, reject) => {
        const request = https.request({
          host: '127.0.0.1',
          port: entry.port,
          method: 'POST',
          path: '/',
          servername: 'phx.jibo.com',
          ca,
          rejectUnauthorized: true,
          headers: {
            ...signedHeaders({ host: 'phx.jibo.com', target: 'Notification_20150505.NewRobotToken', body: discoveryBody }),
            'content-length': Buffer.byteLength(discoveryBody),
          },
        }, (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        });
        request.on('error', reject);
        request.end(discoveryBody);
      });
      assert.equal(discovery.status, 200);
      const token = socketTokenOf(discovery.body);

      // The socket upgrade under the SOCKET hostname, pinned to the Phoenix CA.
      const deliver = (servername, tlsCa) => new Promise((resolve, reject) => {
        const socket = new WebSocket(`wss://127.0.0.1:${entry.port}/${token}`, { servername, ca: tlsCa, rejectUnauthorized: true });
        socket.once('open', () => {
          entry.ep.hub.enqueueNotification({
            accountId: ACCOUNTS['A10-CONTRACT-A']._id,
            skillId: '-1',
            notification: { name: 'LoopUpdated', payload: { via: 'tls' } },
          });
        });
        socket.once('message', (data) => {
          socket.close();
          resolve(JSON.parse(String(data)));
        });
        socket.once('error', reject);
        socket.once('unexpected-response', (_req, response) => reject(new Error(`socket HTTP ${response.statusCode}`)));
      });

      const frame = await deliver('phx-socket.jibo.com', ca);
      assert.equal(frame.payload.payload.via, 'tls', 'the socket hostname delivered the pushed frame');
      assert.equal(frame.skillId, '-1');
      await tick();
      assert.equal(entry.ep.hub.store.findNotificationsByTokenIds([frame.tokenId]).length, 0, 'the send callback removed the row');

      // A client that does not trust the Phoenix CA, and one that connects to a
      // name the certificate does not carry, both fail the handshake.
      await assert.rejects(() => deliver('phx-socket.jibo.com', undefined), /unable to verify|self.signed|ERR_TLS/i);
      await assert.rejects(() => deliver('other.jibo.com', ca), /altnames|Hostname\/IP/i);
    } finally {
      ws?.close();
      await stopEntrypoint(entry);
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
