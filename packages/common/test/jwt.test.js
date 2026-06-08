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
