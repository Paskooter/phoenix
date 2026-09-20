// OTA HTTP service. Reimplements the pinned Update service (jiborobot/srv-update-ws) over
// two surfaces:
//
//   POST /                       the AWS-JSON Update API the robot's jibo-server-client calls.
//                                Dispatched by the X-Amz-Target operation name. The pinned
//                                server registers all eight model operations:
//                                  Update_20160301.ListUpdates          -> [Update,…]
//                                  Update_20160301.ListUpdatesFrom      -> [Update,…]
//                                  Update_20160301.GetUpdateFrom        -> Update | 404 UPDATE_NOT_FOUND
//                                  Update_20160301.CreateUpdate         -> Update        (admin)
//                                  Update_20160301.RemoveUpdate         -> Update        (creator)
//                                  Update_20160301.ListUniqueFilters    -> [filter,…]    (admin)
//                                  Update_20160301.SetTarget            -> {}            (admin)
//                                  Update_20160301.ListTargets          -> [{serial,target}] (admin)
//   GET  /ota/package?id=<id>    the binary package, streamed with Content-Length so
//                                jibo-download-update can show progress + verify the SHA-1.
//   GET  /healthcheck            (free, from @phoenix/common createService)
//
// Both API models (update-2016-03-01 and updateadmin-2016-03-01) share targetPrefix
// `Update_20160301`, exactly as Account/AccountAdmin share one under A-03 — so a single
// entrypoint answers all eight by operation name.
//
// Auth is the gateway's two-layer model: the handler decorators parse the injected
// `x-amz-credentials` and apply their own admin/ownership checks, while the gateway's
// allow-lists decide admissibility. NONE of the eight Update operations appear in the pinned
// gateway's unauthorizedMethods or its (empty) unsignedMethods, and only
// Account_20151111.Remove is in unactiveMethods (srv-security-gw src/controllers/auth.ctrl.ts)
// — so every one of them requires a signed, active account at the gateway. SigV4 on the
// inbound request is not re-verified here; Phoenix trusts the LAN like the hub's DISABLE_AUTH
// and enforces the decorator layer (this is the same posture as the other Classic faces).
//
// The `url` we hand back points at THIS server (derived from the request Host, or
// ETCO_ota_publicUrl) instead of the source's S3/CloudFront object, so the robot downloads
// from wherever it reached us — see DIVERGENCES.

import { createReadStream } from 'node:fs';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { createService, SIGV4_ERRORS, SigV4Error, verifySigV4 } from '@phoenix/common';
import { parseTarget, sendAmz, sendAmzError, sendBoom, credentialsFrom } from './awsJson.js';
import {
  AUTHORIZED_UNDER_ADMIN,
  UPDATE_BELONGS_OTHER_ACCOUNT,
  UPDATE_CANNOT_DELETE,
  UPDATE_NOT_FOUND,
  UPDATE_ONLY_ADMIN_CAN_CREATE,
  UpdateError,
} from './errors.js';

// The source handler mapping (srv-update-ws src/handlers/update.handler.ts:13-20 and
// src/handlers/targeted.handler.ts:12-15). ListUniqueFilters belongs to the Update handler
// even though its model lives in updateadmin.
const OPERATIONS = new Set([
  'ListUpdates', 'ListUpdatesFrom', 'GetUpdateFrom', 'CreateUpdate', 'RemoveUpdate',
  'ListUniqueFilters', 'SetTarget', 'ListTargets',
]);
// @parseCredentials({adminOnly: true}) — 401 AUTHORIZED_UNDER_ADMIN before any validation.
const ADMIN_ONLY = new Set(['ListUniqueFilters', 'SetTarget', 'ListTargets']);

// Joi-described members, mirroring the source decorators (allowUnknown: true everywhere).
const PAYLOAD_SCHEMAS = {
  ListUpdates: { subsystem: {}, filter: {} },
  ListUpdatesFrom: { fromVersion: { required: true }, subsystem: {}, filter: {} },
  GetUpdateFrom: { fromVersion: { required: true }, subsystem: {}, filter: {} },
  RemoveUpdate: { id: { required: true } },
  ListUniqueFilters: {},
  SetTarget: { serial: { required: true }, target: { allowNull: true } },
  ListTargets: {},
};
const CREATE_HEADER_SCHEMA = {
  'x-update-from-version': { required: true },
  'x-update-to-version': { required: true },
  'x-update-changes': { required: true },
  'x-update-subsystem': {},
  'x-update-filter': {},
};

const OTA_MAX_UPLOAD_BYTES = 1_000_000_000;
const SIGV4_REPLAY_WINDOW_MS = 15 * 60 * 1000;
const PACKAGE_URL_TTL_MS = 24 * 60 * 60 * 1000;

function canonicalPublicOrigin(value, name = 'publicBaseUrl') {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} is required`);
  let parsed;
  try { parsed = new URL(value.trim()); }
  catch (error) { throw new TypeError(`Invalid ${name}: ${error.message}`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname
    || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw new TypeError(`Invalid ${name}: expected an HTTP(S) origin without path, query, or fragment`);
  }
  return parsed.origin;
}

function declaredContentLength(req) {
  const raw = req?.headers?.['content-length'];
  if (raw === undefined || raw === null) return null;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

async function readBodyLimited(req, maxBytes) {
  const declared = declaredContentLength(req);
  if (declared !== null && declared > maxBytes) {
    req.resume?.();
    const error = new Error(`Payload content length greater than maximum allowed: ${maxBytes}`);
    error.statusCode = 413;
    error.code = 'PAYLOAD_TOO_LARGE';
    throw error;
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (total + bytes.length > maxBytes) {
      req.resume?.();
      const error = new Error(`Payload content length greater than maximum allowed: ${maxBytes}`);
      error.statusCode = 413;
      error.code = 'PAYLOAD_TOO_LARGE';
      throw error;
    }
    chunks.push(bytes);
    total += bytes.length;
  }
  return Buffer.concat(chunks, total);
}

function accountIdOf(credentials) {
  const id = credentials?.id ?? credentials?._id ?? credentials?.accountId;
  return id === undefined || id === null || String(id).length === 0 ? null : String(id);
}

function clockMillis(now) {
  if (typeof now === 'function') return clockMillis(now());
  if (now instanceof Date) return now.getTime();
  if (now !== undefined && now !== null) {
    const value = Number(now);
    if (Number.isFinite(value)) return value;
  }
  return Date.now();
}

function signatureFromAuthorization(value) {
  return /(?:^|,\s*)Signature=([a-f0-9]{64})(?:,|$)/i.exec(String(value || ''))?.[1]?.toLowerCase() || null;
}

function replayKey(req, verification) {
  const signature = signatureFromAuthorization(req?.headers?.authorization);
  return signature ? `${verification.accessKeyId}:${signature}` : null;
}

function packagePayload(secret, id, expires) {
  return ['phoenix-ota-v1', 'GET', String(id), String(expires)].join('\n');
}

function packageSignature(secret, id, expires) {
  return createHmac('sha256', secret).update(packagePayload(secret, id, expires)).digest('hex');
}

function packageBearer(secret, url, now) {
  const ids = url.searchParams.getAll('id');
  const expiresValues = url.searchParams.getAll('expires');
  const signatures = url.searchParams.getAll('signature');
  if (ids.length !== 1 || expiresValues.length !== 1 || signatures.length !== 1) return null;
  const id = ids[0];
  const expiryText = expiresValues[0];
  const signature = signatures[0];
  if (!id || !/^[0-9A-Za-z_-]+$/.test(id) || !/^\d+$/.test(expiryText)) return null;
  const expires = Number(expiryText);
  if (!Number.isSafeInteger(expires) || expires <= now || String(expires) !== expiryText || !/^[a-f0-9]{64}$/i.test(signature)) return null;
  const expected = Buffer.from(packageSignature(secret, id, expires), 'hex');
  const supplied = Buffer.from(signature, 'hex');
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
  return id;
}

class ReplayGuard {
  constructor({ now = Date.now, maxEntries = 50_000 } = {}) {
    this.now = now;
    this.maxEntries = maxEntries;
    this.entries = new Map();
  }

  accept(key, expires) {
    if (!key) return false;
    const now = Number(this.now());
    for (const [entry, expiry] of this.entries) if (expiry <= now) this.entries.delete(entry);
    if (this.entries.has(key)) return false;
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, Math.min(Number(expires) || now + SIGV4_REPLAY_WINDOW_MS, now + SIGV4_REPLAY_WINDOW_MS));
    return true;
  }
}

/**
 * Joi-equivalent member validation for the declared shape. Returns the source-style Joi
 * message on failure (-> Boom.badData -> 422), or null. Unknown members are ignored
 * (allowUnknown: true).
 */
function validateMembers(obj, schema) {
  const o = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  for (const [name, rule] of Object.entries(schema)) {
    const v = o[name];
    if (v === undefined || v === null) {
      if (rule.allowNull && v === null) continue;
      if (rule.required) return `child "${name}" fails because ["${name}" is required]`;
      if (v === null) return `child "${name}" fails because ["${name}" must be a string]`;
      continue;
    }
    if (typeof v !== 'string') return `child "${name}" fails because ["${name}" must be a string]`;
    if (rule.required && v === '') return `child "${name}" fails because ["${name}" is not allowed to be empty]`;
  }
  return null;
}

/** Source CreateUpdate dependency headers: `x-update-dependencies<name>` -> dependencies[name]. */
function parseDependencies(headers = {}) {
  const dependencies = {};
  for (const key of Object.keys(headers)) {
    if (key.indexOf('x-update-dependencies') === 0) {
      dependencies[key.replace('x-update-dependencies', '')] = headers[key];
    }
  }
  return dependencies;
}

export function createOtaService({
  catalog,
  publicBaseUrl = null,
  resolveCredentials,
  authenticate,
  requireAuth = (typeof resolveCredentials === 'function' || process.env.ETCO_ota_requireAuth === 'true'),
  maxUploadBytes = OTA_MAX_UPLOAD_BYTES,
  packageBearerSecret = process.env.ETCO_ota_packageBearerSecret || process.env.ETCO_server_hubTokenSecret || process.env.HUB_TOKEN_SECRET,
  replayGuard = new ReplayGuard(),
  now = Date.now,
} = {}) {
  const configuredOrigin = publicBaseUrl ? canonicalPublicOrigin(publicBaseUrl) : null;
  if (requireAuth && !configuredOrigin) {
    throw new TypeError('publicBaseUrl is required when OTA authentication is enabled');
  }
  if (requireAuth && !packageBearerSecret) {
    throw new TypeError('packageBearerSecret is required when OTA authentication is enabled');
  }
  const uploadLimit = Number(maxUploadBytes);
  if (!Number.isSafeInteger(uploadLimit) || uploadLimit < 0) throw new TypeError('maxUploadBytes must be a non-negative safe integer');
  const packageSecret = packageBearerSecret || 'development-ota-package-secret';
  const baseFor = (req) => configuredOrigin || `http://${(req.headers && req.headers.host) || 'localhost'}`;

  function hostMatches(req) {
    if (!configuredOrigin) return true;
    const expected = new URL(configuredOrigin);
    const actual = String(req?.headers?.host || '').toLowerCase();
    return actual === expected.host.toLowerCase();
  }

  async function authenticateRequest(req, body, op) {
    if (!requireAuth) return credentialsFrom(req);
    if (!hostMatches(req)) {
      const error = new SigV4Error({ code: 'SIGNATURE_MISMATCH', message: 'Request host does not match configured public origin', statusCode: 401 });
      throw error;
    }
    let verification;
    if (typeof authenticate === 'function') {
      verification = await authenticate({ req, body, op });
    } else {
      verification = verifySigV4({
        method: req.method || 'POST',
        path: req.originalUrl || req.url || '/',
        headers: req.headers || {},
        body,
        now: typeof now === 'function' ? now() : now,
        resolveCredentials,
      });
    }
    if (!verification || !verification.credentials) throw new SigV4Error(SIGV4_ERRORS.ACCOUNT_SERVICE_UNAVAILABLE);
    const caller = verification.credentials;
    if (!accountIdOf(caller)) throw new SigV4Error(SIGV4_ERRORS.ACCOUNT_SERVICE_UNAVAILABLE);
    const key = replayKey(req, verification);
    const date = clockMillis(now) + SIGV4_REPLAY_WINDOW_MS;
    if (key && !replayGuard.accept(key, date)) {
      const error = new SigV4Error({ code: 'SIGNATURE_REPLAYED', message: 'Request signature has already been used', statusCode: 401 });
      throw error;
    }
    return caller;
  }

  const packageUrl = (entry, requestBase) => {
    // In the legacy standalone mode the URL must retain the request's ephemeral/test port. In
    // authenticated mode `requestBase` is always the configured canonical origin, so Host can
    // never influence a public download destination.
    const base = requestBase || baseFor({ headers: { host: configuredOrigin ? new URL(configuredOrigin).host : 'localhost' } });
    if (!requireAuth) return `${base}/ota/package?id=${encodeURIComponent(entry.id)}`;
    const expires = Math.floor(clockMillis(now) + PACKAGE_URL_TTL_MS);
    const signature = packageSignature(packageSecret, entry.id, expires);
    return `${base}/ota/package?id=${encodeURIComponent(entry.id)}&expires=${expires}&signature=${signature}`;
  };

  const dispatch = async ({ req, res, body, log }) => {
    const op = parseTarget(req);
    const baseUrl = baseFor(req);
    const urlForEntry = (entry) => packageUrl(entry, baseUrl);
    if (!OPERATIONS.has(op)) {
      log.warn?.('unknown update target', { target: (req.headers && req.headers['x-amz-target']) || '(none)' });
      // The source answered an unmapped method with Boom.notFound (404, no code). Phoenix's
      // Classic faces answer 400 UnknownOperationException; that status divergence is the
      // already-recorded A8 finding and is kept consistent here.
      return void sendAmzError(res, 400, 'UnknownOperationException', `unknown target ${(req.headers && req.headers['x-amz-target']) || '(none)'}`);
    }

    let wireBody = body && typeof body === 'object' ? JSON.stringify(body) : (body == null ? '' : body);
    if (op === 'CreateUpdate') {
      if (req._otaRawBody === undefined) req._otaRawBody = await readBodyLimited(req, uploadLimit);
      wireBody = req._otaRawBody;
    } else if (Buffer.isBuffer(req.rawBody)) {
      wireBody = req.rawBody;
    }
    let creds;
    try {
      creds = await authenticateRequest(req, wireBody, op);
    } catch (error) {
      if (error?.statusCode === 413 || error?.code === 'PAYLOAD_TOO_LARGE') {
        return void sendBoom(res, 413, error.message);
      }
      if (error instanceof SigV4Error && SIGV4_ERRORS[error.code]) return void sendAmzError(res, error.statusCode || 401, error.code, error.message);
      if (error?.code === 'SIGNATURE_REPLAYED') return void sendAmzError(res, 401, error.code, error.message);
      log.error?.('ota authentication failed', { error: error?.message });
      return void sendAmzError(res, 503, SIGV4_ERRORS.ACCOUNT_SERVICE_UNAVAILABLE.code, SIGV4_ERRORS.ACCOUNT_SERVICE_UNAVAILABLE.message);
    }
    if (ADMIN_ONLY.has(op) && !creds.isAdmin) return void sendAmzError(res, 401, AUTHORIZED_UNDER_ADMIN.code, AUTHORIZED_UNDER_ADMIN.message);

    const query = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    const invalid = validateMembers(op === 'CreateUpdate' ? req.headers : query, op === 'CreateUpdate' ? CREATE_HEADER_SCHEMA : PAYLOAD_SCHEMAS[op]);
    if (invalid) return void sendBoom(res, 422, invalid);

    try {
      switch (op) {
        case 'ListUpdates':
        case 'ListUpdatesFrom': {
          const filter = await catalog.effectiveFilter(query.filter, creds.friendlyId);
          const matches = op === 'ListUpdates'
            ? catalog.listUpdates({ subsystem: query.subsystem, filter })
            : catalog.listUpdatesFrom({ fromVersion: query.fromVersion, subsystem: query.subsystem, filter });
          log.info?.('update query', { op, subsystem: query.subsystem, fromVersion: query.fromVersion, filter, returned: matches.length, available: catalog.entries.length });
            return void sendAmz(res, 200, matches.map((e) => catalog.toUpdate(e, { baseUrl, fromVersion: query.fromVersion, packageUrl: urlForEntry })));
        }

        case 'GetUpdateFrom': {
          const filter = await catalog.effectiveFilter(query.filter, creds.friendlyId);
          const best = catalog.getUpdateFrom({ fromVersion: query.fromVersion, subsystem: query.subsystem, filter });
          log.info?.('update query', { op, subsystem: query.subsystem, fromVersion: query.fromVersion, filter, returned: best ? 1 : 0, available: catalog.entries.length });
          // The robot's system-manager (UpdateManager::checkForUpdates) treats ANY error code
          // other than exactly "UPDATE_NOT_FOUND" as fatal and aborts the whole multi-subsystem
          // check — so a subsystem we don't stock (e.g. @be/be, which sorts first) must return
          // precisely this code or os/services never get checked.
          if (!best) return void sendAmzError(res, UPDATE_NOT_FOUND.statusCode, UPDATE_NOT_FOUND.code, UPDATE_NOT_FOUND.message);
          return void sendAmz(res, 200, catalog.toUpdate(best, { baseUrl, fromVersion: query.fromVersion, packageUrl: urlForEntry }));
        }

        case 'CreateUpdate': {
          // The method body's own admin gate (update.handler.ts:45-47); the enclosing
          // parseCredentials({}) enforces nothing, so validation above runs first.
          if (!creds.isAdmin) return void sendAmzError(res, UPDATE_ONLY_ADMIN_CAN_CREATE.statusCode, UPDATE_ONLY_ADMIN_CAN_CREATE.code, UPDATE_ONLY_ADMIN_CAN_CREATE.message);
            const data = req._otaRawBody || await readBodyLimited(req, uploadLimit);
          let entry;
          try {
            entry = await catalog.createUpdate({
              accountId: creds.id ?? null,
              fromVersion: req.headers['x-update-from-version'],
              toVersion: req.headers['x-update-to-version'],
              changes: req.headers['x-update-changes'],
              subsystem: req.headers['x-update-subsystem'],
              filter: req.headers['x-update-filter'],
              dependencies: parseDependencies(req.headers),
              data,
            });
          } catch (err) {
            if (err instanceof UpdateError) return void sendAmzError(res, err.statusCode, err.code, err.message);
            throw err;
          }
          return void sendAmz(res, 200, catalog.toUpdate(entry, { baseUrl, packageUrl: urlForEntry }));
        }

        case 'RemoveUpdate': {
          const entry = catalog.findById(query.id);
          if (!entry) return void sendAmzError(res, UPDATE_NOT_FOUND.statusCode, UPDATE_NOT_FOUND.code, UPDATE_NOT_FOUND.message);
          if ((creds.id ?? null) !== (entry.accountId ?? null)) {
            return void sendAmzError(res, UPDATE_BELONGS_OTHER_ACCOUNT.statusCode, UPDATE_BELONGS_OTHER_ACCOUNT.code, UPDATE_BELONGS_OTHER_ACCOUNT.message);
          }
          const removed = await catalog.removeUpdate(query.id);
          if (!removed) return void sendAmzError(res, UPDATE_CANNOT_DELETE.statusCode, UPDATE_CANNOT_DELETE.code, UPDATE_CANNOT_DELETE.message);
          return void sendAmz(res, 200, catalog.toUpdate(removed, { baseUrl, packageUrl: urlForEntry }));
        }

        case 'ListUniqueFilters':
          return void sendAmz(res, 200, catalog.listUniqueFilters());

        case 'SetTarget':
          await catalog.setTarget(query.serial, query.target);
          return void sendAmz(res, 200, {});

        case 'ListTargets':
          return void sendAmz(res, 200, catalog.listTargets());

        default:
          return void sendAmzError(res, 400, 'UnknownOperationException', `unknown target ${op}`);
      }
    } catch (err) {
      log.error?.('ota operation failed', { op, error: err.message });
      return void sendAmzError(res, 500, 'InternalFailure', err.message);
    }
  };
  // CreateUpdate ships the package as the request entity, so its route must bypass the JSON
  // parser and hand the handler the raw stream (the source routed it to a stream handler).
  dispatch.rawBody = (req) => parseTarget(req) === 'CreateUpdate';

  const routes = {
    'POST /': dispatch,

    'GET /ota/package': async ({ req, res, url, log }) => {
      if (requireAuth && !hostMatches(req)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        return void res.end('forbidden');
      }
      const id = url.searchParams.get('id');
      const bearerId = requireAuth
        ? packageBearer(packageSecret, url, clockMillis(now))
        : id;
      if (requireAuth && bearerId !== id) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        return void res.end('forbidden');
      }
      const entry = id && catalog.findById(id);
      if (!entry) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        return void res.end('no such package');
      }
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': entry.length,
        'cache-control': 'private, no-store',
      });
      try {
        await pipeline(createReadStream(entry._file), res);
      } catch (err) {
        // Client hung up mid-download, or read error after headers were sent — nothing to do but log.
        log.warn?.('ota package stream interrupted', { id, error: err.message });
      }
    },
  };

  return createService({ name: 'ota', routes });
}
