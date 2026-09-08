// The Amazon V4 request signer used by the archived security gateway and the
// Jibo server clients.  This module deliberately follows the source's small
// implementation instead of pulling in an AWS SDK: the account service needs
// to verify the credential that signed the request, while the public
// x-amz-credentials forwarding header is only gateway metadata and is never an
// identity source here.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { parse as parseQueryString } from 'node:querystring';

export const SIGV4_ALGORITHM = 'AWS4-HMAC-SHA256';
export const SIGV4_CLOCK_SKEW_MS = 15 * 60 * 1000;

// These are the exact wire errors from srv-security-gw/src/errors/account.ts.
export const SIGV4_ERRORS = Object.freeze({
  ACCESS_KEY_NOT_FOUND: Object.freeze({
    code: 'ACCESS_KEY_NOT_FOUND',
    message: 'Access key not found',
    statusCode: 401,
  }),
  ACCOUNT_NOT_ACTIVE: Object.freeze({
    code: 'ACCOUNT_NOT_ACTIVE',
    message: 'Account not active',
    statusCode: 403,
  }),
  MISSING_AUTH_HEADER: Object.freeze({
    code: 'MISSING_AUTH_HEADER',
    message: 'Request is not signed properly, missing authorization header',
    statusCode: 401,
  }),
  MISSING_DATE_HEADER: Object.freeze({
    code: 'MISSING_DATE_HEADER',
    message: 'Request must contain Date or X-Amz-Date header',
    statusCode: 401,
  }),
  MISSING_ENCRYPTION_ALGORITHM: Object.freeze({
    code: 'MISSING_ENCRYPTION_ALGORITHM',
    message: 'Request is not signed properly, encryption algorithm not specified',
    statusCode: 401,
  }),
  SIGNATURE_MISMATCH: Object.freeze({
    code: 'SIGNATURE_MISMATCH',
    message: 'Signature does not match',
    statusCode: 401,
  }),
  ACCOUNT_SERVICE_UNAVAILABLE: Object.freeze({
    code: 'ACCOUNT_SERVICE_UNAVAILABLE',
    message: 'Account service not found',
    statusCode: 503,
  }),
  CLOCK_SKEW_TOO_LONG: Object.freeze({
    code: 'CLOCK_SKEW_TOO_LONG',
    message: 'Clock skew is more than 15 minutes',
    statusCode: 401,
  }),
});

const UNSIGNABLE_HEADERS = new Set([
  'connection',
  'authorization',
  'content-type',
  'content-length',
  'user-agent',
  'presigned-expires',
]);

export class SigV4Error extends Error {
  constructor(definition, cause) {
    super(definition.message, cause ? { cause } : undefined);
    this.name = definition.code;
    this.code = definition.code;
    this.statusCode = definition.statusCode;
  }
}

function fail(code, cause) {
  throw new SigV4Error(SIGV4_ERRORS[code], cause);
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(key, value, encoding) {
  return createHmac('sha256', key).update(value).digest(encoding);
}

function asBodyBuffer(body) {
  if (body === undefined || body === null) return Buffer.alloc(0);
  return Buffer.isBuffer(body) ? body : Buffer.from(String(body));
}

/** Lowercase header names, preserving the source's string value semantics. */
export function normalizeHeaders(input = {}) {
  const result = Object.create(null);
  for (const [name, value] of Object.entries(input || {})) {
    if (value === undefined || value === null) continue;
    const key = String(name).toLowerCase();
    const rendered = Array.isArray(value) ? value.join(', ') : String(value);
    if (result[key] === undefined) result[key] = rendered;
    else result[key] = `${result[key]}, ${rendered}`;
  }
  return result;
}

function headerValue(headers, name) {
  return headers[String(name).toLowerCase()];
}

function setHeader(headers, name, value) {
  const lower = name.toLowerCase();
  const existing = Object.keys(headers).find((key) => key.toLowerCase() === lower);
  headers[existing || name] = value;
}

function canonicalHeaderValue(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

function isSignableHeader(name, signedHeaders) {
  if (signedHeaders) return signedHeaders.has(name);
  return name.startsWith('x-amz-') || !UNSIGNABLE_HEADERS.has(name);
}

function signedHeaderNames(headers, signedHeaderText) {
  const requested = signedHeaderText
    ? new Set(String(signedHeaderText).split(';').map((name) => name.trim().toLowerCase()).filter(Boolean))
    : null;
  // The archived V4 implementation enumerates request headers and filters
  // against signedHeaders when it is supplied.  It does not synthesize a
  // missing header named by the authorization value.
  return Object.keys(headers)
    .map((name) => name.toLowerCase())
    .filter((name) => isSignableHeader(name, requested))
    .sort();
}

function canonicalHeaders(headers, signedHeaderText) {
  const requested = signedHeaderText
    ? new Set(String(signedHeaderText).split(';').map((name) => name.trim().toLowerCase()).filter(Boolean))
    : null;
  return Object.keys(headers)
    // The archived v4.js comparator is an ASCII/code-unit comparison of the
    // lower-case names. localeCompare gives punctuation a locale-dependent
    // order (for example, `a.` may sort before `a!`), changing the signature.
    .sort((a, b) => (a < b ? -1 : 1))
    .map((name) => name.toLowerCase())
    .filter((name, index, all) => all.indexOf(name) === index && isSignableHeader(name, requested))
    .map((name) => `${name}:${canonicalHeaderValue(headers[name])}`)
    .join('\n');
}

// AWS util.uriEscapePath splits on '/' and escapes each segment, retaining
// empty segments and therefore repeated or trailing slashes.
function uriEscape(value) {
  let result = encodeURIComponent(String(value));
  // encodeURIComponent leaves these characters alone, while the archived AWS
  // util escapes them (and uses uppercase hexadecimal digits).
  result = result.replace(/[!*'()]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return result;
}

function canonicalPath(path) {
  const raw = String(path || '/').split('?', 1)[0] || '/';
  return raw.split('/').map(uriEscape).join('/');
}

function parseQuery(path) {
  const query = String(path || '').split('?', 2)[1];
  if (!query) return '';

  // srv-security-gw delegates parsing to node:querystring. In particular,
  // malformed percent escapes are retained by its forgiving unescape path,
  // while valid portions of the same key/value still decode; a hand parser
  // that catches decodeURIComponent would reset both portions incorrectly.
  const params = parseQueryString(query);
  return Object.keys(params).sort().map((name) => {
    const encodedName = uriEscape(name);
    const value = params[name];
    if (Array.isArray(value)) {
      return value.slice().sort().map((item) => `${encodedName}=${uriEscape(item)}`).join('&');
    }
    return `${encodedName}=${uriEscape(value)}`;
  }).join('&');
}

function bodyHash(headers, body, bodyDigest) {
  // This is intentional source compatibility. srv-security-gw/v4.js trusts an
  // explicit x-amz-content-sha256 value and, in particular, supports the native
  // client which signs an empty StandardHttpRequest before it attaches `{}`.
  // Requests without the explicit header always hash the exact received bytes.
  const explicit = headerValue(headers, 'x-amz-content-sha256');
  if (bodyDigest !== undefined && !/^[a-f0-9]{64}$/.test(bodyDigest)) throw new TypeError('Invalid precomputed body digest');
  return explicit || bodyDigest || hash(asBodyBuffer(body));
}

export function canonicalRequest({ method = 'POST', path = '/', headers = {}, body = '', bodyDigest, signedHeaders, service = 'jibo' } = {}) {
  const normalized = normalizeHeaders(headers);
  const headerText = canonicalHeaders(normalized, signedHeaders);
  const signedText = signedHeaderNames(normalized, signedHeaders).join(';');
  return [
    String(method).toUpperCase(),
    service === 's3' ? (String(path || '/').split('?', 1)[0] || '/') : canonicalPath(path),
    parseQuery(path),
    `${headerText}\n`,
    signedText,
    bodyHash(normalized, body, bodyDigest),
  ].join('\n');
}

function parseDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  if (typeof value !== 'string' || !value) return new Date(NaN);
  // The source accepts compact Amazon timestamps and normal Date strings.
  const compact = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (compact) return new Date(`${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6]}Z`);
  return new Date(value);
}

function amzDate(value) {
  const date = parseDate(value);
  if (!Number.isFinite(date.getTime())) return null;
  const iso = date.toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
}

function scopeDate(datetime) {
  return datetime.slice(0, 8);
}

function credentialScope(datetime, region, service) {
  return `${scopeDate(datetime)}/${region}/${service}/aws4_request`;
}

function signingKey(secretAccessKey, datetime, region, service) {
  const dateKey = hmac(`AWS4${secretAccessKey}`, scopeDate(datetime));
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, service);
  return hmac(serviceKey, 'aws4_request');
}

function stringToSign(datetime, scope, request) {
  return [SIGV4_ALGORITHM, datetime, scope, hash(request)].join('\n');
}

function signatureFor({ secretAccessKey, datetime, region, service, request }) {
  return hmac(signingKey(secretAccessKey, datetime, region, service), stringToSign(datetime, credentialScope(datetime, region, service), request), 'hex');
}

function validAccessKey(accessKeyId) {
  return typeof accessKeyId === 'string' && accessKeyId.length > 0 && !/[\s,/]/.test(accessKeyId);
}

/**
 * Produce a signed request using the archived JS signer wire format.
 * `headers` are returned with their original spelling, plus X-Amz-Date and
 * Authorization. The canonical request is returned for fixture diagnostics.
 */
export function signSigV4({
  method = 'POST',
  path = '/',
  headers = {},
  body = '',
  accessKeyId,
  secretAccessKey,
  region,
  service = 'jibo',
  date = new Date(),
} = {}) {
  if (!validAccessKey(accessKeyId) || !secretAccessKey || !region || !service) {
    throw new TypeError('accessKeyId, secretAccessKey, region, and service are required');
  }
  const datetime = amzDate(date);
  if (!datetime) throw new TypeError('date must be a valid timestamp');

  const outputHeaders = { ...headers };
  setHeader(outputHeaders, 'X-Amz-Date', datetime);
  const normalized = normalizeHeaders(outputHeaders);
  const signedHeaders = signedHeaderNames(normalized);
  const request = canonicalRequest({ method, path, headers: normalized, body, service });
  const scope = credentialScope(datetime, region, service);
  const signature = signatureFor({ secretAccessKey, datetime, region, service, request });
  const authorization = `${SIGV4_ALGORITHM} Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}`;
  setHeader(outputHeaders, 'Authorization', authorization);

  return {
    headers: outputHeaders,
    authorization,
    canonicalRequest: request,
    stringToSign: stringToSign(datetime, scope, request),
  };
}

function parseAuthorization(value) {
  if (!value) fail('MISSING_AUTH_HEADER');
  const parts = String(value).split(', ');
  const first = parts[0] || '';
  const firstSpace = first.indexOf(' ');
  const algorithm = firstSpace < 0 ? first : first.slice(0, firstSpace);
  if (algorithm !== SIGV4_ALGORITHM) fail('MISSING_ENCRYPTION_ALGORITHM');

  const attributes = Object.create(null);
  if (firstSpace >= 0) {
    const equal = first.slice(firstSpace + 1).indexOf('=');
    if (equal >= 0) {
      const attribute = first.slice(firstSpace + 1);
      attributes[attribute.slice(0, equal)] = attribute.slice(equal + 1);
    }
  }
  for (const part of parts.slice(firstSpace < 0 ? 0 : 1)) {
    const equal = part.indexOf('=');
    if (equal > 0) attributes[part.slice(0, equal)] = part.slice(equal + 1);
  }
  const credential = attributes.Credential;
  const signedHeaders = attributes.SignedHeaders;
  const signature = attributes.Signature;
  if (!credential || !signedHeaders || !signature) fail('SIGNATURE_MISMATCH');
  const scope = credential.split('/');
  if (scope.length !== 5 || scope[4] !== 'aws4_request' || !validAccessKey(scope[0]) || !scope[1] || !scope[2] || !scope[3]) {
    fail('SIGNATURE_MISMATCH');
  }
  return {
    credential: scope[0],
    date: scope[1],
    region: scope[2],
    service: scope[3],
    signedHeaders,
    signature,
  };
}

function equalText(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Verify one request against a credential resolver. The resolver is called
 * only with the access key from Authorization; x-amz-credentials is ignored.
 * It may return an account synchronously or null. The result includes the
 * resolved account so callers can use the cryptographically authenticated
 * identity without parsing a public header.
 */
export function verifySigV4({
  method = 'POST',
  path = '/',
  headers = {},
  body = '',
  bodyDigest,
  now = new Date(),
  resolveCredentials,
} = {}) {
  const normalized = normalizeHeaders(headers);
  const authorization = headerValue(normalized, 'authorization');
  // AuthController checks for the authorization header before entering its
  // detailed date/algorithm parser. Preserve that observable ordering when a
  // request is missing both headers.
  if (!authorization) fail('MISSING_AUTH_HEADER');
  const requestDateTime = headerValue(normalized, 'x-amz-date') || headerValue(normalized, 'date');
  if (!requestDateTime) fail('MISSING_DATE_HEADER');
  const datetime = amzDate(requestDateTime);
  const parsedDate = parseDate(requestDateTime);
  const nowDate = parseDate(now);
  if (!datetime || !Number.isFinite(parsedDate.getTime()) || !Number.isFinite(nowDate.getTime())
      || Math.abs(parsedDate.getTime() - nowDate.getTime()) > SIGV4_CLOCK_SKEW_MS) {
    fail('CLOCK_SKEW_TOO_LONG');
  }

  const parsed = parseAuthorization(authorization);
  if (parsed.date !== scopeDate(datetime)) fail('SIGNATURE_MISMATCH');
  if (typeof resolveCredentials !== 'function') fail('ACCOUNT_SERVICE_UNAVAILABLE');

  let credentials;
  try {
    credentials = resolveCredentials(parsed.credential);
  } catch (error) {
    fail('ACCOUNT_SERVICE_UNAVAILABLE', error);
  }
  if (!credentials) fail('ACCESS_KEY_NOT_FOUND');
  if (!credentials.isActive) fail('ACCOUNT_NOT_ACTIVE');
  if (!credentials.secretAccessKey) fail('ACCESS_KEY_NOT_FOUND');

  const request = canonicalRequest({
    method,
    path,
    headers: normalized,
    body,
    bodyDigest,
    signedHeaders: parsed.signedHeaders,
    service: parsed.service,
  });
  const expectedSignature = signatureFor({
    secretAccessKey: credentials.secretAccessKey,
    datetime,
    region: parsed.region,
    service: parsed.service,
    request,
  });
  const expected = `${SIGV4_ALGORITHM} Credential=${parsed.credential}/${credentialScope(datetime, parsed.region, parsed.service)}, SignedHeaders=${signedHeaderNames(normalized, parsed.signedHeaders).join(';')}, Signature=${expectedSignature}`;
  if (!equalText(expected, headerValue(normalized, 'authorization'))) fail('SIGNATURE_MISMATCH');

  return {
    accessKeyId: parsed.credential,
    region: parsed.region,
    service: parsed.service,
    credentials,
    canonicalRequest: request,
  };
}
