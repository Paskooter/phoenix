// Source-compatible LoopUpdated event construction and a durable delivery
// seam for the later Account -> notification-ws integration.
//
// srv-account-ws emits LoopUpdated from the Loop post-save hook. Phoenix's
// account and Classic processes do not share the source SNS/event-bus process,
// so this module persists the exact notification request beside the successful
// loop mutation and lets an explicitly supplied publisher drain it later.

import { randomBytes } from 'node:crypto';

export const LOOP_UPDATED_SKILL_ID = '-1';
export const LOOP_UPDATED_EVENT_NAME = 'LoopUpdated';

function id(value) {
  if (value === undefined || value === null) return undefined;
  return typeof value === 'string' ? value : value.toString();
}

function newOutboxId() {
  return randomBytes(12).toString('hex');
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export const LOOP_UPDATED_ERROR_MAX_LENGTH = 512;
const SAFE_ERROR_CODE = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const SENSITIVE_KEY = /^(?:authorization|proxy-authorization|www-authenticate|cookie|set-cookie|auth|x-api-key|api[_-]?key|access[_-]?key[_-]?id|aws[_-]?access[_-]?key[_-]?id|secret[_-]?access[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|oauth[_-]?token|bearer|jwt|token|secret|password|passwd|credential[s]?|signature|sig|session(?:[_-]?id|[_-]?token)?|private[_-]?key|client[_-]?secret)$/i;
const SENSITIVE_KEY_TEXT = '(?:authorization|proxy-authorization|www-authenticate|cookie|set-cookie|auth|x-api-key|api[_-]?key|access[_-]?key[_-]?id|aws[_-]?access[_-]?key[_-]?id|secret[_-]?access[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|oauth[_-]?token|bearer|jwt|token|secret|password|passwd|credential[s]?|signature|sig|session(?:[_-]?id|[_-]?token)?|private[_-]?key|client[_-]?secret)';
const SENSITIVE_ASSIGNMENT = new RegExp(`([\\\"']?${SENSITIVE_KEY_TEXT}[\\\"']?\\s*[:=]\\s*)(?:\\\"[^\\\"]*\\\"|'[^']*'|[^\\s,;&)}]+)`, 'gi');
const URL_PATTERN = /https?:[/][/][^\s<>\"']+/gi;

function safeErrorCode(error) {
  const code = error && error.code;
  return typeof code === 'string' && SAFE_ERROR_CODE.test(code) ? code : null;
}

function sanitizeUrl(value) {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    for (const key of url.searchParams.keys()) {
      if (SENSITIVE_KEY.test(key) || /^x-amz-(?:credential|signature|security-token)$/i.test(key)) {
        url.searchParams.set(key, '[REDACTED]');
      }
    }
    // Fragments are not sent on HTTP requests but commonly contain bearer
    // material in diagnostics, so do not retain them.
    url.hash = '';
    return url.toString();
  } catch {
    // Keep a useful marker without returning malformed URL text that may carry
    // userinfo or a credential-bearing query.
    return '[REDACTED_URL]';
  }
}

function sanitizeErrorText(value) {
  let text = String(value == null ? 'Publisher failed' : value);
  text = text.replace(URL_PATTERN, (url) => sanitizeUrl(url));
  text = text.replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [REDACTED]');
  text = text.replace(SENSITIVE_ASSIGNMENT, '$1[REDACTED]');
  return text.replace(/\s+/g, ' ').trim() || 'Publisher failed';
}

/** Keep retry diagnostics useful while preventing publisher data leakage. */
export function sanitizePublisherError(error) {
  const code = safeErrorCode(error);
  const message = sanitizeErrorText(error && error.message !== undefined ? error.message : error);
  const prefix = code ? `${code}: ` : '';
  return `${prefix}${message}`.slice(0, LOOP_UPDATED_ERROR_MAX_LENGTH);
}

function sourceMember(member = {}) {
  const result = {
    memberId: id(member._id),
    status: member.status,
    invitedAsLegalGuardian: member.invitedAsLegalGuardian === undefined
      ? false : member.invitedAsLegalGuardian,
    legalGuardianId: id(member.legalGuardianId),
    agreementId: member.agreementId,
    nickname: member.nickname,
    phoneticName: member.phoneticName,
    enrolled: member.enrolled || { face: false, voice: false },
  };
  if (member.accountId) {
    result.id = id(member.accountId);
  } else if (member.memberProperties) {
    result.memberProperties = { ...member.memberProperties };
  }
  return result;
}

/** Build the loopSchema.post("save") payload at the source field boundary. */
export function buildLoopUpdatedPayload(loop) {
  return {
    id: id(loop?._id),
    name: loop?.name,
    members: (loop?.members || []).map(sourceMember),
    isSuspended: loop?.isSuspended,
    owner: id(loop?.owner),
    robot: id(loop?.robot),
    created: loop?.created,
    updated: loop?.updated,
  };
}

/** Build the notification-ws event-handler request from a saved loop. */
export function buildLoopUpdatedNotification(loop) {
  const accountId = id(loop?.robot);
  if (!accountId) return null;
  return {
    accountId,
    skillId: LOOP_UPDATED_SKILL_ID,
    notification: {
      name: LOOP_UPDATED_EVENT_NAME,
      payload: buildLoopUpdatedPayload(loop),
    },
  };
}

/**
 * Durable outbox for LoopUpdated requests.
 *
 * `publisher` is deliberately an explicit function. In a colocated test or
 * deployment it can be `hub.deliverNotification.bind(hub)`; a split service
 * deployment can drain the same records through its authenticated event
 * bridge. No public access key is ever converted into `accountId` here.
 */
export class LoopUpdatedOutbox {
  /** @param {import('./store.js').Store} store */
  constructor(store, { publisher = null, clock = () => Date.now() } = {}) {
    this.store = store;
    this.publisher = typeof publisher === 'function' ? publisher : null;
    this.clock = clock;
    this.draining = null;
    this.drainScheduled = null;
    this.drainRequested = false;
  }

  /** Return pending rows in persisted insertion order. */
  pending() {
    return [...this.store.notificationOutbox.values()].map((entry) => clone(entry));
  }

  _commitOutbox(mutator) {
    const before = new Map([...this.store.notificationOutbox]
      .map(([key, value]) => [key, clone(value)]));
    try {
      const result = mutator();
      this.store.flush();
      return result;
    } catch (error) {
      this.store.notificationOutbox.clear();
      for (const [key, value] of before) this.store.notificationOutbox.set(key, value);
      throw error;
    }
  }

  /**
   * Record a successful Loop save and persist the event in the same Store
   * snapshot as the changed loop. A missing robot identity cannot be routed by
   * the source handler, so such a loop produces no outbox row.
   */
  record(loop) {
    const request = buildLoopUpdatedNotification(loop);
    if (!request) {
      // An administrator can save a loop whose robot relation is already
      // absent. The source still persists that Loop save; only the
      // notification-ws routing step lacks an account target.
      this.store.flush();
      return null;
    }
    const now = new Date(this.clock()).toISOString();
    const entry = {
      _id: newOutboxId(),
      created: now,
      updated: now,
      attempts: 0,
      ...request,
    };
    // Store.flush serializes both the already-mutated loop and this row. This
    // closes the crash window between a persisted state change and its event.
    this._commitOutbox(() => {
      this.store.notificationOutbox.set(entry._id, entry);
    });
    this._startDrain();
    return { ...entry, notification: { ...entry.notification, payload: { ...entry.notification.payload } } };
  }

  /** Drain once; failed publication retains the row for retry/recovery. */
  drain() {
    if (!this.publisher) return Promise.resolve({ published: 0, retained: this.pending().length });
    if (this.drainScheduled) return this.drainScheduled;
    if (this.draining) {
      // A drain iterates a snapshot. A producer can append another event
      // while the current publisher is awaiting its bridge; remember that
      // mutation so the newly committed row gets one follow-up pass after
      // the current drain settles.
      this.drainRequested = true;
      return this.draining;
    }
    return this._drainNow();
  }

  _drainNow() {
    this.draining = (async () => {
      let published = 0;
      for (const entry of this.pending()) {
        // A previous entry can have removed this row while the snapshot was
        // being processed, for example after an explicit retry call.
        if (!this.store.notificationOutbox.has(entry._id)) continue;
        try {
          await this.publisher({
            accountId: entry.accountId,
            skillId: entry.skillId,
            notification: entry.notification,
          });
          try {
            this._commitOutbox(() => this.store.notificationOutbox.delete(entry._id));
          } catch {
            // Publication succeeded but its durable acknowledgement did not.
            // _commitOutbox restored the row; leave it for a later recovery
            // pass rather than reporting it as delivered or losing it.
            break;
          }
          published += 1;
        } catch (error) {
          if (this.store.notificationOutbox.has(entry._id)) {
            try {
              this._commitOutbox(() => {
                const current = this.store.notificationOutbox.get(entry._id);
                if (!current) return;
                current.attempts = Number(current.attempts || 0) + 1;
                current.lastError = sanitizePublisherError(error);
                current.updated = new Date(this.clock()).toISOString();
              });
            } catch {
              // The update was rolled back with the original row. A later
              // recovery can retry publication once persistence is healthy.
              break;
            }
          }
        }
      }
      return { published, retained: this.store.notificationOutbox.size };
    })().finally(() => {
      this.draining = null;
      if (this.drainRequested) {
        // Only a producer/recovery call made while the previous pass was
        // active requests this pass. A failed publisher by itself does not
        // spin a tight retry loop.
        this.drainRequested = false;
        queueMicrotask(() => this._startDrain());
      }
    });
    return this.draining;
  }

  _startDrain() {
    if (!this.publisher) return Promise.resolve({ published: 0, retained: this.pending().length });
    if (this.drainScheduled) return this.drainScheduled;
    if (this.draining) {
      this.drainRequested = true;
      return this.draining;
    }

    let resolveScheduled;
    let rejectScheduled;
    const scheduled = new Promise((resolve, reject) => {
      resolveScheduled = resolve;
      rejectScheduled = reject;
    });
    // Automatic publication is deliberately deferred until the next
    // check phase. The source Loop post-save hook schedules LoopUpdated with
    // setImmediate. LoopCreated follows asynchronous account population, so
    // the source does not guarantee their relative order. Keep `draining` promise-shaped
    // immediately so existing callers can await automatic delivery.
    this.drainScheduled = scheduled;
    this.draining = scheduled;
    setImmediate(() => {
      if (this.drainScheduled !== scheduled) return;
      this.drainScheduled = null;
      // The scheduled promise is only a handoff placeholder. Clear it before
      // starting the real drain so _drainNow can own this.draining and its
      // completion cleanup.
      if (this.draining === scheduled) this.draining = null;
      let running;
      try {
        running = this._drainNow();
      } catch (error) {
        rejectScheduled(error);
        return;
      }
      running.then(resolveScheduled, rejectScheduled);
    });
    // record() intentionally does not await this promise. Keep an unexpected
    // internal rejection from becoming an unhandled rejection; the durable
    // row remains available to recover().
    try {
      void scheduled.catch(() => {});
    } catch { /* Promise construction cannot normally throw. */ }
    return scheduled;
  }

  /** Retry pending rows after account-service/repository restart. */
  recover() {
    return this.drain();
  }
}
