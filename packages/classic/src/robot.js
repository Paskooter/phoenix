// `robot` service (Robot_20160225) — robot manufacturing/lifecycle + read-state.
//
// Re-derived from pinned source (the archive MCP-pinned originals, not a prior report):
//   command side  jiborobot/srv-robots-ws@4c8b1b75f3e0ccb90fab160019637704ba62d36a
//     src/handlers/robot.handler.js          (COMMAND_ACCEPTED_RESPONSE, isManufacturing,
//                                             Joi validatePayload, op mapping)
//     src/command.handlers/robot.{create,create.batch,update,delete,calibrate}.js
//     src/repositories/{robot,abstract}.repository.js  (event-sourced aggregate)
//     src/aggregates/robot.js                (RobotCreated/Updated/Deleted/Calibrated)
//     src/controllers/event.ctrl.js          (convertId: 4 hyphen parts -> PascalCase)
//     src/errors/robot.js, config/config.json (restrictedToOwner/restrictedToManufacturing)
//   read side     jiborobot/srv-robots-read-ws@decbbf7e959af3dabe2384940cb316b0689a18b4
//     src/handlers/robot.handler.js          (isManufacturingOrAdmin, hasRobot/listRobots)
//     src/query.handlers/robot.{read,history,calibrate,friendly.ids}.js
//     src/query.handlers/abstract.robot.handler.js  (serialNumber validation)
//     src/controllers/robot.ctrl.js          (read projection + convertId)
//     src/errors/robot.js, src/schemes/robot.js
//   friendly ids  jiborobot/srv-serial-names src/main.js (see serialNames.js)
//
// Wire model: apis/robot-2016-02-25.normal.json and apis/robotadmin-2016-02-25.normal.json.
// Both files declare `targetPrefix: Robot_20160225`, so robot and robotadmin operations
// arrive under the SAME X-Amz-Target prefix and are distinguished by operation name only.
//
// Phoenix collapses the source's command service (which publishes events on a Redis
// EventBus) and read service (which materialises them into a Mongo Robot document) into a
// single handler backed by one durable event log: command ops append events, read ops
// project the same log. That collapse is deliberate (Phoenix has no Mongo/Redis) but the
// observable records, shapes, permission gates and error envelopes are the source's.
//
// Ops: getRobot, getRobotHistory, getCalibrationData, getFriendlyIds (read) +
//      createRobot, createRobotBatch, updateRobot, removeRobot, calibrateRobot (command).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultPort } from '@phoenix/contracts';
import { Store as AccountStore } from '../../account/src/store.js';
import { sendAmz, sendAmzError, ValidationException } from './awsJson.js';
import { generateFriendlyId } from './serialNames.js';
import { verifiedCallerFromRequest } from './caller.js';

// ---------------------------------------------------------------------------
// Source constants
// ---------------------------------------------------------------------------

/** srv-robots-ws/src/handlers/robot.handler.js `isManufacturing`. */
export const MANUFACTURING_EMAIL = 'manufacturing@jibo.com';

/** srv-robots-ws/config/config.json. */
export const RESTRICTED_TO_OWNER = ['remoteEnabled'];
export const RESTRICTED_TO_MANUFACTURING = ['suspended'];

/** srv-robots-ws/src/handlers/robot.handler.js `COMMAND_ACCEPTED_RESPONSE`. */
export const COMMAND_ACCEPTED_RESPONSE = { result: 'Command accepted' };

/**
 * Error envelopes verbatim from the two pinned errors/robot.js files. The `code` is the
 * `__type`/`x-amzn-errortype` the aws-sdk fork's json protocol reads back
 * (srv-jibo-server-client lib/protocol/json.js extractError).
 */
export const ROBOT_ERRORS = {
  ENTITY_ALREADY_EXISTS: { code: 'ENTITY_ALREADY_EXISTS', statusCode: 409, message: 'Entity already exists' },
  ENTITY_NOT_FOUND: { code: 'ENTITY_NOT_FOUND', statusCode: 404, message: 'Entity not found' },
  ENTITY_DELETED: { code: 'ENTITY_DELETED', statusCode: 410, message: 'Entity is deleted' },
  MANUFACTURING_ONLY: { code: 'MANUFACTURING_ONLY', statusCode: 403, message: 'Only manufacturing account can access this method' },
  MANUFACTURING_OR_OWNER_ONLY: { code: 'MANUFACTURING_OR_OWNER_ONLY', statusCode: 403, message: 'Only manufacturing or owner account can access this method' },
  ROBOT_OR_OWNER_ONLY: { code: 'ROBOT_OR_OWNER_ONLY', statusCode: 403, message: 'Only robot or owner account can access this method' },
  ACCOUNT_SERVICE_UNAVAILABLE: { code: 'ACCOUNT_SERVICE_UNAVAILABLE', statusCode: 503, message: 'Account service not available' },
  SERIAL_NUMBER_NOT_SET: { code: 'SERIAL_NUMBER_NOT_SET', statusCode: 422, message: 'Serial number not set for the robot' },
  SERIAL_NUMBER_NOT_MATCH: { code: 'SERIAL_NUMBER_NOT_MATCH', statusCode: 422, message: 'Provided serial number does not match with stored one' },
  ROBOT_NOT_FOUND: { code: 'ROBOT_NOT_FOUND', statusCode: 404, message: 'Robot not found' },
  ROBOT_NAMES_NOT_GENERATED: { code: 'ROBOT_NAMES_NOT_GENERATED', statusCode: 409, message: 'Failed to find enough random names in reasonable amount of time' },
};

// ---------------------------------------------------------------------------
// id conversion + deep merge (source semantics)
// ---------------------------------------------------------------------------

/**
 * EventController.convertId (srv-robots-ws/src/controllers/event.ctrl.js) and
 * RobotController.convertId (srv-robots-read-ws): a 4-part hyphen id becomes PascalCase
 * per part; any other id is returned unchanged. The command side stores the converted id
 * and the read side looks it up converted, so `ab-cd-ef-gh` round-trips as `Ab-Cd-Ef-Gh`.
 */
export function convertRobotId(id) {
  if (!id) return id;
  const parts = String(id).split('-');
  if (parts.length !== 4) return id;
  return parts.map((part) => (part.length === 0 ? part : part[0].toUpperCase() + part.slice(1).toLowerCase())).join('-');
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Deep value copy so a projected aggregate can never mutate the stored event log. */
const clone = (value) => (value === undefined ? undefined : structuredClone(value));

/** jQuery-style `extend(true, target, source)` used by the source aggregate/controller. */
function deepExtend(target, source) {
  if (!isPlainObject(source)) return target;
  for (const [key, value] of Object.entries(source)) {
    if (isPlainObject(value) && isPlainObject(target[key])) deepExtend(target[key], value);
    else if (Array.isArray(value)) target[key] = value.map((item) => (isPlainObject(item) ? deepExtend({}, item) : item));
    else target[key] = value;
  }
  return target;
}

// ---------------------------------------------------------------------------
// Durable event log
// ---------------------------------------------------------------------------

/**
 * Durable, process-restart-surviving event log standing in for the source's Mongo `Event`
 * collection (srv-robots-ws/src/schemes/event.js) plus the read projection Mongo `Robot`
 * document (srv-robots-read-ws/src/schemes/robot.js). Events are appended by command ops
 * and projected by read ops; the log is mirrored to a JSON file under `dir`.
 */
export class RobotStore {
  /** @param {{dir?: string, file?: string, events?: Array}} [opts] */
  constructor(opts = {}) {
    this.dir = opts.dir || process.env.ETCO_classic_robotDir || join(tmpdir(), 'phx-robots');
    this.file = opts.file || join(this.dir, 'robots.json');
    this.events = Array.isArray(opts.events) ? opts.events : this.#load();
  }

  #load() {
    try {
      if (!existsSync(this.file)) return [];
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      return Array.isArray(parsed?.events) ? parsed.events : [];
    } catch {
      return [];
    }
  }

  #persist() {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file, JSON.stringify({ events: this.events }));
  }

  /** Append one source-shaped event; returns the stored copy. */
  append(event) {
    const stored = clone(event);
    this.events.push(stored);
    this.#persist();
    return stored;
  }

  /** Events for one robot id, oldest first (source `.sort({ created: 1 })`). */
  eventsFor(id) {
    const key = convertRobotId(id);
    return this.events.filter((event) => event.objectId === key).sort((a, b) => a.created - b.created);
  }

  /**
   * Project the aggregate for one robot (source `AbstractRepository.getRawAggregate` +
   * `Robot.applyEvent`, with the read controller's calibration merge). `events` is always
   * present; `exists`/`deleted` describe the command side.
   */
  aggregate(id) {
    const key = convertRobotId(id);
    const events = this.eventsFor(key);
    const aggregate = { id: key, events, exists: events.length > 0, deleted: false, payload: {}, created: undefined, updated: undefined, calibrationPayload: undefined };
    for (const event of events) {
      switch (event.name) {
        case 'RobotCreated':
          aggregate.payload = clone(event.payload) || {};
          aggregate.created = event.created;
          break;
        case 'RobotUpdated':
          aggregate.payload = deepExtend(aggregate.payload || {}, clone(event.payload) || {});
          aggregate.updated = event.created;
          break;
        case 'RobotDeleted':
          aggregate.deleted = true;
          break;
        case 'RobotCalibrated':
          aggregate.calibrationPayload = deepExtend(aggregate.calibrationPayload || {}, clone(event.payload) || {});
          aggregate.updated = event.created;
          break;
        default:
          break;
      }
    }
    return aggregate;
  }
}

// ---------------------------------------------------------------------------
// caller identity + account ownership (two-layer auth seam)
// ---------------------------------------------------------------------------

/**
 * The security gateway forwarded the authenticated identity to service handlers as the
 * `x-amz-credentials` header (srv-server parseCredentials.ts). The public
 * Phoenix entrypoint creates a verified caller before any handler runs; the
 * header fallback remains only for explicitly unguarded compatibility fixtures.
 */
export function credentialsFrom(req, requireVerified = false) {
  const verified = verifiedCallerFromRequest(req);
  if (verified) return {
    id: verified.accountId,
    email: verified.email,
    isAdmin: verified.isAdmin,
    friendlyId: verified.friendlyId,
  };
  if (requireVerified) return null;
  try {
    const parsed = JSON.parse(req?.headers?.['x-amz-credentials'] || '');
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      id: parsed.id ?? parsed._id ?? null,
      email: parsed.email ?? null,
      isAdmin: !!parsed.isAdmin,
      friendlyId: parsed.friendlyId ?? null,
    };
  } catch {
    return null;
  }
}

function accountBase() {
  const v = process.env.NET_account;
  if (!v) return `http://localhost:${DefaultPort.account}`;
  return /^https?:\/\//.test(v) ? v : `http://${v}`;
}

/**
 * Default ownership resolver.  The source's `AccountClient.listRobots(ownerId, owned)` issues
 * `GET <account>/robots?ownerId=<id>[&owned=true]`; Phoenix first resolves the same answer from
 * the configured read-only Account snapshot, because that legacy internal route is deliberately
 * not public here. Returns an array when the trusted source answers, and `undefined` when it
 * cannot be reached or parsed. An unresolved ownership check must fail closed.
 */
export async function accountOwnedRobots(ownerId, ownerEditable = false) {
  if (!ownerId) return undefined;

  // Phoenix's public Account face intentionally does not expose the original
  // service-to-service GET /robots?ownerId=... route.  The Classic process is
  // already configured with the Account's read-only durable snapshot for its
  // SigV4 credential verifier; use that same local-only seam for this
  // ownership check.  It avoids both an unavailable internal HTTP dependency
  // and an accidental public owner/robot enumeration endpoint.
  const fromSnapshot = accountOwnedRobotsFromSnapshot(ownerId, ownerEditable);
  if (fromSnapshot !== undefined) return fromSnapshot;

  // Retain the source-shaped HTTP lookup for deployments that intentionally
  // provide it, but fail closed if neither trusted route is available.
  try {
    const query = new URLSearchParams({ ownerId: String(ownerId) });
    if (ownerEditable) query.set('owned', 'true');
    const res = await fetch(`${accountBase()}/robots?${query.toString()}`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return undefined;
    const body = await res.json();
    if (!Array.isArray(body)) return undefined;
    return body.map((entry) => (entry && typeof entry === 'object' ? String(entry.friendlyId ?? entry.id ?? entry) : String(entry)));
  } catch {
    return undefined;
  }
}

/**
 * Resolve readable/owner-editable robot ids from the local Account snapshot.
 * `undefined` means the trusted snapshot cannot be read; `[]` is a valid
 * answer for an account with no matching active household.  This distinction
 * is important because callers must fail closed on an unavailable account
 * service rather than treating it as an empty account.
 */
function accountOwnedRobotsFromSnapshot(ownerId, ownerEditable) {
  const file = process.env.ETCO_classic_accountDataFile || process.env.ETCO_account_dataFile;
  if (!file) return undefined;
  try {
    const store = new AccountStore(file);
    const accountId = String(ownerId);
    const visible = [...store.loops.values()].filter((loop) => {
      if (!loop || loop.isDeleted === true) return false;
      if (String(loop.owner) === accountId) return true;
      if (ownerEditable) return false;
      return (loop.members || []).some((member) => String(member?.accountId) === accountId
        && ['accepted', 'invited'].includes(String(member?.status || '').toLowerCase()));
    });
    return visible.flatMap((loop) => {
      const robot = loop.robot ? store.accounts.get(String(loop.robot)) : null;
      return robot?.friendlyId ? [String(robot.friendlyId)] : [];
    });
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// handler
// ---------------------------------------------------------------------------

const ID_REQUIRED = 'child "id" fails because ["id" is required]';
const validation = (res, message) => sendAmzError(res, ValidationException, message);

/**
 * @param {object} [opts]
 * @param {RobotStore} [opts.store]            durable event log (default: file-backed)
 * @param {(req) => object|null} [opts.identity] caller identity resolver
 * @param {(ownerId: string, ownerEditable: boolean) => Promise<string[]|undefined>} [opts.ownedRobots]
 *        account ownership resolver (array of robot ids, or undefined when unavailable)
 * @param {() => string} [opts.newFriendlyId]  friendly-id generator
 * @param {() => number} [opts.clock]          event timestamp source
 */
export function makeRobotHandler(opts = {}) {
  const store = opts.store || new RobotStore();
  const identity = opts.identity
    ? (req) => (opts.callerBoundary ? verifiedCallerFromRequest(req) && opts.identity(req) : opts.identity(req))
    : (req) => credentialsFrom(req, !!opts.callerBoundary);
  const ownedRobots = opts.ownedRobots || accountOwnedRobots;
  const newFriendlyId = opts.newFriendlyId || generateFriendlyId;
  const clock = opts.clock || Date.now;

  const now = () => Number(clock());

  return async function robotHandler({ req, res, op, body, log }) {
    const credentials = identity(req);
    const isManufacturing = !!credentials && credentials.email === MANUFACTURING_EMAIL;
    const isAdmin = !!credentials && credentials.isAdmin;
    const isManufacturingOrAdmin = isManufacturing || isAdmin;
    const b = body || {};

    switch (String(op || '').toLowerCase()) {
      // ---- read side (srv-robots-read-ws) ---------------------------------
      case 'getrobot':
      case 'getcalibrationdata':
      case 'getrobothistory':
        return readOp(String(op).toLowerCase());

      case 'getfriendlyids': {
        if (!isManufacturingOrAdmin) return void sendAmzError(res, ROBOT_ERRORS.MANUFACTURING_ONLY);
        const count = b.count;
        if (typeof count !== 'number' || Number.isNaN(count)) {
          return void validation(res, 'child "count" fails because ["count" must be a number]');
        }
        if (count <= 0) return void sendAmz(res, 200, []);
        const ids = [];
        let limit = count * 1000; // source retry budget
        while (ids.length < count) {
          const candidate = newFriendlyId();
          const taken = store.eventsFor(candidate).length > 0;
          if (!taken && !ids.includes(candidate)) ids.push(candidate);
          else limit -= 1;
          if (limit < 0) return void sendAmzError(res, ROBOT_ERRORS.ROBOT_NAMES_NOT_GENERATED);
        }
        // Output shape IdPairs = list of IdPair{id}; the wire body is the array itself.
        return void sendAmz(res, 200, ids.map((id) => ({ id })));
      }

      // ---- command side (srv-robots-ws) -----------------------------------
      case 'createrobot': {
        if (!isManufacturing) return void sendAmzError(res, ROBOT_ERRORS.MANUFACTURING_ONLY);
        if (typeof b.id !== 'string' || b.id === '') return void validation(res, ID_REQUIRED);
        if (!isPlainObject(b.payload)) return void validation(res, 'child "payload" fails because ["payload" is required]');
        const key = convertRobotId(b.id);
        const aggregate = store.aggregate(key);
        if (aggregate.exists && !aggregate.deleted) return void sendAmzError(res, ROBOT_ERRORS.ENTITY_ALREADY_EXISTS);
        store.append({ name: 'RobotCreated', objectId: key, created: now(), payload: b.payload });
        return void sendAmz(res, 200, COMMAND_ACCEPTED_RESPONSE);
      }

      case 'createrobotbatch': {
        if (!isManufacturing) return void sendAmzError(res, ROBOT_ERRORS.MANUFACTURING_ONLY);
        if (!Array.isArray(body)) return void validation(res, '"value" must be an array');
        // The source loop does not await per-item validate/handle and swallows every
        // per-item error; the batch response is always Command accepted.
        for (const item of body) {
          try {
            if (!isPlainObject(item) || typeof item.id !== 'string' || item.id === '' || !isPlainObject(item.payload)) continue;
            const key = convertRobotId(item.id);
            const aggregate = store.aggregate(key);
            if (aggregate.exists && !aggregate.deleted) continue; // ENTITY_ALREADY_EXISTS ignored per item
            store.append({ name: 'RobotCreated', objectId: key, created: now(), payload: item.payload });
          } catch (err) {
            log?.warn?.('robot createRobotBatch: ignoring item error', { error: err?.message });
          }
        }
        return void sendAmz(res, 200, COMMAND_ACCEPTED_RESPONSE);
      }

      case 'updaterobot': {
        if (typeof b.id !== 'string' || b.id === '') return void validation(res, ID_REQUIRED);
        if (!isPlainObject(b.payload)) return void validation(res, 'child "payload" fails because ["payload" is required]');
        const isOwnerEditable = RESTRICTED_TO_OWNER.some((prop) => b.payload[prop] !== undefined);
        const restrictedToManufacturing = RESTRICTED_TO_MANUFACTURING.some((prop) => b.payload[prop] !== undefined);
        let owned;
        if (!isManufacturing && credentials) {
          try {
            owned = await ownedRobots(credentials.id, isOwnerEditable);
          } catch {
            owned = undefined;
          }
          if (!Array.isArray(owned)) return void sendAmzError(res, ROBOT_ERRORS.ACCOUNT_SERVICE_UNAVAILABLE);
        }
        if (!isManufacturing && restrictedToManufacturing) return void sendAmzError(res, ROBOT_ERRORS.MANUFACTURING_ONLY);
        if (!isManufacturing && credentials && !owned.includes(b.id)) {
          return void sendAmzError(res, ROBOT_ERRORS.ROBOT_OR_OWNER_ONLY);
        }
        const key = convertRobotId(b.id);
        const aggregate = store.aggregate(key);
        if (!aggregate.exists) return void sendAmzError(res, ROBOT_ERRORS.ENTITY_NOT_FOUND);
        if (aggregate.deleted) return void sendAmzError(res, ROBOT_ERRORS.ENTITY_DELETED);
        store.append({ name: 'RobotUpdated', objectId: key, created: now(), payload: b.payload });
        return void sendAmz(res, 200, COMMAND_ACCEPTED_RESPONSE);
      }

      case 'removerobot': {
        if (!isManufacturing) return void sendAmzError(res, ROBOT_ERRORS.MANUFACTURING_ONLY);
        if (typeof b.id !== 'string' || b.id === '') return void validation(res, ID_REQUIRED);
        const key = convertRobotId(b.id);
        const aggregate = store.aggregate(key);
        if (!aggregate.exists) return void sendAmzError(res, ROBOT_ERRORS.ENTITY_NOT_FOUND);
        if (aggregate.deleted) return void sendAmzError(res, ROBOT_ERRORS.ENTITY_DELETED);
        store.append({ name: 'RobotDeleted', objectId: key, created: now() });
        return void sendAmz(res, 200, COMMAND_ACCEPTED_RESPONSE);
      }

      case 'calibraterobot': {
        if (!isManufacturing) return void sendAmzError(res, ROBOT_ERRORS.MANUFACTURING_ONLY);
        if (typeof b.id !== 'string' || b.id === '') return void validation(res, ID_REQUIRED);
        if (!isPlainObject(b.calibrationPayload)) return void validation(res, 'child "calibrationPayload" fails because ["calibrationPayload" is required]');
        const key = convertRobotId(b.id);
        const aggregate = store.aggregate(key);
        if (!aggregate.exists) return void sendAmzError(res, ROBOT_ERRORS.ENTITY_NOT_FOUND);
        if (aggregate.deleted) return void sendAmzError(res, ROBOT_ERRORS.ENTITY_DELETED);
        store.append({ name: 'RobotCalibrated', objectId: key, created: now(), payload: b.calibrationPayload });
        return void sendAmz(res, 200, COMMAND_ACCEPTED_RESPONSE);
      }

      default:
        return void sendAmzError(res, ValidationException, `unknown Robot operation: ${op}`);
    }

    // No stored record + no forwarded identity: the robot's boot read must still get a
    // valid, empty record (the source 404s, but the robot relies on this read at boot and
    // falls back to its own /var calibration; see DIVERGENCES/A-07).
    function lanTrustRobot(id) {
      return { id: convertRobotId(id) || '', payload: {} };
    }

    // ---- read handlers -----------------------------------------------------
    async function readOp(which) {
      // permission: source isManufacturingOrAdmin || hasRobot(credentials.id).
      // Keep this separate from the event-log projection below.  An adopted
      // legacy robot is a real Account/loop record, but it predates Phoenix's
      // RobotCreated event log and therefore has no Classic lifecycle history.
      // A successful ownership lookup is the authority for its empty bootstrap
      // read; it is never a blanket exception for arbitrary missing ids.
      let ownsRequestedRobot = false;
      if (!isManufacturingOrAdmin) {
        let owned;
        if (credentials) {
          try {
            owned = await ownedRobots(credentials.id, false);
          } catch {
            owned = undefined;
          }
          if (!Array.isArray(owned)) return void sendAmzError(res, ROBOT_ERRORS.ACCOUNT_SERVICE_UNAVAILABLE);
          ownsRequestedRobot = owned.includes(b.id);
        }
        if (credentials && !ownsRequestedRobot) {
          return void sendAmzError(res, ROBOT_ERRORS.MANUFACTURING_OR_OWNER_ONLY);
        }
        // This branch is retained for unguarded compatibility fixtures only;
        // production Classic requests always carry the verified caller.
      }

      const aggregate = store.aggregate(b.id);
      const found = aggregate.exists && !aggregate.deleted; // a deleted robot is gone from the read projection

      // Administrators may read any existing lifecycle record without an
      // ownership lookup.  For a *missing* record, however, retain the same
      // ownership proof before treating it as an Account-adopted bootstrap
      // record.  This matters when the household owner is also an admin.
      if (!aggregate.exists && credentials && isAdmin) {
        try {
          const owned = await ownedRobots(credentials.id, false);
          ownsRequestedRobot = Array.isArray(owned) && owned.includes(b.id);
        } catch {
          ownsRequestedRobot = false;
        }
      }

      // An Account-adopted robot that has never gone through the manufacturing
      // lifecycle has no events at all.  Its verified owner may still read the
      // deliberately empty bootstrap projection (matching the robot's boot
      // fallback).  Do not apply this to a deleted aggregate: a deletion is
      // meaningful lifecycle state and must remain a 404.
      const accountAdoptedWithoutHistory = !!credentials && ownsRequestedRobot && !aggregate.exists;
      if (!found && credentials && !accountAdoptedWithoutHistory) {
        return void sendAmzError(res, ROBOT_ERRORS.ROBOT_NOT_FOUND);
      }

      if (found && b.serialNumber !== undefined) {
        const serial = (aggregate.payload || {}).serialNumber;
        if (!serial) return void sendAmzError(res, ROBOT_ERRORS.SERIAL_NUMBER_NOT_SET);
        if (serial !== b.serialNumber) return void sendAmzError(res, ROBOT_ERRORS.SERIAL_NUMBER_NOT_MATCH);
      }

      if (which === 'getrobot') {
        if (!found) return void sendAmz(res, 200, lanTrustRobot(b.id));
        const record = { id: aggregate.id, payload: aggregate.payload || {} };
        if (aggregate.created !== undefined) record.created = aggregate.created;
        if (aggregate.updated !== undefined) record.updated = aggregate.updated;
        return void sendAmz(res, 200, record);
      }

      if (which === 'getcalibrationdata') {
        if (!found) return void sendAmz(res, 200, { id: aggregate.id, calibrationPayload: {} });
        const record = { id: aggregate.id };
        if (aggregate.calibrationPayload !== undefined) record.calibrationPayload = aggregate.calibrationPayload;
        return void sendAmz(res, 200, record);
      }

      // getrobothistory — output shape Events = list of Event{id,name,payload,created}.
      if (!found) return void sendAmz(res, 200, []);
      return void sendAmz(res, 200, aggregate.events.map((event) => ({
        id: event.objectId,
        name: event.name,
        created: event.created,
        payload: event.payload,
      })));
    }
  };
}

export default makeRobotHandler;
