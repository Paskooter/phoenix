// HS256 JSON Web Tokens — interoperable with the robot's `jsonwebtoken.sign(payload, secret)`
// (default algorithm HS256). The robot signs IAuthDetails with the shared secret and connects
// with `Authorization: Bearer <jwt>` (hub-client/src/Client.ts:50-52); the gateway verifies
// against ETCO_server_hubTokenSecret (BaseService.ts:67-77). We implement HS256 directly on
// node:crypto so there is no external dependency and behavior is fully under our control.

import { createHmac, timingSafeEqual } from 'node:crypto';

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

const b64urlJson = (obj) => b64url(JSON.stringify(obj));

function b64urlDecode(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function hmac(input, secret) {
  return createHmac('sha256', secret).update(input).digest();
}

/**
 * Sign a payload as an HS256 JWT. Adds `iat` (issued-at, seconds) like jsonwebtoken does,
 * unless already present. Used by the test client that mimics the robot.
 * @param {object} payload
 * @param {string} secret
 * @param {{ iat?: number }} [opts] iat override (seconds) — pass for deterministic tokens
 */
export function sign(payload, secret, opts = {}) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const body = { ...payload };
  if (body.iat === undefined) body.iat = opts.iat ?? Math.floor(Date.now() / 1000);
  const signingInput = `${b64urlJson(header)}.${b64urlJson(body)}`;
  const sig = b64url(hmac(signingInput, secret));
  return `${signingInput}.${sig}`;
}

/**
 * Verify an HS256 JWT and return its payload. Throws on a malformed token, an unsupported
 * algorithm, or a bad signature — matching the gateway's "reject before upgrade" behavior.
 * @param {string} token
 * @param {string} secret
 * @returns {object} the decoded payload
 */
export function verify(token, secret) {
  if (typeof token !== 'string') throw new Error('jwt must be a string');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('jwt malformed');
  const [h, p, s] = parts;

  let header;
  try {
    header = JSON.parse(b64urlDecode(h).toString('utf8'));
  } catch {
    throw new Error('jwt header invalid');
  }
  if (header.alg !== 'HS256') throw new Error(`unsupported jwt alg: ${header.alg}`);

  const expected = hmac(`${h}.${p}`, secret);
  const actual = b64urlDecode(s);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error('invalid signature');
  }

  try {
    return JSON.parse(b64urlDecode(p).toString('utf8'));
  } catch {
    throw new Error('jwt payload invalid');
  }
}
