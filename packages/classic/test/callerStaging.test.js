import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fsPromises, { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { request as httpRequest } from 'node:http';
import * as common from '@phoenix/common';
import { normalizeHeaders, signSigV4 } from '@phoenix/common';
import { createClassicEntrypoint, MediaStore } from '../src/index.js';
import { createClassicRouter } from '../src/router.js';
import { cleanupVerifiedClassicRequest, createVerifiedClassicCaller } from '../src/caller.js';

const NOW = new Date('2026-10-01T12:00:00Z');
const ACCOUNT = { id: 'staging-account', accessKeyId: 'staging-key', secretAccessKey: 'staging-secret', isActive: true };
const BYTES = Buffer.from('signed upload bytes');
const creations = new Map();
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function headersFor(bytes = BYTES, extra = {}, account = ACCOUNT) {
  return normalizeHeaders(signSigV4({
    headers: { host: 'upload.fixture.test', 'content-length': String(bytes.length),
      'x-amz-target': 'Key_20160201.ShareBinary', 'x-amz-content-sha256': digest(bytes), ...extra },
    body: bytes, accessKeyId: account.accessKeyId, secretAccessKey: account.secretAccessKey,
    region: 'us-east-1', service: 'jibo', date: NOW,
  }).headers);
}

function request(headers, bytes = BYTES) {
  let reads = 0;
  const req = new Readable({ read() { reads++; this.push(bytes); this.push(null); } });
  Object.assign(req, { method: 'POST', url: '/', headers });
  return { req, reads: () => reads };
}

async function scratch(t) {
  const old = process.env.TMPDIR;
  const root = await mkdtemp(join(tmpdir(), 'phoenix-caller-staging-test-'));
  process.env.TMPDIR = root;
  creations.set(root, 0);
  const original = fsPromises.mkdtemp;
  const spy = t.mock.method(fsPromises, 'mkdtemp', async (...args) => {
    creations.set(root, creations.get(root) + 1);
    return original(...args);
  });
  syncBuiltinESMExports();
  t.after(async () => {
    spy.mock.restore();
    syncBuiltinESMExports();
    creations.delete(root);
    if (old === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = old;
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

const rejectedHeaders = [
  ['missing authorization', (h) => { delete h.authorization; }, 'MISSING_AUTH_HEADER'],
  ['unknown access key', (h) => { h.authorization = h.authorization.replace('staging-key/', 'unrecognized-key/'); }, 'ACCESS_KEY_NOT_FOUND'],
  ['missing date', (h) => { delete h['x-amz-date']; }, 'MISSING_DATE_HEADER'],
  ['stale date', (h) => { h['x-amz-date'] = '20200101T000000Z'; }, 'CLOCK_SKEW_TOO_LONG'],
  ['malformed authorization', (h) => { h.authorization = 'not-a-signer'; }, 'MISSING_ENCRYPTION_ALGORITHM'],
  ['different credential date', (h) => { h.authorization = h.authorization.replace('/20261001/', '/20260930/'); }, 'SIGNATURE_MISMATCH'],
  ['changed signed header', (h) => { h.host = 'different.fixture.test'; }, 'SIGNATURE_MISMATCH'],
];
for (const [name, mutate, code] of rejectedHeaders) {
  test(`raw caller preflight rejects ${name} before staging`, async (t) => {
    const root = await scratch(t);
    const headers = headersFor();
    mutate(headers);
    const input = request(headers);
    const boundary = createVerifiedClassicCaller({ now: NOW,
      resolveCredentials: (key) => key === ACCOUNT.accessKeyId ? ACCOUNT : null });
    try {
      await assert.rejects(boundary({ req: input.req }), { code });
      assert.deepEqual({ reads: input.reads(), files: await readdir(root), creations: creations.get(root) }, { reads: 0, files: [], creations: 0 });
    } finally { await cleanupVerifiedClassicRequest(input.req); }
  });
}

for (const [name, account, code] of [
  ['inactive account', { ...ACCOUNT, isActive: false }, 'ACCOUNT_NOT_ACTIVE'],
  ['deleted account', { ...ACCOUNT, isDeleted: true }, 'ACCESS_KEY_NOT_FOUND'],
]) {
  test(`raw caller preflight rejects ${name} before staging`, async (t) => {
    const root = await scratch(t);
    const input = request(headersFor());
    const boundary = createVerifiedClassicCaller({ now: NOW, resolveCredentials: () => account });
    try {
      await assert.rejects(boundary({ req: input.req }), { code });
      assert.deepEqual({ reads: input.reads(), files: await readdir(root), creations: creations.get(root) }, { reads: 0, files: [], creations: 0 });
    } finally { await cleanupVerifiedClassicRequest(input.req); }
  });
}

test('raw caller removes staging when the received digest differs', async (t) => {
  const root = await scratch(t);
  const input = request(headersFor(), Buffer.from('different payload'));
  const boundary = boundaryFor(budgetFor({ maxUploads: 1, maxBytes: 1024 }));
  try {
    await assert.rejects(boundary({ req: input.req }), { code: 'SIGNATURE_MISMATCH' });
    assert.ok(input.reads() > 0);
    assert.deepEqual(await readdir(root), []);
    const next = request(headersFor(BYTES, { 'x-id': 'after-digest' }));
    await boundary({ req: next.req });
    await cleanupVerifiedClassicRequest(next.req);
  } finally { await cleanupVerifiedClassicRequest(input.req); }
});

function budgetFor(options) {
  return common.createUploadStagingBudget?.(options) || {};
}
function boundaryFor(stagingBudget, extra = {}) {
  return createVerifiedClassicCaller({ now: NOW, resolveCredentials: () => ACCOUNT, stagingBudget, ...extra });
}

function heldRequest(headers = headersFor()) {
  let started;
  const reading = new Promise((resolve) => { started = resolve; });
  const req = new Readable({ read() { started(); } });
  Object.assign(req, { method: 'POST', url: '/', headers });
  return { req, reading };
}

test('raw caller shares concurrent staging admission across boundaries and recovers after dispatch', async (t) => {
  const root = await scratch(t);
  const budget = budgetFor({ maxUploads: 1, maxBytes: 1024 });
  const first = heldRequest();
  const firstBoundary = boundaryFor(budget);
  const secondBoundary = boundaryFor(budget);
  const pending = firstBoundary({ req: first.req });
  const next = request(headersFor(BYTES, { 'x-id': 'next' }));
  try {
    await first.reading;
    assert.equal((await readdir(root)).length, 1);
    await assert.rejects(secondBoundary({ req: next.req }), { code: 'REQUEST_THROTTLED', statusCode: 503 });
    assert.equal(next.reads(), 0);
    assert.equal((await readdir(root)).length, 1);
    first.req.push(BYTES);
    first.req.push(null);
    await pending;
    await assert.rejects(secondBoundary({ req: next.req }), { code: 'REQUEST_THROTTLED' });
    await cleanupVerifiedClassicRequest(first.req);
    await secondBoundary({ req: next.req });
    await cleanupVerifiedClassicRequest(next.req);
    assert.deepEqual(await readdir(root), []);
  } finally {
    first.req.destroy(new Error('fixture finished'));
    await pending.catch(() => {});
    await cleanupVerifiedClassicRequest(first.req);
    await cleanupVerifiedClassicRequest(next.req);
  }
});

test('raw caller releases partial staging on client abort', async (t) => {
  const root = await scratch(t);
  const budget = budgetFor({ maxUploads: 1, maxBytes: BYTES.length });
  const boundary = boundaryFor(budget);
  const first = heldRequest(headersFor(BYTES, { 'content-length': undefined, 'transfer-encoding': 'chunked' }));
  const pending = boundary({ req: first.req });
  // Attach the rejection handler before intentionally ending the transport.
  const rejected = assert.rejects(pending, /fixture client abort/);
  await first.reading;
  const chunkRead = new Promise((resolve) => first.req.once('data', resolve));
  first.req.push(BYTES.subarray(0, 4));
  await chunkRead;
  first.req.destroy(new Error('fixture client abort'));
  await rejected;
  assert.deepEqual(await readdir(root), []);
  const next = request(headersFor(BYTES, { 'x-id': 'after-abort' }));
  await boundary({ req: next.req });
  await cleanupVerifiedClassicRequest(next.req);
  assert.deepEqual(await readdir(root), []);
});

test('raw caller bounds aggregate bytes for declared and chunked entities', async (t) => {
  const root = await scratch(t);
  const budget = budgetFor({ maxUploads: 4, maxBytes: BYTES.length + 1 });
  const first = request(headersFor());
  const boundary = boundaryFor(budget);
  const known = request(headersFor(BYTES, { 'x-id': 'known' }));
  const chunked = request(headersFor(BYTES, { 'content-length': undefined, 'transfer-encoding': 'chunked', 'x-id': 'chunked' }));
  try {
    await boundary({ req: first.req });
    await assert.rejects(boundary({ req: known.req }), { code: 'REQUEST_THROTTLED', statusCode: 503 });
    assert.equal(known.reads(), 0);
    await assert.rejects(boundary({ req: chunked.req }), { code: 'REQUEST_THROTTLED', statusCode: 503 });
    assert.ok(chunked.reads() > 0);
    assert.equal((await readdir(root)).length, 1);
    await cleanupVerifiedClassicRequest(first.req);
    const retry = request(headersFor(BYTES, { 'x-id': 'after-budget' }));
    await boundary({ req: retry.req });
    await cleanupVerifiedClassicRequest(retry.req);
    assert.deepEqual(await readdir(root), []);
  } finally {
    for (const req of [first.req, known.req, chunked.req]) await cleanupVerifiedClassicRequest(req);
  }
});

test('raw caller keeps the process-wide default staging admission bounded', async (t) => {
  const root = await scratch(t);
  const inputs = [];
  const maximum = common.DEFAULT_UPLOAD_STAGING_MAX_UPLOADS ?? 4;
  try {
    for (let i = 0; i < maximum; i++) {
      const input = request(headersFor(BYTES, { 'x-id': `default-${i}` }));
      inputs.push(input);
      await boundaryFor(undefined)({ req: input.req });
    }
    const next = request(headersFor(BYTES, { 'x-id': 'default-next' }));
    inputs.push(next);
    await assert.rejects(boundaryFor(undefined)({ req: next.req }), { code: 'REQUEST_THROTTLED', statusCode: 503 });
    assert.equal(next.reads(), 0);
    assert.equal((await readdir(root)).length, maximum);
  } finally {
    for (const input of inputs) await cleanupVerifiedClassicRequest(input.req);
  }
});

test('raw caller removes staged bytes when final replay verification refuses dispatch', async (t) => {
  const root = await scratch(t);
  const boundary = boundaryFor(budgetFor({ maxUploads: 1, maxBytes: 1024 }));
  const first = request(headersFor());
  await boundary({ req: first.req });
  await cleanupVerifiedClassicRequest(first.req);
  const repeated = request(headersFor());
  try {
    await assert.rejects(boundary({ req: repeated.req }), { code: 'SIGNATURE_REPLAYED' });
    assert.ok(repeated.reads() > 0);
    assert.deepEqual(await readdir(root), []);
    const next = request(headersFor(BYTES, { 'x-id': 'after-replay' }));
    await boundary({ req: next.req });
    await cleanupVerifiedClassicRequest(next.req);
  } finally { await cleanupVerifiedClassicRequest(repeated.req); }
});

test('raw caller returns a throttle response for a chunked entity crossing the staging byte budget', async (t) => {
  const root = await scratch(t);
  const budget = budgetFor({ maxUploads: 2, maxBytes: 5 });
  const routes = createClassicRouter([{ match: /^Key/, handler: () => assert.fail('request must remain outside dispatch') }],
    { callerBoundary: boundaryFor(budget) });
  const server = await common.createService({ name: 'classic-staging-fixture', routes }).listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const result = await new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: server.address().port, method: 'POST', path: '/',
      headers: headersFor(BYTES, { 'content-length': undefined, 'transfer-encoding': 'chunked' }) }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(BYTES);
  });
  assert.equal(result.status, 503);
  assert.equal(result.body.__type, 'REQUEST_THROTTLED');
  assert.deepEqual(await readdir(root), []);
});

test('signed two MiB streamed media is published byte-for-byte with supported payload hash forms', async (t) => {
  const root = await scratch(t);
  const store = new MediaStore({ directory: join(root, 'objects'), file: join(root, 'media.json') });
  const svc = createClassicEntrypoint({ publicUrl: 'https://upload.fixture.test', callerBoundary: boundaryFor(undefined),
    media: { store, loops: { members: () => [ACCOUNT.id], accountLoops: () => ['staging-loop'], ownedLoops: () => [] } } });
  const server = await svc.listen(0);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const bytes = Buffer.alloc(2 * 1024 * 1024, 0xa7);
  for (const payloadHash of [digest(bytes), 'UNSIGNED-PAYLOAD', undefined]) {
    const path = `photo-${payloadHash || 'body-hash'}`;
    const headers = headersFor(bytes, { 'x-amz-target': 'Media_20160725.Create', 'x-amz-content-sha256': payloadHash,
      'content-length': undefined, 'transfer-encoding': 'chunked', 'x-loop-id': 'staging-loop', 'x-path': path,
      'x-type': 'image', 'x-encrypted': 'true' });
    const result = await new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port: server.address().port, method: 'POST', path: '/', headers }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
        res.on('error', reject);
      });
      req.on('error', reject);
      for (let start = 0; start < bytes.length; start += 64 * 1024) req.write(bytes.subarray(start, start + 64 * 1024));
      req.end();
    });
    assert.equal(result.status, 200, result.body);
    assert.deepEqual(await readFile(store.objectFile(path)), bytes);
  }
  assert.deepEqual((await readdir(root)).filter((name) => name.startsWith('phoenix-classic-auth-')), []);
});
