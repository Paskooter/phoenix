// `jot` service (Jibo Jot) — the loop-scoped family messaging surface the robot and the mobile
// app used to send/list/read messages. Until now Phoenix had NO `/^jot/i` classic route, so every
// Jot target answered UnknownOperationException 400 (A-01 candidate, "absent-no-classic-service").
//
// The pinned source (read through the Jibo archive MCP, cited by file):
//   jibo:server/jot-ws@9a725d3ed8d991aa840131f5ef98c630df2fdf4e
//     src/handlers/message.handler.js   the five-operation mapping + per-op @validatePayload Joi
//     src/controllers/message.ctrl.js   the real contract (membership, impersonation, list, read)
//     src/errors/message.js             the exact Jot error catalogue (codes + statuses)
//     src/schemes/message.js            the Message collection + toJSON id/created transform
//     src/clients/{account,media}.client.js   the two internal service hops
//   jibo:jiborobot/srv-jot-ws-archived@4432ac5d017ae1971a447f42e7a4b29da7eb2e58
//     archive/message.spec.js           the ONLY recovered runtime exercise of this service: it
//                                       sends literal X-Amz-Target `Jot_20160512.<Op>`
//     src/controllers/message.ctrl.js   the pre-refactor controller (isEncrypted, bulk count)
//     src/routes/route.js               the direct, non-X-Amz-Target POST /numberOfUnreadMessagesBulk
//   jibo:jiborobot/srv-jibo-server-client (historical APIs)
//     apis/jot-2016-01-26.normal.json   targetPrefix Jot_20160126  (10 operation pairs)
//     apis/jot-2016-03-10.normal.json   targetPrefix Jot_20160310  (14 operation pairs, party era)
//     apis/jot-2016-05-10.normal.json   targetPrefix Jot_20160310
//     apis/jot-2016-05-12.normal.json   targetPrefix Jot_20160126, the last model:
//                                       CreateMessage/ListMessages/MarkRead/MarkLoopRead/
//                                       NumberOfUnreadMessagesInLoops
//   jibo:server/message-bus
//     src/events/base.js, src/events/jotEvents.js   the JotMessageCreated Kafka event + payload
//
// HOW THE DEPLOYED SERVICE SELECTS AN OPERATION — this SETTLES DIVERGENCES A19a:
//   Jot is an `@jibo/server` service (server/jot-ws@9a725d3 src/index.js: `new App({…})`). The
//   framework dispatcher reads ONLY the operation segment of X-Amz-Target and DISCARDS the prefix —
//   server/server src/server.js `lowerMethodName(request)`:
//     const target = request.headers['x-amz-target'];
//     const methodName = target.split('.')[1];
//     return methodName[0].toLowerCase() + methodName.substring(1);
//   (byte-identical in the pinned dependency: @jibo/server@3.1.1 dst/server.js:70-73, which is what
//   jiborobot/srv-jot-ws-archived pins as `~3.1.1`; @jibo/server@2.1.3 dst/server.js:64-68, the
//   `^2.1.3` of server/jot-ws@9a725d3, is the same code). The PREFIX IS THEREFORE NOT SIGNIFICANT:
//   `Jot_20160126` (what the last SDK model declares), `Jot_20160512` (what the only recovered
//   integration test sends) and any other prefix at all reach the SAME handler. JOT_TARGET_PREFIXES
//   records the two OBSERVED prefixes for auditing; JOT_DISPATCH_RULE states the mechanism.
//
//   Both observed prefixes rest on real, pinned evidence, so both are served:
//     jiborobot/srv-jibo-server-client@b2da11bc apis/jot-2016-05-12.normal.json
//       metadata.targetPrefix = "Jot_20160126" — the last model was re-cut for 2016-05-12 but its
//       prefix metadata still names 2016-01-26
//     jiborobot/srv-jot-ws-archived@4432ac5d archive/message.spec.js
//       'X-Amz-Target': 'Jot_20160512.CreateMessage' at line 63 (also ListMessages/MarkRead/
//       MarkLoopRead) — the only recovered runtime exercise of this service
//
// THE VERSIONED CONTRACT (acceptance 1) — every model read directly from the archive MCP:
//     apis/jot-2016-01-26.normal.json@4c68f963   Jot_20160126: CreateMessage, RemoveMessage,
//       ListIncomingMessages, ListSentMessages, MarkDelivered, MarkSeen                 (6 ops)
//     apis/jot-2016-05-12.normal.json@b2da11bc   Jot_20160126: CreateMessage, ListMessages,
//       MarkRead, MarkLoopRead, NumberOfUnreadMessagesInLoops                          (5 ops)
//     apis/jot-2016-03-10.normal.json@1b26ad78   Jot_20160310: CreatePart, CreateMessage,
//       UpdateMessage, RemoveMessage, GetMessages, ListIncomingMessages, ListSentMessages,
//       MarkDelivered, MarkAllDelivered, MarkSeen, MarkAllSeen                          (11 ops)
//       (the later 39f53698 cut swaps in ListMessages: … GetMessages, ListMessages, MarkSeen,
//        MarkAllSeen; the A-01 operation map's Jot_20160310 union also carries ListInbox/ListSent)
//   UNION under `Jot_20160126` = 10 distinct operation names; under `Jot_20160310` = 14. Only the
//   LAST (loop-era) handler was recovered — server/jot-ws@9a725d3 message.handler.js maps exactly
//   createMessage/listMessages/markRead/markLoopRead/numberOfUnreadMessagesInLoops — so the other 19
//   pairs have no matching-era handler and are NOT invented. `docs/parity/candidates/
//   A-01-operation-map.json` /denominator/prefixAmbiguity/perPrefixModelUnionPairCounts records the
//   same 10 + 14 split.
//
// THE UNMAPPED-OPERATION ENVELOPE (acceptance 2 — "exact error envelopes"):
//   A target whose operation is not in the handler's `mapping` never reaches the handler: the
//   framework answers it first, in the POST / onRequest extension (server/server src/server.js,
//   @jibo/server@3.1.1 dst/server.js:110-114):
//     const handler = this.mapping[methodName];
//     if (!handler) return reply(Boom.notFound('Method ' + methodName + ' not found.'));
//   i.e. HTTP 404 with the raw Boom body {statusCode:404, error:'Not Found', message:'Method <op>
//   not found.'} (`<op>` is the lower-first operation name) and NO x-amzn-errortype header. Because
//   this runs in onRequest it PREcedes @parseCredentials/@validatePayload: an unmapped operation is
//   a 404 even when unsigned. Reproduced verbatim by jotMethodNotFound()/sendBoom() below; the
//   sibling graduated service VoiceTraining answers the same class of 404 (src/voiceTraining.js).

// DEAD DEPENDENCIES (explicit seams, never faked):
//   * AccountClient.get(loopId)  -> GET http://<account>/loop?loopId=  (membership + robot check).
//     Reproduced by an injected `account` seam `{ get(loopId) }`. When no seam is wired the two
//     membership gates are SKIPPED (documented LAN-trust divergence, same posture as Media/Person).
//   * MediaClient.getMedia(accountId, paths) -> POST http://<media>/getMedia (part url population).
//     Reproduced by an injected `media` seam; the classic entrypoint wires `mediaStoreClient()`
//     (an in-process read of the same Media store, since there is no second HTTP hop here). The
//     default seam answers [] — the media service is a separate, unrecovered hop.
//   * bus.eventSender.send(JotMessageCreated) -> Kafka (topic from config.server.kafka). The bus is
//     gone; the event is reproduced in full (payload + eventKey, from message-bus src/events) and
//     handed to an `onEvent` sink whose default records it durably and logs. Kafka fan-out (e.g. a
//     downstream push notification of a new jot) is NOT reconstructed, so no consumer is notified.
//
// State: one atomically replaced JSON file holds the source `Message` collection plus the observed
// event ledger, so messages created before a restart are still listed after it.

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { sendJson } from '@phoenix/common';
import { sendAmz, sendAmzError, ValidationException } from './awsJson.js';
import { accountIdFromRequest, MISSING_AUTH_HEADER } from './person.js';
import { expandMedia } from './media.js';

// jibo:server/jot-ws@9a725d3 src/errors/message.js — verbatim codes, messages and statuses.
export const JOT_ERRORS = {
  JOT_MUST_BE_LOOP_MEMBER: { code: 'JOT_MUST_BE_LOOP_MEMBER', statusCode: 403, message: 'You must be a member of the loop to list or create messages' },
  JOT_ROBOT_CAN_IMPERSONATE: { code: 'JOT_ROBOT_CAN_IMPERSONATE', statusCode: 403, message: 'Only robot can impersonate as loop member' },
  JOT_CONTENT_OR_PARTS_REQUIRED: { code: 'JOT_CONTENT_OR_PARTS_REQUIRED', statusCode: 422, message: 'Either content or parts must be present' },
  ACCOUNT_SERVICE_UNAVAILABLE: { code: 'ACCOUNT_SERVICE_UNAVAILABLE', statusCode: 503, message: 'Account service not available' },
  MEDIA_SERVICE_UNAVAILABLE: { code: 'MEDIA_SERVICE_UNAVAILABLE', statusCode: 503, message: 'Media service not available' },
};

/** The five operations the pinned loop-era handler maps (message.handler.js `this.mapping`). */
export const JOT_OPERATIONS = [
  'createmessage', 'listmessages', 'markread', 'markloopread', 'numberofunreadmessagesinloops',
];

/**
 * The observed Jot target prefixes. `Jot_20160126` is what the last (2016-05-12) SDK model declares;
 * `Jot_20160512` is what the archived integration test literally sends. The deployed dispatcher
 * reads only the operation segment of X-Amz-Target, so the prefix is not significant and both (and
 * any other) resolve to this one service — see JOT_DISPATCH_RULE.
 */
export const JOT_TARGET_PREFIXES = ['Jot_20160126', 'Jot_20160512'];

/**
 * The pinned dispatch rule (server/server src/server.js `lowerMethodName`, @jibo/server@3.1.1
 * dst/server.js:70-73): X-Amz-Target is split on '.', segment [1] is lower-first'd, and ONLY that
 * name selects a handler — the prefix is discarded. Because the prefix is never compared, a target
 * like `<any-prefix>.CreateMessage` reaches the same handler. Recorded as a constant so the resolved
 * A19a finding is asserted, not just commented.
 */
export const JOT_DISPATCH_RULE = 'operation-name-only';

/** srv-server server.ts / @jibo/server lowerMethodName — lowercases ONLY the first character. */
export function lowerFirstOp(operation) {
  const s = String(operation === undefined || operation === null ? '' : operation);
  return s.length ? s[0].toLowerCase() + s.slice(1) : s;
}

/**
 * The framework's unmapped-operation refusal. @jibo/server@3.1.1 dst/server.js:112-114 replies
 * `Boom.notFound('Method ' + methodName + ' not found.')` from the POST / onRequest extension, i.e.
 * the raw Boom body with the lower-first operation name and no error `code`/`x-amzn-errortype`.
 */
export function jotMethodNotFound(operation) {
  return { statusCode: 404, error: 'Not Found', message: `Method ${lowerFirstOp(operation)} not found.` };
}

/** message.ctrl.js `const MESSAGES_LIMIT = 50` — the list page size, no cursor. */
export const JOT_MESSAGES_LIMIT = 50;

/** srv-jot-ws-archived src/routes/route.js — the direct, non-X-Amz-Target bulk count route. */
export const JOT_BULK_ROUTE = '/numberOfUnreadMessagesBulk';

// server/message-bus src/events/jotEvents.js + src/events/base.js: the event name is the class name
// and BaseEvent stamps `payload.eventKey = constructor.name`.
export const JOT_EVENTS = { JotMessageCreated: { name: 'JotMessageCreated' } };

/** server/message-bus src/events/jotEvents.js JotMessageCreated schema members. */
export const JOT_MESSAGE_CREATED_SCHEMA = ['messageId', 'content', 'senderId', 'loopId', 'tags'];

/** The exact BaseEvent/JotMessageCreated wire object handed to the (dead Kafka) EventSender. */
export class JotMessageCreated {
  constructor(payload) {
    this.payload = { ...(payload || {}) };
    this.payload.eventKey = this.constructor.name;
  }
}

const sameId = (a, b) => a != null && b != null && String(a) === String(b);
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/** Mongo ObjectIds are 12 random bytes as 24 hex characters (the source's Message `_id`). */
function newMessageId() { return randomBytes(12).toString('hex'); }

function normalizeMessage(record) {
  return {
    id: String(record.id),
    seq: Number.isFinite(record.seq) ? record.seq : 0,
    created: Number.isFinite(record.created) ? record.created : Date.now(),
    content: record.content === undefined || record.content === null ? undefined : String(record.content),
    loopId: record.loopId === undefined || record.loopId === null ? undefined : String(record.loopId),
    sender: record.sender === undefined || record.sender === null ? undefined : String(record.sender),
    tags: Array.isArray(record.tags) ? record.tags.map(String) : [],
    read: Array.isArray(record.read) ? record.read.map(String) : [],
    isEncrypted: record.isEncrypted === true,
    parts: Array.isArray(record.parts)
      ? record.parts
        .filter((part) => part && typeof part.path === 'string')
        .map((part) => (part.meta === undefined ? { path: part.path } : { path: part.path, meta: clone(part.meta) }))
      : [],
  };
}

/**
 * Durable Message store. The source's `Message` mongoose collection (schemes/message.js) is one
 * document per message: `{ _id, created, content, loopId, sender, tags[], read[], isEncrypted,
 * parts[{path, meta}] }` with a `{loopId:1, created:1}` index. `read` is the set of accounts that
 * have read the message (the create seeds it with the sender, so the sender always reads their own
 * message). Mongoose's toJSON transform maps `_id -> id` and `created -> epoch ms`.
 *
 * The index is not modelled separately: `findForList` filters + sorts + limits in one pass and
 * applies the source's reverse-after-descending-limit behaviour, which is exactly what the query
 * does. A monotonic `seq` tiebreaker keeps equal-millisecond rows in insertion order (MongoDB's
 * sort is not guaranteed stable; the source test used distinct millisecond timestamps).
 */
export class JotStore {
  constructor({
    file = process.env.ETCO_classic_jotFile || join(tmpdir(), 'phoenix-jot.json'),
    clock = Date.now,
  } = {}) {
    this.file = file;
    this.clock = clock;
    this.messages = [];
    this.events = []; // observed JotMessageCreated attempts (dead Kafka ledger)
    this._seq = 0;
    this._load();
  }

  _load() {
    if (!existsSync(this.file)) return;
    let raw;
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch (error) {
      throw new Error(`jot store unreadable (${this.file}): ${error.message}`);
    }
    for (const record of raw.messages || []) {
      if (record && typeof record.id === 'string') this.messages.push(normalizeMessage(record));
    }
    this._seq = this.messages.reduce((max, record) => Math.max(max, record.seq || 0), 0);
    if (Array.isArray(raw.events)) this.events = raw.events.map(clone);
  }

  _flush() {
    const serialized = JSON.stringify({ messages: this.messages, events: this.events }, null, 2);
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${randomBytes(8).toString('hex')}.tmp`;
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      try { writeFileSync(fd, serialized); } finally { closeSync(fd); }
      renameSync(tmp, this.file);
    } finally {
      try { unlinkSync(tmp); } catch { /* renamed or cleanup unavailable */ }
    }
  }

  now() { return typeof this.clock === 'function' ? this.clock() : Date.now(); }

  /** message.ctrl.js create: `Message.create({sender, loopId, tags, content, read:[sender], parts})`. */
  create({ sender, loopId, content, tags = [], read = [], isEncrypted = false, parts = [] }) {
    const record = {
      id: newMessageId(),
      seq: (this._seq += 1),
      created: this.now(),
      content: content === undefined || content === null ? undefined : String(content),
      loopId,
      sender,
      tags: (tags || []).map(String),
      read: (read || []).map(String),
      isEncrypted: isEncrypted === true,
      parts: (parts || [])
        .filter((part) => part && typeof part.path === 'string')
        .map((part) => (part.meta === undefined ? { path: part.path } : { path: part.path, meta: clone(part.meta) })),
    };
    this.messages.push(record);
    this._flush();
    return record;
  }

  /**
   * schemes/message.js toJSON transform + the controller's `fillRead`. Only the members declared in
   * the pinned 2016-05-12 Message shape are emitted (the generated client strips the rest anyway):
   * id, loopId, content, sender, tags, parts, isRead, isEncrypted, created.
   *
   * `fillRead` (message.ctrl.js) sets `isRead` from `message.read.some(read => read.equals(accountId))`.
   * The source applied it inside populateParts; folding it into the view is observably identical
   * because every create/list answer goes through populateParts before it is returned.
   */
  view(record, accountId) {
    const out = { id: record.id, loopId: record.loopId };
    if (record.content !== undefined) out.content = record.content;
    out.sender = record.sender;
    out.tags = [...(record.tags || [])];
    out.parts = (record.parts || []).map((part) => {
      const out2 = { path: part.path };
      if (part.meta !== undefined) out2.meta = clone(part.meta);
      for (const key of ['url', 'type', 'reference', 'accountId', 'loopId', 'isDeleted', 'created']) {
        if (part[key] !== undefined) out2[key] = part[key];
      }
      return out2;
    });
    out.isRead = (record.read || []).some((read) => sameId(read, accountId));
    out.isEncrypted = record.isEncrypted === true;
    out.created = record.created;
    return out;
  }

  /**
   * message.ctrl.js list: `Message.find(condition).sort({created: sortOrder}).limit(50)`, then
   * reverse when the pass was descending. `after` is an exclusive lower bound, `before` exclusive
   * upper; when only `after` is given the pass is ascending, otherwise descending (then reversed),
   * so the answered page is always ascending by created.
   */
  findForList({ loopId, before, after }) {
    const sortOrder = (!before && after) ? 1 : -1;
    let rows = this.messages.filter((record) => sameId(record.loopId, loopId));
    if (after !== undefined && after !== null) rows = rows.filter((record) => record.created > after);
    if (before !== undefined && before !== null) rows = rows.filter((record) => record.created < before);
    rows = rows.slice().sort((a, b) => (a.created - b.created) * sortOrder || (a.seq - b.seq) * sortOrder);
    rows = rows.slice(0, JOT_MESSAGES_LIMIT);
    if (sortOrder === -1) rows = rows.reverse();
    return rows;
  }

  findById(id) { return this.messages.find((record) => sameId(record.id, id)) || null; }

  /** message.ctrl.js markRead: `Message.update({_id:{$in:ids}}, {$addToSet:{read}}, {multi:true})`. */
  markRead({ ids = [], accountId }) {
    const wanted = new Set((ids || []).map(String));
    let changed = 0;
    for (const record of this.messages) {
      if (!wanted.has(String(record.id))) continue;
      if ((record.read || []).some((read) => sameId(read, accountId))) continue;
      record.read = [...(record.read || []), accountId];
      changed += 1;
    }
    if (changed) this._flush();
    return changed;
  }

  /** message.ctrl.js markLoopRead: `Message.update({loopId}, {$addToSet:{read}}, {multi:true})`. */
  markLoopRead({ loopId, accountId }) {
    let changed = 0;
    for (const record of this.messages) {
      if (!sameId(record.loopId, loopId)) continue;
      if ((record.read || []).some((read) => sameId(read, accountId))) continue;
      record.read = [...(record.read || []), accountId];
      changed += 1;
    }
    if (changed) this._flush();
    return changed;
  }

  /** message.ctrl.js numberOfUnreadMessagesInLoops: `Message.count({read:{$ne:accountId}, loopId:{$in}})`.
   *  `$ne` on an array field matches documents whose array does not contain the value. */
  countUnread({ accountId, loopIds = [] }) {
    const wanted = new Set((loopIds || []).map(String));
    return this.messages.filter((record) => wanted.has(String(record.loopId))
      && !(record.read || []).some((read) => sameId(read, accountId))).length;
  }

  /** Record one observed JotMessageCreated attempt (the dead Kafka ledger). */
  recordEvent(event) {
    this.events.push(clone(event));
    this._flush();
    return event;
  }
}

// ------------------------------------------------------------------------------------------------
// Controller — a direct port of jibo:server/jot-ws@9a725d3 src/controllers/message.ctrl.js
// ------------------------------------------------------------------------------------------------

function fail(code) {
  const err = new Error(JOT_ERRORS[code].message);
  return Object.assign(err, JOT_ERRORS[code]);
}

/** A failing hop is a typed 503 unless the seam already threw a typed error (the source propagated
 *  the account/media `Boom.create(payload.statusCode, payload.message)`). */
function accountFailure(error) {
  if (error && error.statusCode) return error;
  const err = new Error(JOT_ERRORS.ACCOUNT_SERVICE_UNAVAILABLE.message);
  err.cause = error;
  return Object.assign(err, JOT_ERRORS.ACCOUNT_SERVICE_UNAVAILABLE);
}

function mediaFailure(error) {
  if (error && error.statusCode) return error;
  const err = new Error(JOT_ERRORS.MEDIA_SERVICE_UNAVAILABLE.message);
  err.cause = error;
  return Object.assign(err, JOT_ERRORS.MEDIA_SERVICE_UNAVAILABLE);
}

/** Default media seam: the media service is a separate, unrecovered HTTP hop. */
export function unavailableMedia() {
  return { async getMedia() { return []; } };
}

/**
 * In-process stand-in for MediaClient.getMedia over the SAME Media store this entrypoint serves.
 * `POST /getMedia` (srv-media-ws src/routes/media.route.js + media.ctrl.js `get`) queries
 * `Media.find({isDeleted:{$ne:true}, $or:[{path:{$in}},{'thumbs.path':{$in}}]})`, expands thumbs,
 * then filters to the account's own loops and — because the route passes `ignoreOwnership: true` —
 * drops (never throws on) rows outside them. `accountLoops(accountId)` supplies those loop ids; when
 * it is not wired the loop filter is skipped (documented LAN-trust divergence).
 */
export function mediaStoreClient(mediaStore, { accountLoops } = {}) {
  if (!mediaStore || typeof mediaStore.get !== 'function') throw new TypeError('mediaStoreClient requires a MediaStore');
  return {
    async getMedia(accountId, paths) {
      const wanted = (paths || []).map(String).filter(Boolean);
      if (wanted.length === 0) return [];
      const mediaList = expandMedia(mediaStore.get(wanted).filter((record) => record.isDeleted !== true));
      if (typeof accountLoops !== 'function') return mediaList;
      const loops = await accountLoops(accountId);
      if (loops === null || loops === undefined) return mediaList;
      const accessible = new Set((loops || []).map(String));
      return mediaList.filter((media) => accessible.has(String(media.loopId)));
    },
  };
}

export class JotMessageController {
  constructor({ store, account, media, onEvent, logger } = {}) {
    if (!store) throw new TypeError('jot controller requires a JotStore');
    this.store = store;
    this.account = account;
    this.media = media || unavailableMedia();
    this.onEvent = onEvent;
    this.logger = logger || { warn: () => {}, info: () => {} };
  }

  /** No account seam wired => the membership/impersonation gates are skipped (LAN trust). */
  hasAccountSeam() { return !!this.account && typeof this.account.get === 'function'; }

  async requireLoop(loopId) {
    let loop;
    try {
      loop = await this.account.get(loopId);
    } catch (error) {
      throw accountFailure(error);
    }
    if (!loop) throw fail('ACCOUNT_SERVICE_UNAVAILABLE');
    return loop;
  }

  /**
   * message.ctrl.js getImpersonatedAccount: only the loop's robot may impersonate, and the resolved
   * account must be an ACCEPTED member. The two recovered revisions disagree on the member id field
   * (`member.memberId` in server/jot-ws@9a725d3, `member.accountId` in the archived test fixture and
   * in the Account service's populated loop, which carries BOTH) — both are checked.
   *
   * Precedence matters: impersonation/membership (403) is evaluated BEFORE the create content check
   * (422), because getImpersonatedAccount is the first statement of the source's `create`.
   */
  async getImpersonatedAccount({ loopId, accountId, impersonateAs }) {
    // LAN trust: no membership source is wired, so the robot-check and membership gates cannot run
    // (documented divergence). The impersonation SUBSTITUTION is kept — it is not a gate.
    if (!this.hasAccountSeam()) return impersonateAs || accountId;
    const loop = await this.requireLoop(loopId);
    const members = (Array.isArray(loop.members) ? loop.members : [])
      .filter((member) => member && String(member.status || '').toLowerCase() === 'accepted');
    if (impersonateAs) {
      if (!sameId(loop.robot, accountId)) throw fail('JOT_ROBOT_CAN_IMPERSONATE');
      accountId = impersonateAs;
    }
    const isMember = members.some((member) => sameId(member.memberId, accountId) || sameId(member.accountId, accountId));
    if (!isMember) throw fail('JOT_MUST_BE_LOOP_MEMBER');
    return accountId;
  }

  async emit(event) {
    if (typeof this.onEvent === 'function') {
      try {
        await this.onEvent(event);
      } catch (error) {
        this.logger.warn?.('jot: event sink failed', { error: error?.message, eventKey: event?.payload?.eventKey });
      }
      return;
    }
    this.store.recordEvent(event.payload);
    this.logger.info?.('jot event', { eventKey: event?.payload?.eventKey, messageId: event?.payload?.messageId });
  }

  async populateParts(accountId, messages) {
    const pathsToRequest = [].concat(...messages.map((message) => (message.parts || []).map((part) => part.path)));
    let mediaList;
    try {
      mediaList = await this.media.getMedia(accountId, pathsToRequest);
    } catch (error) {
      throw mediaFailure(error);
    }
    const mediaMap = {};
    for (const media of mediaList || []) mediaMap[String(media.path)] = media;
    for (const message of messages) {
      for (const part of message.parts || []) {
        const media = mediaMap[String(part.path)];
        if (!media) continue;
        part.url = media.url;
        part.type = media.type;
        part.loopId = media.loopId;
        part.accountId = media.accountId;
        part.reference = media.reference;
        part.created = media.created;
        // The archived controller also copied isDeleted (a member of the pinned MessagePart shape).
        if (media.isDeleted !== undefined) part.isDeleted = media.isDeleted;
      }
    }
  }

  /** message.ctrl.js create. The message and its event are committed before populateParts runs, so a
   *  failing media hop answers 503 with the message already persisted — exactly the source order. */
  async create({ accountId, impersonateAs, loopId, content, tags, isEncrypted, parts }) {
    const sender = await this.getImpersonatedAccount({ loopId, accountId, impersonateAs });
    if (!content && (!parts || parts.length === 0)) throw fail('JOT_CONTENT_OR_PARTS_REQUIRED');
    const record = this.store.create({
      sender, loopId, tags: tags || [], content, read: [sender], isEncrypted, parts: parts || [],
    });
    await this.emit(new JotMessageCreated({
      messageId: record.id, senderId: sender, loopId, tags: record.tags, content,
    }));
    const message = this.store.view(record, sender);
    await this.populateParts(sender, [message]);
    return message;
  }

  /** message.ctrl.js list. `skip` is read by the handler but not by the controller — it is ignored. */
  async list({ accountId, loopId, impersonateAs, before, after }) {
    accountId = await this.getImpersonatedAccount({ loopId, accountId, impersonateAs });
    const messages = this.store.findForList({ loopId, before, after })
      .map((record) => this.store.view(record, accountId));
    await this.populateParts(accountId, messages);
    return messages;
  }

  /** message.ctrl.js markRead. The source carries an explicit `TODO: check accountId can
   *  impersonate`: there is NO membership or robot check here — impersonateAs simply replaces the
   *  account id. Reproduced as-is (the hole is documented, not silently closed). */
  async markRead({ accountId, impersonateAs, ids }) {
    accountId = impersonateAs || accountId;
    this.store.markRead({ ids, accountId });
    return { result: 'Marked as read' };
  }

  /** message.ctrl.js markLoopRead re-runs getImpersonatedAccount twice (as written in the source). */
  async markLoopRead({ accountId, impersonateAs, loopId }) {
    accountId = await this.getImpersonatedAccount({ loopId, accountId, impersonateAs });
    await this.getImpersonatedAccount({ loopId, accountId });
    this.store.markLoopRead({ loopId, accountId });
    return { result: 'Marked all as read' };
  }

  /** message.ctrl.js numberOfUnreadMessagesInLoops. The declared output shape is {count}; the
   *  archived revision also returned accountId/loopIds, which the generated client strips, so the
   *  AWS-JSON answer is exactly {count} and the direct bulk route carries the triple. */
  async numberOfUnreadMessagesInLoops({ accountId, loopIds }) {
    return { count: this.store.countUnread({ accountId, loopIds }) };
  }

  /** srv-jot-ws-archived src/controllers/message.ctrl.js numberOfUnreadMessagesBulk. */
  async numberOfUnreadMessagesBulk(accounts) {
    return Promise.all((accounts || []).map(async (account) => {
      const count = await this.store.countUnread({ accountId: account.accountId, loopIds: account.loopIds });
      return { count, accountId: account.accountId, loopIds: account.loopIds };
    }));
  }
}

// ------------------------------------------------------------------------------------------------
// @validatePayload(Joi) port — per-operation member validation
// ------------------------------------------------------------------------------------------------

const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;
const isString = (value) => typeof value === 'string';
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const joiString = (field, value, { required = false, empty = false } = {}) => {
  if (value === undefined || value === null) {
    return required ? `child "${field}" fails because ["${field}" is required]` : null;
  }
  if (!isString(value)) return `child "${field}" fails because ["${field}" must be a string]`;
  if (!empty && value.length === 0) return `child "${field}" fails because ["${field}" is not allowed to be empty]`;
  return null;
};

const joiNumber = (field, value) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || Number.isNaN(value)) return `child "${field}" fails because ["${field}" must be a number]`;
  return null;
};

const joiBoolean = (field, value) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') return `child "${field}" fails because ["${field}" must be a boolean]`;
  return null;
};

const joiStringArray = (field, value, { required = false, min = 0 } = {}) => {
  if (value === undefined || value === null) {
    return required ? `child "${field}" fails because ["${field}" is required]` : null;
  }
  if (!Array.isArray(value)) return `child "${field}" fails because ["${field}" must be an array]`;
  for (const item of value) {
    if (!isNonEmptyString(item)) return `child "${field}" fails because ["${field}" at position ${value.indexOf(item)} fails because ["${field}${value.indexOf(item)}" must be a string]]`;
  }
  if (min > 0 && value.length < min) return `child "${field}" fails because ["${field}" must contain at least ${min} items]`;
  return null;
};

const joiParts = (field, value) => {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return `child "${field}" fails because ["${field}" must be an array]`;
  for (let index = 0; index < value.length; index += 1) {
    const part = value[index];
    if (!isPlainObject(part)) return `child "${field}" fails because ["${field}" at position ${index} must be an object]`;
    const pathError = joiString('path', part.path, { required: true });
    if (pathError) return `child "${field}" fails because ["${field}" at position ${index} fails because [${pathError}]]`;
    for (const key of ['type', 'reference', 'url']) {
      const error = joiString(key, part[key]);
      if (error) return `child "${field}" fails because ["${field}" at position ${index} fails because [${error}]]`;
    }
  }
  return null;
};

/** message.handler.js @validatePayload — one validator per mapped operation. */
export const JOT_VALIDATORS = {
  createmessage: (body) => joiString('loopId', body.loopId, { required: true })
    || joiString('impersonateAs', body.impersonateAs)
    || joiString('content', body.content, { empty: true })
    || joiStringArray('tags', body.tags)
    || joiBoolean('isEncrypted', body.isEncrypted)
    || joiParts('parts', body.parts),
  listmessages: (body) => joiString('loopId', body.loopId, { required: true })
    || joiString('impersonateAs', body.impersonateAs)
    || joiNumber('before', body.before)
    || joiNumber('after', body.after),
  markread: (body) => joiStringArray('ids', body.ids, { required: true, min: 1 })
    || joiString('impersonateAs', body.impersonateAs),
  markloopread: (body) => joiString('loopId', body.loopId, { required: true })
    || joiString('impersonateAs', body.impersonateAs),
  numberofunreadmessagesinloops: (body) => joiStringArray('loopIds', body.loopIds, { required: true, min: 1 }),
};

// ------------------------------------------------------------------------------------------------
// Wire handlers
// ------------------------------------------------------------------------------------------------

/**
 * The raw Hapi/Boom body the framework emits for `Boom.notFound(...)` — `{statusCode, error,
 * message}` with NO `code` and NO `x-amzn-errortype` header. Mirrors the identical helper in
 * src/backup.js (and the Boom shape src/log.js reproduces), because the shared sendAmzError()
 * stamps `__type` + `x-amzn-errortype` and would change this wire contract.
 */
function sendBoom(res, statusCode, message) {
  const body = JSON.stringify({ statusCode, error: 'Not Found', message });
  res.removeHeader?.('x-powered-by');
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-cache',
    vary: 'accept-encoding',
  });
  res.end(body);
}

/**
 * The X-Amz-Target handler for `Jot*.{operation}`.
 *
 * @param {object} [options]
 * @param {JotStore} [options.store]
 * @param {{get: Function}} [options.account]  AccountClient seam { get(loopId) -> populated loop }
 * @param {{getMedia: Function}} [options.media]  MediaClient seam { getMedia(accountId, paths) }
 * @param {Function} [options.onEvent]  (JotMessageCreated) => void|Promise; the dead Kafka sink
 * @param {{warn?:Function, info?:Function, error?:Function}} [options.logger]
 */
export function makeJotHandler({ store = new JotStore(), account, media, onEvent, logger } = {}) {
  const controller = new JotMessageController({ store, account, media, onEvent, logger });

  const ops = {
    createmessage: ({ body, accountId }) => controller.create({
      accountId,
      impersonateAs: body.impersonateAs,
      loopId: body.loopId,
      content: body.content,
      tags: body.tags,
      isEncrypted: body.isEncrypted,
      parts: body.parts,
    }),
    listmessages: ({ body, accountId }) => controller.list({
      accountId, loopId: body.loopId, impersonateAs: body.impersonateAs, before: body.before, after: body.after,
    }),
    markread: ({ body, accountId }) => controller.markRead({ accountId, ids: body.ids, impersonateAs: body.impersonateAs }),
    markloopread: ({ body, accountId }) => controller.markLoopRead({ accountId, loopId: body.loopId, impersonateAs: body.impersonateAs }),
    numberofunreadmessagesinloops: ({ body, accountId }) => controller.numberOfUnreadMessagesInLoops({ accountId, loopIds: body.loopIds }),
  };

  return async function jotHandler({ req, res, body, op, log }) {
    const name = String(op || '').toLowerCase();
    const handler = ops[name];
    // The framework resolves the handler FIRST, in the POST / onRequest extension — before
    // @parseCredentials and @validatePayload run. So an unregistered operation is the framework's
    // raw Boom 404 (`Method <lowerFirst op> not found.`), not a payload error and not an auth error.
    if (!handler) return void sendBoom(res, 404, jotMethodNotFound(op).message);
    // @parseCredentials({}) is the OUTERMOST decorator, so the auth gate precedes payload validation.
    // (The gateway enforces the signature for every Jot target before the service hop:
    //  jiborobot/srv-security-gw src/controllers/auth.ctrl.ts — `unauthorizedMethods` carries no Jot
    //  target, so a request with no Authorization throws the shared MISSING_AUTH_HEADER 401.)
    const accountId = accountIdFromRequest(req);
    if (!accountId) return void sendAmzError(res, MISSING_AUTH_HEADER);
    const payload = (body && typeof body === 'object' && !Array.isArray(body)) ? body : {};
    const invalid = JOT_VALIDATORS[name](payload);
    if (invalid) return void sendAmzError(res, ValidationException, invalid);
    if (log) log.info('jot request', { op: name });
    try {
      const out = await handler({ body: payload, accountId });
      return void sendAmz(res, 200, out === undefined ? {} : out);
    } catch (error) {
      if (error && error.statusCode) return void sendAmzError(res, error);
      log?.error?.('jot request failed', { op: name, error: error?.message });
      return void sendAmzError(res, { code: 'InternalFailure', statusCode: 500, message: 'Internal server error' });
    }
  };
}

/**
 * The direct HTTP surface: `POST /numberOfUnreadMessagesBulk`, ported from
 * jibo:jiborobot/srv-jot-ws-archived src/routes/route.js. It carries NO credentials header — the
 * source route has no parseCredentials — and answers one `{count, accountId, loopIds}` per requested
 * account. Hapi validated `payload: Joi.array().items(Joi.object()).required()`; a non-array body is
 * a 400, and a controller failure is `Boom.wrap(err, 400)`.
 */
export function jotHttpRoutes({ store = new JotStore(), account, media, onEvent, logger } = {}) {
  const controller = new JotMessageController({ store, account, media, onEvent, logger });
  return {
    [`POST ${JOT_BULK_ROUTE}`]: async ({ res, body }) => {
      if (!Array.isArray(body)) {
        return void sendJson(res, 400, {
          statusCode: 400, error: 'Bad Request', message: 'child "value" fails because ["value" must be an array]',
        });
      }
      try {
        return await controller.numberOfUnreadMessagesBulk(body);
      } catch (error) {
        return void sendJson(res, 400, { statusCode: 400, error: 'Bad Request', message: error.message });
      }
    },
  };
}
