import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  SIGV4_ERRORS,
  SIGV4_CLOCK_SKEW_MS,
  SigV4Error,
  signSigV4,
  verifySigV4,
} from '../src/sigv4.js';

const ACCESS_KEY = 'AKIDEXAMPLE';
const SECRET = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
const DATE = new Date('2015-08-30T12:36:00.000Z');
const BASE = {
  method: 'POST',
  path: '/',
  body: '{}',
  headers: {
    Host: 'example.test',
    'X-Amz-Target': 'Account_20151111.CreateHubToken',
    'Content-Type': 'application/json',
  },
  accessKeyId: ACCESS_KEY,
  secretAccessKey: SECRET,
  region: 'global',
  service: 'jibo',
  date: DATE,
};

function signed(overrides = {}) {
  return signSigV4({ ...BASE, ...overrides, headers: { ...BASE.headers, ...(overrides.headers || {}) } });
}

function verify(headers, overrides = {}) {
  return verifySigV4({
    method: BASE.method,
    path: BASE.path,
    body: BASE.body,
    headers,
    now: DATE,
    resolveCredentials: (accessKeyId) => accessKeyId === ACCESS_KEY
      ? { _id: 'acct-1', accessKeyId, secretAccessKey: SECRET, isActive: true }
      : null,
    ...overrides,
  });
}

function errorCode(fn) {
  assert.throws(fn, (error) => error instanceof SigV4Error);
  try { fn(); } catch (error) { return error.code; }
  return null;
}

test('SigV4 matches the pinned AWS SDK 2.205.0 source signer fixture', () => {
  const result = signed();
  assert.equal(result.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/global/jibo/aws4_request, SignedHeaders=host;x-amz-date;x-amz-target, Signature=90798648dcdc365e28c2b1a88ee29deccf3606dbb697db68cb410929cce7d36e');
  assert.equal(result.canonicalRequest, [
    'POST',
    '/',
    '',
    'host:example.test',
    'x-amz-date:20150830T123600Z',
    'x-amz-target:Account_20151111.CreateHubToken',
    '',
    'host;x-amz-date;x-amz-target',
    '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
  ].join('\n'));
  assert.equal(verify(result.headers).accessKeyId, ACCESS_KEY);
});

test('SigV4 matches source canonical query, punctuation-header, and s3 path fixtures', () => {
  // Fresh controls from srv-security-gw@43a692fe (src/util.js + src/v4.js):
  // querystring.parse keeps the malformed escape's valid prefix, duplicate
  // values sort independently, header names use ASCII lower-case ordering,
  // and service=s3 leaves the canonical pathname unescaped.
  const query = signSigV4({
    method: 'POST',
    path: '/a b/%2F?b=2&a=2&a=1&bad=%E0%A4%A',
    body: 'x',
    headers: { Host: 'example.test' },
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET,
    region: 'global',
    service: 'jibo',
    date: DATE,
  });
  assert.equal(query.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/global/jibo/aws4_request, SignedHeaders=host;x-amz-date, Signature=05122cc35da53ac76770c5707e6d75239196c936932f4cdd39d93821c42ea357');
  assert.equal(query.canonicalRequest, [
    'POST',
    '/a%20b/%252F',
    'a=1&a=2&b=2&bad=%EF%BF%BD%25A',
    'host:example.test',
    'x-amz-date:20150830T123600Z',
    '',
    'host;x-amz-date',
    '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881',
  ].join('\n'));

  const punctuation = signSigV4({
    method: 'POST',
    path: '/',
    body: 'x',
    headers: {
      Host: 'example.test',
      'a!': 'v',
      'a.': 'w',
      'A-': 'x',
      'presigned-expires': '',
    },
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET,
    region: 'global',
    service: 'jibo',
    date: DATE,
  });
  assert.equal(punctuation.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/global/jibo/aws4_request, SignedHeaders=a!;a-;a.;host;x-amz-date, Signature=acf7705f0147c4cb05e3c1b109a3244831533307f3b8c5474629871d2d4da74a');
  assert.equal(punctuation.canonicalRequest, [
    'POST',
    '/',
    '',
    'a!:v',
    'a-:x',
    'a.:w',
    'host:example.test',
    'x-amz-date:20150830T123600Z',
    '',
    'a!;a-;a.;host;x-amz-date',
    '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881',
  ].join('\n'));

  const s3 = signSigV4({
    method: 'POST',
    path: '/a b/%2F?b=2&a=2&a=1&bad=%E0%A4%A',
    body: 'x',
    headers: { Host: 'example.test' },
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET,
    region: 'global',
    service: 's3',
    date: DATE,
  });
  assert.equal(s3.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/global/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=ec70b4b621cb49a28b1b257dbc3f1a833e9e321e12fcb4067b14bc89840237e2');
  assert.equal(s3.canonicalRequest, [
    'POST',
    '/a b/%2F',
    'a=1&a=2&b=2&bad=%EF%BF%BD%25A',
    'host:example.test',
    'x-amz-date:20150830T123600Z',
    '',
    'host;x-amz-date',
    '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881',
  ].join('\n'));
});

test('body and signed-header changes fail while an untrusted x-amz-credentials header cannot change identity', () => {
  const result = signed();
  assert.equal(errorCode(() => verify(result.headers, { body: '{"tampered":true}' })), 'SIGNATURE_MISMATCH');

  const targetChanged = { ...result.headers, 'x-amz-target': 'Account_20151111.Remove' };
  assert.equal(errorCode(() => verify(targetChanged)), 'SIGNATURE_MISMATCH');

  const forgedIdentity = { ...result.headers, 'x-amz-credentials': JSON.stringify({ id: 'attacker', accessKeyId: 'ATTACKER' }) };
  assert.equal(verify(forgedIdentity).accessKeyId, ACCESS_KEY);
});

test('key, account, algorithm, and date errors preserve security-gateway codes', () => {
  const result = signed();
  const noAuth = { ...result.headers };
  delete noAuth.Authorization;
  assert.equal(errorCode(() => verify(noAuth)), SIGV4_ERRORS.MISSING_AUTH_HEADER.code);

  const noDate = { ...result.headers };
  delete noDate['X-Amz-Date'];
  assert.equal(errorCode(() => verify(noDate)), SIGV4_ERRORS.MISSING_DATE_HEADER.code);

  const badAlgorithm = { ...result.headers, Authorization: result.authorization.replace('AWS4-HMAC-SHA256', 'AWS3-HMAC-SHA256') };
  assert.equal(errorCode(() => verify(badAlgorithm)), SIGV4_ERRORS.MISSING_ENCRYPTION_ALGORITHM.code);

  const unknown = signed({ accessKeyId: 'UNKNOWNKEY' });
  assert.equal(errorCode(() => verify(unknown.headers)), SIGV4_ERRORS.ACCESS_KEY_NOT_FOUND.code);

  assert.equal(errorCode(() => verify(result.headers, {
    resolveCredentials: () => ({ secretAccessKey: SECRET, isActive: false }),
  })), SIGV4_ERRORS.ACCOUNT_NOT_ACTIVE.code);
});

test('the source uses a strict greater-than 15-minute clock-skew boundary', () => {
  const result = signed();
  assert.equal(verify(result.headers, { now: new Date(DATE.getTime() + SIGV4_CLOCK_SKEW_MS) }).accessKeyId, ACCESS_KEY);
  assert.equal(errorCode(() => verify(result.headers, { now: new Date(DATE.getTime() + SIGV4_CLOCK_SKEW_MS + 1) })), SIGV4_ERRORS.CLOCK_SKEW_TOO_LONG.code);
  assert.equal(errorCode(() => verify(result.headers, { now: new Date(DATE.getTime() - SIGV4_CLOCK_SKEW_MS - 1) })), SIGV4_ERRORS.CLOCK_SKEW_TOO_LONG.code);
});

test('an explicit x-amz-content-sha256 follows the native source signer path only when supplied', () => {
  const emptyHash = createHash('sha256').update('').digest('hex');
  // Authentication.cpp signs StandardHttpRequest before it attaches the
  // JSON body and X-Amz-Target. Model that exact source ordering: the target
  // is therefore not in SignedHeaders and the explicit empty hash is present.
  const result = signSigV4({
    ...BASE,
    body: '',
    headers: {
      Host: 'example.test',
      'x-amz-content-sha256': emptyHash,
    },
  });
  const nativeHeaders = { ...result.headers, 'X-Amz-Target': 'Account_20151111.CreateHubToken' };
  // The archived gateway takes this explicit value as the canonical payload
  // hash. This is the bounded native-client compatibility path; requests
  // without the header hash the exact received body (tested above).
  assert.equal(verify(nativeHeaders, { body: '{"attachedAfterSigning":true}' }).accessKeyId, ACCESS_KEY);
});
