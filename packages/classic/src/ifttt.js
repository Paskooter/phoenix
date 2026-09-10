// `ifttt` service (IFTTT_20170207) — Jibo's IFTTT integration wire surface.
//
// The pinned source (read through the Jibo archive MCP, cited by file):
//   apis/ifttt-2017-02-07.normal.json                7 operations; targetPrefix IFTTT_20170207
//   jiborobot/srv-ifttt-ws src/handlers/ifttt.handler.ts   op mapping + @validatePayload Joi rules
//   jiborobot/srv-ifttt-ws src/controllers/ifttt.ctrl.ts   controller semantics (the real contract)
//   jiborobot/srv-ifttt-ws src/schemes/{action,identity,media,trigger}.ts   toJSON id/created maps
//   jiborobot/srv-ifttt-ws src/errors/ifttt.ts             the six Boom codes + statuses
//   jiborobot/srv-ifttt-ws src/clients/{ifttt,account}.client.ts
//
// DEAD THIRD PARTY (explicit, never faked):
//   IftttClient.notify() POSTs to https://realtime.ifttt.com/v1/notifications with an
//   `IFTTT-Channel-Key` header (ifttt.client.ts). IFTTT retired that channel and the Jibo
//   channel key is gone; there is nothing to call. The controller still creates the Trigger
//   rows and returns CommandResponse{result:"Command accepted"} regardless, so Phoenix keeps
//   that wire behavior, but the notify step is an injectable adapter whose DEFAULT records the
//   attempt as UNAVAILABLE (delivered:false, reason) and never reports a fabricated success.
//
// The Mongo collections (Identity/Trigger/Action/TriggerMedia) and the Account/loop list and
// KeyClient are other dead Classic services. The four Mongo-backed collections are reproduced by
// a durable, atomically replaced JSON store (Mongo's own durability, see DEFAULT_FILE/_persist)
// plus injectable fixture adapters (loops / notify / key / email). The default loop
// adapter answers the LAN-trust single-household case so a real client still gets shapes and
// statuses instead of errors; every adapter is replaceable and nothing is invented.

import { sendAmz, sendAmzError, accessKeyIdFromAuth, ValidationException } from './awsJson.js';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

// The original IFTTT service kept Identity/Trigger/Action/TriggerMedia in Mongo (see
// jiborobot/srv-ifttt-ws src/schemes/*.ts), so the state is durable across process restarts.
// Phoenix has no Mongo dependency; it keeps the same document boundaries in one atomically
// replaced JSON file, matching the other Classic stores (notificationStore/key/person/jot/media).
const DEFAULT_FILE = join(tmpdir(), 'phoenix-ifttt.json');

// jiborobot/srv-ifttt-ws src/errors/ifttt.ts — verbatim codes, messages and statuses.
export const IFTTT_ERRORS = {
  ROBOT_MUST_CALL: { code: 'ROBOT_MUST_CALL', message: 'Only robot must be calling this method', statusCode: 403 },
  APPLET_NOT_FOUND: { code: 'APPLET_NOT_FOUND', message: 'Corresponding applet not found in IFTTT', statusCode: 404 },
  USER_NOT_FOUND: { code: 'USER_NOT_FOUND', message: 'Corresponding user not linked to Jibo account', statusCode: 404 },
  IDENTITY_NOT_FOUND: { code: 'IDENTITY_NOT_FOUND', message: 'Identity not found', statusCode: 404 },
  IDENTITY_ONLY_ACCESSIBLE_BY_OWNER: { code: 'IDENTITY_ONLY_ACCESSIBLE_BY_OWNER', message: 'Specified identity only accessible by loop owner', statusCode: 403 },
  IDENTITY_TRIGGER_CHANGED: { code: 'IDENTITY_TRIGGER_CHANGED', message: 'Identity trigger has changed', statusCode: 409 },
};

// srv-ifttt-ws src/controllers/ifttt.ctrl.ts:15-19
const COMMAND_RESULT = { result: 'Command accepted' };
const MEDIA_FILTER = '__MEDIA_FILTER__';
const USER_FILTER = '__USER_FILTER__';
const POLL_INTERVAL = 4 * 60 * 60 * 1000;        // 4 hours
const USER_POLL_INTERVAL = 4 * 24 * 60 * 60 * 1000; // 4 days
const DEFAULT_LIMIT = 50;

/**
 * srv-ifttt-ws src/controllers/ifttt.ctrl.ts:316-318 — `metaphone(stemmer(text || ""))`.
 * The original depended on the npm `metaphone` and `stemmer` packages, which Phoenix does not
 * carry. The observable contract is only that the same text always maps to the same opaque
 * identity key, so the default is a stable local index and the exact algorithm is an injected
 * seam (see PHOENIX localKey). Exact phonetic parity is a DIVERGENCE CANDIDATE.
 */
export function localPhoneticKey(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function toEpoch(value) {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.getTime();
}

export class IftttStore {
  constructor({
    clock = Date.now,
    newId = randomUUID,
    phonetic = localPhoneticKey,
    file = process.env.ETCO_classic_iftttFile || DEFAULT_FILE,
  } = {}) {
    this.clock = clock;
    this.newId = newId;
    this.phonetic = phonetic;
    // `null` disables persistence (an intentionally ephemeral store); the default is the same
    // durable-file behavior the source gets from Mongo.
    this.file = file;
    this.identities = new Map(); // _id (the IFTTT identity string) -> { id, filter, loopIds, updated }
    this.triggers = [];          // { _id, identity, text, created }
    this.actions = [];           // { _id, loopId, fields, created }
    this.media = [];             // { _id, identity, encryptedUrl, decryptedUrl, created }
    this.notifications = [];     // observed notify() attempts (dead-provider ledger)
    this.keyCalls = [];          // observed KeyClient calls (dead-provider ledger)
    this._load();
  }

  /** Re-read the four Mongo-backed collections from the durable file (a no-op for file=null). */
  _load() {
    if (!this.file || !existsSync(this.file)) return;
    let raw;
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch (error) {
      throw new Error(`ifttt store unreadable (${this.file}): ${error.message}`);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`ifttt store has an invalid root (${this.file})`);
    }
    for (const identity of raw.identities || []) {
      if (identity && identity.id !== undefined) this.identities.set(identity.id, identity);
    }
    for (const row of raw.triggers || []) if (row && row._id) this.triggers.push(row);
    for (const row of raw.actions || []) if (row && row._id) this.actions.push(row);
    for (const row of raw.media || []) if (row && row._id) this.media.push(row);
  }

  /** Atomically replace the durable file after a mutation (fsync-of-the-swap pattern). */
  _persist() {
    if (!this.file) return;
    const output = {
      version: 1,
      identities: [...this.identities.values()],
      triggers: this.triggers,
      actions: this.actions,
      media: this.media,
    };
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    // A per-write unique temporary name so a concurrent writer can never clobber ours mid-write.
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      try { writeFileSync(fd, `${JSON.stringify(output, null, 2)}\n`); } finally { closeSync(fd); }
      renameSync(temporary, this.file);
    } finally {
      try { unlinkSync(temporary); } catch { /* renamed or already gone */ }
    }
  }

  now() { return this.clock(); }

  // ---- Identity ------------------------------------------------------------------------------
  findIdentity(id) { return this.identities.get(id) || null; }

  /** identity.ts toJSON keeps _id as the wire id; the response shapes never expose `updated`. */
  findIdentities({ filter } = {}) {
    const all = [...this.identities.values()];
    if (filter === undefined) return all;
    return all.filter((identity) => identity.filter === filter);
  }

  /**
   * srv-ifttt-ws src/controllers/ifttt.ctrl.ts:334-354 findOrCreateIdentity. A filter change on
   * an existing id is IDENTITY_TRIGGER_CHANGED 409; refresh or first insert rewrites loopIds+updated.
   */
  findOrCreateIdentity({ identity, filter, loopIds, refresh = false }) {
    let obj = this.findIdentity(identity);
    const existed = !!obj;
    if (!obj) obj = { id: identity, filter, loopIds: [...(loopIds || [])], updated: this.now() };
    if (obj.filter !== filter) return { error: IFTTT_ERRORS.IDENTITY_TRIGGER_CHANGED };
    if (refresh || !existed) {
      obj.loopIds = [...(loopIds || [])];
      obj.updated = this.now();
    }
    this.identities.set(identity, obj);
    this._persist();
    return { identity: obj };
  }

  // ---- Trigger / Action / Media (Mongo collections) ------------------------------------------
  createTrigger({ identity, text }) {
    const row = { _id: this.newId(), identity, text, created: new Date(this.now()) };
    this.triggers.push(row);
    this._persist();
    return row;
  }

  /** triggerSchema toJSON transform (trigger.ts): id from _id, created -> epoch ms. */
  triggerView(row) { return { id: row._id, identity: row.identity, text: row.text, created: toEpoch(row.created) }; }

  /** Trigger.find({identity}).sort({created:-1}).limit(limit) — source can filter by identity. */
  listTriggers({ identity, limit }) {
    const rows = this.triggers
      .filter((row) => (identity === undefined ? true : row.identity === identity))
      .sort((a, b) => toEpoch(b.created) - toEpoch(a.created));
    return rows.slice(0, limit).map((row) => this.triggerView(row));
  }

  createAction({ loopId, fields }) {
    const row = { _id: this.newId(), loopId, fields: clone(fields), created: new Date(this.now()) };
    this.actions.push(row);
    this._persist();
    return row;
  }

  /** actionSchema toJSON transform (action.ts): id from _id, created -> epoch ms. */
  actionView(row) { return { id: row._id, loopId: row.loopId, fields: clone(row.fields), created: toEpoch(row.created) }; }

  listActions({ loopId, limit }) {
    const rows = this.actions
      .filter((row) => row.loopId === loopId)
      .sort((a, b) => toEpoch(b.created) - toEpoch(a.created));
    return rows.slice(0, limit).map((row) => this.actionView(row));
  }

  createMedia({ identity, encryptedUrl }) {
    const existing = this.media.find((row) => row.identity === identity && row.encryptedUrl === encryptedUrl);
    if (existing) return existing;
    const row = { _id: this.newId(), identity, encryptedUrl, decryptedUrl: undefined, created: new Date(this.now()) };
    this.media.push(row);
    this._persist();
    return row;
  }

  updateMedia({ encryptedUrl, decryptedUrl }) {
    const rows = this.media.filter((row) => row.encryptedUrl === encryptedUrl);
    for (const row of rows) row.decryptedUrl = decryptedUrl;
    if (rows.length > 0) this._persist();
    return rows;
  }

  /** mediaSchema toJSON transform (media.ts): id from _id, created -> epoch ms. */
  mediaView(row) {
    const out = { id: row._id, identity: row.identity, created: toEpoch(row.created) };
    if (row.encryptedUrl !== undefined) out.encryptedUrl = row.encryptedUrl;
    if (row.decryptedUrl !== undefined) out.decryptedUrl = row.decryptedUrl;
    return out;
  }

  /** Media.find({identity, decryptedUrl:{$exists:true}}).sort desc.limit */
  listMedia({ identity, limit }) {
    const rows = this.media
      .filter((row) => row.identity === identity && row.decryptedUrl !== undefined)
      .sort((a, b) => toEpoch(b.created) - toEpoch(a.created));
    return rows.slice(0, limit).map((row) => this.mediaView(row));
  }

  /** ctrl.deleteTriggers: Trigger.remove + Media-with-decryptedUrl then Media.remove. */
  removeTriggersAndMedia(identity) {
    this.triggers = this.triggers.filter((row) => row.identity !== identity);
    const removable = this.media.filter((row) => row.identity === identity && row.decryptedUrl !== undefined);
    this.media = this.media.filter((row) => row.identity !== identity);
    this._persist();
    return removable;
  }

  removeIdentity(identity) {
    this.identities.delete(identity);
    this._persist();
  }

  // ---- dead-provider ledgers ------------------------------------------------------------------
  recordNotification(identities, outcome) {
    this.notifications.push({ identities: identities.map((i) => i.id), outcome });
  }

  recordKeyCall(call) { this.keyCalls.push(call); }
}

// ---- fixture adapters ------------------------------------------------------------------------

/**
 * The AccountClient (account.client.ts) is another dead Classic service. listLoops(ownerId,true)
 * is the robot gate; listOwnerLoops(ownerId) feeds the owner paths. The default answer is a
 * single implicit household loop where the caller is both owner and robot, so the LAN-trust
 * deployment serves the documented behavior; tests inject their own adapter.
 */
export function singleHouseholdLoops(accountId) {
  const loop = { id: `loop-${accountId}`, robot: accountId, owner: accountId };
  return {
    listLoops: async () => [loop],
    listOwnerLoops: async () => [loop],
  };
}

/**
 * Default notify adapter for the dead IFTTT realtime endpoint. It records the attempt and
 * reports the truth: nothing was delivered. It must never return a success shape.
 */
export function unavailableIftttNotify(store) {
  return async (identities) => {
    const outcome = {
      delivered: false,
      reason: 'IFTTT realtime notifications endpoint (realtime.ifttt.com/v1/notifications) is dead',
      endpoint: 'https://realtime.ifttt.com/v1/notifications',
    };
    store.recordNotification(identities, outcome);
    return outcome;
  };
}

/** Default KeyClient adapter: the encryption-key service is another dead Classic service. */
export function unavailableKeyClient(store) {
  return {
    async removeBinaries({ encryptedUrls }) {
      store.recordKeyCall({ op: 'removeBinaries', encryptedUrls, performed: false, reason: 'KeyClient (srv-key-ws) binary store unavailable' });
      return { removed: false };
    },
    async createBinaryRequest({ accountId, encryptedUrl, loopId }) {
      store.recordKeyCall({ op: 'createBinaryRequest', accountId, encryptedUrl, loopId, performed: false, reason: 'KeyClient (srv-key-ws) binary store unavailable' });
      return { requested: false };
    },
  };
}

// ---- validation (source @validatePayload Joi) ------------------------------------------------

function validationMessage(body, field, kind) {
  const value = body == null ? undefined : body[field];
  if (value === undefined || value === null) return `child "${field}" fails because ["${field}" is required]`;
  if (kind === 'string' && typeof value !== 'string') return `child "${field}" fails because ["${field}" must be a string]`;
  if (kind === 'string' && value.length === 0) return `child "${field}" fails because ["${field}" is not allowed to be empty]`;
  if (kind === 'object' && (typeof value !== 'object' || Array.isArray(value))) return `child "${field}" fails because ["${field}" must be an object]`;
  return null;
}

function limitOf(value) {
  if (typeof value === 'undefined' || value > DEFAULT_LIMIT || value < 0) return DEFAULT_LIMIT;
  return value;
}

// ---- handler ----------------------------------------------------------------------------------

/**
 * @param {object} [options]
 * @param {IftttStore} [options.store]
 * @param {object} [options.loops]   { listLoops(accountId, asRobot), listOwnerLoops(ownerId) } fixture adapter
 * @param {function} [options.notify] async (identities) => outcome; the dead IFTTT client seam
 * @param {object} [options.key]      { removeBinaries, createBinaryRequest } fixture adapter
 * @param {function} [options.email]  (accountId) => email|undefined, for UserInfo.name
 * @param {{warn?:Function, info?:Function}} [options.logger]
 */
export function makeIftttHandler({ store = new IftttStore(), loops, notify, key, email, logger } = {}) {
  const onImport = logger || { warn: () => {}, info: () => {} };

  const accountIdOf = (req) => accessKeyIdFromAuth(req) || 'anon';
  const loopsFor = (accountId) => loops || singleHouseholdLoops(accountId);
  const notifyFn = notify || unavailableIftttNotify(store);
  const keyFn = key || unavailableKeyClient(store);
  const emailOf = (accountId) => (typeof email === 'function' ? email(accountId) : undefined);

  const fail = (res, error) => sendAmzError(res, error);
  const requireField = (res, body, field, kind) => {
    const message = validationMessage(body, field, kind);
    if (!message) return false;
    sendAmzError(res, ValidationException, message);
    return true;
  };

  async function robotLoop(accountId) {
    const result = await loopsFor(accountId).listLoops(accountId, true);
    const list = Array.isArray(result) ? result : [];
    if (list.length !== 1 || String(list[0].robot) !== String(accountId)) return { error: IFTTT_ERRORS.ROBOT_MUST_CALL };
    return { loop: list[0] };
  }

  /** ctrl.createTrigger (ifttt.ctrl.ts:43-70). Robot-only; identity matched by phonetic filter. */
  async function createTrigger({ res, body, accountId, log }) {
    if (requireField(res, body, 'text', 'string')) return;
    const { loop, error } = await robotLoop(accountId);
    if (error) return fail(res, error);
    const phonetic = store.phonetic(body.text);
    const identities = store.findIdentities({ filter: phonetic })
      .filter((identity) => identity.loopIds.includes(loop.id) && toEpoch(identity.updated) > store.now() - POLL_INTERVAL);
    if (identities.length === 0) {
      const user = store.findIdentities({ filter: USER_FILTER })
        .find((identity) => identity.loopIds.includes(loop.id) && toEpoch(identity.updated) > store.now() - USER_POLL_INTERVAL);
      return fail(res, user ? IFTTT_ERRORS.APPLET_NOT_FOUND : IFTTT_ERRORS.USER_NOT_FOUND);
    }
    for (const identity of identities) store.createTrigger({ identity: identity.id, text: body.text });
    const outcome = await notifyFn(identities);
    if (outcome && outcome.delivered === false) {
      log?.warn?.('ifttt: notify unavailable (dead IFTTT realtime API)', { identities: identities.map((i) => i.id), reason: outcome.reason });
    }
    return void sendAmz(res, 200, COMMAND_RESULT);
  }

  /** ctrl.listTriggers (ifttt.ctrl.ts:173-203). Owner path; handler Joi requires identity. */
  async function listTriggers({ res, body, accountId, log }) {
    if (requireField(res, body, 'identity', 'string')) return;
    const ownerLoops = await loopsFor(accountId).listOwnerLoops(accountId);
    const loopIds = (Array.isArray(ownerLoops) ? ownerLoops : []).map((loop) => loop.id);
    const user = store.findOrCreateIdentity({ filter: USER_FILTER, identity: accountId, loopIds });
    if (user.error) return fail(res, user.error);
    const identity = store.findOrCreateIdentity({ filter: store.phonetic(body.text), identity: body.identity, loopIds, refresh: true });
    if (identity.error) return fail(res, identity.error);
    const limit = limitOf(body.limit);
    if (limit === 0) return void sendAmz(res, 200, []);
    const triggers = store.listTriggers({ identity: body.identity, limit });
    if (triggers.length > 0) log?.info?.('ifttt listTriggers', { identity: body.identity });
    return void sendAmz(res, 200, triggers);
  }

  /** ctrl.listMedia (ifttt.ctrl.ts:213-242). Owner path; handler Joi requires identity. */
  async function listMedia({ res, body, accountId, log }) {
    if (requireField(res, body, 'identity', 'string')) return;
    const ownerLoops = await loopsFor(accountId).listOwnerLoops(accountId);
    const loopIds = (Array.isArray(ownerLoops) ? ownerLoops : []).map((loop) => loop.id);
    const user = store.findOrCreateIdentity({ filter: USER_FILTER, identity: accountId, loopIds });
    if (user.error) return fail(res, user.error);
    const identity = store.findOrCreateIdentity({ filter: MEDIA_FILTER, identity: body.identity, loopIds, refresh: true });
    if (identity.error) return fail(res, identity.error);
    const limit = limitOf(body.limit);
    if (limit === 0) return void sendAmz(res, 200, []);
    const media = store.listMedia({ identity: body.identity, limit });
    if (media.length > 0) log?.info?.('ifttt listMedia', { identity: body.identity });
    return void sendAmz(res, 200, media);
  }

  /** ctrl.createAction (ifttt.ctrl.ts:140-162). Owner loops only; handler Joi requires fields. */
  async function createAction({ res, body, accountId }) {
    if (requireField(res, body, 'fields', 'object')) return;
    const all = await loopsFor(accountId).listLoops(accountId);
    const ownerLoops = (Array.isArray(all) ? all : []).filter((loop) => String(loop.owner) === String(accountId));
    const created = ownerLoops.map((loop) => store.createAction({ loopId: loop.id, fields: body.fields }));
    return void sendAmz(res, 200, created.map((row) => store.actionView(row)));
  }

  /** ctrl.listActions (ifttt.ctrl.ts:275-290). Robot-only. */
  async function listActions({ res, body, accountId }) {
    const { loop, error } = await robotLoop(accountId);
    if (error) return fail(res, error);
    const limit = limitOf(body.limit);
    if (limit === 0) return void sendAmz(res, 200, []);
    return void sendAmz(res, 200, store.listActions({ loopId: loop.id, limit }));
  }

  /** ctrl.deleteIdentity (ifttt.ctrl.ts:244-266). Owner intersection gate + cascade delete. */
  async function deleteIdentity({ res, body, accountId }) {
    if (requireField(res, body, 'identity', 'string')) return;
    const all = await loopsFor(accountId).listLoops(accountId);
    const loopIds = (Array.isArray(all) ? all : []).map((loop) => loop.id);
    const identity = store.findIdentity(body.identity);
    if (!identity) return fail(res, IFTTT_ERRORS.IDENTITY_NOT_FOUND);
    if (!identity.loopIds.some((id) => loopIds.includes(id))) return fail(res, IFTTT_ERRORS.IDENTITY_ONLY_ACCESSIBLE_BY_OWNER);
    const mediaToRemove = store.removeTriggersAndMedia(body.identity);
    const encryptedUrls = mediaToRemove.map((row) => row.encryptedUrl);
    if (encryptedUrls.length > 0) await keyFn.removeBinaries({ encryptedUrls });
    store.removeIdentity(body.identity);
    return void sendAmz(res, 200, COMMAND_RESULT);
  }

  /** ctrl.userInfo (ifttt.ctrl.ts:299-308). */
  async function userInfo({ res, accountId }) {
    const all = await loopsFor(accountId).listLoops(accountId);
    const loopIds = (Array.isArray(all) ? all : []).map((loop) => loop.id);
    const identity = store.findOrCreateIdentity({ filter: USER_FILTER, identity: accountId, loopIds, refresh: true });
    if (identity.error) return fail(res, identity.error);
    return void sendAmz(res, 200, { id: accountId, name: emailOf(accountId) || '' });
  }

  const ops = { createTrigger, listTriggers, listMedia, createAction, listActions, deleteIdentity, userInfo };
  const mapping = {
    trigger: 'createTrigger',
    listtriggers: 'listTriggers',
    listmedia: 'listMedia',
    deleteidentity: 'deleteIdentity',
    action: 'createAction',
    listactions: 'listActions',
    userinfo: 'userInfo',
  };

  return async function iftttHandler({ req, res, body, op, log }) {
    const method = mapping[op.toLowerCase()];
    if (!method) return void sendAmzError(res, ValidationException, `unknown ifttt operation: ${op}`);
    const accountId = accountIdOf(req);
    void onImport;
    await ops[method]({ res, body: body || {}, accountId, log });
  };
}
