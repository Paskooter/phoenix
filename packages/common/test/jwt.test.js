import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  JsonWebTokenError,
  NotBeforeError,
  TokenExpiredError,
  sign,
  verify,
} from '../src/jwt.js';

const SECRET = 'secret';

const b64url = (value) => Buffer.from(value).toString('base64url');

function hmacToken(payload, { alg = 'HS256', typ = 'JWT', secret = SECRET, signature } = {}) {
  const header = b64url(JSON.stringify({ alg, typ }));
  const body = b64url(JSON.stringify(payload));
  const input = `${header}.${body}`;
  const sig = signature === undefined
    ? createHmac(`sha${alg.slice(2)}`, secret).update(input).digest('base64url')
    : signature;
  return `${input}.${sig}`;
}

function hmacRawToken(payloadJson, { alg = 'HS256', typ = 'JWT', secret = SECRET } = {}) {
  const header = b64url(JSON.stringify({ alg, typ }));
  const body = b64url(payloadJson);
  const input = `${header}.${body}`;
  const sig = createHmac(`sha${alg.slice(2)}`, secret).update(input).digest('base64url');
  return `${input}.${sig}`;
}

function noneToken(payload, typ = 'JWT') {
  return `${b64url(JSON.stringify({ alg: 'none', typ }))}.${b64url(JSON.stringify(payload))}.`;
}

function expectJwtError(fn, ErrorType, message) {
  assert.throws(fn, (error) => {
    assert.equal(error.constructor, ErrorType);
    assert.equal(error.message, message);
    return true;
  });
}

test('sign/verify round-trips the payload and adds iat', () => {
  const payload = { id: 'acct-1', friendlyId: 'My-Robot', accessKeyId: 'k', secretAccessKey: 's' };
  const token = sign(payload, SECRET);
  assert.equal(token.split('.').length, 3);
  const decoded = verify(token, SECRET);
  assert.equal(decoded.id, 'acct-1');
  assert.equal(decoded.friendlyId, 'My-Robot');
  assert.equal(typeof decoded.iat, 'number');
});

test('verify accepts each HMAC algorithm allowed by the pinned source defaults', () => {
  for (const alg of ['HS256', 'HS384', 'HS512']) {
    assert.equal(verify(hmacToken({ id: alg }, { alg }), SECRET).id, alg);
  }
});

test('verify rejects a wrong secret and a tampered payload', () => {
  const token = sign({ id: 'a' }, SECRET);
  expectJwtError(() => verify(token, 'other'), JsonWebTokenError, 'invalid signature');

  const [h, , s] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ id: 'admin' })).toString('base64url');
  expectJwtError(() => verify(`${h}.${forged}.${s}`, SECRET), JsonWebTokenError, 'invalid signature');
});

test('verify matches source errors for missing, malformed, algorithm, and signature cases', () => {
  expectJwtError(() => verify(undefined, SECRET), JsonWebTokenError, 'jwt must be provided');
  expectJwtError(() => verify('', SECRET), JsonWebTokenError, 'jwt must be provided');
  expectJwtError(() => verify(42, SECRET), JsonWebTokenError, 'jwt must be a string');
  expectJwtError(() => verify('not-a-jwt', SECRET), JsonWebTokenError, 'jwt malformed');

  const none = noneToken({ id: 'a' });
  expectJwtError(() => verify(none, SECRET), JsonWebTokenError, 'jwt signature is required');
  expectJwtError(() => verify(hmacToken({ id: 'a' }, { alg: 'none', signature: 'x' }), SECRET), JsonWebTokenError, 'invalid algorithm');
  expectJwtError(() => verify(`${none.split('.')[0]}..x`, SECRET), JsonWebTokenError, 'invalid token');
  expectJwtError(() => verify(`${none.split('.')[0]}.${none.split('.')[1]}.`, undefined, { algorithms: ['HS256'] }), JsonWebTokenError, 'invalid algorithm');
  assert.deepEqual(verify(noneToken({ id: 'a' }), undefined), { id: 'a' });
});

test('verify parses JWT payloads before algorithm and signature checks', () => {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const badPayload = b64url('{bad');
  assert.throws(() => verify(`${header}.${badPayload}.x`, SECRET), (error) => {
    assert.equal(error.name, 'SyntaxError');
    assert.match(error.message, /^Unexpected token b in JSON at position 1$/);
    return true;
  });

  const badAlgorithm = b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  assert.throws(() => verify(`${badAlgorithm}.${badPayload}.x`, SECRET), (error) => {
    assert.equal(error.name, 'SyntaxError');
    assert.match(error.message, /^Unexpected token b in JSON at position 1$/);
    return true;
  });
});

test('verify translates modern JSON diagnostics with source UTF-16 positions', () => {
  const cases = [
    ['ttr', 'Unexpected token t in JSON at position 1'],
    ['tt', 'Unexpected token t in JSON at position 1'],
    ['[1 -2]', 'Unexpected number in JSON at position 3'],
    ['{"a":1-}', 'Unexpected number in JSON at position 6'],
    ['{"a":"\\-"}', 'Unexpected number in JSON at position 7'],
    ['{"a":"\\q"}', 'Unexpected token q in JSON at position 7'],
    ['{"a":"\\1"}', 'Unexpected number in JSON at position 7'],
    ['["x",x]', 'Unexpected token x in JSON at position 5'],
    ['["a", {"key": a}]', 'Unexpected token a in JSON at position 14'],
    ['{"a": true, "t": te}', 'Unexpected token e in JSON at position 18'],
    ['NaN', 'Unexpected token N in JSON at position 0'],
    ['Infinity', 'Unexpected token I in JSON at position 0'],
  ];
  for (const [payloadJson, message] of cases) {
    assert.throws(() => verify(hmacRawToken(payloadJson), SECRET), (error) => {
      assert.equal(error.name, 'SyntaxError');
      assert.equal(error.message, message);
      return true;
    });
  }
});

test('verify compares canonical source signature text and decodes headers as binary', () => {
  const canonical = hmacToken({ id: 'a' });
  const [header, body, signature] = canonical.split('.');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const finalIndex = alphabet.indexOf(signature.at(-1));
  const alternate = `${signature.slice(0, -1)}${alphabet[finalIndex + 1]}`;
  assert.notEqual(alternate, signature);
  assert.deepEqual(
    verify(`${header}.${body}.${signature}`, SECRET),
    { id: 'a' },
  );
  expectJwtError(() => verify(`${header}.${body}.${alternate}`, SECRET), JsonWebTokenError, 'invalid signature');

  const unicodeHeader = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT', 'é': 'synthetic' }));
  const unicodeBody = b64url(JSON.stringify({ id: 'a' }));
  const input = `${unicodeHeader}.${unicodeBody}`;
  const unicodeSignature = createHmac('sha256', SECRET).update(input).digest('base64url');
  assert.deepEqual(verify(`${input}.${unicodeSignature}`, SECRET), { id: 'a' });
});

test('verify enforces exact exp boundaries without an implicit clock skew', () => {
  const now = 1_700_000_000;
  assert.equal(verify(sign({ id: 'a', exp: now + 1 }, SECRET, { iat: now }), SECRET, { clockTimestamp: now }).id, 'a');
  expectJwtError(
    () => verify(sign({ id: 'a', exp: now }, SECRET, { iat: now }), SECRET, { clockTimestamp: now }),
    TokenExpiredError,
    'jwt expired',
  );
  expectJwtError(
    () => verify(sign({ id: 'a', exp: now - 1 }, SECRET, { iat: now }), SECRET, { clockTimestamp: now }),
    TokenExpiredError,
    'jwt expired',
  );
  assert.equal(verify(sign({ id: 'a' }, SECRET, { iat: now }), SECRET, { clockTimestamp: now }).id, 'a');
});

test('verify enforces nbf boundaries and registered-claim types', () => {
  const now = 1_700_000_000;
  assert.equal(verify(sign({ id: 'a', nbf: now }, SECRET, { iat: now }), SECRET, { clockTimestamp: now }).id, 'a');
  expectJwtError(
    () => verify(sign({ id: 'a', nbf: now + 1 }, SECRET, { iat: now }), SECRET, { clockTimestamp: now }),
    NotBeforeError,
    'jwt not active',
  );
  expectJwtError(
    () => verify(sign({ id: 'a', exp: 'soon' }, SECRET, { iat: now }), SECRET, { clockTimestamp: now }),
    JsonWebTokenError,
    'invalid exp value',
  );
  expectJwtError(
    () => verify(sign({ id: 'a', nbf: 'later' }, SECRET, { iat: now }), SECRET, { clockTimestamp: now }),
    JsonWebTokenError,
    'invalid nbf value',
  );
});

test('verify preserves source payload decoding for JWT primitives, objects, and null', () => {
  assert.equal(verify(noneToken('hello'), undefined), 'hello');
  assert.equal(verify(noneToken(7), undefined), 7);
  assert.deepEqual(verify(noneToken({ id: 'a' }), undefined), { id: 'a' });
  assert.throws(() => verify(noneToken(null), undefined), (error) => {
    assert.equal(error.name, 'TypeError');
    assert.equal(error.message, "Cannot read property 'nbf' of null");
    return true;
  });

  // A non-JWT header keeps JSON primitives as the source's raw string, while
  // an object is still recovered by jsonwebtoken.decode's compatibility parse.
  assert.equal(verify(noneToken('hello', 'JWS'), undefined), '"hello"');
  assert.deepEqual(verify(noneToken({ id: 'a' }, 'JWS'), undefined), { id: 'a' });
});
