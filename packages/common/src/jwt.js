// HMAC JSON Web Tokens — interoperable with the robot's
// `jsonwebtoken.sign(payload, secret)` (default algorithm HS256). The robot signs IAuthDetails
// with the shared secret and connects with `Authorization: Bearer <jwt>` (hub-client/src/Client.ts:
// 50-52); the gateway verifies against ETCO_server_hubTokenSecret (BaseService.ts:67-77). We
// implement the shared-secret algorithms directly on node:crypto so there is no external runtime
// dependency and the source error contract is explicit.

import { createHmac, timingSafeEqual } from 'node:crypto';

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

const b64urlJson = (obj) => b64url(JSON.stringify(obj));

function b64urlDecode(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function decodePayload(header, encodedPayload) {
  const payloadText = b64urlDecode(encodedPayload).toString('utf8');
  if (header.typ === 'JWT') {
    // jws.decode parses a JWT-typed payload before algorithm/signature
    // validation. Preserve that precedence and the source's old V8 wording
    // for a null payload, which is later exposed by the claim checks.
    return parseJson(payloadText);
  }

  // jsonwebtoken.decode then performs its compatibility parse: only an
  // object (including null, as in the original JS `typeof` check) replaces
  // the raw string; JSON primitives remain strings.
  let payload = payloadText;
  try {
    const parsed = JSON.parse(payloadText);
    if (typeof parsed === 'object') payload = parsed;
  } catch {
    // A non-JWT payload is allowed to remain a string.
  }
  return payload;
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch (error) {
    // Node 8's JSON.parse message is part of the BaseService error body. Newer
    // V8 releases changed the same diagnostic to a quoted, context-rich form.
    const message = error.message;
    if (message === 'Unexpected end of JSON input') throw error;

    // Keep a conservative fallback for a future V8 diagnostic that the scanner
    // cannot classify. Explicit Node-style positions are safe to use because
    // they are emitted by the parser itself, rather than inferred from text.
    const positionMatch = message.match(/(?:at position|at) (\d+)/);
    if (positionMatch) {
      const translated = legacyJsonToken(value, Number(positionMatch[1]));
      throw new SyntaxError(translated);
    }

    // Modern V8 either omits the position from token diagnostics or points at
    // the first occurrence of a repeated character. Walk the JSON grammar to
    // locate the first offending UTF-16 code unit instead of searching for the
    // token text. JSON.parse remains authoritative for deciding that the value
    // is invalid; this bounded scanner only translates its diagnostic.
    const scannedPosition = jsonSyntaxPosition(value);
    if (scannedPosition >= 0) {
      const translated = legacyJsonToken(value, scannedPosition);
      if (translated !== 'Unexpected end of JSON input') throw new SyntaxError(translated);
    }

    const tokenMatch = message.match(/^Unexpected token ['"](.+?)['"]/);
    if (tokenMatch) {
      throw new SyntaxError(`Unexpected token ${tokenMatch[1]} in JSON at position 0`);
    }

    // Node 22 uses this form for NaN/Infinity. The grammar scanner above has
    // already located the invalid leading code unit in those cases; reaching
    // here means the parser emitted an unrecognised message.
    const invalidNumber = message.match(/^['"](?:NaN|Infinity)['"] is not valid JSON$/);
    if (invalidNumber) {
      throw new SyntaxError(`Unexpected token ${value[0]} in JSON at position 0`);
    }

    throw error;
  }
}

function legacyJsonToken(value, position) {
  const token = value[position];
  if (token === undefined) return 'Unexpected end of JSON input';
  // V8 6.2 classifies a leading minus as a number diagnostic even when the
  // surrounding JSON state is malformed (for example `[1 -2]`, `{"a":1-}`,
  // or an invalid escaped `\\-` inside a string). Keep this decision tied to
  // the parser-reported code unit; escaped literals such as `\\q` still use
  // the literal `q` token below rather than a broad escape rewrite.
  if (token === '-' || /\d/.test(token)) return `Unexpected number in JSON at position ${position}`;
  if (token === '"') return `Unexpected string in JSON at position ${position}`;
  return `Unexpected token ${token} in JSON at position ${position}`;
}

/**
 * Locate JSON.parse's first invalid UTF-16 code unit without using a text
 * search. This deliberately accepts top-level primitives because JWT payloads
 * are parsed by jws before jsonwebtoken validates their claims. The scanner is
 * iterative so an untrusted deeply nested payload cannot consume the JS call
 * stack; JSON.parse remains the validity oracle.
 */
function jsonSyntaxPosition(raw) {
  let index = skipJsonWhitespace(raw, 0);
  if (index >= raw.length) return index;

  const stack = [{ type: 'root', state: 'value' }];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    index = skipJsonWhitespace(raw, index);

    if (frame.type === 'root') {
      if (frame.state === 'value') {
        if (raw[index] === '{' || raw[index] === '[') {
          stack.push({
            type: raw[index] === '{' ? 'object' : 'array',
            state: raw[index] === '{' ? 'key' : 'value',
          });
          index++;
          continue;
        }
        const value = scanJsonPrimitive(raw, index);
        if (value.error !== undefined) return value.error;
        index = value.end;
        frame.state = 'afterValue';
        continue;
      }

      index = skipJsonWhitespace(raw, index);
      if (index < raw.length) return index;
      stack.pop();
      continue;
    }

    if (frame.type === 'object') {
      if (frame.state === 'key' || frame.state === 'keyAfterComma') {
        if (raw[index] === '}') {
          if (frame.state === 'keyAfterComma') return index;
          stack.pop();
          index++;
          if (stack.length > 0) stack[stack.length - 1].state = 'afterValue';
          continue;
        }
        if (raw[index] !== '"') return index;
        const key = scanJsonString(raw, index);
        if (key.error !== undefined) return key.error;
        index = key.end;
        frame.state = 'colon';
        continue;
      }

      if (frame.state === 'colon') {
        if (raw[index] !== ':') return index;
        index++;
        frame.state = 'value';
        continue;
      }

      if (frame.state === 'value') {
        if (raw[index] === '{' || raw[index] === '[') {
          stack.push({
            type: raw[index] === '{' ? 'object' : 'array',
            state: raw[index] === '{' ? 'key' : 'value',
          });
          index++;
          continue;
        }
        const value = scanJsonPrimitive(raw, index);
        if (value.error !== undefined) return value.error;
        index = value.end;
        frame.state = 'afterValue';
        continue;
      }

      if (raw[index] === '}') {
        stack.pop();
        index++;
        if (stack.length > 0) stack[stack.length - 1].state = 'afterValue';
        continue;
      }
      if (raw[index] === ',') {
        index++;
        frame.state = 'keyAfterComma';
        continue;
      }
      return index;
    }

    if (frame.state === 'value' || frame.state === 'valueAfterComma') {
      if (raw[index] === ']') {
        if (frame.state === 'valueAfterComma') return index;
        stack.pop();
        index++;
        if (stack.length > 0) stack[stack.length - 1].state = 'afterValue';
        continue;
      }
      if (raw[index] === '{' || raw[index] === '[') {
        stack.push({
          type: raw[index] === '{' ? 'object' : 'array',
          state: raw[index] === '{' ? 'key' : 'value',
        });
        index++;
        continue;
      }
      const value = scanJsonPrimitive(raw, index);
      if (value.error !== undefined) return value.error;
      index = value.end;
      frame.state = 'afterValue';
      continue;
    }

    if (raw[index] === ']') {
      stack.pop();
      index++;
      if (stack.length > 0) stack[stack.length - 1].state = 'afterValue';
      continue;
    }
    if (raw[index] === ',') {
      index++;
      frame.state = 'valueAfterComma';
      continue;
    }
    return index;
  }

  return -1;
}

function scanJsonPrimitive(raw, position) {
  const character = raw[position];
  if (character === undefined) return { error: position };
  if (character === '"') return scanJsonString(raw, position);
  if (character === 't') return scanJsonLiteral(raw, position, 'true');
  if (character === 'f') return scanJsonLiteral(raw, position, 'false');
  if (character === 'n') return scanJsonLiteral(raw, position, 'null');
  if (character === '-' || /\d/.test(character)) return scanJsonNumber(raw, position);
  return { error: position };
}

function scanJsonLiteral(raw, position, literal) {
  for (let offset = 0; offset < literal.length; offset++) {
    const index = position + offset;
    if (raw[index] === undefined) return { error: index };
    if (raw[index] !== literal[offset]) return { error: index };
  }
  return { end: position + literal.length };
}

function scanJsonNumber(raw, position) {
  let index = position;
  if (raw[index] === '-') {
    index++;
    if (!/[0-9]/.test(raw[index] || '')) return { error: index };
  }
  if (raw[index] === '0') {
    index++;
    if (/\d/.test(raw[index] || '')) return { error: index };
  } else {
    while (/\d/.test(raw[index] || '')) index++;
  }
  if (raw[index] === '.') {
    index++;
    if (!/[0-9]/.test(raw[index] || '')) return { error: index };
    while (/\d/.test(raw[index] || '')) index++;
  }
  if (raw[index] === 'e' || raw[index] === 'E') {
    index++;
    if (raw[index] === '+' || raw[index] === '-') index++;
    if (!/[0-9]/.test(raw[index] || '')) return { error: index };
    while (/\d/.test(raw[index] || '')) index++;
  }
  return { end: index };
}

function scanJsonString(raw, position) {
  for (let index = position + 1; index < raw.length; index++) {
    const character = raw[index];
    if (character === '"') return { end: index + 1 };
    if (character.charCodeAt(0) < 0x20) return { error: index };
    if (character !== '\\') continue;
    const escaped = raw[++index];
    if (escaped === undefined) return { error: index };
    if (escaped === 'u') {
      for (let digit = 0; digit < 4; digit++) {
        const code = raw[index + 1 + digit];
        if (code === undefined) return { error: index + 1 + digit };
        if (!/[0-9a-f]/i.test(code)) return { error: index + 1 + digit };
      }
      index += 4;
    } else if (!/["\\/bfnrt]/.test(escaped)) {
      return { error: index };
    }
  }
  return { error: raw.length };
}

function skipJsonWhitespace(raw, position) {
  while (position < raw.length && /[\u0020\u0009\u000a\u000d]/.test(raw[position])) position++;
  return position;
}

function hmac(input, secret) {
  return createHmac('sha256', secret).update(input).digest();
}

const VERIFY_ALGORITHMS = Object.freeze({
  HS256: 'sha256',
  HS384: 'sha384',
  HS512: 'sha512',
});

export class JsonWebTokenError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JsonWebTokenError';
  }
}

export class TokenExpiredError extends JsonWebTokenError {
  constructor(message, expiredAt) {
    super(message);
    this.name = 'TokenExpiredError';
    this.expiredAt = expiredAt;
  }
}

export class NotBeforeError extends JsonWebTokenError {
  constructor(message, date) {
    super(message);
    this.name = 'NotBeforeError';
    this.date = date;
  }
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
 * Verify a shared-secret JWT and return its payload. This covers the HMAC algorithms that the
 * pinned source permits by default for a string secret (HS256, HS384, HS512), plus the source's
 * explicitly unauthenticated `none` form when no key is supplied. Throws source-shaped errors
 * before the gateway upgrades the socket.
 * @param {string} token
 * @param {string} secret
 * @returns {*} the decoded payload
 */
export function verify(token, secret, options = {}) {
  options = options || {};
  if (options.clockTimestamp && typeof options.clockTimestamp !== 'number') {
    throw new JsonWebTokenError('clockTimestamp must be a number');
  }
  const clockTimestamp = options.clockTimestamp || Math.floor(Date.now() / 1000);

  // jsonwebtoken@8.1.1 distinguishes a missing/empty token from a non-string
  // token. The gateway exposes these errors through the WebSocket upgrade, so
  // preserve the source exception names as well as messages.
  if (!token) throw new JsonWebTokenError('jwt must be provided');
  if (typeof token !== 'string') throw new JsonWebTokenError('jwt must be a string');

  const parts = token.split('.');
  if (parts.length !== 3) throw new JsonWebTokenError('jwt malformed');
  const [h, p, s] = parts;
  const hasSignature = s.trim() !== '';
  if (!hasSignature && secret) throw new JsonWebTokenError('jwt signature is required');
  if (hasSignature && !secret) throw new JsonWebTokenError('secret or public key must be provided');

  // jws.decode accepts only URL-safe base64 segments and requires a non-empty
  // header and payload. Keep this check before JSON parsing so malformed
  // entities use the source's generic "invalid token" error.
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(token)) {
    throw new JsonWebTokenError('invalid token');
  }

  let header;
  try {
    // jws@3 decodes the header with the `binary`/latin1 encoding. Header
    // fields are ASCII in the hub contract, but preserving this matters for
    // malformed and non-ASCII edge cases before verification.
    header = JSON.parse(b64urlDecode(h).toString('latin1'));
  } catch {
    throw new JsonWebTokenError('invalid token');
  }
  // jws considers any truthy JSON header valid, even an array or primitive;
  // the subsequent `header.alg` lookup then reports the source's
  // `invalid algorithm`. JSON null remains the invalid-token case.
  if (!header) throw new JsonWebTokenError('invalid token');

  // jws.decode parses a JWT payload before jsonwebtoken checks the selected
  // algorithm or verifies its signature. This ordering is observable for a
  // malformed payload paired with a bad algorithm/signature.
  const payload = decodePayload(header, p);

  const algorithms = options.algorithms || (hasSignature ? Object.keys(VERIFY_ALGORITHMS) : ['none']);
  if (!algorithms.includes(header.alg)) throw new JsonWebTokenError('invalid algorithm');
  const digest = VERIFY_ALGORITHMS[header.alg];
  if (header.alg === 'none') {
    // jsonwebtoken@8.1.1 enables this only for a token without a signature and no
    // supplied key. The checks above already reject both other combinations.
    if (hasSignature) throw new JsonWebTokenError('invalid signature');
  } else {
    if (!digest) throw new JsonWebTokenError('invalid algorithm');
    // jwa@3 compares the canonical base64url signature strings as bytes. It
    // does not decode alternate encodings whose discarded low bits happen to
    // produce the same HMAC bytes, so retain that source boundary.
    const expected = b64url(createHmac(digest, secret).update(`${h}.${p}`).digest());
    const expectedBytes = Buffer.from(expected);
    const actualBytes = Buffer.from(s);
    if (expectedBytes.length !== actualBytes.length || !timingSafeEqual(expectedBytes, actualBytes)) {
      throw new JsonWebTokenError('invalid signature');
    }
  }

  const clockTolerance = options.clockTolerance || 0;
  // Keep the source's direct property access: a validly signed JSON null
  // reaches the same TypeError that jsonwebtoken@8.1.1 emits.
  if (payload === null) throw new TypeError("Cannot read property 'nbf' of null");
  if (typeof payload.nbf !== 'undefined' && !options.ignoreNotBefore) {
    if (typeof payload.nbf !== 'number') throw new JsonWebTokenError('invalid nbf value');
    if (payload.nbf > clockTimestamp + clockTolerance) {
      throw new NotBeforeError('jwt not active', new Date(payload.nbf * 1000));
    }
  }

  if (typeof payload.exp !== 'undefined' && !options.ignoreExpiration) {
    if (typeof payload.exp !== 'number') throw new JsonWebTokenError('invalid exp value');
    if (clockTimestamp >= payload.exp + clockTolerance) {
      throw new TokenExpiredError('jwt expired', new Date(payload.exp * 1000));
    }
  }

  return payload;
}
