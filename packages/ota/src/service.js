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
import { pipeline } from 'node:stream/promises';
import { createService } from '@phoenix/common';
import { parseTarget, sendAmz, sendAmzError, sendBoom, credentialsFrom, readBody } from './awsJson.js';
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

export function createOtaService({ catalog, publicBaseUrl = null } = {}) {
  const baseFor = (req) => publicBaseUrl || `http://${(req.headers && req.headers.host) || 'localhost'}`;

  const dispatch = async ({ req, res, body, log }) => {
    const op = parseTarget(req);
    const baseUrl = baseFor(req);
    if (!OPERATIONS.has(op)) {
      log.warn?.('unknown update target', { target: (req.headers && req.headers['x-amz-target']) || '(none)' });
      // The source answered an unmapped method with Boom.notFound (404, no code). Phoenix's
      // Classic faces answer 400 UnknownOperationException; that status divergence is the
      // already-recorded A8 finding and is kept consistent here.
      return void sendAmzError(res, 400, 'UnknownOperationException', `unknown target ${(req.headers && req.headers['x-amz-target']) || '(none)'}`);
    }

    const creds = credentialsFrom(req);
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
          return void sendAmz(res, 200, matches.map((e) => catalog.toUpdate(e, { baseUrl, fromVersion: query.fromVersion })));
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
          return void sendAmz(res, 200, catalog.toUpdate(best, { baseUrl, fromVersion: query.fromVersion }));
        }

        case 'CreateUpdate': {
          // The method body's own admin gate (update.handler.ts:45-47); the enclosing
          // parseCredentials({}) enforces nothing, so validation above runs first.
          if (!creds.isAdmin) return void sendAmzError(res, UPDATE_ONLY_ADMIN_CAN_CREATE.statusCode, UPDATE_ONLY_ADMIN_CAN_CREATE.code, UPDATE_ONLY_ADMIN_CAN_CREATE.message);
          const data = await readBody(req);
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
          return void sendAmz(res, 200, catalog.toUpdate(entry, { baseUrl }));
        }

        case 'RemoveUpdate': {
          const entry = catalog.findById(query.id);
          if (!entry) return void sendAmzError(res, UPDATE_NOT_FOUND.statusCode, UPDATE_NOT_FOUND.code, UPDATE_NOT_FOUND.message);
          if ((creds.id ?? null) !== (entry.accountId ?? null)) {
            return void sendAmzError(res, UPDATE_BELONGS_OTHER_ACCOUNT.statusCode, UPDATE_BELONGS_OTHER_ACCOUNT.code, UPDATE_BELONGS_OTHER_ACCOUNT.message);
          }
          const removed = await catalog.removeUpdate(query.id);
          if (!removed) return void sendAmzError(res, UPDATE_CANNOT_DELETE.statusCode, UPDATE_CANNOT_DELETE.code, UPDATE_CANNOT_DELETE.message);
          return void sendAmz(res, 200, catalog.toUpdate(removed, { baseUrl }));
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

    'GET /ota/package': async ({ res, url, log }) => {
      const id = url.searchParams.get('id');
      const entry = id && catalog.findById(id);
      if (!entry) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        return void res.end('no such package');
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': entry.length });
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
