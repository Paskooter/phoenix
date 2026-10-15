import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as sigv4 from '../src/sigv4.js';
import * as staging from '../src/index.js';

const NOW = new Date('2026-10-01T12:00:00Z');
const ACCOUNT = { id: 'preflight-account', accessKeyId: 'preflight-key', secretAccessKey: 'preflight-secret', isActive: true };
const BODY = Buffer.from('streamed payload');
const HASH = createHash('sha256').update(BODY).digest('hex');
function signed(extra = {}) {
  return sigv4.signSigV4({ headers: { host: 'fixture.test', 'x-amz-target': 'Key_20160201.ShareBinary',
    'x-amz-content-sha256': HASH, ...extra }, body: BODY, ...ACCOUNT, region: 'api-dev', service: '', date: NOW }).headers;
}
function options(headers) {
  return { headers, now: NOW, resolveCredentials: (key) => key === ACCOUNT.accessKeyId ? ACCOUNT : null };
}

test('SigV4 preflight inspects only headers and returns no caller identity', () => {
  const input = options(signed());
  Object.defineProperties(input, {
    body: { get() { assert.fail('preflight must not inspect body'); } },
    bodyDigest: { get() { assert.fail('preflight must not inspect body digest'); } },
  });
  assert.equal(sigv4.preflightSigV4(input), undefined);
});

test('SigV4 preflight retains body-dependent verification for a signer without an explicit hash', () => {
  const headers = signed({ 'x-amz-content-sha256': undefined });
  sigv4.preflightSigV4(options(headers));
  assert.equal(sigv4.verifySigV4({ ...options(headers), body: BODY }).credentials.id, ACCOUNT.id);
  assert.throws(() => sigv4.verifySigV4({ ...options(headers), body: 'different' }), { code: 'SIGNATURE_MISMATCH' });
});

test('SigV4 preflight enforces signature shape and the native payload policy', () => {
  for (const headers of [
    { ...signed(), Authorization: signed().Authorization.replace(/Signature=.*/, 'Signature=not-hex') },
    signed({ 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' }),
    signed({ 'x-amz-content-sha256': 'invalid-digest' }),
  ]) {
    assert.throws(() => sigv4.preflightSigV4({ ...options(headers), allowNativeClientPayloadHash: true }), { code: 'SIGNATURE_MISMATCH' });
  }
});

test('staging reservations charge declared bytes and excess chunks until idempotent release', () => {
  const budget = staging.createUploadStagingBudget({ maxBytes: 10, maxUploads: 2 });
  const a = budget.acquire(4);
  a.consume(4);
  const b = budget.acquire(5);
  assert.throws(() => a.consume(2), { code: 'REQUEST_THROTTLED', statusCode: 503 });
  a.consume(1);
  b.release();
  b.release();
  const c = budget.acquire(5);
  assert.throws(() => budget.acquire(0), { code: 'REQUEST_THROTTLED' });
  a.release();
  c.release();
  const full = budget.acquire(10);
  full.release();
  assert.throws(() => full.consume(1), TypeError);
});

test('staging defaults admit the full existing per-request upload cap and remain bounded', () => {
  const budget = staging.createUploadStagingBudget();
  const full = budget.acquire(staging.DEFAULT_UPLOAD_STAGING_MAX_BYTES);
  assert.throws(() => budget.acquire(1), { code: 'REQUEST_THROTTLED' });
  full.release();
  const leases = Array.from({ length: staging.DEFAULT_UPLOAD_STAGING_MAX_UPLOADS }, () => budget.acquire(1));
  assert.throws(() => budget.acquire(1), { code: 'REQUEST_THROTTLED' });
  for (const lease of leases) lease.release();
});

test('staging limits and reservations reject invalid numeric configuration', () => {
  assert.equal(typeof staging.createUploadStagingBudget, 'function');
  for (const value of [-1, 1.5, Infinity, NaN, '10']) {
    assert.throws(() => staging.createUploadStagingBudget({ maxBytes: value }), TypeError);
    assert.throws(() => staging.createUploadStagingBudget({ maxUploads: value }), TypeError);
    assert.throws(() => staging.createUploadStagingBudget().acquire(value), TypeError);
  }
});
