import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as common from '@phoenix/common';
import { Catalog } from '../src/catalog.js';
import { createOtaService } from '../src/service.js';

const NOW = new Date('2026-10-01T12:00:00Z');
const ACCOUNT = { id: 'ota-upload-admin', accessKeyId: 'ota-upload-key', secretAccessKey: 'ota-upload-secret', isActive: true, isAdmin: true };
const BYTES = Buffer.from('update-package-fixture');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
function headersFor(bytes = BYTES, extra = {}) {
  return common.normalizeHeaders(common.signSigV4({
    headers: { host: 'ota-upload.fixture.test', 'content-type': 'application/octet-stream',
      'content-length': String(bytes.length), 'x-amz-target': 'Update_20160301.CreateUpdate',
      'x-amz-content-sha256': digest(bytes), 'x-update-from-version': '*', 'x-update-to-version': '1.2.3',
      'x-update-changes': 'fixture', ...extra }, body: bytes,
    accessKeyId: ACCOUNT.accessKeyId, secretAccessKey: ACCOUNT.secretAccessKey,
    region: 'us-east-1', service: 'jibo', date: NOW,
  }).headers);
}
async function fixture(t, extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'phoenix-ota-upload-test-'));
  const catalog = await Catalog.load({ entries: [], dataDir: directory, log: {} });
  const reads = [];
  let notifyRead;
  const reading = new Promise((resolve) => { notifyRead = resolve; });
  const svc = createOtaService({ catalog, publicBaseUrl: 'https://ota-upload.fixture.test',
    packageBearerSecret: 'fixture-package-secret', now: NOW,
    resolveCredentials: (key) => key === ACCOUNT.accessKeyId ? ACCOUNT : null, ...extra });
  svc.server.prependListener('request', (req, res) => {
    const state = { calls: 0, bodyReads: 0, atResponse: null };
    reads.push(state);
    const read = req.read;
    req.read = function (...args) { state.bodyReads++; return read.apply(this, args); };
    const iterator = req[Symbol.asyncIterator];
    req[Symbol.asyncIterator] = function () { state.calls++; notifyRead(); return iterator.call(this); };
    const writeHead = res.writeHead;
    res.writeHead = function (...args) { state.atResponse = state.bodyReads; return writeHead.apply(this, args); };
  });
  const server = await svc.listen(0, '127.0.0.1');
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, catalog, reads, reading, port: server.address().port };
}
function post(port, headers, bytes = BYTES) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method: 'POST', path: '/', headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(bytes);
  });
}

for (const [name, mutate, code, status] of [
  ['missing authorization', (h) => { delete h.authorization; }, 'MISSING_AUTH_HEADER', 401],
  ['unknown access key', (h) => { h.authorization = h.authorization.replace('ota-upload-key/', 'unrecognized-key/'); }, 'ACCESS_KEY_NOT_FOUND', 401],
  ['missing date', (h) => { delete h['x-amz-date']; }, 'MISSING_DATE_HEADER', 401],
  ['stale date', (h) => { h['x-amz-date'] = '20200101T000000Z'; }, 'CLOCK_SKEW_TOO_LONG', 401],
  ['malformed authorization', (h) => { h.authorization = 'not-a-signer'; }, 'MISSING_ENCRYPTION_ALGORITHM', 401],
  ['different credential date', (h) => { h.authorization = h.authorization.replace('/20261001/', '/20260930/'); }, 'SIGNATURE_MISMATCH', 401],
  ['changed signed header', (h) => { h['x-update-changes'] = 'different'; }, 'SIGNATURE_MISMATCH', 401],
  ['different host', (h) => { h.host = 'different.fixture.test'; }, 'SIGNATURE_MISMATCH', 401],
]) {
  test(`OTA raw preflight rejects ${name} before reading`, async (t) => {
    const f = await fixture(t);
    const headers = headersFor();
    mutate(headers);
    const result = await post(f.port, headers);
    assert.equal(result.status, status);
    assert.equal(result.body.__type, code);
    assert.equal(f.reads[0].atResponse, 0);
    assert.equal(f.catalog.entries.length, 0);
  });
}
for (const [name, account, code, status] of [
  ['inactive account', { ...ACCOUNT, isActive: false }, 'ACCOUNT_NOT_ACTIVE', 403],
  ['deleted account', { ...ACCOUNT, isDeleted: true }, 'ACCESS_KEY_NOT_FOUND', 401],
]) {
  test(`OTA raw preflight rejects ${name} before reading`, async (t) => {
    const f = await fixture(t, { resolveCredentials: () => account });
    const result = await post(f.port, headersFor());
    assert.equal(result.status, status);
    assert.equal(result.body.__type, code);
    assert.equal(f.reads[0].atResponse, 0);
  });
}

test('OTA raw upload checks received digest and accepts a subsequent signed package', async (t) => {
  const f = await fixture(t, { stagingBudget: common.createUploadStagingBudget?.({ maxUploads: 1, maxBytes: 4 * 1024 * 1024 }) });
  const bytes = Buffer.alloc(2 * 1024 * 1024, 0xa7);
  const mismatch = await post(f.port, headersFor(bytes), Buffer.alloc(bytes.length, 0xa8));
  assert.equal(mismatch.status, 401);
  assert.equal(mismatch.body.__type, 'SIGNATURE_MISMATCH');
  assert.ok(f.reads[0].atResponse > 0);
  assert.equal(f.catalog.entries.length, 0);
  const success = await post(f.port, headersFor(bytes, { 'x-update-changes': 'accepted' }), bytes);
  assert.equal(success.status, 200);
  assert.deepEqual(await readFile(f.catalog.entries[0]._file), bytes);
});

test('OTA raw upload reserves staging admission before reading and releases it after abort', async (t) => {
  const stagingBudget = common.createUploadStagingBudget?.({ maxUploads: 1, maxBytes: 1024 });
  let notifyReleased;
  const released = new Promise((resolve) => { notifyReleased = resolve; });
  if (stagingBudget) {
    const acquire = stagingBudget.acquire;
    stagingBudget.acquire = (bytes) => {
      const lease = acquire(bytes);
      const release = lease.release;
      lease.release = () => { release(); notifyReleased(); };
      return lease;
    };
  }
  const f = await fixture(t, { stagingBudget });
  // Gate the body reader without relying on a timer or client socket backpressure.
  const svcRequest = http.request({ hostname: '127.0.0.1', port: f.port, method: 'POST', path: '/', headers: headersFor() });
  const clientClosed = new Promise((resolve) => svcRequest.on('error', resolve));
  svcRequest.flushHeaders();
  try {
    await f.reading;
    const result = await post(f.port, headersFor(BYTES, { 'x-update-to-version': '1.2.4' }));
    assert.equal(result.status, 503);
    assert.equal(result.body.__type, 'REQUEST_THROTTLED');
    assert.equal(f.reads[1].atResponse, 0);
    svcRequest.destroy(new Error('fixture client abort'));
    await clientClosed;
    await released;
    const next = await post(f.port, headersFor(BYTES, { 'x-update-to-version': '1.2.5' }));
    assert.equal(next.status, 200);
  } finally { svcRequest.destroy(new Error('fixture finished')); }
});

test('OTA raw upload accepts the authenticated Classic loopback peer and checks its token before reading', async (t) => {
  const f = await fixture(t, { internalPeerToken: 'fixture-classic-peer-token' });
  const headers = headersFor(BYTES, {
    'x-phoenix-ota-peer-token': 'fixture-classic-peer-token',
    'x-phoenix-verified-account': JSON.stringify({ id: ACCOUNT.id, isAdmin: true }),
  });
  delete headers.authorization;
  const invalid = await post(f.port, { ...headers, 'x-phoenix-ota-peer-token': 'different-token' });
  assert.equal(invalid.status, 401);
  assert.equal(invalid.body.__type, 'MISSING_AUTH_HEADER');
  assert.equal(f.reads[0].atResponse, 0);
  const valid = await post(f.port, headers);
  assert.equal(valid.status, 200);
  assert.deepEqual(await readFile(f.catalog.entries[0]._file), BYTES);
});
