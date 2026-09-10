// A-12 — Log_20150309 ingestion + binary/ASR upload behavior, verified against the archived
// jiborobot/srv-log-ws source (handlers/log.handler.ts, controllers/log.ctrl.ts,
// errors/log.ts) and the API models apis/log-{,admin}2015-03-09.normal.json.
// Covers: the 6+1 op inventory, Joi-shaped validation (422), REQUEST_THROTTLED (429),
// ROBOT_ONLY (403), AUTHORIZED_UNDER_ADMIN (401), sync vs async acks, usable upload
// destinations backed by a durable retrievable sink, trace metadata (trackingId /
// deviceId / robotId stamping), producer-retry tolerance and no-eviction retention.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClassicEntrypoint } from '../src/index.js';

let server; let port; let logStore; let logDir;
const base = () => `http://localhost:${port}`;

async function amz(target, body, { headers = {}, method = 'POST' } = {}) {
  const res = await fetch(`${base()}/`, {
    method,
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': target, ...headers },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, errType: res.headers.get('x-amzn-errortype'), body: await res.json().catch(() => null) };
}

// Exactly what the pinned client's lib/protocol/json.js:extractError resolves err.code to:
// the x-amzn-errortype header, overridden by body.__type || body.code || body.error.
const clientCode = (r) => r.body?.__type || r.body?.code || r.body?.error || r.errType || 'UnknownError';

before(async () => {
  logDir = mkdtempSync(join(tmpdir(), 'phx-log-test-'));
  process.env.ETCO_classic_logDir = logDir;
  const entry = await createClassicEntrypoint().listen(0);
  server = entry.server || entry;
  port = server.address().port;
  logDir = entry.logStore?.dir || logDir;
});

after(() => {
  server.close();
  delete process.env.ETCO_classic_logDir;
});

const readEvents = () => {
  try {
    return readFileSync(join(logDir, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
};

test('PutEvents: synchronous ack, level derivation, trace stamping, durable events file', async () => {
  const r = await amz('Log_20150309.PutEvents', {
    trackingId: 'trk-1',
    deviceId: 'dev-9',
    events: [
      { message: 'plain record' },
      { message: 'this is an error record' },
      { message: 'warned', level: 'warn' },
      { message: 'kept verbose', level: 'verbose' },
    ],
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { result: 'Successfully added events' });

  const lines = readEvents();
  assert.ok(lines.length >= 4, 'one line per event lands in the durable sink');
  const first = lines.find((e) => e.message === 'plain record');
  const err = lines.find((e) => e.message === 'this is an error record');
  const warn = lines.find((e) => e.message === 'warned');
  assert.equal(first.level, 'info', 'no level + no "error" in message -> info (srv-log-ws rule)');
  assert.equal(err.level, 'error', 'message mentioning "error" -> error');
  assert.equal(warn.level, 'warn', 'valid level is kept');
  assert.equal(first.deviceId, 'dev-9', 'deviceId stamped onto the event');
  assert.equal(first.trackingId, 'trk-1', 'trackingId stamped onto the event');
});

test('PutEvents: account/robot identity from x-amz-credentials (gateway), info default, empty list 200', async () => {
  const withCreds = await amz('Log_20150309.PutEvents', { events: [{ message: 'm1' }] }, {
    headers: { 'x-amz-credentials': JSON.stringify({ id: 'acct-11', friendlyId: 'fid-22' }) },
  });
  assert.equal(withCreds.status, 200);
  const line = readEvents().find((e) => e.message === 'm1');
  assert.equal(line.accountId, 'acct-11');
  assert.equal(line.robotId, 'fid-22');
  assert.equal(line.level, 'info');

  const empty = await api('Log_20150309.PutEvents', { events: [] });
  assert.equal(empty.status, 200, 'empty array passes Joi array().required() like the source');
});

test('PutEvents validation: 422 Boom.badData for missing/bad members', async () => {
  const missing = await api('Log_20150309.PutEvents', {});
  assert.equal(missing.status, 422);
  assert.equal(missing.errType, null, 'a Boom-shaped error carries no x-amzn-errortype header');
  assert.equal(clientCode(missing), 'Unprocessable Entity', 'client falls back to body.error (source had no code)');
  const nonArray = await api('Log_20150309.PutEvents', { events: { nope: 1 } });
  assert.equal(nonArray.status, 422);
  const badDevice = await api('Log_20150309.PutEvents', { events: [], deviceId: 7 });
  assert.equal(badDevice.status, 422);
  const badTracking = await api('Log_20150309.PutEvents', { events: [], trackingId: ['x'] });
  assert.equal(badTracking.status, 422);
});

test('PutEventsAsync: async ack shape + usable gzip upload destination, credentials-independent', async () => {
  const r = await api('Log_20150309.PutEventsAsync', { kind: 'LOG', serial: 'SER-100' });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ['contentEncoding', 'uploadUrl']);
  assert.equal(r.body.contentEncoding, 'gzip');
  assert.ok(r.body.uploadUrl.startsWith(base()), 'uploadUrl points back at this entrypoint');

  // robot PUTs the gzipped raw log file to the handshake URL
  const gz = Buffer.from('gzip-payload-bytes\x00\x01', 'binary');
  const put = await fetch(r.body.uploadUrl, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: gz });
  assert.equal(put.status, 200);
  assert.ok(put.headers.get('etag')?.startsWith('"'), 'PUT answers an S3-style ETag');

  // ... and the object is retrievable from the durable sink (GET by the echoed/derived key)
  const key = new URL(r.body.uploadUrl).searchParams.get('key');
  const got = await fetch(`${base()}/log/blob?key=${encodeURIComponent(key)}`);
  assert.equal(got.status, 200);
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), gz, 'events-async object is byte-identical');
  assert.match(key, /^log-async\/robot=\/serial=SER-100\/account=\/year=\d+\/month=\d+\/day=\d+\/kind=LOG\/\d+\.gz$/);
});

test('PutEventsAsync validation: kind/HEALTH+LOG enum and required serial -> 422', async () => {
  const badKind = await api('Log_20150309.PutEventsAsync', { kind: 'k', serial: 's' });
  assert.equal(badKind.status, 422);
  assert.equal(clientCode(badKind), 'Unprocessable Entity');
  const noSerial = await api('Log_20150309.PutEventsAsync', { kind: 'LOG' });
  assert.equal(noSerial.status, 422);
  const numSerial = await api('Log_20150309.PutEventsAsync', { kind: 'HEALTH', serial: 12 });
  assert.equal(numSerial.status, 422);
  const health = await api('Log_20150309.PutEventsAsync', { kind: 'HEALTH', serial: 's2' });
  assert.equal(health.status, 200, 'HEALTH kind is valid');
});

test('PutEventsAsync / PutBinary throttle: probability=0 -> 429 REQUEST_THROTTLED (exact srv-log-ws error)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-log-throttle-'));
  process.env.ETCO_classic_logDir = dir;
  process.env.ETCO_log_probability = '0';
  const throttled = await createClassicEntrypoint().listen(0);
  const p = throttled.address().port;
  try {
    const amzThrottled = async (target, body) => {
      const res = await fetch(`http://localhost:${p}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': target },
        body: JSON.stringify(body || {}),
      });
      return { status: res.status, errType: res.headers.get('x-amzn-errortype'), body: await res.json().catch(() => null) };
    };
    const ev = await amzThrottled('Log_20150309.PutEventsAsync', { kind: 'LOG', serial: 's' });
    assert.equal(ev.status, 429);
    assert.equal(ev.errType, 'REQUEST_THROTTLED');
    assert.equal(ev.body.message, 'Request throttled due to server rules.');
    const bin = await amzThrottled('Log_20150309.PutBinaryAsync', { trackingId: 't' });
    assert.equal(bin.status, 429);
  } finally {
    throttled.close();
    process.env.ETCO_log_probability = '';
    delete process.env.ETCO_log_probability;
    process.env.ETCO_classic_logDir = logDir;
  }
});

test('PutBinaryAsync: async binary handshake {path,url,uploadUrl}; retried handshakes make independent objects', async () => {
  const a = await api('Log_20150309.PutBinaryAsync', { trackingId: 'trk-bin' });
  assert.equal(a.status, 200);
  assert.deepEqual(Object.keys(a.body).sort(), ['path', 'uploadUrl', 'url']);
  assert.ok(a.body.path.startsWith('/log/log-binary/'));
  assert.ok(a.body.uploadUrl.startsWith(base()));
  assert.ok(a.body.url.startsWith(base()));

  const blob = Buffer.from('binary-blob-0xDEADBEEF', 'binary');
  const put = await fetch(a.body.uploadUrl, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: blob });
  assert.equal(put.status, 200);

  // Producer retry of the same PUT (same URL) must ack again and keep last-write semantics, like S3.
  const retried = Buffer.from('binary-blob-RETRY', 'binary');
  const put2 = await fetch(a.body.uploadUrl, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: retried });
  assert.equal(put2.status, 200, 'a retried PUT to the same uploadUrl is accepted (no 5xx)');
  const got = await fetch(a.body.url);
  assert.equal(got.status, 200);
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), retried, 'sink keeps the latest retried bytes (last-write-wins)');

  // Producer retries: a second handshake must NOT reuse the first object (S3-style uuid per grant)
  const b = await api('Log_20150309.PutBinaryAsync', { trackingId: 'trk-bin' });
  assert.notEqual(a.body.path, b.body.path, 'each async handshake yields a fresh object key');
});

test('PutBinary (sync): raw stream ingestion, {path,url}, trackingId from x-tracking-id header', async () => {
  const payload = Buffer.from('sync-binary-raw-\x00\xff', 'binary');
  const res = await fetch(`${base()}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'x-amz-target': 'Log_20150309.PutBinary',
      'x-tracking-id': 'cam-42',
    },
    body: payload,
  });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.deepEqual(Object.keys(out).sort(), ['path', 'url']);
  assert.ok(out.path.includes('cam-42'), 'trackingId lands in the object path');
  const got = await fetch(out.url);
  assert.equal(got.status, 200);
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), payload, 'sync binary retrievable');
});

test('PutAsrBinary: bucket/key/metadata/uploadUrl handshake with ASR key layout; retrievable', async () => {
  const r = await api('Log_20150309.PutAsrBinary', { trackingId: 'asr-t1', metadata: { role: 'listener' } });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ['bucketName', 'key', 'metadata', 'uploadUrl']);
  assert.deepEqual(r.body.metadata, { role: 'listener' });
  assert.match(r.body.key, /^asr-binary\/year=\d+\/month=\d+\/day=\d+\/accountId=\/trackingId=asr-t1\/\d+\.bin$/);

  const audio = Buffer.from('asr-wav-bytes', 'binary');
  const put = await fetch(r.body.uploadUrl, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: audio });
  assert.equal(put.status, 200);
  const got = await fetch(`${base()}/log/blob?key=${encodeURIComponent(r.body.key)}`);
  assert.equal(got.status, 200);
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), audio, 'ASR binary retrievable from the sink');
});

test('PutAsrBinary validation: trackingId required string; metadata must be an object -> 422', async () => {
  assert.equal((await api('Log_20150309.PutAsrBinary', {})).status, 422);
  assert.equal((await api('Log_20150309.PutAsrBinary', { trackingId: 9 })).status, 422);
  assert.equal((await api('Log_20150309.PutAsrBinary', { trackingId: 't', metadata: 'no' })).status, 422);
  assert.equal((await api('Log_20150309.PutAsrBinary', { trackingId: 't', metadata: ['a'] })).status, 422);
  assert.equal((await api('Log_20150309.PutAsrBinary', { trackingId: 't', metadata: { k: 'v' } })).status, 200);
});

test('NewKinesisCredentials: ROBOT_ONLY without a robot identity; document-shaped creds for the robot', async () => {
  const denied = await api('Log_20150309.NewKinesisCredentials');
  assert.equal(denied.status, 403);
  assert.equal(denied.errType, 'ROBOT_ONLY');
  assert.equal(denied.body.message, 'Request forbidden. Only robotd are allowed.');

  const ok = await api('Log_20150309.NewKinesisCredentials', {}, {
    headers: { 'x-amz-credentials': JSON.stringify({ id: 'a1', friendlyId: 'robot-7' }) },
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(Object.keys(ok.body).sort(), ['credentials', 'region', 'streamName']);
  assert.deepEqual(Object.keys(ok.body.credentials).sort(),
    ['AccessKeyId', 'Expiration', 'SecretAccessKey', 'SessionToken'], 'StsCredentials shape is complete');
  assert.equal(ok.body.credentials.Expiration, '1970-01-01T00:00:00.000Z', 'already-expired -> robot cannot stream');
});

test('SetLevel (admin): AUTHORIZED_UNDER_ADMIN without admin identity; Command accepted with it', async () => {
  const noAdmin = await api('Log_20150309.SetLevel', { friendlyIds: ['r1'], namespaces: [{ namespace: 'l', level: 'debug' }] });
  assert.equal(noAdmin.status, 401);
  assert.equal(noAdmin.errType, 'AUTHORIZED_UNDER_ADMIN');

  const adminHeaders = { 'x-amz-credentials': JSON.stringify({ id: 'a1', friendlyId: 'f1', isAdmin: true }) };
  const ok = await api('Log_20150309.SetLevel', { friendlyIds: ['r1', 'r2'], namespaces: [{ namespace: 'jibo', level: 'debug' }] }, { headers: adminHeaders });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { result: 'Command accepted' });
});

test('SetLevel validation mirrors its Joi schema -> 422', async () => {
  const admin = { 'x-amz-credentials': JSON.stringify({ id: 'a', friendlyId: 'f', isAdmin: true }) };
  const call = (body) => api('Log_20150309.SetLevel', body, { headers: admin });
  assert.equal((await call({})).status, 422);
  assert.equal((await call({ friendlyIds: 'not-array', namespaces: [] })).status, 422);
  assert.equal((await call({ friendlyIds: [1], namespaces: [] })).status, 422, 'non-string friendlyId rejected');
  assert.equal((await call({ friendlyIds: [], namespaces: [{ namespace: 'x', level: 'loud' }] })).status, 422, 'level outside npm enum rejected');
  assert.equal((await call({ friendlyIds: [], namespaces: [{ namespace: 'x', level: 'info' }] })).status, 200);
});

test('unknown Log operation -> 404 NotFoundException (source Boom.notFound)', async () => {
  const r = await api('Log_20150309.PutFaceBinary', {});
  assert.equal(r.status, 404);
  assert.equal(r.errType, null, 'a Boom-shaped error carries no x-amzn-errortype header');
  assert.equal(r.body.error, 'Not Found');
  assert.equal(clientCode(r), 'Not Found', 'the pinned client sees the HTTP reason phrase as err.code');
  assert.match(r.body.message, /Method .*? not found\./);
});

test('retention: objects are never evicted; the sink keeps every event and every blob', async () => {
  // a blob written early is still readable after the whole preceding workload ran
  const before = readEvents().length;
  const r = await api('Log_20150309.PutAsrBinary', { trackingId: 'retention-1' });
  const b = Buffer.from('retained-bytes');
  await fetch(r.body.uploadUrl, { method: 'PUT', body: b });
  for (let i = 0; i < 5; i++) await api('Log_20150309.PutEvents', { events: [{ message: `fill-${i}` }] });
  const got = await fetch(`${base()}/log/blob?key=${encodeURIComponent(r.body.key)}`);
  assert.equal(got.status, 200);
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), b, 'no server-side eviction (source had none; S3 lifecycle owned it)');
  assert.ok(readEvents().length > before, 'event log keeps accumulating, never truncated');
});

// ---- A-12 defect regressions (verifier findings A12e / A12f / blob restart) ----

// A12e: the source's 422/404 failures were raw Boom payloads { statusCode, error, message }
// with NO error code, so the pinned client surfaced the HTTP reason phrase as err.code.
test('A12e 422: client-visible error code is the Boom reason phrase, not ValidationException', async () => {
  const r = await api('Log_20150309.PutEvents', {});
  assert.equal(r.status, 422);
  assert.equal(r.errType, null, 'no x-amzn-errortype header, like the source');
  assert.equal(r.body.__type, undefined, 'no __type member, like the source');
  assert.equal(r.body.code, undefined, 'no code member, like the source');
  assert.equal(r.body.statusCode, 422);
  assert.equal(r.body.error, 'Unprocessable Entity');
  assert.equal(clientCode(r), 'Unprocessable Entity', 'what the pinned client reads as err.code');
});

test('A12e 404: client-visible error code is the Boom reason phrase, not NotFoundException', async () => {
  const r = await api('Log_20150309.PutFaceBinary', {});
  assert.equal(r.status, 404);
  assert.equal(r.errType, null);
  assert.equal(r.body.__type, undefined);
  assert.equal(r.body.code, undefined);
  assert.equal(r.body.statusCode, 404);
  assert.equal(r.body.error, 'Not Found');
  assert.equal(clientCode(r), 'Not Found');
});

test('A12e: codified Log errors keep the AWS code envelope (429/403/401 unchanged)', async () => {
  const denied = await api('Log_20150309.NewKinesisCredentials');
  assert.equal(denied.status, 403);
  assert.equal(denied.errType, 'ROBOT_ONLY');
  assert.equal(clientCode(denied), 'ROBOT_ONLY');
  const noAdmin = await api('Log_20150309.SetLevel', { friendlyIds: [], namespaces: [] });
  assert.equal(noAdmin.status, 401);
  assert.equal(noAdmin.errType, 'AUTHORIZED_UNDER_ADMIN');
  assert.equal(clientCode(noAdmin), 'AUTHORIZED_UNDER_ADMIN');
});

// A12f: Joi's VerbosityLevel shape has NO required members, so `{}`, `{namespace}` and
// `{level}` are all valid upstream -> 200; present members are still type/enum checked.
test('A12f: SetLevel namespaces items have no required members (Joi VerbosityLevel)', async () => {
  const admin = { 'x-amz-credentials': JSON.stringify({ id: 'a', friendlyId: 'f', isAdmin: true }) };
  const call = (namespaces) => api('Log_20150309.SetLevel', { friendlyIds: [], namespaces }, { headers: admin });
  assert.equal((await call([{}])).status, 200, '[{}] is valid upstream');
  assert.equal((await call([{ namespace: 'x' }])).status, 200, '[{namespace}] is valid upstream');
  assert.equal((await call([{ level: 'info' }])).status, 200, '[{level}] is valid upstream');
  assert.equal((await call([{}, { namespace: 'x' }, { level: 'silly' }])).status, 200, 'mixed items valid');
  // present members are still validated
  assert.equal((await call([{ namespace: 7 }])).status, 422, 'namespace must be a string');
  assert.equal((await call([{ level: 'loud' }])).status, 422, 'level must be in the npm enum');
  assert.equal((await call(['nope'])).status, 422, 'items must be objects');
  assert.equal((await call([null])).status, 422, 'items must be objects');
});

// A12f: the source's FriendlyId is Joi.string(), which rejects the empty string.
test('A12f: SetLevel friendlyIds rejects the empty string like Joi.string()', async () => {
  const admin = { 'x-amz-credentials': JSON.stringify({ id: 'a', friendlyId: 'f', isAdmin: true }) };
  const r = await api('Log_20150309.SetLevel', { friendlyIds: [''], namespaces: [] }, { headers: admin });
  assert.equal(r.status, 422, 'Joi.string() rejects ""');
  assert.equal(clientCode(r), 'Unprocessable Entity');
  const ok = await api('Log_20150309.SetLevel', { friendlyIds: ['r1'], namespaces: [] }, { headers: admin });
  assert.equal(ok.status, 200, 'a non-empty friendlyId still passes');
});

// Defect 3: the store indexes in memory, so a fresh process 404s on a key whose object file
// is still on disk. The file is the source of truth; the index must be rebuilt from it.
test('defect 3: GET /log/blob survives a process restart (index rebuilt from the object file)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-log-restart-'));
  const prev = process.env.ETCO_classic_logDir;
  process.env.ETCO_classic_logDir = dir;
  const key = 'log-binary/acct-1/trk-restart/blob-1';
  const bytes = Buffer.from('survives-a-restart-\x00\x01\xff', 'binary');
  let first; let firstSvc;
  try {
    firstSvc = createClassicEntrypoint();
    first = await firstSvc.listen(0);
    const p = first.address().port;
    const put = await fetch(`http://localhost:${p}/log/upload?key=${encodeURIComponent(key)}`, { method: 'PUT', body: bytes });
    assert.equal(put.status, 200);
    const before = await fetch(`http://localhost:${p}/log/blob?key=${encodeURIComponent(key)}`);
    assert.equal(before.status, 200, 'retrievable in the process that accepted the PUT');
    assert.deepEqual(Buffer.from(await before.arrayBuffer()), bytes);
  } finally {
    first?.close();
  }
  let second; let secondSvc;
  try {
    // A restart: brand-new process, brand-new LogStore, same on-disk directory.
    secondSvc = createClassicEntrypoint();
    second = await secondSvc.listen(0);
    assert.equal(secondSvc.logStore.index.size, 0, 'a restarted process starts with an empty in-memory index');
    const p = second.address().port;
    const after = await fetch(`http://localhost:${p}/log/blob?key=${encodeURIComponent(key)}`);
    assert.equal(after.status, 200, 'the object file is still on disk, so the index is rebuilt from it');
    assert.deepEqual(Buffer.from(await after.arrayBuffer()), bytes, 'bytes survive the restart');
  } finally {
    second?.close();
    if (prev === undefined) delete process.env.ETCO_classic_logDir;
    else process.env.ETCO_classic_logDir = prev;
  }
});

// ---- aliases to keep the file compact --------------------------------------
function api(target, body, opts) { return amz(target, body, opts); }