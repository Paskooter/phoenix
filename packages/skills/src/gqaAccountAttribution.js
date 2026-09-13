// Source-backed account and attribution seams for the opt-in GQA profile.
//
// Source: jiborobot/srv-gqa-ws@ebe1a7d38f511570060c1fbf61bec89d58419b26,
// gqa/account.py and gqa/attribute.py.  The source account lookup uses a
// configured HTTP endpoint; attribution uses a Mongo collection.  Neither
// boundary has a Phoenix default, so selecting one is always explicit.

import { isIP } from 'node:net';
import { verifySigV4 } from '@phoenix/common';
import { redactProviderUrl, redactProviderUrls } from './gqaProviderUrl.js';

export const GQA_ACCOUNT_SOURCE_REVISION = 'ebe1a7d38f511570060c1fbf61bec89d58419b26';
export const GQA_ACCOUNT_SOURCE_MODULE = 'gqa/account.py';
export const GQA_ATTRIBUTE_SOURCE_REVISION = 'ebe1a7d38f511570060c1fbf61bec89d58419b26';
export const GQA_ATTRIBUTE_SOURCE_MODULE = 'gqa/attribute.py';
export const GQA_ACCOUNT_SERVICE_ENV = 'ETCO_server_accountService';
export const GQA_ATTRIBUTION_TRUSTED_INTERNAL_ENV = 'PHOENIX_GQA_ATTRIBUTION_TRUSTED_INTERNAL';
export const GQA_ATTRIBUTION_TRUSTED_INTERNAL_ADDRESSES_ENV = 'PHOENIX_GQA_ATTRIBUTION_TRUSTED_INTERNAL_ADDRESSES';
export const GQA_ATTRIBUTION_AUTHORIZATION_REQUIRED_MESSAGE = 'Attribution authorization required';
export const GQA_ATTRIBUTION_AUTHORIZATION_NOT_CONFIGURED_MESSAGE = 'Attribution authorization is not configured';
export const GQA_ATTRIBUTION_ACCESS_DENIED_MESSAGE = 'Attribution access denied';
export const GQA_INTERNAL_ERROR_MESSAGE = 'Internal server error';

const LOOPBACK_REMOTE_ADDRESSES = Object.freeze(['127.0.0.1', '::1']);

// gqa/attribute.py creates this index after every insert.  The object form is
// the native Node Mongo representation of the same ordered source keys.
export const GQA_ATTRIBUTE_INDEX = Object.freeze({
  loop_id: -1,
  timestamp: -1,
  service: -1,
});

// Flask/Werkzeug's malformed and empty JSON requests use this same standard
// 400 body. It is kept at the opt-in attribution route boundary; other
// Phoenix routes continue using the common JSON error action.
const SOURCE_BAD_REQUEST_HTML = '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 3.2 Final//EN">\n'
  + '<title>400 Bad Request</title>\n<h1>Bad Request</h1>\n'
  + '<p>The browser (or proxy) sent a request that this server could not understand.</p>\n';

function escapeNonAscii(json) {
  // Python json.dumps defaults to ensure_ascii=True.  Deliberately iterate
  // UTF-16 code units so astral values become the same pair of \u escapes.
  return json.replace(/[\u0080-\uFFFF]/g, (character) => (
    `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
  ));
}

/** The subset of Python json.dumps needed by account/attribution payloads. */
export function sourceJsonDumps(value) {
  if (value === undefined) throw new TypeError('undefined is not JSON serializable');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    const json = JSON.stringify(value);
    return typeof value === 'string' ? escapeNonAscii(json) : json;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite number is not JSON serializable');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(sourceJsonDumps).join(', ')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value).map(([key, item]) => (
      `${escapeNonAscii(JSON.stringify(key))}: ${sourceJsonDumps(item)}`
    )).join(', ')}}`;
  }
  throw new TypeError(`${typeof value} is not JSON serializable`);
}

/** Python truthiness for JSON values used by account/attribution branches. */
export function sourceTruthy(value) {
  if (value === null || value === undefined || value === false || value === 0 || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function sourceObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a mapping`);
  }
  return value;
}

function requiredField(value, name, label) {
  const object = sourceObject(value, label);
  if (!Object.prototype.hasOwnProperty.call(object, name)) {
    throw new TypeError(`${label} is missing '${name}'`);
  }
  return object[name];
}

/** An HTTP error whose public message is deliberately fixed and safe. */
class GqaAttributionHttpError extends Error {
  constructor(statusCode, publicMessage, cause) {
    super(publicMessage);
    this.name = 'GqaAttributionHttpError';
    this.statusCode = statusCode;
    this.publicMessage = publicMessage;
    if (cause !== undefined) this.cause = cause;
  }
}

function isGqaAttributionHttpError(error) {
  try {
    return error instanceof GqaAttributionHttpError;
  } catch {
    return false;
  }
}

function normalizedRemoteAddress(value) {
  const address = String(value || '').trim().toLowerCase();
  if (address.startsWith('::ffff:') && isIP(address.slice('::ffff:'.length)) === 4) {
    return address.slice('::ffff:'.length);
  }
  return address;
}

function configuredRemoteAddresses(value) {
  const addresses = value === undefined
    ? [...LOOPBACK_REMOTE_ADDRESSES]
    : Array.isArray(value) ? value : String(value).split(',');
  const normalized = addresses.map((address) => normalizedRemoteAddress(address)).filter(Boolean);
  if (normalized.length === 0 || normalized.some((address) => isIP(address) === 0)) {
    throw new TypeError('GQA trusted internal addresses must contain valid IP addresses');
  }
  return Object.freeze([...new Set(normalized)]);
}

function configuredTrustedInternal(value) {
  if (value === true) {
    return Object.freeze({ mode: 'trusted-internal', remoteAddresses: configuredRemoteAddresses() });
  }
  if (value === false || value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value) || value.mode !== 'trusted-internal') {
    throw new TypeError("GQA trusted internal authorization must use mode 'trusted-internal'");
  }
  return Object.freeze({
    mode: 'trusted-internal',
    remoteAddresses: configuredRemoteAddresses(value.remoteAddresses),
  });
}

/**
 * Read the only legacy authorization mode supported by the GQA attribution
 * routes. It is intentionally disabled unless an operator explicitly opts in.
 * The default allowlist is loopback; remote deployments must name the exact
 * socket peer addresses and must keep the service behind their authenticated
 * front door. X-Forwarded-For is never consulted.
 */
export function readGqaAttributionAuthConfig(env = process.env) {
  const enabled = String(env?.[GQA_ATTRIBUTION_TRUSTED_INTERNAL_ENV] ?? '').trim().toLowerCase();
  if (!enabled || ['0', 'false', 'no', 'off'].includes(enabled)) return undefined;
  if (!['1', 'true', 'yes', 'on'].includes(enabled)) {
    throw new TypeError(`${GQA_ATTRIBUTION_TRUSTED_INTERNAL_ENV} must be true or false`);
  }
  return Object.freeze({
    trustedInternal: configuredTrustedInternal({
      mode: 'trusted-internal',
      remoteAddresses: env?.[GQA_ATTRIBUTION_TRUSTED_INTERNAL_ADDRESSES_ENV],
    }),
  });
}

function normalizedCaller(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const accountId = value.accountId ?? value.accountID ?? value._id ?? value.id;
  if (typeof accountId !== 'string' || accountId.length === 0) return null;
  return Object.freeze({ accountId, isAdmin: value.isAdmin === true });
}

function defaultAccountIdFromCredentials(credentials) {
  if (credentials === null || typeof credentials !== 'object' || Array.isArray(credentials)) {
    throw new Error('Verified credentials do not identify an account');
  }
  const accountId = credentials.accountId
    ?? credentials.accountID
    ?? credentials._id
    ?? credentials.id;
  if (typeof accountId !== 'string' || accountId.length === 0) {
    throw new Error('Verified credentials do not identify an account');
  }
  return accountId;
}

function requestPathForSigV4(request) {
  const path = request?.originalUrl ?? request?.url;
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('GQA attribution request URL is required for signature verification');
  }
  if (path.includes('?')) {
    // The attribution endpoints do not use query parameters. Reject them so
    // every request-target byte remains bound until common canonicalization is
    // updated to preserve nested question marks.
    throw new Error('GQA attribution request URL query parameters are not supported');
  }
  return path;
}

function requestMethodForSigV4(request) {
  const method = request?.method;
  if (typeof method !== 'string' || method.trim() === '') {
    throw new Error('GQA attribution HTTP method is required for signature verification');
  }
  return method;
}

function requestBodyForSigV4(request) {
  if (!request || request.rawBody === undefined) {
    // Never reconstruct a signed entity from the parsed JSON object. A
    // production HTTP request must pass through createService's raw-body
    // capture hook before this verifier is invoked.
    throw new Error('GQA attribution raw request body is required for signature verification');
  }
  if (Buffer.isBuffer(request.rawBody) || typeof request.rawBody === 'string') return request.rawBody;
  throw new Error('GQA attribution raw request body is not a byte string');
}

function rejectCompressedRequestEncoding(headers) {
  if (headers === null || typeof headers !== 'object') return;
  const encodings = [];
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== 'content-encoding') continue;
    if (typeof value !== 'string') {
      throw new Error('GQA SigV4 content encoding header is invalid');
    }
    encodings.push(...value.split(',').map((encoding) => encoding.trim().toLowerCase()).filter(Boolean));
  }
  if (encodings.some((encoding) => encoding !== 'identity')) {
    // createService captures the post-inflation body. Reject compressed
    // requests rather than authenticating bytes different from the wire body.
    throw new Error('GQA SigV4 compressed content encoding is not supported');
  }
}

/**
 * Build a production attribution verifier from the repository SigV4 boundary.
 *
 * `resolveCredentials(accessKeyId)` is passed directly to @phoenix/common's
 * verifier and must return the active credential record containing
 * `secretAccessKey` (or null). `accountLookup(accountId)` runs only after the
 * signature is valid and maps the account identifier from that trusted record
 * to an account object containing `_id`/`accountId`/`id` and optional `isAdmin`.
 * Both callbacks are deployment-owned; neither receives request body fields or
 * the legacy x-amz-credentials header.
 */
export function createGqaSigV4CallerVerifier({
  resolveCredentials,
  accountLookup,
  clock = () => new Date(),
  allowNativeClientPayloadHash = false,
} = {}) {
  if (typeof resolveCredentials !== 'function') {
    throw new TypeError('GQA SigV4 caller verifier requires resolveCredentials');
  }
  if (typeof accountLookup !== 'function') {
    throw new TypeError('GQA SigV4 caller verifier requires accountLookup');
  }
  if (typeof clock !== 'function') throw new TypeError('GQA SigV4 caller verifier clock must be a function');
  if (typeof allowNativeClientPayloadHash !== 'boolean') {
    throw new TypeError('GQA SigV4 caller verifier allowNativeClientPayloadHash must be boolean');
  }
  if (allowNativeClientPayloadHash) {
    throw new TypeError('GQA SigV4 caller verifier allowNativeClientPayloadHash must remain disabled');
  }

  return async function verifyGqaSigV4Caller(request) {
    const method = requestMethodForSigV4(request);
    const path = requestPathForSigV4(request);
    const headers = request && request.headers;
    const body = requestBodyForSigV4(request);
    rejectCompressedRequestEncoding(headers);
    const verification = verifySigV4({
      method,
      path,
      headers,
      body,
      now: clock(),
      resolveCredentials,
      allowNativeClientPayloadHash,
    });
    const accountId = defaultAccountIdFromCredentials(verification.credentials);
    if (verification.credentials.isDeleted === true || verification.credentials.isActive !== true) {
      throw new Error('GQA SigV4 credentials are not active');
    }
    if (typeof accountId !== 'string' || accountId.length === 0) {
      throw new Error('GQA SigV4 account identity is invalid');
    }
    const account = await accountLookup(accountId);
    if (!account || typeof account !== 'object' || Array.isArray(account)
      || account.isDeleted === true || account.isActive !== true) {
      throw new Error('GQA SigV4 account is not active or unavailable');
    }
    const caller = normalizedCaller(account);
    if (!caller || caller.accountId !== accountId) {
      throw new Error('GQA SigV4 account identity is unavailable');
    }
    return caller;
  };
}

function remoteAddress(request) {
  return normalizedRemoteAddress(request?.socket?.remoteAddress ?? request?.connection?.remoteAddress);
}

function legacyCredentialsFromRequest(request) {
  const headers = request?.headers || {};
  const raw = headers['x-amz-credentials'] ?? headers['X-Amz-Credentials'];
  if (raw === undefined) throw new Error("Missing 'x-amz-credentials' header");
  const credentials = sourceObject(JSON.parse(raw), 'x-amz-credentials');
  requiredField(credentials, 'id', 'x-amz-credentials');
  return credentials;
}

/**
 * Build the attribution identity boundary. `verifyCaller` is the production
 * seam: it must cryptographically verify the request (or consume identity
 * verified by a trusted front door) and return `{ accountId, isAdmin }`.
 * It receives the transport request only; route bodies and identity headers
 * are never used by the ownership checks. The legacy header is accepted only
 * inside the explicit, socket-address-bound trusted-internal mode.
 */
export function createGqaAttributionAuthorizer({ verifyCaller, trustedInternal } = {}) {
  if (verifyCaller !== undefined && typeof verifyCaller !== 'function') {
    throw new TypeError('GQA attribution verifyCaller must be a function');
  }
  if (verifyCaller !== undefined && trustedInternal !== undefined && trustedInternal !== false) {
    throw new TypeError('GQA attribution authorization must choose verifyCaller or trustedInternal');
  }
  const trusted = configuredTrustedInternal(trustedInternal);
  if (verifyCaller) {
    return async function verifyAttributionCaller(request) {
      try {
        return normalizedCaller(await verifyCaller(request));
      } catch (error) {
        throw new GqaAttributionHttpError(401, GQA_ATTRIBUTION_AUTHORIZATION_REQUIRED_MESSAGE, error);
      }
    };
  }
  if (trusted) {
    return async function authorizeTrustedInternal(request) {
      if (!trusted.remoteAddresses.includes(remoteAddress(request))) return null;
      try {
        return normalizedCaller(legacyCredentialsFromRequest(request));
      } catch (error) {
        throw new GqaAttributionHttpError(401, GQA_ATTRIBUTION_AUTHORIZATION_REQUIRED_MESSAGE, error);
      }
    };
  }
  return async function denyUnconfiguredAttributionCaller() {
    throw new GqaAttributionHttpError(503, GQA_ATTRIBUTION_AUTHORIZATION_NOT_CONFIGURED_MESSAGE);
  };
}

const GQA_ERROR_NAME_MAX_LENGTH = 128;
const GQA_ERROR_CODE_MAX_LENGTH = 128;
const GQA_ERROR_MESSAGE_MAX_LENGTH = 512;
const GQA_ERROR_CONTROL_CHAR_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]/gu;

function safeErrorProperty(error, property) {
  try {
    return error?.[property];
  } catch {
    return undefined;
  }
}

function sanitizeErrorText(value, fallback = 'Unknown GQA attribution failure', maxLength = GQA_ERROR_MESSAGE_MAX_LENGTH) {
  let text;
  try {
    text = value === undefined || value === null || value === '' ? fallback : String(value);
  } catch {
    text = fallback;
  }
  // Redact credential-shaped text before escaping so control characters cannot
  // split a sensitive value away from its marker. Repeat after escaping in
  // case the marker itself contained a control character.
  const escaped = redactErrorCredentials(text)
    .replace(GQA_ERROR_CONTROL_CHAR_RE, (character) => (
      `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
    ));
  return redactErrorCredentials(escaped).slice(0, maxLength);
}

const GQA_CREDENTIAL_ASSIGNMENT_RE = /((?:["']?)(?:authorization|cookie|x-amz-credentials|api[_-]?key|secret(?:[_-]?access[_-]?key)?|password|passwd|token|access[_-]?key(?:[_-]?id)?|credentials?)(?:["']?)\s*[:=]\s*)[^\r\n]*/gi;
const GQA_CREDENTIAL_ASSIGNMENT_DETECT_RE = /(?:["']?)(?:authorization|cookie|x-amz-credentials|api[_-]?key|secret(?:[_-]?access[_-]?key)?|password|passwd|token|access[_-]?key(?:[_-]?id)?|credentials?)(?:["']?)\s*[:=]\s*/i;
const GQA_AUTH_SCHEME_RE = /\b(Bearer|Basic)\s+[^\r\n]*/gi;
const GQA_AUTH_SCHEME_VALUE_RE = /\b(?:Bearer|Basic)\s+([^\r\n\s,;]+)/gi;
const GQA_AUTH_SCHEME_COMPACT_VALUE_RE = /\b(?:Bearer|Basic)([a-z0-9+/=._~-]+)/gi;
const GQA_AUTH_SCHEME_OBFUSCATED_BOUNDARY_RE = /\b(?:Bearer|Basic)(?=[^\sA-Z0-9])/i;
const GQA_AUTH_SCHEME_DIAGNOSTIC_WORDS = new Set([
  'auth',
  'authentication',
  'authorization',
  'configured',
  'configuration',
  'error',
  'failed',
  'failure',
  'header',
  'headers',
  'information',
  'invalid',
  'is',
  'missing',
  'mode',
  'not',
  'operation',
  'request',
  'required',
  'scheme',
  'unavailable',
  'value',
  'values',
  'with',
]);
const GQA_NAMED_ENTITY_CODE_POINTS = Object.freeze({
  amp: 38,
  apos: 39,
  bsol: 92,
  colon: 58,
  equals: 61,
  gt: 62,
  lt: 60,
  nbsp: 160,
  percnt: 37,
  quot: 34,
  tab: 9,
  newline: 10,
  carriage_return: 13,
});
const GQA_UNRESOLVED_ENCODING_SENTINEL = String.fromCharCode(0xe000) + 'GQA_UNRESOLVED_ENCODING';
const GQA_CREDENTIAL_KEY_WORDS = Object.freeze([
  'authorization',
  'cookie',
  'x-amz-credentials',
  'api_key',
  'api-key',
  'apikey',
  'secret',
  'secret_access_key',
  'secret-access-key',
  'secretaccesskey',
  'password',
  'passwd',
  'token',
  'access_key',
  'access-key',
  'accesskey',
  'access_key_id',
  'access-key-id',
  'accesskeyid',
  'credential',
  'credentials',
]);
const GQA_POSSIBLE_ASSIGNMENT_RE = /["']?([^"'\s:=]{1,64})["']?\s*[:=]\s*/gu;

function decodeErrorCodePoint(code, radix) {
  const value = Number.parseInt(code, radix);
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff
    ? String.fromCodePoint(value)
    : '';
}

function decodeErrorEscapes(text) {
  // Keep backslashes intact until all escape layers are decoded; collapse
  // repeated layers immediately before decoding the innermost marker.
  return text
    // Decode named entities before escape/percent passes so an entity that
    // introduces an escape delimiter is processed in this pass.
    .replace(/&([a-z][a-z0-9_]*);/gi, (match, name) => {
      const codePoint = GQA_NAMED_ENTITY_CODE_POINTS[name.toLowerCase()];
      return codePoint === undefined ? match : String.fromCodePoint(codePoint);
    })
    // Collapse repeated escape layers before decoding the innermost marker.
    .replace(new RegExp(String.fromCharCode(92).repeat(2) + '{2,}', 'g'), String.fromCharCode(92))
    // Treat short control escapes as separators for marker detection.
    .replace(/\\([bfnrt])/gi, '')
    .replace(/\\([0-7]{1,3})/g, (_match, code) => decodeErrorCodePoint(code, 8))
    .replace(/\\U([0-9A-Fa-f]{8})/g, (_match, code) => decodeErrorCodePoint(code, 16))
    .replace(/\\u\{([0-9a-f]{1,6})\}/gi, (_match, code) => decodeErrorCodePoint(code, 16))
    .replace(/\\u([0-9A-Fa-f]{4})/g, (_match, code) => decodeErrorCodePoint(code, 16))
    .replace(/%U\{([0-9a-f]{1,6})\}/gi, (_match, code) => decodeErrorCodePoint(code, 16))
    .replace(/%U([0-9A-Fa-f]{8})/g, (_match, code) => decodeErrorCodePoint(code, 16))
    .replace(/%u\{([0-9a-f]{1,6})\}/gi, (_match, code) => decodeErrorCodePoint(code, 16))
    .replace(/%u([0-9A-Fa-f]{4})/g, (_match, code) => decodeErrorCodePoint(code, 16))
    .replace(/\\x([0-9a-f]{2})/gi, (_match, code) => decodeErrorCodePoint(code, 16))
    .replace(/(?:%[0-9a-f]{2})+/gi, (encoded) => {
      try {
        const decoded = decodeURIComponent(encoded);
        return decoded;
      } catch {
        return GQA_UNRESOLVED_ENCODING_SENTINEL;
      }
    })
    // Treat malformed/unknown percent spellings as separators for marker detection.
    .replace(/%(?:[g-z]{1,2}|[0-9a-f](?![0-9a-f]))/gi, '')
    .replace(/&#x([0-9a-f]{1,6});?/gi, (_match, code) => decodeErrorCodePoint(code, 16))
    .replace(/&#([0-9]{1,7});?/g, (_match, code) => decodeErrorCodePoint(code, 10))
    // Treat unknown escape/entity spellings as separators for marker detection.
    .replace(new RegExp(String.fromCharCode(92).repeat(2) + '.', 'g'), '')
    .replace(/&[a-z][a-z0-9_]*;/gi, '');
}

function normalizeErrorCredentialText(text) {
  let normalized = text.normalize('NFKC');
  for (let pass = 0; pass < 32; pass += 1) {
    const decoded = decodeErrorEscapes(normalized)
      .normalize('NFKC')
      .replace(GQA_ERROR_CONTROL_CHAR_RE, '');
    if (decoded.includes(GQA_UNRESOLVED_ENCODING_SENTINEL)) return null;
    if (decoded === normalized) return decoded.replace(/\\/g, '');
    normalized = decoded;
  }
  return null;
}

function editDistanceAtMost(left, right, limit) {
  const leftCharacters = [...left];
  const rightCharacters = [...right];
  if (Math.abs(leftCharacters.length - rightCharacters.length) > limit) return false;
  let previous = Array.from({ length: rightCharacters.length + 1 }, (_character, index) => index);
  for (let leftIndex = 1; leftIndex <= leftCharacters.length; leftIndex += 1) {
    const current = [leftIndex];
    let rowMinimum = current[0];
    for (let rightIndex = 1; rightIndex <= rightCharacters.length; rightIndex += 1) {
      const substitutionCost = leftCharacters[leftIndex - 1] === rightCharacters[rightIndex - 1] ? 0 : 1;
      const value = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + substitutionCost,
      );
      current[rightIndex] = value;
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > limit) return false;
    previous = current;
  }
  return previous[rightCharacters.length] <= limit;
}

function hasCredentialLikeAssignment(text) {
  for (const match of text.matchAll(GQA_POSSIBLE_ASSIGNMENT_RE)) {
    const key = match[1].toLowerCase();
    // Fuzzy matching is only for Unicode/confusable obfuscation. Treating
    // ordinary ASCII plurals such as "tokens" as credentials is too broad.
    if (!/[^\x00-\x7f]/u.test(key)) continue;
    if (GQA_CREDENTIAL_KEY_WORDS.some((candidate) => editDistanceAtMost(key, candidate, 1))) return true;
  }
  return false;
}

function hasAuthSchemeCredential(text, valuePattern) {
  for (const match of text.matchAll(valuePattern)) {
    if (!GQA_AUTH_SCHEME_DIAGNOSTIC_WORDS.has(match[1].toLowerCase())) return true;
  }
  return false;
}

function redactErrorCredentials(text) {
  const normalized = normalizeErrorCredentialText(text);
  // Unknown/deeply nested encodings are not safe to preserve: the bounded
  // normalization pass may not have reached a hidden credential marker.
  if (normalized === null) return '[REDACTED]';
  // Remove Unicode whitespace for detection only. This catches markers split
  // by non-ASCII spacing without changing ordinary diagnostic text.
  const compact = normalized.replace(/\s+/gu, '');
  // Only redact credential indicators when they introduce a value. Ordinary
  // diagnostics such as "Attribution authorization is not configured" and
  // stable codes such as ACCESS_KEY_NOT_FOUND remain useful.
  const compactChanged = compact !== normalized;
  const normalizedAuthScheme = hasAuthSchemeCredential(normalized, GQA_AUTH_SCHEME_VALUE_RE);
  const compactAuthScheme = hasAuthSchemeCredential(compact, GQA_AUTH_SCHEME_COMPACT_VALUE_RE);
  const normalizedExactCredential = GQA_CREDENTIAL_ASSIGNMENT_DETECT_RE.test(normalized)
    || normalizedAuthScheme;
  const compactCredential = GQA_CREDENTIAL_ASSIGNMENT_DETECT_RE.test(compact);
  const fuzzyCredential = hasCredentialLikeAssignment(normalized)
    || hasCredentialLikeAssignment(compact);
  const normalizedHasCredential = normalizedExactCredential
    || compactCredential
    || fuzzyCredential
    || (normalized !== text
      && compactAuthScheme
      && GQA_AUTH_SCHEME_OBFUSCATED_BOUNDARY_RE.test(text));
  const originalHasCredential = GQA_CREDENTIAL_ASSIGNMENT_DETECT_RE.test(text)
    || hasAuthSchemeCredential(text, GQA_AUTH_SCHEME_VALUE_RE);
  if (!normalizedHasCredential && !originalHasCredential) return text;
  // If normalization/compaction changed the input, or fuzzy detection found a
  // marker, a raw replacement cannot prove every encoded marker was covered.
  if (normalized !== text || !originalHasCredential || (compactChanged && compactCredential) || fuzzyCredential) {
    return '[REDACTED]';
  }
  return text
    .replace(GQA_CREDENTIAL_ASSIGNMENT_RE, '$1[REDACTED]')
    .replace(GQA_AUTH_SCHEME_RE, '$1 [REDACTED]');
}

/** Return diagnostic detail safe for internal logs; never includes a stack. */
export function safeGqaErrorDetail(error) {
  const name = safeErrorProperty(error, 'name');
  const code = safeErrorProperty(error, 'code');
  const message = safeErrorProperty(error, 'message');
  const fallbackMessage = message === undefined || message === null || message === ''
    ? (error !== null && error !== undefined
      && ['string', 'number', 'boolean', 'bigint', 'symbol'].includes(typeof error) ? error : undefined)
    : message;
  return {
    name: sanitizeErrorText(name, 'Error', GQA_ERROR_NAME_MAX_LENGTH),
    ...(code === undefined || code === null || code === ''
      ? {} : { code: sanitizeErrorText(code, 'Unknown GQA attribution error code', GQA_ERROR_CODE_MAX_LENGTH) }),
    message: sanitizeErrorText(fallbackMessage),
  };
}

export function safeGqaErrorCause(error) {
  const cause = safeErrorProperty(error, 'cause');
  return cause === undefined ? undefined : safeGqaErrorDetail(cause);
}

function logGqaAttributionError(context, error) {
  const fields = { error: safeGqaErrorDetail(error) };
  const cause = safeGqaErrorCause(error);
  if (cause !== undefined) fields.cause = cause;
  context?.log?.error?.('GQA attribution request failed', fields);
}

function sourceError(error) {
  const publicMessage = isGqaAttributionHttpError(error)
    ? safeErrorProperty(error, 'publicMessage')
    : GQA_INTERNAL_ERROR_MESSAGE;
  return {
    version: '5.2.15',
    // The legacy source included a stack field here. Keep the version/message envelope
    // but never place internal messages, credentials, or stack frames on wire.
    message: typeof publicMessage === 'string' ? publicMessage : GQA_INTERNAL_ERROR_MESSAGE,
  };
}

function accountKey(value) {
  // JSON object keys use Python's JSON spelling for the values that can reach
  // the source account call through a request body.
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  return String(value);
}

function configuredEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length === 0) {
    throw new TypeError('GQA account service endpoint must be configured explicitly');
  }
  return endpoint;
}

/**
 * Construct the source account.get_loop_id boundary.
 *
 * The source intentionally does not inspect HTTP status: it calls
 * response.json() and indexes the returned mapping. Network/JSON failures
 * return a fresh empty object; a structurally invalid successful mapping is
 * allowed to remain visible to the caller, matching the source's access
 * outside its try/except block.
 */
export function createGqaAccountLookup({ endpoint, fetchImpl = globalThis.fetch } = {}) {
  const accountEndpoint = configuredEndpoint(endpoint);
  if (typeof fetchImpl !== 'function') throw new TypeError('GQA account fetch implementation must be a function');

  return async function getLoopId(userId) {
    let accountServiceOutput;
    try {
      const response = await fetchImpl(accountEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: sourceJsonDumps({ accountsIds: [userId] }),
      });
      if (!response || typeof response.json !== 'function') throw new TypeError('GQA account response has no json() method');
      accountServiceOutput = await response.json();
    } catch (_error) {
      return {};
    }

    const mapping = sourceObject(accountServiceOutput, 'account service response');
    const key = accountKey(userId);
    if (!Object.prototype.hasOwnProperty.call(mapping, key)) {
      // account.py uses account_service_output[user_id], so a missing source
      // key is a visible post-HTTP failure rather than an empty successful map.
      throw new Error(`Account service response is missing '${key}'`);
    }
    const loopValues = mapping[key];
    if (!sourceTruthy(loopValues)) return {};
    if (loopValues === null || loopValues === undefined || typeof loopValues[0] === 'undefined') {
      throw new TypeError(`Account service value for '${key}' is not indexable`);
    }
    return loopValues[0];
  };
}

function timestampMs(clock) {
  const value = clock();
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('GQA attribution clock must return a finite number');
  return Math.trunc(value);
}

// Python compares a truthy JSON timestamp with an integer before building the
// Mongo query. JavaScript's relational operators would coerce strings,
// arrays, and objects instead, turning a source TypeError into a successful
// (and often different) query. Booleans remain numeric in Python and are
// therefore deliberately accepted here.
function sourceTimestamp(value, label) {
  if (sourceTruthy(value)
    && typeof value !== 'number'
    && typeof value !== 'boolean') {
    throw new TypeError(`${label} must be numeric`);
  }
  return value;
}

function attributionRecord(service, query, url, imageUrl, loopId, clock) {
  return {
    service,
    query,
    url: redactProviderUrl(url),
    image_url: redactProviderUrl(imageUrl),
    loop_id: loopId,
    timestamp: timestampMs(clock),
  };
}

async function collectCursor(cursor) {
  if (cursor && typeof cursor[Symbol.asyncIterator] === 'function') {
    const values = [];
    for await (const item of cursor) values.push(item);
    return values;
  }
  if (cursor && typeof cursor[Symbol.iterator] === 'function') return [...cursor];
  throw new TypeError('GQA attribution collection.find() must return an iterable cursor');
}

/** Wrap a real Mongo-style `DATABASE.attributes` collection. */
export function createGqaAttributionStore({ collection, clock = Date.now } = {}) {
  if (!collection || typeof collection.insertOne !== 'function'
    || typeof collection.createIndex !== 'function'
    || typeof collection.find !== 'function' || typeof collection.deleteMany !== 'function') {
    throw new TypeError('GQA attribution collection must provide Mongo insertOne/createIndex/find/deleteMany methods');
  }

  return Object.freeze({
    async insert(service, query, url, imageUrl, loopId) {
      const record = attributionRecord(service, query, url, imageUrl, loopId, clock);
      await collection.insertOne(record);
      await collection.createIndex(GQA_ATTRIBUTE_INDEX);
    },

    async search(loopId, service, before, after) {
      const threshold = timestampMs(clock) - (90 * 24 * 60 * 60 * 1000);
      sourceTimestamp(after, 'after');
      if (!sourceTruthy(after) || after < threshold) after = threshold;
      const timestamp = { $gt: after };
      if (sourceTruthy(before)) timestamp.$lt = before;
      const query = { loop_id: loopId, timestamp };
      if (sourceTruthy(service)) query.service = service;
      // The source passes a PyMongo projection as its second positional
      // argument. Node's modern Mongo driver takes FindOptions there, so the
      // equivalent projection must be nested under `projection`.
      const cursor = collection.find(query, { projection: { _id: 0 } });
      const limited = cursor && typeof cursor.limit === 'function' ? cursor.limit(50) : cursor;
      return (await collectCursor(limited)).map((record) => redactProviderUrls(record));
    },

    async wipe(loopId) {
      const result = await collection.deleteMany({ loop_id: loopId });
      return result?.deletedCount ?? result?.deleted_count ?? 0;
    },
  });
}

/**
 * Deterministic offline store with the source Mongo query semantics.  It is a
 * test/deployment seam only; the profile never selects it implicitly.
 */
export function createGqaMemoryAttributionStore({ clock = Date.now } = {}) {
  const records = [];
  return Object.freeze({
    async insert(service, query, url, imageUrl, loopId) {
      records.push(attributionRecord(service, query, url, imageUrl, loopId, clock));
    },

    async search(loopId, service, before, after) {
      const threshold = timestampMs(clock) - (90 * 24 * 60 * 60 * 1000);
      sourceTimestamp(after, 'after');
      if (!sourceTruthy(after) || after < threshold) after = threshold;
      // Stored timestamps are numeric. Mongo's range operators bracket BSON
      // types; a truthy nonnumeric bound matches no numeric timestamp. The
      // source passes `before` to Mongo without a Python numeric comparison.
      if (typeof after !== 'number'
        || (sourceTruthy(before) && typeof before !== 'number')) return [];
      return records
        .filter((record) => record.loop_id === loopId
          && (!sourceTruthy(service) || record.service === service)
          && record.timestamp > after
          && (!sourceTruthy(before) || record.timestamp < before))
        .slice(0, 50)
        .map((record) => ({ ...record }));
    },

    async wipe(loopId) {
      let count = 0;
      for (let index = records.length - 1; index >= 0; index -= 1) {
        if (records[index].loop_id === loopId) {
          records.splice(index, 1);
          count += 1;
        }
      }
      return count;
    },

    snapshot() {
      return records.map((record) => ({ ...record }));
    },
  });
}

function sendSourceJson(context, value, status = 200) {
  const response = context?.res;
  const body = sourceJsonDumps(value);
  if (response && typeof response.status === 'function'
    && typeof response.type === 'function' && typeof response.send === 'function') {
    response.status(status).type('html').send(body);
    return undefined;
  }
  return value;
}

function sourceRequestMapping(body) {
  return sourceObject(body, 'request JSON');
}

function requestContentType(request) {
  const headers = request?.headers || {};
  const value = headers['content-type'] ?? headers['Content-Type'];
  if (value === undefined || value === null) return undefined;
  return String(value).split(';', 1)[0].trim().toLowerCase();
}

function requestHasEntity(request) {
  const headers = request?.headers || {};
  const rawLength = headers['content-length'] ?? headers['Content-Length'];
  const length = Number(rawLength);
  if (Number.isFinite(length)) return length > 0;
  return headers['transfer-encoding'] !== undefined || headers['Transfer-Encoding'] !== undefined;
}

function isSourceJsonRequest(request) {
  const type = requestContentType(request);
  return type === 'application/json'
    || (type?.startsWith('application/') && type.endsWith('+json'));
}

function sourceRequestBody(context) {
  // Flask 0.12 accepts application/json and application/*+json. Keep
  // unsupported media out of the parser as well as this route's body access.
  if (!isSourceJsonRequest(context?.req)) return null;
  return context?.body;
}

function emptyJsonRequest(request) {
  return isSourceJsonRequest(request) && !requestHasEntity(request);
}

function sendSourceBadRequest(context) {
  const response = context?.res;
  if (response && typeof response.status === 'function'
    && typeof response.setHeader === 'function' && typeof response.end === 'function') {
    response.status(400);
    // Express's `res.set()` appends a charset to text media types. The source
    // Flask response has exactly `text/html`, so use Node's header primitive
    // for this opt-in framework error body.
    response.setHeader('Content-Type', 'text/html');
    response.setHeader('Content-Length', String(Buffer.byteLength(SOURCE_BAD_REQUEST_HTML)));
    response.end(SOURCE_BAD_REQUEST_HTML);
    return undefined;
  }
  if (response && typeof response.status === 'function'
    && typeof response.type === 'function' && typeof response.send === 'function') {
    response.status(400).type('html').send(SOURCE_BAD_REQUEST_HTML);
    return undefined;
  }
  return SOURCE_BAD_REQUEST_HTML;
}

function sourceParserError(context) {
  return sendSourceBadRequest(context);
}

function routeAuthorizer({ attributionAuth, verifyCaller, trustedInternal } = {}) {
  if (attributionAuth !== undefined) {
    if (typeof attributionAuth === 'function') return createGqaAttributionAuthorizer({ verifyCaller: attributionAuth });
    if (attributionAuth?.mode === 'trusted-internal') {
      return createGqaAttributionAuthorizer({ trustedInternal: attributionAuth });
    }
    return createGqaAttributionAuthorizer(attributionAuth);
  }
  return createGqaAttributionAuthorizer({ verifyCaller, trustedInternal });
}

async function requireAttributionCaller(authorize, context) {
  try {
    const caller = await authorize(context?.req);
    if (!caller) throw new GqaAttributionHttpError(401, GQA_ATTRIBUTION_AUTHORIZATION_REQUIRED_MESSAGE);
    return caller;
  } catch (error) {
    if (isGqaAttributionHttpError(error)) throw error;
    throw new GqaAttributionHttpError(401, GQA_ATTRIBUTION_AUTHORIZATION_REQUIRED_MESSAGE, error);
  }
}

function callerLoopIds(value) {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.filter((loopId) => typeof loopId === 'string' && loopId.length > 0))];
}

function attributionErrorStatus(error) {
  const statusCode = isGqaAttributionHttpError(error) ? safeErrorProperty(error, 'statusCode') : undefined;
  return Number.isInteger(statusCode) ? statusCode : 500;
}

/** Source `/retrieveAtt`, with caller-owned loop authorization. */
export function createGqaRetrieveAttributionRoute({
  accountLookup,
  attribution,
  attributionAuth,
  verifyCaller,
  trustedInternal,
} = {}) {
  if (typeof accountLookup !== 'function') throw new TypeError('GQA retrieveAtt requires an account lookup');
  if (!attribution || typeof attribution.search !== 'function') throw new TypeError('GQA retrieveAtt requires attribution storage');
  const authorize = routeAuthorizer({ attributionAuth, verifyCaller, trustedInternal });
  const route = async (context = {}) => {
    try {
      // Authentication must precede both body-derived work and account lookup.
      // The gateway's JWT is not forwarded to this HTTP service, so the default
      // authorizer denies rather than treating x-amz-credentials as identity.
      const caller = await requireAttributionCaller(authorize, context);
      // Flask rejects an empty application/json entity in request.json before
      // the account lookup. Keep that route-local 400 for authenticated calls.
      if (emptyJsonRequest(context.req)) return sendSourceBadRequest(context);
      const loopIds = callerLoopIds(await accountLookup(caller.accountId));
      if (loopIds.length === 0) {
        throw new GqaAttributionHttpError(403, GQA_ATTRIBUTION_ACCESS_DENIED_MESSAGE);
      }
      // Source performs the account call before data.get(), so top-level
      // JSON values retain the account side effect before their 500.
      const body = sourceRequestMapping(sourceRequestBody(context));
      const data = [];
      for (const loopId of loopIds) {
        data.push(...await attribution.search(loopId, body.Service, body.before, body.after));
      }
      return sendSourceJson(context, { data });
    } catch (error) {
      logGqaAttributionError(context, error);
      return sendSourceJson(context, sourceError(error), attributionErrorStatus(error));
    }
  };
  // Flask accepts top-level JSON values and lets the route produce its own
  // failure; the common service's loose parser gives this route that boundary.
  route.jsonStrict = false;
  route.jsonTypes = ['application/json', 'application/*+json'];
  route.bodyDefault = null;
  route.parserError = sourceParserError;
  return route;
}

/** Source `/wipeID`, restricted to the target loop owner or an admin. */
export function createGqaWipeAttributionRoute({
  attribution,
  accountLookup,
  attributionAuth,
  verifyCaller,
  trustedInternal,
} = {}) {
  if (!attribution || typeof attribution.wipe !== 'function') throw new TypeError('GQA wipeID requires attribution storage');
  if (accountLookup !== undefined && typeof accountLookup !== 'function') {
    throw new TypeError('GQA wipeID account lookup must be a function');
  }
  const authorize = routeAuthorizer({ attributionAuth, verifyCaller, trustedInternal });
  const route = async (context = {}) => {
    try {
      const caller = await requireAttributionCaller(authorize, context);
      if (emptyJsonRequest(context.req)) return sendSourceBadRequest(context);
      const body = sourceRequestMapping(sourceRequestBody(context));
      const targetId = requiredField(body, 'ID', 'wipeID request');
      if (!sourceTruthy(targetId)) return sendSourceJson(context, { message: 'No id provided.' });
      // The value is a resource identifier, never a Mongo selector. Reject
      // arrays/objects before an admin can reach the destructive store call.
      if (typeof targetId !== 'string') {
        throw new GqaAttributionHttpError(403, GQA_ATTRIBUTION_ACCESS_DENIED_MESSAGE);
      }
      if (!caller.isAdmin) {
        const ownedLoopIds = accountLookup ? callerLoopIds(await accountLookup(caller.accountId)) : [];
        if (!ownedLoopIds.includes(targetId)) {
          throw new GqaAttributionHttpError(403, GQA_ATTRIBUTION_ACCESS_DENIED_MESSAGE);
        }
      }
      return sendSourceJson(context, { deleted_row: await attribution.wipe(targetId) });
    } catch (error) {
      logGqaAttributionError(context, error);
      return sendSourceJson(context, sourceError(error), attributionErrorStatus(error));
    }
  };
  route.jsonStrict = false;
  route.jsonTypes = ['application/json', 'application/*+json'];
  route.bodyDefault = null;
  route.parserError = sourceParserError;
  return route;
}
