import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sign, verify } from '../src/jwt.js';

test('sign/verify round-trips the payload and adds iat', () => {
  const payload = { id: 'acct-1', friendlyId: 'My-Robot', accessKeyId: 'k', secretAccessKey: 's' };
  const token = sign(payload, 'secret');
  assert.equal(token.split('.').length, 3);
  const decoded = verify(token, 'secret');
  assert.equal(decoded.id, 'acct-1');
  assert.equal(decoded.friendlyId, 'My-Robot');
  assert.equal(typeof decoded.iat, 'number');
});

test('verify rejects a wrong secret', () => {
  const token = sign({ id: 'a' }, 'secret');
  assert.throws(() => verify(token, 'other'), /invalid signature/);
});

test('verify rejects a tampered payload', () => {
  const token = sign({ id: 'a' }, 'secret');
  const [h, , s] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ id: 'admin' })).toString('base64url');
  assert.throws(() => verify(`${h}.${forged}.${s}`, 'secret'), /invalid signature/);
});

test('verify rejects a non-HS256 alg', () => {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ id: 'a' })).toString('base64url');
  assert.throws(() => verify(`${header}.${body}.`, 'secret'), /unsupported jwt alg/);
});

test('verify rejects malformed tokens', () => {
  assert.throws(() => verify('not-a-jwt', 'secret'), /malformed/);
});

test('verify honors exp: future ok, past rejected, absent stays valid', () => {
  const now = Math.floor(Date.now() / 1000);
  const future = sign({ id: 'a', exp: now + 3600 }, 'secret');
  assert.equal(verify(future, 'secret').id, 'a');

  const past = sign({ id: 'a', exp: now - 3600 }, 'secret');
  assert.throws(() => verify(past, 'secret'), /jwt expired/);

  const noExp = sign({ id: 'a' }, 'secret'); // hand-signed robot creds: no exp -> always valid
  assert.equal(verify(noExp, 'secret').id, 'a');
});

test('verify allows small clock skew on exp', () => {
  const now = Math.floor(Date.now() / 1000);
  const justExpired = sign({ id: 'a', exp: now - 10 }, 'secret'); // within 30s skew window
  assert.equal(verify(justExpired, 'secret').id, 'a');
});
