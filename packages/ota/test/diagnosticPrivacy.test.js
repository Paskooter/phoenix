// Synthetic-only, real loopback HTTP/logger controls. Qualify complete OTA
// diagnostic records, not the unchanged shared request/error/voice-span sinks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs';
import { mkdtemp, writeFile, truncate, unlink, rm } from 'node:fs/promises';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { setImmediate, setTimeout as delay } from 'node:timers/promises';
import { recentLogs } from '@phoenix/common';
import { Catalog } from '../src/catalog.js';
import { createOtaService } from '../src/service.js';

const HOST = 'ota-privacy.example.test';
const KEY = 'synthetic-privacy-package-key';
const PEER = 'synthetic-privacy-peer-key';
const NOW = 1_800_000_000_000;
const ID = 'os-13.2.0-fcs';
const PAYLOAD = Buffer.from('synthetic privacy fixture package bytes');
const CALLER = {
  id: 'synthetic-privacy-account', friendlyId: 'Synthetic-Privacy-Robot', email: 'synthetic-privacy-owner@example.test',
};
const QUERY = { fromVersion: '13.1.0', subsystem: 'os', filter: 'fcs' };
const MESSAGES = new Set(['update query', 'ota package download', 'ota package stream interrupted']);
const REF = createHmac('sha256', createHmac('sha256', KEY).update('phoenix-ota-robot-ref-v1').digest())
  .update(`robot\n${CALLER.friendlyId}`).digest('hex').slice(0, 12);

function expectedUrl() {
  const expires = NOW + 24 * 60 * 60 * 1000;
  const signature = createHmac('sha256', KEY).update(['phoenix-ota-v1', 'GET', ID, String(expires)].join('\n')).digest('hex');
  const trace = createHmac('sha256', KEY).update(['phoenix-ota-log-trace-v1', signature, REF].join('\n')).digest('hex');
  return new URL(`https://${HOST}/ota/package?id=${ID}&expires=${expires}&signature=${signature}&trace=${REF}.${trace}`);
}

function correlationHeaders(profile, url) {
  // All identifiers are invented. Even syntactically valid UUIDs must not be
  // copied into these diagnostics; format validation is not anonymization.
  const values = {
    identifying: ['SYNTHETIC-PRIVATE-SERIAL-IN-TRANSID', 'synthetic-utterance-owner@example.test', 'Synthetic-Private-Correlation-Robot'],
    credentials: [url.href, 'Bearer synthetic-utterance-credential', 'AWS4-HMAC-SHA256 Credential=synthetic-correlation-credential'],
    UUID: ['11111111-2222-4333-8444-555555555555', '22222222-3333-4444-8555-666666666666', '33333333-4444-4555-8666-777777777777'],
  }[profile];
  return {
    'x-jibo-transid': values[0],
    'x-jibo-utteranceid': values[1],
    'x-correlation-id': values[2],
    'x-request-id': 'synthetic-request-private-identifier',
    'x-jibo-robotid': 'synthetic-header-private-robot',
    'x-phoenix-turn-id': '44444444-5555-4666-8777-888888888888',
    'x-jibo-logging-config': '{"ota":"debug"}',
  };
}

async function fixture(t, { large = false } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ota-diagnostic-privacy-'));
  const file = path.join(dir, 'synthetic-private-file-name.tar');
  await writeFile(file, PAYLOAD);
  if (large) await truncate(file, 16 * 1024 * 1024);
  const catalog = await Catalog.load({ dataDir: dir, log: {}, entries: [{
    id: ID, subsystem: 'os', fromVersion: '*', toVersion: '13.2.0', filter: 'fcs',
    changes: 'synthetic fixture release', dependencies: { services: '13.1.0' }, file: path.basename(file),
  }] });
  const service = createOtaService({
    catalog, publicBaseUrl: `https://${HOST}`, packageBearerSecret: KEY,
    requireAuth: true, resolveCredentials: () => null, internalPeerToken: PEER, now: () => NOW,
  });
  const agent = new http.Agent({ keepAlive: true });
  t.after(async () => {
    agent.destroy();
    service.server.closeAllConnections();
    await new Promise(resolve => service.server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const server = await service.listen(0, '127.0.0.1');
  return { server, agent, dir, file, length: catalog.entries[0].length };
}

function request(f, pathname, { method = 'GET', body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: f.server.address().port, method, path: pathname,
      headers: { host: HOST, ...headers }, agent: f.agent,
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function issue(f, op = 'GetUpdateFrom', headers = {}) {
  const response = await request(f, '/', {
    method: 'POST', headers: {
      'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `Update_20160301.${op}`,
      'x-phoenix-ota-peer-token': PEER, 'x-phoenix-verified-account': JSON.stringify(CALLER), ...headers,
    }, body: JSON.stringify(QUERY),
  });
  assert.equal(response.status, 200);
  const update = {
    _id: ID, created: 0, accountId: 'phoenix-ota', fromVersion: QUERY.fromVersion, toVersion: '13.2.0',
    changes: 'synthetic fixture release', url: expectedUrl().href,
    shaHash: createHash('sha1').update(PAYLOAD).digest('hex'), length: PAYLOAD.length,
    subsystem: 'os', filter: 'fcs', dependencies: { services: '13.1.0' },
  };
  const metadata = JSON.parse(response.body);
  // Large interrupted fixtures have a different real file digest/length. The
  // URL/bearer/trace must still be exactly the independently computed values.
  if (f.length === PAYLOAD.length) assert.deepEqual(metadata, op === 'GetUpdateFrom' ? update : [update]);
  else assert.equal(metadata.url, update.url);
  return new URL(op === 'GetUpdateFrom' ? metadata.url : metadata[0].url);
}

async function download(f, url, headers) {
  const response = await request(f, url.pathname + url.search, { headers });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, PAYLOAD, 'valid bearer and signed metadata preserve exact package bytes');
  const { date, ...wireHeaders } = response.headers;
  assert.ok(Number.isFinite(Date.parse(date)));
  assert.deepEqual(wireHeaders, {
    'x-powered-by': 'Express', 'content-type': 'application/octet-stream',
    'content-length': String(PAYLOAD.length), 'cache-control': 'private, no-store',
    connection: 'keep-alive', 'keep-alive': 'timeout=5',
  });
}

function interrupt(f, url, headers = {}, abortClient = false) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const req = http.get({
      hostname: '127.0.0.1', port: f.server.address().port, path: url.pathname + url.search,
      headers: { host: HOST, ...headers }, agent: false,
    }, res => {
      res.on('data', chunk => {
        bytes += chunk.length;
        if (abortClient) { res.destroy(); resolve({ status: res.statusCode, bytes }); }
      });
      res.on('error', () => resolve({ status: res.statusCode, bytes }));
      res.on('end', () => reject(new Error('fixture unexpectedly completed an interrupted download')));
    });
    req.on('error', error => abortClient ? reject(error) : resolve({ bytes }));
  });
}

async function capture(t, msg, action) {
  const { cursor } = recentLogs();
  const output = { stdout: [], stderr: [] };
  const mocks = Object.entries(output).map(([name, chunks]) =>
    t.mock.method(process[name], 'write', chunk => { chunks.push(String(chunk)); return true; }));
  let result;
  try {
    result = await action();
    for (let i = 0; i < 200 && !recentLogs({ since: cursor, ns: 'ota' }).events.some(line => line.msg === msg); i++) await delay(5);
    // Finish pipeline cleanup before restoring sinks or starting the next case.
    await setImmediate();
  } finally { for (const mock of mocks) mock.mock.restore(); }
  const records = Object.fromEntries(Object.entries(output).map(([name, chunks]) => [name,
    chunks.join('').split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(line => MESSAGES.has(line.msg)),
  ]));
  return { result, ...records, ring: recentLogs({ since: cursor, ns: 'ota', limit: 1000 }).events.filter(line => MESSAGES.has(line.msg)) };
}

function assertRecords(captured, msg, fields, unsafe = []) {
  const level = msg === 'ota package stream interrupted' ? 'warn' : 'info';
  const sink = level === 'warn' ? 'stderr' : 'stdout';
  assert.equal(captured[sink].length, 1, `one complete ${sink} diagnostic`);
  assert.equal(captured[sink === 'stdout' ? 'stderr' : 'stdout'].length, 0, 'no duplicate diagnostic at the other sink');
  assert.equal(captured.ring.length, 1, 'one complete recentLogs record');
  const record = captured[sink][0];
  assert.ok(Number.isFinite(Date.parse(record.t)));
  assert.deepEqual(record, { t: record.t, level, ns: 'ota', msg, ...fields }, 'complete diagnostic field set has no inherited request context');
  const { seq, ...buffered } = captured.ring[0];
  assert.ok(Number.isSafeInteger(seq) && seq > 0);
  assert.deepEqual(buffered, record, 'recentLogs contains exactly the emitted diagnostic plus its sequence');
  const raw = JSON.stringify([record, captured.ring[0]]);
  const url = expectedUrl();
  for (const value of [KEY, PEER, ...Object.values(CALLER), url.href,
    url.searchParams.get('signature'), url.searchParams.get('trace'), ...unsafe]) {
    assert.equal(raw.includes(value), false, 'no synthetic identifying text, correlation ID, credential, path or error message');
  }
}

for (const profile of ['identifying', 'credentials', 'UUID']) {
  for (const op of ['ListUpdates', 'ListUpdatesFrom', 'GetUpdateFrom']) {
    test(`${op} diagnostic excludes ${profile} correlation headers from stdout and recentLogs`, async t => {
      const f = await fixture(t);
      const headers = correlationHeaders(profile, expectedUrl());
      const captured = await capture(t, 'update query', () => issue(f, op, headers));
      assertRecords(captured, 'update query', {
        op, robotRef: REF, ...QUERY, returned: 1, available: 1,
      }, Object.values(headers));
    });
  }

  test(`completed download diagnostic excludes ${profile} correlation headers from stdout and recentLogs`, async t => {
    const f = await fixture(t);
    const url = await issue(f);
    const headers = correlationHeaders(profile, url);
    const captured = await capture(t, 'ota package download', () => download(f, url, headers));
    assertRecords(captured, 'ota package download', { id: ID, robotRef: REF, bytes: PAYLOAD.length, durationMs: 0 }, Object.values(headers));
  });

  test(`real interrupted download diagnostic excludes ${profile} correlation headers from stderr and recentLogs`, async t => {
    const f = await fixture(t, { large: true });
    const url = await issue(f);
    const headers = correlationHeaders(profile, url);
    const captured = await capture(t, 'ota package stream interrupted', () => interrupt(f, url, headers, true));
    assert.equal(captured.result.status, 200);
    assert.ok(captured.result.bytes > 0 && captured.result.bytes < f.length, 'real client abort after some but not all file bytes');
    assertRecords(captured, 'ota package stream interrupted', { id: ID, robotRef: REF, error: 'ERR_STREAM_PREMATURE_CLOSE' }, Object.values(headers));
  });
}

test('interrupted file-open diagnostic excludes the real private path and reports only ENOENT', async t => {
  const f = await fixture(t);
  const url = await issue(f);
  await unlink(f.file);
  const captured = await capture(t, 'ota package stream interrupted', () => interrupt(f, url));
  assert.equal(captured.result.bytes, 0);
  assertRecords(captured, 'ota package stream interrupted', { id: ID, robotRef: REF, error: 'ENOENT' }, [f.dir, path.basename(f.file)]);
});

for (const code of ['ERR_STREAM_PREMATURE_CLOSE', 'ECONNRESET', 'EPIPE', 'ENOENT', 'EACCES', 'EIO', 'EISDIR', 'SYNTHETIC-PRIVATE-ERROR-CODE', undefined]) {
  const known = code !== undefined && code !== 'SYNTHETIC-PRIVATE-ERROR-CODE';
  test(`interrupted read diagnostic projects ${code ?? 'missing code'} without arbitrary error text`, async t => {
    const f = await fixture(t);
    const url = await issue(f);
    const privateMessage = `synthetic private read failure at ${f.file}; Bearer synthetic-read-credential`;
    const error = Object.assign(new Error(privateMessage), { ...(code ? { code } : {}) });
    const original = fs.createReadStream;
    // Inject at the file-I/O boundary; the actual ReadStream, pipeline, HTTP
    // handler and both logger sinks still process the failure themselves.
    const mock = t.mock.method(fs, 'createReadStream', (file, options) => original(file, { ...options, fs: {
      open: fs.open, close: fs.close,
      read(_fd, ...args) { const callback = args.pop(); process.nextTick(callback, error); },
    } }));
    syncBuiltinESMExports();
    let captured;
    try { captured = await capture(t, 'ota package stream interrupted', () => interrupt(f, url)); }
    finally { mock.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(captured.result.bytes, 0);
    assertRecords(captured, 'ota package stream interrupted', {
      id: ID, robotRef: REF, error: known ? code : 'STREAM_ERROR',
    }, [privateMessage, f.dir, path.basename(f.file), 'synthetic-read-credential', ...(known || !code ? [] : [code])]);
  });
}
