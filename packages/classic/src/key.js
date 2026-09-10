// `key` service (Key_20160201) — the UGC (user-generated-content) encryption-key exchange plus
// the loop key backup/restore and the binary decryption-request flow.
//
// Pinned source (read via the Jibo archive MCP):
//   jiborobot/srv-key-ws  src/controllers/key.ctrl.ts, src/handlers/key.handler.ts,
//                         src/errors/key.ts, src/routes/binary.route.ts,
//                         src/schemes/{key,backup,binary}.ts, config/config.json
//   jiborobot/srv-jibo-server-client  apis/key-2016-02-01.normal.json  (targetPrefix Key_20160201)
//
// The original is a @jibo/server (Hapi) service over MongoDB behind the security gateway:
//   * identity is request.auth.credentials.id — the gateway-forwarded account id;
//   * Key      docs are keyed by _id, deduped per (accountId, loopId, publicKey);
//   * Backup   docs are keyed by loopId ALONE (unique index on loopId — one per loop);
//   * Binary   docs hold encryptedUrl -> decryptedUrl for the binary decrypt flow;
//   * errors are Boom.createWithCode(<errors/key.ts>) -> exact code + status (403/404/409).
// The generated client reads `err.code` from `x-amzn-errortype` or the body `__type`, so the
// Phoenix envelope ({__type, message} + x-amzn-errortype) is client-equivalent (A-02 convention).
//
// DURABILITY: the source kept Key/Backup/Binary in MongoDB, so the state outlived the process.
// Phoenix has no Mongo, so the local counterpart is one atomically-rewritten JSON file
// (ETCO_classic_keyFile, default $TMPDIR/phoenix-key.json) loaded on construction — a restarted
// process serves the same requests, backups and decrypted binaries. Binary uploads land under
// ETCO_classic_keyBinaryDir (default $TMPDIR/phx-key-binaries) and are served back from there.
//
// OWNERSHIP / MEMBERSHIP: the source consulted the Account service for loop membership
// (Loop_2016.ListLoopMembers / ListLoops via AccountClient). Phoenix injects that seam
// (`membership`) and the default implementation calls the internal Account peer routes over the
// trusted hop; an unresolvable lookup leaves the LAN-trust path (same policy as the Backup
// service — see DIVERGENCES).
//
// The cloud's SNS machine wake-up IS reproduced on CreateRequest, by the transport the robot
// already holds open: `KeyNeeded` is enqueued to the loop's robot account through the
// Notification_20150505 socket hub (packages/classic/src/notification.js). jibo-server-service
// relays that frame to jibo-sts's `/server/notifications` socket, whose NotificationManager emits
// `KeyNeeded` -> Exchange.handleKeyNeeded -> processIncomingKeyRequests, so the robot answers
// the request immediately instead of waiting for its 30-minute INCOMING_POLL_DELAY.
// The remaining machine events (KeyShared/KeyTimeout/BinaryNeeded/BinaryShared) are still not
// reproduced: they are response-path notifications, and the requesters poll for their answer.
// The key material itself never reaches Phoenix: the robot encrypts it to the requester's public
// key and only the opaque `encryptedKey` is stored (see the BLIND RELAY note below).

import { randomBytes } from 'node:crypto';
import {
  chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync,
  createWriteStream, createReadStream, rmSync,
} from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { DefaultPort } from '@phoenix/contracts';
import { sendAmz, sendAmzError, accessKeyIdFromAuth } from './awsJson.js';
import { credentialsAccountId } from './backup.js';

/** Source: srv-key-ws src/errors/key.ts — exact codes and status codes. */
export const KEY_ERRORS = Object.freeze({
  KEY_NOT_FOUND: { code: 'KEY_NOT_FOUND', message: 'Key not found', statusCode: 404 },
  KEY_NOT_PART_OF_LOOP: {
    code: 'KEY_NOT_PART_OF_LOOP', message: 'Only loop members can list keys', statusCode: 403,
  },
  ONLY_OWNER_CAN_BACKUP_RESTORE: {
    code: 'ONLY_OWNER_CAN_BACKUP_RESTORE',
    message: 'Only loop owner can backup and restore key',
    statusCode: 403,
  },
  ONLY_OWNER_OR_ROBOT_CAN_RESTORE: {
    code: 'ONLY_OWNER_OR_ROBOT_CAN_RESTORE',
    message: 'Only loop owner or robot can restore key',
    statusCode: 403,
  },
  BACKUP_NOT_FOUND: { code: 'BACKUP_NOT_FOUND', message: 'Backup not found', statusCode: 404 },
  BACKUP_PASSWORD_WRONG: {
    code: 'BACKUP_PASSWORD_WRONG', message: 'Backup password is wrong', statusCode: 409,
  },
  BINARY_NOT_FOUND: { code: 'BINARY_NOT_FOUND', message: 'Binary not found', statusCode: 404 },
  BINARY_NOT_PART_OF_LOOP: {
    code: 'BINARY_NOT_PART_OF_LOOP', message: 'Only loop members can list binaries', statusCode: 403,
  },
  KEY_HASH_DOESNT_MATCH: {
    code: 'KEY_HASH_DOESNT_MATCH', message: 'Key hash doesn\'t match for the loop', statusCode: 409,
  },
});

/** config/config.json: keyShareTimeout 60000 — the source's pending-request timeout. */
const KEY_SHARE_TIMEOUT_MS = Number(process.env.ETCO_classic_keyShareTimeoutMS) || 60_000;
/** The source's list windows: `created > Date.now() - 1000*3600*24*7`. */
const LIST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_FILE = join(tmpdir(), 'phoenix-key.json');
const DEFAULT_BINARY_DIR = join(tmpdir(), 'phx-key-binaries');
const ACCOUNT_TIMEOUT_MS = Number(process.env.ETCO_classic_keyAccountTimeoutMS) || 3000;
const SAFE = /^[A-Za-z0-9_-]+$/; // ids land in file paths / URLs — no traversal

const DEFAULT_PERSISTENCE = {
  chmod: chmodSync, exists: existsSync, mkdir: mkdirSync,
  readFile: readFileSync, rename: renameSync, unlink: unlinkSync, writeFile: writeFileSync,
};

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
/** Mongo ids are 24-hex ObjectIds; the Phoenix counterpart is 12 random bytes hex-encoded. */
const newObjectId = () => randomBytes(12).toString('hex');

/**
 * Durable Key/Backup/Binary store — the local counterpart of the source's three Mongo
 * collections (src/schemes/{key,backup,binary}.ts). Each mutation is atomically persisted to
 * one JSON file so a restarted process serves the same state.
 */
export class KeyStore {
  constructor(file = process.env.ETCO_classic_keyFile || DEFAULT_FILE, options = {}) {
    this.file = file;
    this.persistence = { ...DEFAULT_PERSISTENCE, ...(options.persistence || {}) };
    this.clock = options.clock || (() => Date.now());
    this.keys = new Map();     // id -> { id, accountId, loopId, publicKey, keyHash?, encryptedKey?, created }
    this.backups = new Map();  // loopId -> { loopId, accountId, encryptedKey, passwordHash?, created }
    this.binaries = new Map(); // id -> { id, accountId, loopId, encryptedUrl, decryptedUrl?, created }
    this._load();
    this._committed = this._snapshot();
  }

  _load() {
    if (!this.persistence.exists(this.file)) return;
    let raw;
    try {
      raw = JSON.parse(this.persistence.readFile(this.file, 'utf8'));
    } catch (error) {
      throw new Error(`key store unreadable (${this.file}): ${error.message}`);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`key store has an invalid root (${this.file})`);
    }
    for (const k of raw.keys || []) if (k && k.id) this.keys.set(String(k.id), { ...k });
    for (const b of raw.backups || []) if (b && b.loopId) this.backups.set(String(b.loopId), { ...b });
    for (const b of raw.binaries || []) if (b && b.id) this.binaries.set(String(b.id), { ...b });
  }

  _snapshot() {
    return {
      keys: new Map([...this.keys].map(([k, v]) => [k, clone(v)])),
      backups: new Map([...this.backups].map(([k, v]) => [k, clone(v)])),
      binaries: new Map([...this.binaries].map(([k, v]) => [k, clone(v)])),
    };
  }

  _restore(snapshot) {
    this.keys = snapshot.keys;
    this.backups = snapshot.backups;
    this.binaries = snapshot.binaries;
  }

  _commit(mutator) {
    const before = this._snapshot();
    try {
      const result = mutator();
      this.flush({ rollbackOnError: false });
      return result;
    } catch (error) {
      this._restore(before);
      throw error;
    }
  }

  /** Atomically replace the persisted file after a mutation. */
  flush({ rollbackOnError = true } = {}) {
    const output = {
      version: 1,
      keys: [...this.keys.values()].map(clone),
      backups: [...this.backups.values()].map(clone),
      binaries: [...this.binaries.values()].map(clone),
    };
    const parent = dirname(this.file);
    const temporary = `${this.file}.tmp`;
    let renamed = false;
    try {
      this.persistence.mkdir(parent, { recursive: true, mode: 0o700 });
      this.persistence.writeFile(temporary, `${JSON.stringify(output, null, 2)}\n`, {
        encoding: 'utf8', mode: 0o600,
      });
      this.persistence.chmod(temporary, 0o600);
      this.persistence.rename(temporary, this.file);
      renamed = true;
      this._committed = this._snapshot();
    } catch (error) {
      if (!renamed) {
        try { this.persistence.unlink(temporary); } catch { /* cleanup is best effort */ }
        if (rollbackOnError && this._committed) this._restore(this._committed);
      }
      throw error;
    }
  }

  // ---- Key requests (source KeyController.createRequest/getRequest/share/shouldCreate) ----

  /**
   * Source KeyController.createRequest: findOne({accountId, loopId, publicKey}) then create —
   * the same (account, loop, public key) triple reuses one request document.
   */
  create({ accountId, loopId, publicKey }) {
    const existing = this.findKey({ accountId, loopId, publicKey });
    if (existing) return existing;
    return this._commit(() => {
      const key = { id: newObjectId(), accountId, loopId, publicKey, created: this.clock() };
      this.keys.set(key.id, key);
      return key;
    });
  }

  findKey({ accountId, loopId, publicKey }) {
    for (const k of this.keys.values()) {
      if (k.accountId === accountId && k.loopId === loopId && k.publicKey === publicKey) return k;
    }
    return null;
  }

  get(id) { return this.keys.get(String(id)) || null; }

  /** Source KeyController.share: set encryptedKey + keyHash on the request document. */
  share(id, encryptedKey, keyHash) {
    const key = this.keys.get(String(id));
    if (!key) return null;
    return this._commit(() => {
      key.encryptedKey = encryptedKey;
      key.keyHash = keyHash;
      return key;
    });
  }

  /**
   * Source checkShaingSameKey: every OTHER key document in the loop that already carries a
   * keyHash must carry the SAME one, else KEY_HASH_DOESNT_MATCH (409).
   */
  keyHashConflict(loopId, keyHash) {
    if (keyHash === undefined || keyHash === null) return false;
    for (const k of this.keys.values()) {
      if (k.loopId === loopId && k.keyHash && k.keyHash !== keyHash) return true;
    }
    return false;
  }

  /** Source shouldCreate: any satisfied (encryptedKey-bearing) key in the loop wins. */
  shouldCreate(loopId) {
    for (const key of this.keys.values()) {
      if (key.loopId === loopId && key.encryptedKey) return false;
    }
    return true;
  }

  /** Source listIncomingRequests: pending keys in the loop created by OTHER members, within 7d. */
  incomingRequests(loopId, { accountIds, excludeAccountId } = {}) {
    const cutoff = this.clock() - LIST_WINDOW_MS;
    return [...this.keys.values()].filter((k) => {
      if (k.loopId !== loopId || k.encryptedKey) return false;
      if (k.created !== undefined && k.created <= cutoff) return false;
      if (accountIds && !accountIds.includes(k.accountId)) return false;
      if (!accountIds && excludeAccountId !== undefined && k.accountId === excludeAccountId) return false;
      return true;
    });
  }

  // ---- Key backups (source KeyController.backup/restore) ----

  /** Source backup: one Backup per loopId (unique index) — an existing doc is updated in place. */
  backup({ loopId, accountId, encryptedKey, passwordHash }) {
    return this._commit(() => {
      let backup = this.backups.get(String(loopId));
      if (!backup) {
        backup = { loopId, accountId, created: this.clock() };
        this.backups.set(String(loopId), backup);
      }
      backup.encryptedKey = encryptedKey;
      backup.passwordHash = passwordHash;
      return backup;
    });
  }

  restore(loopId) { return this.backups.get(String(loopId)) || null; }

  // ---- Binaries (source KeyController.createBinaryRequest/shareBinary/listBinaryRequests) ----

  createBinary({ accountId, loopId, encryptedUrl }) {
    for (const b of this.binaries.values()) {
      if (b.accountId === accountId && b.loopId === loopId && b.encryptedUrl === encryptedUrl) return b;
    }
    return this._commit(() => {
      const binary = { id: newObjectId(), accountId, loopId, encryptedUrl, created: this.clock() };
      this.binaries.set(binary.id, binary);
      return binary;
    });
  }

  getBinary(id) { return this.binaries.get(String(id)) || null; }

  setBinaryDecryptedUrl(id, decryptedUrl) {
    const binary = this.binaries.get(String(id));
    if (!binary) return null;
    return this._commit(() => {
      binary.decryptedUrl = decryptedUrl;
      return binary;
    });
  }

  /** Source listBinaryRequests: undecrypted binaries created by loop members, within 7d. */
  listBinaries(loopId, { accountIds } = {}) {
    const cutoff = this.clock() - LIST_WINDOW_MS;
    return [...this.binaries.values()].filter((b) => {
      if (b.loopId !== loopId || b.decryptedUrl) return false;
      if (b.created !== undefined && b.created <= cutoff) return false;
      if (accountIds && !accountIds.includes(b.accountId)) return false;
      return true;
    });
  }

  removeBinaries(encryptedUrls) {
    const wanted = new Set((encryptedUrls || []).map(String));
    return this._commit(() => {
      for (const [id, b] of [...this.binaries]) if (wanted.has(b.encryptedUrl)) this.binaries.delete(id);
      return true;
    });
  }
}

// ---- identity + membership (source handshake with the Account service) --------------------

/**
 * The source's identity is `request.auth.credentials.id`, produced by the gateway. Phoenix's
 * classic face runs without the gateway in-process, so the forwarded `x-amz-credentials` header
 * wins (same seam as the Backup service) and, failing that, the SigV4 Credential access key is
 * resolved to an account id through the injected account store (`accountResolver`).
 *
 * DEFECT FIXED HERE (2026-09-10): the first cut returned the raw access key id as the account id.
 * A real client authenticates with SigV4 only and carries no `x-amz-credentials` header, so the
 * membership check compared an access key (`ylaMUYGrT39yLGHoCUxt`) against account ids and
 * ALWAYS refused `Key_20160201.CreateRequest` with 403 KEY_NOT_PART_OF_LOOP. The existing tests
 * missed it because their fixture used the account id AS the access key. Media already resolves
 * the access key this way (`accessKeyAccountResolver`); key now does too.
 */
export function keyCallerAccountId(req, resolveAccount) {
  const forwarded = credentialsAccountId(req);
  if (forwarded) return forwarded;
  const accessKeyId = accessKeyIdFromAuth(req);
  if (typeof resolveAccount === 'function') {
    try {
      const resolved = resolveAccount(req);
      if (resolved) return String(resolved);
    } catch { /* fall through to the raw access key (LAN trust, as elsewhere) */ }
  }
  return accessKeyId;
}

function accountBase() {
  const v = process.env.NET_account;
  if (!v) return `http://localhost:${DefaultPort.account}`;
  return /^https?:\/\//.test(v) ? v : `http://${v}`;
}

/**
 * Default membership seam: the internal Account peer routes.
 *   GET /loop?loopId=        -> { id, robot, owner, isSuspended } (404 when unknown)
 *   GET /loopMembers?loopId= -> { members: [accountId, …] }
 * `undefined` means "could not resolve" (service down / route absent) and callers keep the
 * documented LAN-trust path rather than refusing a legitimate call on an unrelated outage.
 */
export function accountMembership() {
  return {
    async memberIds(loopId) {
      try {
        const res = await fetch(`${accountBase()}/loopMembers?loopId=${encodeURIComponent(loopId)}`, {
          signal: AbortSignal.timeout(ACCOUNT_TIMEOUT_MS),
        });
        if (!res.ok) return undefined;
        const doc = await res.json();
        return Array.isArray(doc?.members) ? doc.members.map(String) : undefined;
      } catch { return undefined; }
    },
    async loop(loopId) {
      try {
        const res = await fetch(`${accountBase()}/loop?loopId=${encodeURIComponent(loopId)}`, {
          signal: AbortSignal.timeout(ACCOUNT_TIMEOUT_MS),
        });
        if (res.status === 404) return null;   // the account service answered: no such loop
        if (!res.ok) return undefined;         // transient/other failure -> unresolved
        const doc = await res.json();
        if (!doc || typeof doc !== 'object') return undefined;
        return { owner: doc.owner === undefined ? null : String(doc.owner), robot: doc.robot === undefined ? null : String(doc.robot) };
      } catch { return undefined; }
    },
  };
}

// ---- validation (source @validatePayload / @validateHeaders -> Boom.badData) ---------------

/** Joi.string().required() failure wording, matching the source @jibo/server decorators. */
function requiredString(body, field) {
  const value = body[field];
  if (value === undefined || value === null) return `child "${field}" fails because ["${field}" is required]`;
  if (typeof value !== 'string') return `child "${field}" fails because ["${field}" must be a string]`;
  if (value.length === 0) return `child "${field}" fails because ["${field}" is not allowed to be empty]`;
  return null;
}

function optionalString(body, field) {
  const value = body[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return `child "${field}" fails because ["${field}" must be a string]`;
  return null;
}

/** Boom.badData (422) envelope — the source validatePayload/validateHeaders refusal. */
function sendBadData(res, message) {
  const body = JSON.stringify({ statusCode: 422, error: 'Unprocessable Entity', message });
  res.removeHeader?.('x-powered-by');
  res.writeHead(422, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-cache',
    vary: 'accept-encoding',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

// ---- output views (exactly the members declared in key-2016-02-01.normal.json) -------------

function requestView(key) {
  const out = { id: key.id, accountId: key.accountId, loopId: key.loopId, publicKey: key.publicKey };
  if (key.encryptedKey !== undefined && key.encryptedKey !== null) out.encryptedKey = key.encryptedKey;
  return out;
}

function backupView(backup) {
  return { loopId: backup.loopId, accountId: backup.accountId, encryptedKey: backup.encryptedKey };
}

function binaryView(binary) {
  const out = { id: binary.id, accountId: binary.accountId, loopId: binary.loopId, encryptedUrl: binary.encryptedUrl };
  if (binary.decryptedUrl) out.decryptedUrl = binary.decryptedUrl;
  return out;
}

function notFound(res, code) { sendAmzError(res, KEY_ERRORS[code]); }
function refuse(res, code) { sendAmzError(res, KEY_ERRORS[code]); }

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// ---- handler -------------------------------------------------------------------------------

/**
 * @param {KeyStore} store
 * @param {{
 *   membership?: { memberIds: (loopId: string) => Promise<string[]|undefined>,
 *                  loop?: (loopId: string) => Promise<{owner: string|null, robot: string|null}|null|undefined> },
 *   baseFor?: (req) => string,
 *   binaryDir?: string,
 *   keyShareTimeoutMs?: number,
 *   accountResolver?: (req) => string|null,
 *   notifyKeyNeeded?: (request: { loopId: string, siblingAccountIds: string[]|undefined,
 *                                requestedBy: string }) => Promise<void>|void,
 * }} [options]
 */
export function makeKeyHandler(store = new KeyStore(), {
  membership = accountMembership(), baseFor, binaryDir = process.env.ETCO_classic_keyBinaryDir || DEFAULT_BINARY_DIR,
  keyShareTimeoutMs = KEY_SHARE_TIMEOUT_MS, accountResolver, notifyKeyNeeded,
} = {}) {
  const urlBase = baseFor || ((req) => `http://${(req?.headers && req.headers.host) || 'localhost'}`);
  const binaryDirOf = binaryDir;

  /**
   * Source getSiblingIds/getMemberIds: consult the Account service for the loop's members.
   * Returns `undefined` when membership cannot be resolved (LAN-trust path), else the member id
   * list. `forAccountId` mirrors the source's `listMembers(accountId)` — the account whose own
   * membership list is consulted; a non-member is refused KEY_NOT_PART_OF_LOOP.
   */
  async function members(loopId, forAccountId) {
    let ids;
    try { ids = await membership.memberIds(loopId); } catch { ids = undefined; }
    if (ids === undefined || ids === null) return undefined;
    const list = ids.map(String);
    if (forAccountId && !list.includes(String(forAccountId))) throw KEY_ERRORS.KEY_NOT_PART_OF_LOOP;
    return list;
  }

  /** Source checkOwnership (Backup) / checkOwnerOrRobot (Restore) against Loop_2016.ListLoops. */
  async function loopOf(loopId) {
    if (typeof membership.loop !== 'function') return undefined;
    try { return await membership.loop(loopId); } catch { return undefined; }
  }

  function binaryPath(accountId, id, encryptedUrl) {
    const isImage = String(encryptedUrl || '').endsWith('.jpg');
    return `${accountId}/${id}${isImage ? '.jpg' : ''}`;
  }

  function binaryFile(path) {
    return join(binaryDirOf, path);
  }

  return async function keyHandler({ req, res, body, op, log }) {
    const caller = keyCallerAccountId(req, accountResolver);
    const accountId = caller || 'anon';
    const b = body || {};
    switch (String(op || '').toLowerCase()) {
      case 'createrequest': {
        const invalid = requiredString(b, 'loopId') || requiredString(b, 'publicKey');
        if (invalid) return void sendBadData(res, invalid);
        let siblingIds;
        try {
          const ids = await members(b.loopId, caller);
          siblingIds = ids ? ids.filter((id) => String(id) !== String(caller)) : undefined;
        } catch (error) {
          return void sendAmzError(res, error);
        }
        const key = store.create({ accountId, loopId: b.loopId, publicKey: b.publicKey });
        // Source sends KeyNeeded to the siblings and arms a KeyTimeout after keyShareTimeout.
        // Phoenix delivers the machine wake-up over the robot's notification socket instead of
        // SNS (see the header note); a notification failure must never fail the key request, so
        // the publish is best-effort and reported only in the log.
        if (typeof notifyKeyNeeded === 'function') {
          try {
            await notifyKeyNeeded({ loopId: key.loopId, siblingAccountIds: siblingIds, requestedBy: accountId });
          } catch (error) {
            log?.warn?.('key needed notification failed', { loopId: key.loopId, error: error?.message || String(error) });
          }
        }
        log?.info?.('key request created', { id: key.id, loopId: key.loopId });
        scheduleKeyTimeout();
        return void sendAmz(res, 200, requestView(key));
      }
      case 'getrequest': {
        const invalid = requiredString(b, 'id');
        if (invalid) return void sendBadData(res, invalid);
        const key = store.get(b.id);
        if (!key) return void notFound(res, 'KEY_NOT_FOUND');
        if (caller && String(key.accountId) !== String(caller)) {
          // Source getRequest: a requester other than the owner must be a loop sibling.
          try {
            await members(key.loopId, caller);
          } catch (error) {
            return void sendAmzError(res, error);
          }
        }
        return void sendAmz(res, 200, requestView(key));
      }
      case 'share': {
        const invalid = requiredString(b, 'id') || requiredString(b, 'encryptedKey') || optionalString(b, 'keyHash');
        if (invalid) return void sendBadData(res, invalid);
        const key = store.get(b.id);
        if (!key) return void notFound(res, 'KEY_NOT_FOUND');
        if (store.keyHashConflict(key.loopId, b.keyHash)) return void refuse(res, 'KEY_HASH_DOESNT_MATCH');
        try {
          // Source share: the sharer must be a SIBLING of the requesting account.
          const ids = await members(key.loopId, key.accountId);
          if (ids && caller && !ids.map(String).includes(String(caller))) return void refuse(res, 'KEY_NOT_PART_OF_LOOP');
        } catch (error) {
          return void sendAmzError(res, error);
        }
        const shared = store.share(b.id, b.encryptedKey, b.keyHash);
        return void sendAmz(res, 200, requestView(shared));
      }
      case 'shouldcreate': {
        const invalid = requiredString(b, 'loopId');
        if (invalid) return void sendBadData(res, invalid);
        const loop = await loopOf(b.loopId);
        if (loop === null) return void refuse(res, 'KEY_NOT_PART_OF_LOOP'); // source: loops.length < 1
        return void sendAmz(res, 200, { shouldCreate: store.shouldCreate(b.loopId) });
      }
      case 'listincomingrequests': {
        const invalid = requiredString(b, 'loopId');
        if (invalid) return void sendBadData(res, invalid);
        let ids;
        try {
          ids = await members(b.loopId, caller);
        } catch (error) {
          return void sendAmzError(res, error);
        }
        const siblings = ids ? ids.filter((id) => String(id) !== String(caller)) : undefined;
        const pending = store.incomingRequests(b.loopId, siblings
          ? { accountIds: siblings }
          : { excludeAccountId: caller === null ? undefined : caller });
        return void sendAmz(res, 200, pending.map(requestView));
      }
      case 'backup': {
        const invalid = requiredString(b, 'loopId') || requiredString(b, 'encryptedKey') || optionalString(b, 'passwordHash');
        if (invalid) return void sendBadData(res, invalid);
        const loop = await loopOf(b.loopId);
        if (loop === null) return void refuse(res, 'ONLY_OWNER_CAN_BACKUP_RESTORE');
        if (loop && caller && String(loop.owner) !== String(caller)) {
          return void refuse(res, 'ONLY_OWNER_CAN_BACKUP_RESTORE');
        }
        const backup = store.backup({
          loopId: b.loopId, accountId, encryptedKey: b.encryptedKey, passwordHash: b.passwordHash,
        });
        return void sendAmz(res, 200, backupView(backup));
      }
      case 'restore': {
        const invalid = requiredString(b, 'loopId') || optionalString(b, 'passwordHash');
        if (invalid) return void sendBadData(res, invalid);
        const loop = await loopOf(b.loopId);
        if (loop === null) return void refuse(res, 'ONLY_OWNER_OR_ROBOT_CAN_RESTORE');
        if (loop && caller && String(loop.owner) !== String(caller) && String(loop.robot) !== String(caller)) {
          return void refuse(res, 'ONLY_OWNER_OR_ROBOT_CAN_RESTORE');
        }
        const backup = store.restore(b.loopId);
        if (!backup) return void notFound(res, 'BACKUP_NOT_FOUND');
        // Source restore: only a SUPPLIED hash is compared; an omitted one restores.
        if (b.passwordHash !== undefined && b.passwordHash !== null && b.passwordHash !== backup.passwordHash) {
          return void refuse(res, 'BACKUP_PASSWORD_WRONG');
        }
        return void sendAmz(res, 200, backupView(backup));
      }
      case 'listbinaryrequests': {
        const invalid = requiredString(b, 'loopId');
        if (invalid) return void sendBadData(res, invalid);
        let ids;
        try {
          ids = await members(b.loopId, caller);
        } catch (error) {
          return void sendAmzError(res, error);
        }
        const pending = store.listBinaries(b.loopId, ids ? { accountIds: ids } : {});
        return void sendAmz(res, 200, pending.map(binaryView));
      }
      case 'sharebinary': {
        // Source handler: `@validateHeaders({ 'x-id': Joi.string().required() })` and the raw
        // request payload IS the decrypted stream (ShareBinaryRequest.payload = body).
        const id = (req.headers && req.headers['x-id']) || undefined;
        if (typeof id !== 'string' || id.length === 0) {
          return void sendBadData(res, 'child "x-id" fails because ["x-id" is required]');
        }
        const binary = store.getBinary(id);
        if (!binary) return void notFound(res, 'BINARY_NOT_FOUND');
        try {
          // Source shareBinary: memberIds of the REQUESTING account's loop…
          const ids = await members(binary.loopId, binary.accountId);
          // …then the SHARER must be among them.
          if (ids && caller && !ids.map(String).includes(String(caller))) {
            return void refuse(res, 'BINARY_NOT_PART_OF_LOOP');
          }
        } catch (error) {
          return void sendAmzError(res, error);
        }
        const path = binaryPath(caller || binary.accountId, binary.id, binary.encryptedUrl);
        try {
          await mkdir(binaryFile(dirname(path)), { recursive: true });
          const bytes = await readBody(req);
          if (bytes.length) await writeFileAtomic(binaryFile(path), bytes);
        } catch (error) {
          log?.error?.('key binary store failed', { error: error.message });
          return void sendAmzError(res, { code: 'INTERNAL_ERROR', statusCode: 500, message: 'Binary store failed' });
        }
        // The source uploaded to S3 (BinaryController.createPublic) and returned its public url.
        const decryptedUrl = `${urlBase(req)}/key/binary?accountId=${encodeURIComponent(caller || binary.accountId)}&id=${encodeURIComponent(binary.id)}`;
        const shared = store.setBinaryDecryptedUrl(binary.id, decryptedUrl);
        log?.info?.('key binary shared', { id: binary.id, loopId: binary.loopId });
        return void sendAmz(res, 200, binaryView(shared));
      }
      default:
        return void sendAmzError(res, {
          code: 'ValidationException',
          statusCode: 400,
          message: `unknown Key operation: ${op}`,
        });
    }
  };

  /** The source armed a KeyTimeout event after config.json keyShareTimeout; Phoenix has no SNS. */
  function scheduleKeyTimeout() { /* no-op: SNS events are out of scope (see header) */ }
}

/** Write the uploaded binary atomically so a crash cannot leave a half-written object. */
async function writeFileAtomic(file, bytes) {
  const temporary = `${file}.tmp`;
  mkdirSync(dirname(file), { recursive: true });
  const sink = createWriteStream(temporary, { mode: 0o600 });
  await new Promise((resolve, reject) => {
    sink.on('error', reject);
    sink.on('finish', resolve);
    sink.end(bytes);
  });
  renameSync(temporary, file);
}

// ---- non-AWS-JSON routes of the source service (src/routes/binary.route.ts) ----------------

/**
 * POST /binaryRequest and POST /deleteBinaries — the two plain Hapi routes srv-key-ws registers
 * on its own HTTP server next to the AWS-JSON face (binary.route.ts), plus the GET that serves
 * the uploaded decrypted binary back. The upstream binary URL was S3; Phoenix self-hosts it (the
 * same divergence as the Backup blobs).
 *
 * NOTE: no generated client model declares CreateBinaryRequest/DeleteBinaries, so the caller of
 * these two routes in the live deployment is UNKNOWN (the mobile app is dead) — they are built to
 * the pinned route contract.
 */
export function keyRoutes(store, { membership = accountMembership(), baseFor, binaryDir = process.env.ETCO_classic_keyBinaryDir || DEFAULT_BINARY_DIR } = {}) {
  const urlBase = baseFor || ((req) => `http://${(req?.headers && req.headers.host) || 'localhost'}`);

  const createBinaryRequest = async ({ req, res, body, log }) => {
    const b = body || {};
    const invalid = requiredString(b, 'loopId') || requiredString(b, 'accountId') || requiredString(b, 'encryptedUrl');
    if (invalid) return void sendBadData(res, invalid);
    let ids;
    try {
      ids = await membership.memberIds(b.loopId);
      if (ids && !ids.map(String).includes(String(b.accountId))) {
        return void sendHapiError(res, KEY_ERRORS.KEY_NOT_PART_OF_LOOP);
      }
    } catch (error) {
      return void sendHapiError(res, { code: error.code || 'INTERNAL_ERROR', statusCode: error.statusCode || 500, message: error.message });
    }
    const binary = store.createBinary({ accountId: b.accountId, loopId: b.loopId, encryptedUrl: b.encryptedUrl });
    log?.info?.('key binary request created', { id: binary.id, loopId: binary.loopId });
    return void sendExpress(res, 200, binaryView(binary));
  };

  const deleteBinaries = ({ res, body }) => {
    const b = body || {};
    if (!Array.isArray(b.encryptedUrls)) {
      return void sendBadData(res, 'child "encryptedUrls" fails because ["encryptedUrls" is required]');
    }
    for (const binary of [...store.binaries.values()]) {
      if (!b.encryptedUrls.map(String).includes(String(binary.encryptedUrl))) continue;
      for (const candidate of [binaryPathOf(binary, false), binaryPathOf(binary, true)]) {
        try { rmSync(join(binaryDir, candidate), { force: true }); } catch { /* best effort */ }
      }
    }
    store.removeBinaries(b.encryptedUrls);
    return void sendExpress(res, 200, { result: 'Command accepted' });
  };

  const getBinary = async ({ res, url, log }) => {
    const accountId = url.searchParams.get('accountId');
    const id = url.searchParams.get('id');
    if (!accountId || !id || !SAFE.test(accountId) || !SAFE.test(id)) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      return void res.end('bad accountId/id');
    }
    const binary = store.getBinary(id);
    if (!binary) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return void res.end('no such binary');
    }
    const path = binaryPathOf(binary, String(binary.encryptedUrl || '').endsWith('.jpg'), accountId);
    try {
      const stat = statSync(join(binaryDir, path));
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': stat.size });
      await pipeline(createReadStream(join(binaryDir, path)), res);
    } catch (error) {
      log?.warn?.('key binary stream failed', { error: error.message });
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('no such binary');
    }
  };
  getBinary.rawBody = true;

  return { 'POST /binaryRequest': createBinaryRequest, 'POST /deleteBinaries': deleteBinaries, 'GET /key/binary': getBinary };
}

function binaryPathOf(binary, isImage, accountId = binary.accountId) {
  return `${accountId}/${binary.id}${isImage ? '.jpg' : ''}`;
}

/** Hapi/Express JSON reply for the two plain routes (no AWS-JSON envelope). */
function sendExpress(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

const REASON = { 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 422: 'Unprocessable Entity' };

/** Source Boom.createWithCode payload for the plain HTTP routes. */
function sendHapiError(res, err) {
  const payload = { statusCode: err.statusCode, error: REASON[err.statusCode] || 'Error', message: err.message };
  if (err.code) payload.code = err.code;
  const body = JSON.stringify(payload);
  res.removeHeader?.('x-powered-by');
  res.writeHead(err.statusCode, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
