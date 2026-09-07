// Sanitized local control for the authenticated launcher Notification bridge.
// It creates only synthetic accounts, keys, a private store, and a one-day
// loopback certificate. No token or private request body is printed.

import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signSigV4, jwt } from '../../packages/common/src/index.js';
import { startAuthenticatedRobotStack } from './authenticated-stack.mjs';
import { WebSocket } from 'ws';

process.env.PHOENIX_ENV_FILE = '/dev/null';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const manifest = process.argv[2];
if (!manifest) throw new Error('usage: node scripts/parity-robot/authenticated-notification-control.mjs <snapshot-manifest>');

const directory = mkdtempSync(join(tmpdir(), 'phoenix-a10-launcher-control-'));
const runDir = join(directory, 'run');
mkdirSync(runDir, { mode: 0o700 });
chmodSync(runDir, 0o700);
const secretFile = join(directory, 'secret');
const keyFile = join(directory, 'key.pem');
const certFile = join(directory, 'cert.pem');
const storeFile = join(directory, 'account.json');
writeFileSync(secretFile, 'a10-launcher-control-secret\n', { mode: 0o600 });
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyFile, '-out', certFile,
  '-days', '1', '-nodes', '-subj', '/CN=localhost',
], { stdio: 'ignore' });
chmodSync(keyFile, 0o600);
chmodSync(certFile, 0o600);

const accounts = [
  { _id: 'a10-launcher-robot-a', email: 'a10-a@fixture.test', friendlyId: 'a10-a', accessKeyId: 'A10-LAUNCHER-A', secretAccessKey: 'a10-launcher-a-secret', isActive: true, isDeleted: false },
  { _id: 'a10-launcher-robot-b', email: 'a10-b@fixture.test', friendlyId: 'a10-b', accessKeyId: 'A10-LAUNCHER-B', secretAccessKey: 'a10-launcher-b-secret', isActive: true, isDeleted: false },
  { _id: 'a10-launcher-robot-c', email: 'a10-c@fixture.test', friendlyId: 'a10-c', accessKeyId: 'A10-LAUNCHER-C', secretAccessKey: 'a10-launcher-c-secret', isActive: true, isDeleted: false },
];
const loops = accounts.map((entry, index) => ({
  _id: `a10-launcher-loop-${String.fromCharCode(97 + index)}`,
  name: `A10 control loop ${index}`,
  owner: entry._id,
  robot: entry._id,
  members: [{ accountId: entry._id, status: 'ACCEPTED' }],
  isSuspended: false,
  created: 0,
}));
writeFileSync(storeFile, `${JSON.stringify({ accounts, loops, tokens: [], sessions: [], settings: [], notificationOutbox: [] }, null, 2)}\n`, { mode: 0o600 });
chmodSync(storeFile, 0o600);

const [robotA, robotB, robotC] = accounts;
const [loopA, loopB, loopC] = loops;

function signed(host, target, payload, credentials, overrides = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const result = signSigV4({
    method: 'POST', path: '/', body,
    headers: {
      Host: host,
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': target,
      ...(overrides.headers || {}),
    },
    accessKeyId: overrides.accessKeyId || credentials.accessKeyId,
    secretAccessKey: overrides.secretAccessKey || credentials.secretAccessKey,
    region: 'global', service: 'jibo', date: new Date(),
  });
  return { headers: result.headers, body };
}

async function post(base, target, payload, credentials, overrides = {}) {
  const request = signed(new URL(base).host, target, payload, credentials, overrides);
  const response = await fetch(`${base}/`, { method: 'POST', headers: request.headers, body: request.body });
  const raw = await response.text();
  let body = null;
  try { body = JSON.parse(raw); } catch { /* retain the status for non-JSON failures */ }
  return { status: response.status, body, headers: Object.fromEntries(response.headers.entries()) };
}

function openSocket(base, token) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${base}/socket/${token}`, { rejectUnauthorized: false });
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function nextMessage(socket, timeoutMS = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`notification timeout after ${timeoutMS}ms`)), timeoutMS);
    socket.once('message', (encoded) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(encoded)));
    });
  });
}

async function runStack() {
  return startAuthenticatedRobotStack({
    runDir, secretFile, storeFile, keyFile, certFile, snapshotManifest: manifest,
    basePort: 0, entrypointPort: 0, entrypointHost: '127.0.0.1', publicUrl: 'https://localhost',
  });
}

let first;
let second;
let socketA;
let socketB;
let socketC;
try {
  first = await runStack();
  const firstBase = `https://127.0.0.1:${first.receipt.endpoints.entrypointTls}`;
  const result = {
    baseRevision: first.receipt.revision,
    node: first.receipt.node,
    resolverAttached: first.receipt.notification.publisherAttachedAfterClassicReady,
    initialRecovery: first.receipt.notification.recovery,
  };

  const issued = await post(firstBase, 'Account_20151111.CreateHubToken', { payload: 'a10-control' }, robotA);
  const claims = issued.body?.token ? jwt.verify(issued.body.token, 'a10-launcher-control-secret') : null;
  result.createHubToken = {
    status: issued.status,
    claims: claims ? { id: claims.id, secretClaimPresent: Object.prototype.hasOwnProperty.call(claims, 'secretAccessKey'), ttlSeconds: claims.exp - claims.iat } : null,
  };

  const firstToken = await post(firstBase, 'Notification_20150505.NewRobotToken', { deviceId: 'a10-device-a' }, robotA);
  const invalidStatuses = [];
  for (const deviceId of [{ invalid: true }, ['invalid'], true, null]) {
    const invalid = await post(firstBase, 'Notification_20150505.NewRobotToken', { deviceId }, robotA);
    if (invalid.status !== 422 || !first.services.classic.hub.findByToken(firstToken.body?.token)) {
      throw new Error(`source Notification validation control failed for ${JSON.stringify(deviceId)}`);
    }
    invalidStatuses.push(invalid.status);
  }
  result.validation = {
    validStatus: firstToken.status,
    invalidStatuses,
    validationStatus: 422,
    priorTokenStillValid: !!first.services.classic.hub.findByToken(firstToken.body?.token),
  };
  const validAgain = await post(firstBase, 'Notification_20150505.NewRobotToken', { deviceId: 'a10-device-a-again' }, robotA);
  const issuedB = await post(firstBase, 'Notification_20150505.NewRobotToken', { deviceId: 'a10-device-b' }, robotB);
  socketA = await openSocket(firstBase, validAgain.body.token);
  socketB = await openSocket(firstBase, issuedB.body.token);

  const eventA = nextMessage(socketA);
  const suspendA = await post(firstBase, 'Loop_20160324.SuspendLoop', { loopId: loopA._id }, robotA);
  const messageA = await eventA;
  let accountBReceivedA = false;
  try { await nextMessage(socketB, 150); accountBReceivedA = true; } catch { /* isolation control */ }
  const statusInvalidStatuses = [];
  for (const payload of [{}, { accountId: null }, { accountId: 7 }, { accountId: '' }]) {
    const invalid = await post(firstBase, 'Notification_20150505.GetStatus', payload, robotA);
    if (invalid.status !== 422) throw new Error(`source GetStatus validation control failed for ${JSON.stringify(payload)}`);
    statusInvalidStatuses.push(invalid.status);
  }
  const statusOther = await post(firstBase, 'Notification_20150505.GetStatus', { accountId: robotB._id }, robotA);
  const rejected = await post(firstBase, 'Notification_20150505.NewRobotToken', { deviceId: 'forged' }, robotA, {
    accessKeyId: 'A10-UNKNOWN', secretAccessKey: 'a10-unknown-secret',
  });
  result.delivery = {
    suspendStatus: suspendA.status,
    event: {
      name: messageA.payload?.name,
      skillId: messageA.skillId,
      loopId: messageA.payload?.payload?.id,
      accountId: messageA.payload?.payload?.robot,
      isSuspended: messageA.payload?.payload?.isSuspended,
    },
    accountBReceivedA,
    getStatusInvalidStatuses: statusInvalidStatuses,
    crossAccountStatus: { status: statusOther.status, connected: statusOther.body?.connected },
    rejectedCaller: { status: rejected.status, errorType: rejected.headers['x-amzn-errortype'] },
  };

  const issuedC = await post(firstBase, 'Notification_20150505.NewRobotToken', { deviceId: 'a10-device-c' }, robotC);
  first.services.account.loopUpdatedOutbox.publisher = () => { throw new Error('synthetic bridge offline'); };
  const offline = await post(firstBase, 'Loop_20160324.SuspendLoop', { loopId: loopC._id }, robotC);
  await new Promise((resolve) => setTimeout(resolve, 15));
  result.offline = {
    suspendStatus: offline.status,
    retainedBeforeRestart: first.services.account.loopUpdatedOutbox.pending().length,
  };
  socketA.terminate(); socketA = null;
  socketB.terminate(); socketB = null;
  await first.stop();
  first = null;

  second = await runStack();
  const secondBase = `https://127.0.0.1:${second.receipt.endpoints.entrypointTls}`;
  socketC = await openSocket(secondBase, issuedC.body.token);
  const messageC = await nextMessage(socketC);
  result.restartRecovery = {
    recovery: second.receipt.notification.recovery,
    eventName: messageC.payload?.name,
    loopId: messageC.payload?.payload?.id,
    accountId: messageC.payload?.payload?.robot,
    isSuspended: messageC.payload?.payload?.isSuspended,
    pendingAfterSuccessfulSend: second.services.classic.hub.store.findNotificationsByTokenIds([
      second.services.classic.hub.store.findTokenByKey(issuedC.body.token)._id,
    ]).length,
  };
  console.log(JSON.stringify({ kind: 'a10-authenticated-notification-launcher-control', result }));
} finally {
  socketA?.terminate();
  socketB?.terminate();
  socketC?.terminate();
  await first?.stop();
  await second?.stop();
  rmSync(directory, { recursive: true, force: true });
}
