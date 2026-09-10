#!/usr/bin/env node
// A-12 independent verification probe.
//
// Drives the Phoenix classic entrypoint (the merged A-12 implementation) two ways:
//   1. WIRE CAPTURE — the pinned original client (@jibo/jibo-server-client 3.0.105 lib +
//      apis/log{,admin}-2015-03-09.normal.json) is pointed at a local echo server so the
//      exact request the original SDK emits per operation is recorded.
//   2. LIVE PROBE  — all seven declared operations are sent to a running Phoenix classic
//      entrypoint; responses, error envelopes/status codes, sync/async acknowledgments and
//      upload->PUT->GET round trips are recorded.
// Raw-HTTP probes back up the SDK probes for the identity-gated operations and the
// unknown-operation case (which the model cannot express).
//
// Run from the repo/worktree root:  node docs/parity/evidence/2026-09-10/a12-log-ingestion/probe.mjs
// Env: PHOENIX_SDK_DIR (default /home/shell/work/phoenix-jibo-server-client)

import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

const require_ = createRequire(pathToFileURL(process.cwd() + '/'));
const HERE = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = process.env.PHOENIX_SDK_DIR || '/home/shell/work/phoenix-jibo-server-client';
const NODE_PATH = process.env.PHOENIX_SDK_NODE_PATH || '/home/shell/hermes-jibo-be/node_modules';
const OUT = join(process.cwd(), 'docs/parity/evidence/2026-09-10/a12-log-ingestion/probe-output.json');

// --- load the PINNED original client --------------------------------------
let AWS = null; let sdkError = null; let sdkVersion = null;
try {
  // node_loader wires url/querystring shims the sdk relies on under modern node.
  process.env.NODE_PATH = `${NODE_PATH}:${SDK_DIR}/node_modules:${process.env.NODE_PATH || ''}`;
  require_('module').Module._initPaths();
  require_(join(SDK_DIR, 'lib/node_loader.js'));
  AWS = require_(join(SDK_DIR, 'lib/core.js'));
  sdkVersion = require_(join(SDK_DIR, 'package.json')).version;
} catch (e) { sdkError = e.message; }

const LOG_API = require_(join(HERE, 'pinned/log-2015-03-09.normal.json'));
const LOGADMIN_API = require_(join(HERE, 'pinned/logadmin-2015-03-09.normal.json'));

// --- the implementation under test ----------------------------------------
const { createClassicEntrypoint } = await import(pathToFileURL(join(process.cwd(), 'packages/classic/src/index.js')).href);

const result = {
  generatedAt: new Date().toISOString(),
  pinnedModels: {},
  sdk: { dir: SDK_DIR, version: sdkVersion, loaded: !!AWS, error: sdkError },
  wireCapture: [],
  liveProbe: [],
  uploadRoundTrips: [],
  validationMatrix: [],
  errorEnvelopeCodes: {},
  summary: {},
};

// model inventory (independently read from the pinned files)
for (const [svc, api] of [['log', LOG_API], ['logadmin', LOGADMIN_API]]) {
  result.pinnedModels[svc] = {
    endpointPrefix: api.metadata.endpointPrefix,
    targetPrefix: api.metadata.targetPrefix,
    operations: Object.fromEntries(Object.entries(api.operations).map(([name, o]) => [name, {
      wireName: `${api.metadata.targetPrefix}.${name}`,
      input: o.input?.shape, output: o.output?.shape,
      outputRequired: (api.shapes[o.output?.shape]?.required) || null,
    }])),
  };
}

const json = (res, status, obj) => {
  const b = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) });
  res.end(b);
};

// ==========================================================================
// PART 1 — wire capture: what does the ORIGINAL client actually send?
// ==========================================================================
async function wireCapture() {
  const captured = [];
  const echo = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      captured.push({
        target: req.headers['x-amz-target'],
        method: req.method,
        path: req.url,
        contentType: req.headers['content-type'] || null,
        contentLength: req.headers['content-length'] || null,
        transferEncoding: req.headers['transfer-encoding'] || null,
        bodyBytes: Buffer.concat(chunks).length,
        bodyHead: Buffer.concat(chunks).slice(0, 24).toString('latin1'),
      });
      json(res, 200, {});
    });
  });
  await new Promise((r) => echo.listen(0, r));
  const port = echo.address().port;
  if (!AWS) { result.wireCapture = { skipped: 'sdk not loaded', error: sdkError }; await new Promise((r) => echo.close(r)); return; }

  const mk = (api) => new AWS.Service({
    apiConfig: api, endpoint: `http://127.0.0.1:${port}`, region: 'us-east-1',
    sslEnabled: false, maxRetries: 0, credentials: new AWS.Credentials('AKIA', 'secret'),
  });
  const log = mk(LOG_API); const admin = mk(LOGADMIN_API);
  const withCreds = (req, creds) => { req.on('afterBuild', () => { req.httpRequest.headers['x-amz-credentials'] = JSON.stringify(creds); }); return req; };

  const calls = [
    ['PutEvents', log.putEvents({ events: [{ message: 'm', created: 1 }], trackingId: 't' })],
    ['PutEventsAsync', log.putEventsAsync({ kind: 'LOG', serial: 'S1' })],
    ['NewKinesisCredentials', withCreds(log.newKinesisCredentials({}), { id: 'a', friendlyId: 'f' })],
    ['PutBinary', log.putBinary({ trackingId: 't', body: Buffer.from('BINARY') })],
    ['PutBinaryAsync', log.putBinaryAsync({ trackingId: 't' })],
    ['PutAsrBinary', log.putAsrBinary({ trackingId: 't', metadata: { k: 'v' } })],
    ['SetLevel', withCreds(admin.setLevel({ friendlyIds: ['f'], namespaces: [{ namespace: 'n', level: 'debug' }] }), { id: 'a', friendlyId: 'f', isAdmin: true })],
  ];
  for (const [name, req] of calls) {
    try { await req.promise(); } catch { /* echo always 200; ignore */ }
  }
  await new Promise((r) => echo.close(r));
  result.wireCapture = captured;
}

// ==========================================================================
// PART 2 — live probe against Phoenix
// ==========================================================================
async function rawCall(base, target, body, { headers = {}, contentType = 'application/json', method = 'POST', raw } = {}) {
  const init = { method, headers: { ...headers, 'x-amz-target': target } };
  if (contentType) init.headers['content-type'] = contentType;
  if (raw !== undefined) init.body = raw; else if (method !== 'GET') init.body = JSON.stringify(body || {});
  const res = await fetch(`${base}/`, init);
  const text = await res.text();
  let parsed = null; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, errType: res.headers.get('x-amzn-errortype'), body: parsed };
}

function sampleInput(name) {
  switch (name) {
    case 'PutEvents': return { events: [{ message: 'probe' }] };
    case 'PutEventsAsync': return { kind: 'LOG', serial: 'S1' };
    case 'NewKinesisCredentials': return {};
    case 'PutBinary': return null; // raw stream
    case 'PutBinaryAsync': return { trackingId: 'trk' };
    case 'PutAsrBinary': return { trackingId: 'trk' };
    case 'SetLevel': return { friendlyIds: ['f'], namespaces: [{ namespace: 'n', level: 'info' }] };
    default: return {};
  }
}

async function liveProbe() {
  const dir = mkdtempSync(join(tmpdir(), 'a12-probe-'));
  process.env.ETCO_classic_logDir = dir;
  delete process.env.ETCO_log_probability;
  const entry = await createClassicEntrypoint().listen(0);
  const server = entry.server || entry;
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const logStore = entry.logStore;

  const mk = (api) => new AWS.Service({
    apiConfig: api, endpoint: base, region: 'us-east-1', sslEnabled: false, maxRetries: 0,
    credentials: new AWS.Credentials('AKIA', 'secret'),
  });
  const withCreds = (req, creds) => { req.on('afterBuild', () => { req.httpRequest.headers['x-amz-credentials'] = JSON.stringify(creds); }); return req; };
  const sdkCall = async (name, req) => {
    try { const data = await req.promise(); return { op: name, ok: true, data }; }
    catch (err) { return { op: name, ok: false, code: err.code, statusCode: err.statusCode, message: err.message }; }
  };

  const log = mk(LOG_API); const admin = mk(LOGADMIN_API);

  // 2a. all seven operations, driven by the ORIGINAL client where the model can express them
  const seven = [];
  seven.push(await sdkCall('PutEvents', withCreds(log.putEvents({ events: [{ message: 'via-sdk', created: Date.now() }], trackingId: 'trk', deviceId: 'dev' }), { id: 'acct', friendlyId: 'fid' })));
  const asyncGrant = await sdkCall('PutEventsAsync', withCreds(log.putEventsAsync({ kind: 'LOG', serial: 'SER-1' }), { id: 'acct', friendlyId: 'fid' }));
  seven.push(asyncGrant);
  seven.push(await sdkCall('NewKinesisCredentials(no identity)', log.newKinesisCredentials({})));
  seven.push(await sdkCall('NewKinesisCredentials(robot)', withCreds(log.newKinesisCredentials({}), { id: 'acct', friendlyId: 'fid' })));
  seven.push(await sdkCall('PutBinaryAsync', withCreds(log.putBinaryAsync({ trackingId: 'trk' }), { id: 'acct' })));
  seven.push(await sdkCall('PutAsrBinary', withCreds(log.putAsrBinary({ trackingId: 'asr1', metadata: { k: 'v' } }), { id: 'acct' })));
  seven.push(await sdkCall('SetLevel(no admin)', admin.setLevel({ friendlyIds: ['f'], namespaces: [{ namespace: 'n', level: 'debug' }] })));
  seven.push(await sdkCall('SetLevel(admin)', withCreds(admin.setLevel({ friendlyIds: ['f'], namespaces: [{ namespace: 'n', level: 'debug' }] }), { id: 'acct', friendlyId: 'fid', isAdmin: true })));
  // PutBinary needs a stream payload; the sdk sends it with no declared content-type.
  seven.push(await sdkCall('PutBinary', withCreds(log.putBinary({ trackingId: 'cam', body: Buffer.from('SYNC-BIN') }), { id: 'acct' })));
  result.liveProbe = seven;

  // 2b. raw probe: every declared wireName, so "served" is observed not inferred
  const served = [];
  for (const [svc, api] of [['log', LOG_API], ['logadmin', LOGADMIN_API]]) {
    for (const [name, o] of Object.entries(api.operations)) {
      const target = `${api.metadata.targetPrefix}.${name}`;
      const input = sampleInput(name);
      const headers = {};
      if (name === 'SetLevel') headers['x-amz-credentials'] = JSON.stringify({ id: 'a', friendlyId: 'f', isAdmin: true });
      if (name === 'NewKinesisCredentials') headers['x-amz-credentials'] = JSON.stringify({ id: 'a', friendlyId: 'f' });
      const r = await rawCall(base, target, input, { headers });
      served.push({ service: svc, op: name, target, requestBody: input, observed: r });
    }
  }
  result.servedOperations = served;

  // 2c. upload round trips (write to the advertised destination, read it back)
  const kind = (o) => o.toLowerCase();
  const roundTrip = async (label, grant, bytes) => {
    const uploadUrl = grant.uploadUrl || grant;
    const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: bytes });
    const etag = put.headers.get('etag');
    const key = new URL(uploadUrl).searchParams.get('key');
    const get = await fetch(`${base}/log/blob?key=${encodeURIComponent(key)}`);
    const got = Buffer.from(await get.arrayBuffer());
    result.uploadRoundTrips.push({
      label, uploadUrl, key, putStatus: put.status, putEtag: etag,
      getStatus: get.status, bytesMatch: got.equals(Buffer.from(bytes)), size: bytes.length,
      getContentType: get.headers.get('content-type'), getContentLength: get.headers.get('content-length'),
    });
    return key;
  };
  const evGrant = asyncGrant.data || {};
  await roundTrip('PutEventsAsync', evGrant, Buffer.from('gzipbytes'));
  const ba = await rawCall(base, 'Log_20150309.PutBinaryAsync', { trackingId: 'trk' }, { headers: { 'x-amz-credentials': JSON.stringify({ id: 'acct' }) } });
  await roundTrip('PutBinaryAsync', ba.body, Buffer.from('bin-A'));
  const asr = await rawCall(base, 'Log_20150309.PutAsrBinary', { trackingId: 'asr1', metadata: { k: 'v' } }, { headers: { 'x-amz-credentials': JSON.stringify({ id: 'acct' }) } });
  await roundTrip('PutAsrBinary', asr.body, Buffer.from('asr-A'));
  // sync PutBinary writes at request time
  const syncBin = await rawCall(base, 'Log_20150309.PutBinary', null, { contentType: null, headers: { 'x-amz-credentials': JSON.stringify({ id: 'acct' }), 'x-tracking-id': 'cam' }, raw: Buffer.from('sync-A') });
  const syncGet = await fetch(syncBin.body.url);
  result.uploadRoundTrips.push({ label: 'PutBinary(sync)', url: syncBin.body.url, path: syncBin.body.path, getStatus: syncGet.status, bytesMatch: Buffer.from(await syncGet.arrayBuffer()).equals(Buffer.from('sync-A')) });

  // retried PUT to the SAME uploadUrl must ack and be last-write-wins
  const put1 = await fetch(ba.body.uploadUrl, { method: 'PUT', body: Buffer.from('first') });
  const put2 = await fetch(ba.body.uploadUrl, { method: 'PUT', body: Buffer.from('second') });
  const after = await fetch(ba.body.url);
  result.retrySameUrl = { put1: put1.status, put2: put2.status, readBack: Buffer.from(await after.arrayBuffer()).toString('latin1'), readBackStatus: after.status };
  // a second handshake must yield a different object (S3-style independent objects)
  const ba2 = await rawCall(base, 'Log_20150309.PutBinaryAsync', { trackingId: 'trk' }, { headers: { 'x-amz-credentials': JSON.stringify({ id: 'acct' }) } });
  result.retryNewHandshakeDistinctKey = { first: ba.body.path, second: ba2.body.path, distinct: ba.body.path !== ba2.body.path };

  // 2d. validation matrix — every rule from the pinned Joi schemas / models
  const V = async (target, body, headers = {}, note = '') => {
    const r = await rawCall(base, target, body, { headers });
    result.validationMatrix.push({ target, body, headers: Object.keys(headers), note, status: r.status, errType: r.errType, code: r.body?.__type, message: r.body?.message });
    return r;
  };
  const adminCreds = { 'x-amz-credentials': JSON.stringify({ id: 'a', friendlyId: 'f', isAdmin: true }) };
  await V('Log_20150309.PutEvents', {}, {}, 'events missing');
  await V('Log_20150309.PutEvents', { events: { a: 1 } }, {}, 'events not an array');
  await V('Log_20150309.PutEvents', { events: [], deviceId: 7 }, {}, 'deviceId not a string');
  await V('Log_20150309.PutEvents', { events: [], trackingId: ['x'] }, {}, 'trackingId not a string');
  await V('Log_20150309.PutEvents', { events: [] }, {}, 'empty array (Joi array().required() allows)');
  await V('Log_20150309.PutEvents', { events: [], deviceId: '' }, {}, 'empty-string deviceId (Joi string() rejects)');
  await V('Log_20150309.PutEventsAsync', { kind: 'k', serial: 's' }, {}, 'kind outside enum');
  await V('Log_20150309.PutEventsAsync', { kind: 'LOG' }, {}, 'serial missing');
  await V('Log_20150309.PutEventsAsync', { kind: 'LOG', serial: 12 }, {}, 'serial not a string');
  await V('Log_20150309.PutEventsAsync', { kind: 'LOG', serial: '' }, {}, 'empty-string serial (Joi string() rejects)');
  await V('Log_20150309.PutEventsAsync', { kind: 'HEALTH', serial: 's' }, {}, 'HEALTH valid');
  await V('Log_20150309.PutAsrBinary', {}, {}, 'trackingId missing');
  await V('Log_20150309.PutAsrBinary', { trackingId: 9 }, {}, 'trackingId not a string');
  await V('Log_20150309.PutAsrBinary', { trackingId: 't', metadata: 'no' }, {}, 'metadata not an object');
  await V('Log_20150309.PutAsrBinary', { trackingId: 't', metadata: ['a'] }, {}, 'metadata array (Joi.object rejects)');
  await V('Log_20150309.PutAsrBinary', { trackingId: 't', metadata: { k: 'v' } }, {}, 'valid');
  await V('Log_20150309.SetLevel', { friendlyIds: ['r'], namespaces: [{ namespace: 'l', level: 'debug' }] }, {}, 'no admin -> 401');
  await V('Log_20150309.SetLevel', {}, adminCreds, 'missing friendlyIds/namespaces');
  await V('Log_20150309.SetLevel', { friendlyIds: 'x', namespaces: [] }, adminCreds, 'friendlyIds not array');
  await V('Log_20150309.SetLevel', { friendlyIds: [1], namespaces: [] }, adminCreds, 'friendlyId not string');
  await V('Log_20150309.SetLevel', { friendlyIds: [], namespaces: [{ namespace: 'x', level: 'loud' }] }, adminCreds, 'level outside enum');
  await V('Log_20150309.SetLevel', { friendlyIds: [], namespaces: [{}] }, adminCreds, 'empty namespace object (Joi inner keys optional)');
  await V('Log_20150309.SetLevel', { friendlyIds: [], namespaces: [{ namespace: 'x' }] }, adminCreds, 'namespace without level (Joi allows)');
  await V('Log_20150309.SetLevel', { friendlyIds: [], namespaces: [{ level: 'info' }] }, adminCreds, 'level without namespace (Joi allows)');
  await V('Log_20150309.SetLevel', { friendlyIds: [''], namespaces: [{ namespace: 'x', level: 'info' }] }, adminCreds, 'empty-string friendlyId (Joi string() rejects)');
  await V('Log_20150309.NewKinesisCredentials', {}, {}, 'no robot identity -> 403');
  await V('Log_20150309.PutFaceBinary', {}, {}, 'unknown operation');
  await V('Log_20150309.putevents', { events: [] }, {}, 'lowercase op, valid body (source lowerMethodName -> 404)');

  // 2h. what the ORIGINAL client sees for Phoenix's error envelopes (same cases as the
  // source-envelope emulation), so the two can be compared directly.
  const phoenixCodes = [];
  const capClient = async (label, req) => {
    try { await req.promise(); phoenixCodes.push({ label, unexpected: 'no error' }); }
    catch (e) { phoenixCodes.push({ label, clientCode: e.code, clientStatus: e.statusCode, clientMessage: e.message }); }
  };
  // The model's own param_validator screens most malformed inputs client-side, so use a
  // body the pinned model accepts but Phoenix rejects: namespaces [{}] (Joi inner keys optional).
  await capClient('Phoenix 422 validation (model-valid, server-rejected)',
    withCreds(admin.setLevel({ friendlyIds: [], namespaces: [{}] }), { id: 'a', friendlyId: 'f', isAdmin: true }));
  {
    const req = log.newKinesisCredentials({});
    req.on('afterBuild', () => { req.httpRequest.headers['x-amz-target'] = 'Log_20150309.PutFaceBinary'; });
    await capClient('Phoenix 404 unknown op', req);
  }
  {
    const req = withCreds(log.newKinesisCredentials({}), { id: 'a' });
    req.on('afterBuild', () => { req.httpRequest.headers['x-amz-target'] = 'Log_20150309.NewKinesisCredentials'; });
    await capClient('Phoenix 403 robot only', req);
  }
  await capClient('Phoenix 401 admin', admin.setLevel({ friendlyIds: [], namespaces: [] }));
  result.phoenixClientCodes = phoenixCodes;

  // 2e. throttle probability = 0 (fresh entrypoint) — source REQUEST_THROTTLED
  process.env.ETCO_log_probability = '0';
  const t = await createClassicEntrypoint().listen(0);
  const tp = (t.server || t).address().port;
  const tbase = `http://127.0.0.1:${tp}`;
  result.throttle = {
    putEventsAsync: await rawCall(tbase, 'Log_20150309.PutEventsAsync', { kind: 'LOG', serial: 's' }),
    putBinaryAsync: await rawCall(tbase, 'Log_20150309.PutBinaryAsync', { trackingId: 't' }),
    putBinary: await rawCall(tbase, 'Log_20150309.PutBinary', null, { contentType: null, raw: Buffer.from('x') }),
    newKinesisCredentials: await rawCall(tbase, 'Log_20150309.NewKinesisCredentials', {}, { headers: { 'x-amz-credentials': JSON.stringify({ id: 'a', friendlyId: 'f' }) } }),
  };
  (t.server || t).close();
  delete process.env.ETCO_log_probability;

  // 2f. ASR sampling gate at probability=0.5 (deterministic per trackingId hash)
  process.env.ETCO_log_probability = '0.5';
  const a = await createClassicEntrypoint().listen(0);
  const ap = (a.server || a).address().port;
  const abase = `http://127.0.0.1:${ap}`;
  const asrSample = {};
  for (const tid of ['asr-t1', 'asr-t2', 'asr-t3', 'alpha', 'beta']) {
    const r = await rawCall(abase, 'Log_20150309.PutAsrBinary', { trackingId: tid });
    asrSample[tid] = r.status;
  }
  result.asrSampling = asrSample;
  (a.server || a).close();
  delete process.env.ETCO_log_probability;

  // 2g. durable sink: events.jsonl + no eviction
  result.sinkDir = dir;
  result.sinkDirIndexKeys = logStore ? [...logStore.index.keys()].length : null;
  process.env.ETCO_classic_logDir = dir;
  server.close();
  for (const key in { ...process.env }) if (key === 'ETCO_classic_logDir') delete process.env[key];
  return { dir, base };
}

async function sourceEnvelopeEmulation() {
  // The archived server answered errors as Hapi/Boom payloads: validation -> boom.badData
  // ({statusCode:422, error:'Unprocessable Entity', message:<joi>}); unknown op ->
  // boom.notFound ({statusCode:404, error:'Not Found', message:'Method x not found.'});
  // codified errors carry an extra `code` (boom.createWithCode). Point the PINNED original
  // client at a mock emitting exactly those shapes to see the err.code the source produced.
  const cases = [
    { label: 'source 422 validation (Boom.badData)', status: 422, payload: { statusCode: 422, error: 'Unprocessable Entity', message: 'child "events" fails because ["events" is required]' } },
    { label: 'source 404 unknown op (Boom.notFound)', status: 404, payload: { statusCode: 404, error: 'Not Found', message: 'Method putfacebinary not found.' } },
    { label: 'source 429 throttle (createWithCode)', status: 429, payload: { statusCode: 429, error: 'Too Many Requests', message: 'Request throttled due to server rules.', code: 'REQUEST_THROTTLED' } },
    { label: 'source 403 robot only (createWithCode)', status: 403, payload: { statusCode: 403, error: 'Forbidden', message: 'Request forbidden. Only robotd are allowed.', code: 'ROBOT_ONLY' } },
    { label: 'source 401 admin (createWithCode)', status: 401, payload: { statusCode: 401, error: 'Unauthorized', message: 'Must be authorized under admin account', code: 'AUTHORIZED_UNDER_ADMIN' } },
  ];
  const mock = http.createServer((req, res) => {
    let body = Buffer.alloc(0);
    req.on('data', (c) => { body = Buffer.concat([body, c]); });
    req.on('end', () => {
      const target = String(req.headers['x-amz-target'] || '');
      const wanted = target.endsWith('SetLevel') ? 'source 401 admin (createWithCode)'
        : target.endsWith('NewKinesisCredentials') ? 'source 403 robot only (createWithCode)'
        : target.endsWith('PutEventsAsync') ? 'source 429 throttle (createWithCode)'
        : target.endsWith('PutFaceBinary') ? 'source 404 unknown op (Boom.notFound)'
        : 'source 422 validation (Boom.badData)';
      const c = cases.find((x) => x.label === wanted);
      const b = JSON.stringify(c.payload);
      res.writeHead(c.status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) });
      res.end(b);
    });
  });
  await new Promise((r) => mock.listen(0, r));
  const port = mock.address().port;
  if (!AWS) { result.sourceEnvelopeEmulation = { skipped: 'sdk not loaded' }; await new Promise((r) => mock.close(r)); return; }
  const log = new AWS.Service({ apiConfig: LOG_API, endpoint: `http://127.0.0.1:${port}`, region: 'us-east-1', sslEnabled: false, maxRetries: 0, credentials: new AWS.Credentials('AKIA', 'secret') });
  const admin = new AWS.Service({ apiConfig: LOGADMIN_API, endpoint: `http://127.0.0.1:${port}`, region: 'us-east-1', sslEnabled: false, maxRetries: 0, credentials: new AWS.Credentials('AKIA', 'secret') });
  const cap = async (label, req) => {
    try { await req.promise(); result.sourceEnvelopeEmulation.push({ label, unexpected: 'no error' }); }
    catch (e) { result.sourceEnvelopeEmulation.push({ label, clientCode: e.code, clientStatus: e.statusCode, clientMessage: e.message }); }
  };
  result.sourceEnvelopeEmulation = [];
  await cap('source 422 validation (Boom.badData)', log.putEvents({ events: [{ created: 1 }] }));
  await cap('source 404 unknown op (Boom.notFound)', log.newKinesisCredentials({}));
  await cap('source 429 throttle (createWithCode)', log.putEventsAsync({ kind: 'LOG', serial: 's' }));
  // a bogus target the model cannot express, for the 404 shape
  {
    const req = log.newKinesisCredentials({});
    req.on('afterBuild', () => { req.httpRequest.headers['x-amz-target'] = 'Log_20150309.PutFaceBinary'; });
    await cap('source 404 unknown op (Boom.notFound)', req);
  }
  {
    const req = log.newKinesisCredentials({});
    req.on('afterBuild', () => { req.httpRequest.headers['x-amz-target'] = 'Log_20150309.NewKinesisCredentials'; });
    await cap('source 403 robot only (createWithCode)', req);
  }
  await cap('source 401 admin (createWithCode)', admin.setLevel({ friendlyIds: [], namespaces: [] }));
  await new Promise((r) => mock.close(r));
}

async function modelScreening() {
  // Which malformed inputs does the ORIGINAL client reject before it ever hits the wire?
  // (Its param_validator enforces the pinned model's required/min/enum constraints.)
  if (!AWS) { result.modelScreening = { skipped: 'sdk not loaded' }; return; }
  const dead = new AWS.Service({ apiConfig: LOG_API, endpoint: 'http://127.0.0.1:1', region: 'us-east-1', sslEnabled: false, maxRetries: 0, credentials: new AWS.Credentials('AKIA', 'secret') });
  const deadAdmin = new AWS.Service({ apiConfig: LOGADMIN_API, endpoint: 'http://127.0.0.1:1', region: 'us-east-1', sslEnabled: false, maxRetries: 0, credentials: new AWS.Credentials('AKIA', 'secret') });
  const rows = [];
  const screen = async (label, req) => {
    try { await req.promise(); rows.push({ label, sentToWire: true }); }
    catch (e) {
      const clientSide = !e.statusCode || e.code === 'MissingRequiredParameter' || e.code === 'MinRangeError'
        || e.code === 'InvalidParameterType' || e.code === 'InvalidParameterValue' || e.code === 'UnexpectedParameter';
      rows.push({ label, clientSide, code: e.code || null, message: e.message });
    }
  };
  await screen('PutEvents events:[] (model InputEvents min 1)', dead.putEvents({ events: [] }));
  await screen('PutEvents events:[{}] (model InputEvent requires created)', dead.putEvents({ events: [{}] }));
  await screen('PutEvents deviceId:"" (model DeviceId min 1)', dead.putEvents({ events: [{ created: 1 }], deviceId: '' }));
  await screen('PutEventsAsync serial:"" (model Serial min 1)', dead.putEventsAsync({ kind: 'LOG', serial: '' }));
  await screen('PutEventsAsync kind:"k" (model enum)', dead.putEventsAsync({ kind: 'k', serial: 's' }));
  await screen('PutAsrBinary trackingId:"" (model TrackingId min 1)', dead.putAsrBinary({ trackingId: '' }));
  await screen('SetLevel friendlyIds:[""] (FriendlyId: plain string)', deadAdmin.setLevel({ friendlyIds: [''], namespaces: [{ namespace: 'n', level: 'info' }] }));
  await screen('SetLevel namespaces:[{}] (model has no required members)', deadAdmin.setLevel({ friendlyIds: [], namespaces: [{}] }));
  await screen('SetLevel namespaces:[{namespace:"x"}] (model: level optional)', deadAdmin.setLevel({ friendlyIds: [], namespaces: [{ namespace: 'x' }] }));
  result.modelScreening = rows;
}

async function main() {
  await wireCapture();
  await sourceEnvelopeEmulation();
  await modelScreening();
  const { dir } = await liveProbe();
  result.summary = {
    declaredOperations: Object.values(result.pinnedModels).reduce((n, m) => n + Object.keys(m.operations).length, 0),
    servedNotUnknown: (result.servedOperations || []).filter((s) => s.observed.status !== 404 && !/no classic service/i.test(String(s.observed.body?.message))).length,
    servedTotal: (result.servedOperations || []).length,
    uploadRoundTripsOk: result.uploadRoundTrips.filter((r) => r.putStatus === 200 && r.getStatus === 200 && r.bytesMatch).length,
  };
  // events.jsonl durability
  try {
    const { readFileSync } = await import('node:fs');
    const lines = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    result.eventSink = { lines: lines.length, sample: lines.slice(0, 3) };
  } catch (e) { result.eventSink = { error: e.message }; }
  writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result.summary, null, 2));
  console.log('wrote', OUT);
}
main().catch((e) => { console.error('PROBE FAILED', e); process.exit(1); });
