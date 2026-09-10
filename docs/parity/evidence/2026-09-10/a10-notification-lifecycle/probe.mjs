#!/usr/bin/env node
// A-10 independent verification probe.
//
// Drives the merged Phoenix Classic notification boundary and answers three questions
// with runtime observations rather than static scanning:
//
//   1. WIRE NAME + SERVED   - the *pinned original client* (@jibo/jibo-server-client 3.0.105
//      lib/node_loader + lib/core + apis/notification-2015-05-05.normal.json, byte-identical
//      consumer to the pinned srv-jibo-server-client copy) is pointed at a local echo server to
//      record the exact request it emits per operation, then at a live Phoenix entrypoint.
//   2. LIFECYCLE            - token registration/rotation/invalidation/ownership, the error
//      envelopes and exact status codes, and socket delivery to the extent observable without
//      the original robot firmware (subscribed receives, unsubscribed does not, ack deletes,
//      payload retained while no socket is open, and a same-token reconnect driven by the
//      ORIGINAL consumer's own close->reconnect loop).
//   3. TLS / SNI            - the robot-facing socket hostname (`<region>-socket.jibo.com`) is
//      served from a Phoenix-CA certificate and completes a real WSS upgrade, separately from
//      HTTP service discovery. The robot firmware itself remains UNKNOWN.
//
// Run from the worktree root:
//   node docs/parity/evidence/2026-09-10/a10-notification-lifecycle/probe.mjs
// Env: PHOENIX_SDK_DIR (default /home/shell/work/phoenix-jibo-server-client)

import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import https from 'node:https';
import { WebSocket } from 'ws';

const require_ = createRequire(pathToFileURL(`${process.cwd()}/`));
const HERE = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = process.env.PHOENIX_SDK_DIR
  || '/home/shell/work/phoenix/.parity/yarn-cache/v1/npm-@jibo/jibo-server-client-3.0.110-dc0962bd91de9392ecf2ef6f96c6d9f7642d23e8';
const NODE_PATH = process.env.PHOENIX_SDK_NODE_PATH || '/home/shell/hermes-jibo-be/node_modules';
// The pinned repo checkout (3.0.105) ships apis/*.normal.json but an EMPTY clients/
// directory (the generated entry points are a build artifact). The 3.0.110 yarn-cache
// copy ships the generated clients/ + the client model min.json, and its
// lib/services/notification.js is byte-identical to the 3.0.105 consumer.
const NORMAL_MODEL_PATH = process.env.PHOENIX_SDK_NORMAL_MODEL
  || '/home/shell/work/phoenix-jibo-server-client/apis/notification-2015-05-05.normal.json';
const CLIENT_MODEL_PATH = join(SDK_DIR, 'apis/notification-2015-05-05.min.json');

const { createClassicEntrypoint, createVerifiedNotificationAccountResolver, NotificationHub } =
  await import(pathToFileURL(join(process.cwd(), 'packages/classic/src/index.js')).href);
const { ensureTlsCertificates } = await import(pathToFileURL(join(process.cwd(), 'scripts/ensure-tls-certs.mjs')).href);

const out = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  revision: null,
  pinnedClient: {},
  runtime: {},
  operations: {},
  wireCapture: {},
  servedOperations: [],
  authMatrix: [],
  tokenLifecycle: {},
  socketLifecycle: {},
  tls: {},
  summary: {},
};
const findings = [];
const record = (section, key, value) => { out[section][key] = value; };

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// ---------------------------------------------------------------- pinned client
let AWS = null;
let NotificationService = null;
let SDK_MODEL = null;
{
  process.env.NODE_PATH = `${NODE_PATH}:${SDK_DIR}/node_modules:${process.env.NODE_PATH || ''}`;
  require_('module').Module._initPaths();
  require_(join(SDK_DIR, 'lib/node_loader.js'));
  AWS = require_(join(SDK_DIR, 'lib/core.js'));
  // clients/notification.js is the pinned GENERATED entry point: it defines the
  // service, installs the consumer's connect() from lib/services/notification.js,
  // and binds the client model min.json.
  NotificationService = require_(join(SDK_DIR, 'clients/notification.js'));
  SDK_MODEL = require_(CLIENT_MODEL_PATH);
}
const SDK_VERSION = require_(join(SDK_DIR, 'package.json')).version;
const NORMAL_MODEL_TEXT = readFileSync(NORMAL_MODEL_PATH, 'utf8');
const NORMAL_MODEL = JSON.parse(NORMAL_MODEL_TEXT);
const CLIENT_MODEL_TEXT = readFileSync(CLIENT_MODEL_PATH, 'utf8');
const CONSUMER_TEXT = readFileSync(join(SDK_DIR, 'lib/services/notification.js'), 'utf8');
const CONSUMER_TEXT_105 = readFileSync('/home/shell/work/phoenix-jibo-server-client/lib/services/notification.js', 'utf8');

record('pinnedClient', 'sdkVersion', SDK_VERSION);
record('pinnedClient', 'clientModelPath', CLIENT_MODEL_PATH);
record('pinnedClient', 'clientModelSha256', sha256(CLIENT_MODEL_TEXT));
record('pinnedClient', 'normalModelSha256', sha256(NORMAL_MODEL_TEXT));
record('pinnedClient', 'consumerSha256', sha256(CONSUMER_TEXT));
record('pinnedClient', 'consumer3_0_105Identical', sha256(CONSUMER_TEXT) === sha256(CONSUMER_TEXT_105));
record('pinnedClient', 'targetPrefix', NORMAL_MODEL.metadata.targetPrefix);
record('pinnedClient', 'jsonVersion', NORMAL_MODEL.metadata.jsonVersion);
record('pinnedClient', 'declaredOperations', Object.keys(NORMAL_MODEL.operations).map((key) => ({
  operation: key,
  // The aws-sdk JSON protocol builds the wire target from the operation KEY
  // (Service._serviceInterface loops AWS.Model.Api.operations and uses the key /
  // operation.name); `name` is absent on GetStatus in the pinned model.
  modelName: NORMAL_MODEL.operations[key].name ?? null,
  wireName: `${NORMAL_MODEL.metadata.targetPrefix}.${key}`,
  inputShape: NORMAL_MODEL.operations[key].input?.shape,
  outputShape: NORMAL_MODEL.operations[key].output?.shape,
})));
record('pinnedClient', 'clientModelOperations', Object.keys(SDK_MODEL.operations));

// ---------------------------------------------------------------- implementation under test
const dir = mkdtempSync(join(tmpdir(), 'phoenix-a10-probe-'));
const accounts = {
  'A10-ALPHA': { _id: 'account-alpha', id: 'account-alpha', accessKeyId: 'A10-ALPHA', secretAccessKey: 'alpha-secret', isActive: true, isDeleted: false },
  'A10-BETA': { _id: 'account-beta', id: 'account-beta', accessKeyId: 'A10-BETA', secretAccessKey: 'beta-secret', isActive: true, isDeleted: false },
  'A10-GAMMA': { _id: 'account-gamma', id: 'account-gamma', accessKeyId: 'A10-GAMMA', secretAccessKey: 'gamma-secret', isActive: true, isDeleted: false },
  'A10-INACTIVE': { _id: 'account-inactive', id: 'account-inactive', accessKeyId: 'A10-INACTIVE', secretAccessKey: 'inactive-secret', isActive: false, isDeleted: false },
};

function makeEntrypoint(extra = {}) {
  return createClassicEntrypoint({
    notificationFile: join(dir, `${Math.random().toString(16).slice(2)}.json`),
    notificationPollIntervalMs: 25,
    notificationAccountResolver: createVerifiedNotificationAccountResolver({
      resolveCredentials: (accessKeyId) => accounts[accessKeyId],
    }),
    ...extra,
  });
}

const ep = makeEntrypoint();
const server = await ep.listen(0);
const port = server.address().port;
const httpBase = `http://127.0.0.1:${port}`;
const wsBase = `ws://127.0.0.1:${port}`;
const host = `127.0.0.1:${port}`;
record('runtime', 'entrypointPort', port);

const closeServer = (s) => new Promise((resolve) => { if (!s?.listening) return resolve(); s.close(resolve); s.closeAllConnections?.(); });

// ---------------------------------------------------------------- 1. wire capture
{
  const captured = [];
  const { createServer } = await import('node:http');
  const local = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      captured.push({
        method: req.method,
        path: req.url,
        target: req.headers['x-amz-target'],
        contentType: req.headers['content-type'],
        host: req.headers.host,
        signedHeaders: String(req.headers.authorization || '').includes('SignedHeaders=')
          ? String(req.headers.authorization).split('SignedHeaders=')[1].split(',')[0] : null,
        hasAmzDate: Boolean(req.headers['x-amz-date']),
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(200, { 'content-type': 'application/x-amz-json-1.1' });
      res.end(JSON.stringify(captured.at(-1).target.endsWith('GetStatus') ? { connected: true } : { token: 'echo-token' }));
    });
  });
  await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve));
  const echoPort = local.address().port;
  const svc = new NotificationService({
    apiConfig: SDK_MODEL,
    endpoint: `http://127.0.0.1:${echoPort}`,
    region: 'us-east-1',
    credentials: new AWS.Credentials('A10-ALPHA', 'alpha-secret'),
    signatureVersion: 'v4',
    maxRetries: 0,
    sslEnabled: false,
  });
  const call = (method, params) => new Promise((resolve) => svc[method](params, (err, data) => resolve({ error: err?.code || null, data })));
  const newToken = await call('newRobotToken', { deviceId: 'wire-device' });
  const status = await call('getStatus', { accountId: 'account-alpha' });
  await new Promise((resolve) => local.close(resolve));
  record('wireCapture', 'requests', captured);
  record('wireCapture', 'sdkClientResults', { newRobotToken: newToken, getStatus: status });
}

const { signSigV4 } = await import(pathToFileURL(join(process.cwd(), 'packages/common/src/sigv4.js')).href);
function signed(target, payload, accessKeyId = 'A10-ALPHA', secret = 'alpha-secret', overrides = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const signedHeaders = signSigV4({
    method: 'POST', path: '/', body,
    headers: { Host: host, 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': target },
    accessKeyId, secretAccessKey: secret, region: 'us-east-1', service: 'notification', date: new Date(),
    ...overrides,
  });
  return { headers: signedHeaders.headers, body };
}
const postSigned = async (target, payload, key = 'A10-ALPHA', secret = 'alpha-secret') => {
  const request = signed(target, payload, key, secret);
  const response = await fetch(`${httpBase}/`, { method: 'POST', headers: request.headers, body: request.body });
  const text = await response.text();
  let parsed = null; try { parsed = JSON.parse(text); } catch { /* raw */ }
  return { status: response.status, errortype: response.headers.get('x-amzn-errortype'), body: parsed };
};

// ---------------------------------------------------------------- 2. served at runtime (SDK)
{
  const svc = new NotificationService({
    apiConfig: SDK_MODEL,
    endpoint: httpBase,
    region: 'us-east-1',
    credentials: new AWS.Credentials('A10-ALPHA', 'alpha-secret'),
    signatureVersion: 'v4',
    maxRetries: 0,
    sslEnabled: false,
  });
  const call = (method, params) => new Promise((resolve) => svc[method](params, (err, data) => resolve({
    statusCode: err?.statusCode ?? 200, code: err?.code ?? null, data: data ?? null,
  })));
  const token = await call('newRobotToken', { deviceId: 'served-device' });
  const status = await call('getStatus', { accountId: 'account-alpha' });
  out.operations.newRobotToken = token;
  out.operations.getStatus = status;
  out.servedOperations = [
    { wireName: 'Notification_20150505.NewRobotToken', viaSdk: token.statusCode === 200 && typeof token.data?.token === 'string' },
    { wireName: 'Notification_20150505.GetStatus', viaSdk: status.statusCode === 200 && typeof status.data?.connected === 'boolean' },
  ];
  // Dispatch is by target PREFIX, not a wildcard: an operation the pinned model does
  // NOT declare is rejected rather than silently answered.
  out.undeclaredOperation = await postSigned('Notification_20150505.DeleteAll', {});
  out.undeclaredPrefix = await postSigned('Notifier_20150505.NewRobotToken', {});
}

// ---------------------------------------------------------------- 3. auth matrix (raw wire)
async function amz({ target, body, authorization, date, tokenKey }) {
  const headers = { 'content-type': 'application/x-amz-json-1.1' };
  if (target) headers['x-amz-target'] = target;
  if (authorization) headers.authorization = authorization;
  if (date) headers['x-amz-date'] = date;
  const response = await fetch(`${httpBase}/`, { method: 'POST', headers, body: body === undefined ? '' : body });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* keep raw */ }
  return {
    status: response.status,
    errortype: response.headers.get('x-amzn-errortype'),
    body: parsed,
    tokenKey,
  };
}

{
  const T = 'Notification_20150505.NewRobotToken';
  const before = ep.hub.store.findTokenByAccountId('account-alpha');
  out.authMatrix.push({ case: 'no authorization header', ...(await amz({ target: T, body: '{"deviceId":"x"}' })) });
  out.authMatrix.push({ case: 'unknown access key (signed with other secret)', ...(await postSigned(T, { deviceId: 'x' }, 'A10-UNKNOWN', 'nope')) });
  out.authMatrix.push({ case: 'known key, wrong secret', ...(await postSigned(T, { deviceId: 'x' }, 'A10-ALPHA', 'wrong')) });
  out.authMatrix.push({ case: 'inactive account', ...(await postSigned(T, { deviceId: 'x' }, 'A10-INACTIVE', 'inactive-secret')) });
  const stale = signed(T, { deviceId: 'x' });
  const skewed = new Date(Date.now() - 30 * 60 * 1000);
  const skewHeaders = signSigV4({
    method: 'POST', path: '/', body: JSON.stringify({ deviceId: 'x' }),
    headers: { Host: host, 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': T },
    accessKeyId: 'A10-ALPHA', secretAccessKey: 'alpha-secret', region: 'us-east-1', service: 'notification', date: skewed,
  });
  out.authMatrix.push({
    case: 'clock skew beyond 15 minutes',
    ...(await (async () => {
      const response = await fetch(`${httpBase}/`, { method: 'POST', headers: skewHeaders.headers, body: JSON.stringify({ deviceId: 'x' }) });
      return { status: response.status, errortype: response.headers.get('x-amzn-errortype'), body: await response.json().catch(() => null) };
    })()),
  });
  void stale;
  const after = ep.hub.store.findTokenByAccountId('account-alpha');
  record('authMatrix', 'tokenRotatedByRejectedRequests', JSON.stringify(before?.tokenKey) !== JSON.stringify(after?.tokenKey));
  // Missing date on an otherwise valid signature keeps the source check order.
  const noDate = await amz({ target: T, body: '{"deviceId":"x"}', authorization: 'AWS4-HMAC-SHA256 Credential=A10-ALPHA/20260910/us-east-1/notification/aws4_request, SignedHeaders=host;x-amz-date, Signature=00' });
  out.authMatrix.push({ case: 'authorization present, date missing', ...noDate });
}

// ---------------------------------------------------------------- 4. token lifecycle
{
  const T = 'Notification_20150505.NewRobotToken';
  const first = await postSigned(T, { deviceId: 'lifecycle-1' });
  const firstToken = first.body.token;
  const doc = ep.hub.store.findTokenByKey(firstToken);
  const second = await postSigned(T, { deviceId: 'lifecycle-2' });
  const secondDoc = ep.hub.store.findTokenByKey(second.body.token);
  out.tokenLifecycle = {
    newRobotTokenStatus: first.status,
    tokenShape: /^[a-f0-9]{128}$/.test(firstToken || '') ? 'sha-less 64 random bytes hex (128 chars)' : firstToken,
    responseKeys: first.body && Object.keys(first.body),
    tokenDocumentKeys: doc && Object.keys(doc).sort(),
    rotationKeepsTokenDocument: doc._id === secondDoc._id,
    rotationChangesTokenKey: firstToken !== second.body.token,
    oldKeyResolvableAfterRotation: ep.hub.store.findTokenByKey(firstToken) !== null,
    accountsAreIsolated: (() => {
      const beta = ep.hub.store.findTokenByAccountId('account-beta');
      return beta === null || beta === undefined;
    })(),
  };
  const beta = await postSigned(T, { deviceId: 'beta-1' }, 'A10-BETA', 'beta-secret');
  out.tokenLifecycle.betaTokenIssued = /^[a-f0-9]{128}$/.test(beta.body.token || '');
  out.tokenLifecycle.betaDistinctAccountId = ep.hub.store.findTokenByKey(beta.body.token).accountId;
  out.tokenLifecycle.alphaDocumentUnchangedByBeta = ep.hub.store.findTokenByKey(second.body.token).accountId === 'account-alpha';
  // validation envelopes, source Joi shape
  for (const payload of [{ deviceId: {} }, { deviceId: [] }, { deviceId: true }, { deviceId: null }, { deviceId: '' }]) {
    out.tokenLifecycle[`reject_${JSON.stringify(payload)}`] = await postSigned(T, payload);
  }
  for (const payload of ['', null, [], false, 0, '"scalar"', 'not json at all']) {
    const encoded = typeof payload === 'string' && (payload.startsWith('"') || payload === 'not json at all') ? payload : JSON.stringify(payload);
    const result = await postSigned(T, encoded);
    out.tokenLifecycle[`rejectBody_${JSON.stringify(payload)}`] = result;
  }
  out.tokenLifecycle.validAfterRejects = (await postSigned(T, { deviceId: 'lifecycle-3' })).status;
  const S = 'Notification_20150505.GetStatus';
  for (const payload of [{}, { accountId: null }, { accountId: 7 }, { accountId: '' }, { accountId: 'account-beta', extra: 1 }]) {
    out.tokenLifecycle[`getStatus_${JSON.stringify(payload)}`] = await postSigned(S, payload);
  }
}

// ---------------------------------------------------------------- 5. socket lifecycle
const openRaw = (url) => new Promise((resolve, reject) => {
  const ws = new WebSocket(url);
  ws._buf = []; ws._frames = 0; ws._waiters = [];
  ws.on('message', (data) => {
    ws._frames += 1;
    const message = JSON.parse(String(data));
    if (ws._waiters.length) ws._waiters.shift()(message); else ws._buf.push(message);
  });
  ws.once('open', () => resolve(ws));
  ws.once('error', (error) => reject(error));
  ws.once('unexpected-response', (_req, response) => reject(new Error(`socket HTTP ${response.statusCode}`)));
});
const nextFrame = (ws, timeout = 2000) => new Promise((resolve, reject) => {
  if (ws._buf.length) return resolve(ws._buf.shift());
  const timer = setTimeout(() => reject(new Error('frame timeout')), timeout);
  ws._waiters.push((message) => { clearTimeout(timer); resolve(message); });
});
const upgradeStatus = async (path) => new Promise((resolve) => {
  const ws = new WebSocket(`${wsBase}${path}`);
  ws.once('open', () => { ws.close(); resolve({ outcome: 'open' }); });
  ws.once('unexpected-response', (_req, response) => resolve({ outcome: 'rejected', status: response.statusCode }));
  ws.once('error', (error) => resolve({ outcome: 'error', message: error.message }));
});

{
  const T = 'Notification_20150505.NewRobotToken';
  const alpha = (await postSigned(T, { deviceId: 'socket-alpha' })).body.token;
  const beta = (await postSigned(T, { deviceId: 'socket-beta' }, 'A10-BETA', 'beta-secret')).body.token;

  const subscribed = await openRaw(`${wsBase}/socket/${alpha}`);
  const live = nextFrame(subscribed);
  ep.hub.enqueueNotification({ accountId: 'account-alpha', skillId: '-1', notification: { name: 'LoopUpdated', payload: { seq: 'live' } } });
  const liveFrame = await live;

  const other = await openRaw(`${wsBase}/socket/${beta}`);
  ep.hub.enqueueNotification({ accountId: 'account-alpha', skillId: '-1', notification: { name: 'LoopUpdated', payload: { seq: 'isolation' } } });
  const isolated = await nextFrame(subscribed);
  let otherReceived = null;
  try { otherReceived = await nextFrame(other, 250); } catch { otherReceived = null; }

  // frame shape = the FULL notification document (source JSON.stringify(notification))
  out.socketLifecycle.deliveredFrameKeys = Object.keys(liveFrame).sort();
  out.socketLifecycle.deliveredFrame = liveFrame;
  out.socketLifecycle.isolatedFrameMatchesSubscriber = isolated.payload.payload.seq === 'isolation';
  out.socketLifecycle.unsubscribedAccountReceivedNothing = otherReceived === null;

  // ack: the row disappears only after the send callback succeeds
  await new Promise((resolve) => setImmediate(resolve));
  const alphaTokenId = ep.hub.store.findTokenByKey(alpha)._id;
  out.socketLifecycle.pendingAfterAck = ep.hub.store.findNotificationsByTokenIds([alphaTokenId]).length;

  // ownership of GetStatus (source has no ownership check): another account queries it
  out.socketLifecycle.getStatusOtherAccount = await postSigned('Notification_20150505.GetStatus', { accountId: 'account-beta' });

  // unknown + rotated tokens at the upgrade
  out.socketLifecycle.unknownTokenUpgrade = await upgradeStatus(`/socket/${'a'.repeat(128)}`);
  const rotatedAway = (await postSigned(T, { deviceId: 'socket-alpha-rotated' })).body.token;
  out.socketLifecycle.rotatedTokenUpgrade = await upgradeStatus(`/socket/${alpha}`);
  const newSocket = await openRaw(`${wsBase}/${rotatedAway}`);
  out.socketLifecycle.rootSegmentUrlUpgrade = { outcome: 'open' };
  newSocket.close();
  // Token parsing at the upgrade. The source reads the LAST '/' segment of the RAW
  // upgrade url (ws.upgradeReq.url), so a query string stays part of the token and a
  // trailing slash yields an empty token - both would fail the lookup there.
  const queryToken = (await postSigned(T, { deviceId: 'socket-alpha-query' })).body.token;
  out.socketLifecycle.queryBearingTokenUpgrade = await upgradeStatus(`/${queryToken}?probe=1`);
  out.socketLifecycle.trailingSlashUpgrade = await upgradeStatus(`/${queryToken}/`);
  out.socketLifecycle.bareRootUpgrade = await upgradeStatus('/');
  void rotatedAway;

  // enqueue with no socket open: the row is retained (source keeps it for the next poll/connect)
  other.terminate();
  subscribed.terminate();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const offline = ep.hub.enqueueNotification({ accountId: 'account-alpha', skillId: '-1', notification: { name: 'LoopUpdated', payload: { seq: 'offline' } } });
  await new Promise((resolve) => setTimeout(resolve, 100));
  out.socketLifecycle.rowRetainedWhileOffline = ep.hub.store.findNotificationsByTokenIds([offline.tokenId]).length === 1;
  out.socketLifecycle.statusWhileOffline = await postSigned('Notification_20150505.GetStatus', { accountId: 'account-alpha' });
}

// ---------------------------------------------------------------- 6. the ORIGINAL consumer drives the socket
{
  const consumerConsole = [];
  const originalLog = console.log;
  console.log = (...args) => { consumerConsole.push(args.map(String).join(' ')); };
  let connected = null;
  try {
    const svc = new NotificationService({
      apiConfig: SDK_MODEL,
      endpoint: httpBase,
      region: 'us-east-1',
      credentials: new AWS.Credentials('A10-GAMMA', 'gamma-secret'),
      signatureVersion: 'v4',
      sslEnabled: false,
      wsendpoint: wsBase,
      maxRetries: 0,
    });
    // The pinned consumer mints its own token through newRobotToken, then opens
    // `wsEndpoint + '/' + result.token` (lib/services/notification.js connect()).
    connected = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('consumer connect timeout')), 5000);
      svc.connect({ deviceId: 'consumer-1' }, (error, hub) => {
        clearTimeout(timer);
        if (error) reject(error); else resolve(hub);
      });
    });
    const events = [];
    for (const name of ['open', 'close', 'message', 'pong', 'websocket error', 'error']) {
      connected.on(name, (payload) => events.push({ event: name, payload: name === 'message' ? payload : undefined }));
    }
    const nextConsumerMessage = (timeoutMs) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('consumer frame timeout')), timeoutMs);
      connected.once('message', (message) => { clearTimeout(timer); resolve(message); });
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const live = nextConsumerMessage(4000);
    ep.hub.enqueueNotification({ accountId: 'account-gamma', skillId: '-1', notification: { name: 'LoopUpdated', payload: { seq: 'consumer-live' } } });
    const delivered = await live;

    // Drop the connection from the SERVER side (no client close), so the consumer's
    // own close->reconnect loop has to recover without being told to stop.
    for (const socket of ep.hub.sockets.values()) socket.terminate();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const queuedDuringGap = ep.hub.enqueueNotification({
      accountId: 'account-gamma', skillId: '-1', notification: { name: 'LoopUpdated', payload: { seq: 'consumer-gap' } },
    });
    const afterDrop = await nextConsumerMessage(20000);
    const connectLines = consumerConsole.filter((line) => line.startsWith('trying to connect:'));
    out.socketLifecycle.originalConsumer = {
      opened: events.some((entry) => entry.event === 'open'),
      liveFrameSeq: delivered?.payload?.payload?.seq ?? null,
      gapFrameSeq: afterDrop?.payload?.payload?.seq ?? null,
      gapRowStillStoredAfterRedelivery: ep.hub.store.findNotificationsByTokenIds([queuedDuringGap.tokenId]).length,
      sawCloseOrWebsocketError: events.some((entry) => entry.event === 'close' || entry.event === 'websocket error'),
      eventNames: events.map((entry) => entry.event),
      connectUrlLines: connectLines.map((line) => line.replace(/[a-f0-9]{128}/, '<token>')),
      connectAttempts: connectLines.length,
      consumerReusedTheSameToken: new Set(connectLines).size === 1 && connectLines.length >= 2,
      ackedRowNotReplayed: !consumerConsole.some((line) => line.includes('consumer-live')),
      reconnectIntervalMs: 10000,
    };
  } catch (error) {
    out.socketLifecycle.originalConsumer = { error: error.message };
  } finally {
    console.log = originalLog;
    consumerConsole.length = 0;
    try { connected?.close(); } catch { /* already closed */ }
  }
}

// ---------------------------------------------------------------- 7. TLS / SNI, separate from HTTP discovery
{
  let tlsError = null;
  let paths = null;
  try {
    process.env.PHOENIX_TLS_REGIONS = 'phx';
    paths = ensureTlsCertificates({
      dir: join(dir, 'tls'),
      env: { ...process.env, PHOENIX_TLS_REGIONS: 'phx', PHOENIX_TLS_EXTRA_NAMES: '' },
      log: () => {},
    });
  } catch (error) { tlsError = error.message; }
  if (!paths) {
    out.tls = { error: tlsError };
  } else {
    const { readFileSync: rf } = await import('node:fs');
    const tlsEp = createClassicEntrypoint({
      tls: { cert: rf(paths.cert), key: rf(paths.key) },
      notificationFile: join(dir, 'tls-notifications.json'),
      notificationPollIntervalMs: 25,
      notificationAccountResolver: createVerifiedNotificationAccountResolver({
        resolveCredentials: (accessKeyId) => accounts[accessKeyId],
      }),
    });
    const tlsServer = await tlsEp.listen(0, '127.0.0.1');
    const tlsPortReal = tlsServer.address().port;
    const ca = rf(paths.caCert);
    const tlsOrigin = `127.0.0.1:${tlsPortReal}`;
    // HTTP service discovery over the same TLS port, addressed as <region>.jibo.com
    // (the robot's REST hostname). The request is signed like the real client.
    const discoveryBody = JSON.stringify({ deviceId: 'tls-device' });
    const discoveryRequest = signSigV4({
      method: 'POST', path: '/', body: discoveryBody,
      headers: { Host: 'phx.jibo.com', 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': 'Notification_20150505.NewRobotToken' },
      accessKeyId: 'A10-ALPHA', secretAccessKey: 'alpha-secret', region: 'us-east-1', service: 'notification', date: new Date(),
    });
    const discovery = await new Promise((resolve, reject) => {
      const request = https.request({
        host: '127.0.0.1', port: tlsPortReal, method: 'POST', path: '/',
        servername: 'phx.jibo.com', ca, rejectUnauthorized: true,
        headers: { ...discoveryRequest.headers, 'content-length': Buffer.byteLength(discoveryBody) },
      }, (response) => {
        const chunks = []; response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      });
      request.on('error', reject);
      request.end(discoveryBody);
    });
    // socket delivery over the socket hostname (SNI = <region>-socket.jibo.com)
    const tlsToken = JSON.parse(discovery.body).token;
    void tlsOrigin;
    const deliverOverTls = (servername, tlsCa) => new Promise((resolve, reject) => {
      const ws = new WebSocket(`wss://127.0.0.1:${tlsPortReal}/${tlsToken}`, { servername, ca: tlsCa, rejectUnauthorized: true });
      const timer = setTimeout(() => reject(new Error('tls frame timeout')), 4000);
      ws.once('open', () => {
        tlsEp.hub.enqueueNotification({ accountId: 'account-alpha', skillId: '-1', notification: { name: 'LoopUpdated', payload: { seq: 'tls' } } });
      });
      ws.once('message', (data) => { clearTimeout(timer); ws.close(); resolve(JSON.parse(String(data))); });
      ws.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
    let deliveredTls = null; let tlsFailure = null;
    try { deliveredTls = await deliverOverTls('phx-socket.jibo.com', ca); } catch (error) { tlsFailure = error.message; }
    let untrustedFailure = null;
    try { await deliverOverTls('phx-socket.jibo.com', undefined); } catch (error) { untrustedFailure = error.message; }
    let wrongNameFailure = null;
    try { await deliverOverTls('other.jibo.com', ca); } catch (error) { wrongNameFailure = error.message; }
    out.tls = {
      cert: paths.cert,
      san: require_('node:child_process').execFileSync('openssl', ['x509', '-in', paths.cert, '-noout', '-ext', 'subjectAltName']).toString().trim(),
      httpDiscovery: discovery,
      socketDeliveryOverTls: { seq: deliveredTls?.payload?.payload?.seq ?? null, error: tlsFailure },
      withoutPhoenixCaRejected: Boolean(untrustedFailure),
      withoutPhoenixCaError: untrustedFailure,
      wrongSniRejected: Boolean(wrongNameFailure),
      wrongSniError: wrongNameFailure,
      note: 'The robot firmware is not available; this exercises the TLS/SNI path with a standard client, not the robot.',
    };
    tlsEp.hub.stopDelivery();
    await closeServer(tlsServer);
  }
}

// ---------------------------------------------------------------- summary
out.summary = {
  declaredOperations: out.pinnedClient.declaredOperations.length,
  servedOperations: out.servedOperations.filter((entry) => entry.viaSdk).length,
  authCases: out.authMatrix.length,
  socketDeliveryObservable: {
    subscribedReceived: Boolean(out.socketLifecycle.deliveredFrameKeys),
    unsubscribedReceivedNothing: out.socketLifecycle.unsubscribedAccountReceivedNothing,
    originalConsumerOpened: out.socketLifecycle.originalConsumer?.opened === true,
    originalConsumerReconnectedWithin10s: out.socketLifecycle.originalConsumer?.gapFrameSeq === 'consumer-gap',
  },
  tlsSocketDelivered: out.tls?.socketDeliveryOverTls?.seq === 'tls',
};
findings.push(`declared=${out.summary.declaredOperations} served=${out.summary.servedOperations}`);
findings.push(`socket subscribed=${out.summary.socketDeliveryObservable.subscribedReceived} unsubscribedSilent=${out.summary.socketDeliveryObservable.unsubscribedReceivedNothing} consumerReconnect=${out.summary.socketDeliveryObservable.originalConsumerReconnectedWithin10s}`);
findings.push(`tls=${out.summary.tlsSocketDelivered}`);
out.findings = findings;
out.revision = (await import('node:child_process')).execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

writeFileSync(join(HERE, 'probe-output.json'), `${JSON.stringify(out, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(out.summary, null, 2)}\n`);
ep.hub.stopDelivery();
await closeServer(server);
rmSync(dir, { recursive: true, force: true });
process.exit(0);
