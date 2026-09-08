// Durable local EventSender counterpart for InvitedToJoinLoop.
//
// srv-account-ws publishes JSON events to the configured SNS topic. Phoenix
// keeps the event contract independent of AWS: a configured local HTTP sink
// can consume the same serialized event, while this file-backed outbox keeps
// it recoverable across an account-process restart and acknowledges rows only
// after the sink accepts them.

import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_EVENT_FILE = join(tmpdir(), 'phoenix-invitation-events.json');

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function newId() {
  return randomBytes(12).toString('hex');
}

function numberOption(value, fallback, minimum = 1) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, number) : fallback;
}

function validateEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new TypeError('event must be an object');
  }
  if (typeof event.validate === 'function') event.validate();
  if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
    throw new TypeError('event.payload must be an object');
  }
  if (typeof event.payload.eventKey !== 'string' || event.payload.eventKey.length === 0) {
    throw new TypeError('eventKey is not defined');
  }
}

function sourceEvent(event) {
  validateEvent(event);
  const value = clone(event);
  // A clone no longer has the source class's validate method, so verify its
  // wire contract once more at the plain-object boundary used by HTTP sinks.
  validateEvent(value);
  return value;
}

function failureFromRow(row) {
  const error = new Error(row.lastError || `event ${row._id} remains pending`);
  error.code = 'INVITATION_EVENT_PENDING';
  error.eventId = row._id;
  return error;
}

function parseStored(value, file) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`invitation event outbox unreadable (${file}): ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || (parsed.version !== undefined && parsed.version !== 1)
    || !Array.isArray(parsed.events)) {
    throw new Error(`invitation event outbox has an invalid root (${file})`);
  }
  return parsed.events.map((row) => {
    if (!row || typeof row !== 'object' || !row._id || !row.event) {
      throw new Error(`invitation event outbox has an invalid row (${file})`);
    }
    validateEvent(row.event);
    return {
      _id: String(row._id),
      created: String(row.created || new Date(0).toISOString()),
      updated: String(row.updated || row.created || new Date(0).toISOString()),
      attempts: Number(row.attempts || 0),
      lastError: row.lastError === undefined ? undefined : String(row.lastError),
      event: clone(row.event),
    };
  });
}

function defaultPersistence() {
  return {
    chmod: chmodSync,
    close: closeSync,
    exists: existsSync,
    fchmod: fchmodSync,
    mkdir: mkdirSync,
    open: openSync,
    readFile: readFileSync,
    rename: renameSync,
    unlink: unlinkSync,
    writeFile: writeFileSync,
  };
}

/**
 * A durable EventSender-compatible queue.
 *
 * `publisher(event, row)` is an explicit local consumer boundary. A publisher
 * rejection leaves the event row pending and rejects `send`, matching the
 * source caller's caught Promise. With no publisher, `send` still durably
 * queues the event for a later `consume`/`recover` operation; it never claims
 * that an external event bus delivered it.
 */
export class InvitationEventOutbox {
  constructor(file = DEFAULT_EVENT_FILE, {
    publisher = null,
    clock = () => Date.now(),
    persistence = undefined,
  } = {}) {
    this.file = file;
    this.publisher = typeof publisher === 'function'
      ? publisher
      : publisher && typeof publisher.send === 'function'
        ? publisher.send.bind(publisher)
        : null;
    this.clock = clock;
    this.persistence = { ...defaultPersistence(), ...(persistence || {}) };
    this.events = [];
    this.draining = null;
    this.drainRequested = false;
    this._load();
    this._committed = this._snapshot();
  }

  _load() {
    if (!this.persistence.exists(this.file)) return;
    this.events = parseStored(this.persistence.readFile(this.file, 'utf8'), this.file);
  }

  _snapshot() {
    return this.events.map((row) => clone(row));
  }

  _restore(snapshot) {
    this.events = snapshot.map((row) => clone(row));
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

  flush({ rollbackOnError = true } = {}) {
    const output = JSON.stringify({ version: 1, events: this.events.map((row) => clone(row)) }, null, 2) + '\n';
    const parent = dirname(this.file);
    const temporary = `${this.file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    let fd;
    let renamed = false;
    try {
      this.persistence.mkdir(parent, { recursive: true, mode: 0o700 });
      fd = this.persistence.open(temporary, 'wx', 0o600);
      try {
        this.persistence.writeFile(fd, output);
        this.persistence.fchmod(fd, 0o600);
      } finally {
        this.persistence.close(fd);
        fd = undefined;
      }
      this.persistence.rename(temporary, this.file);
      renamed = true;
      try { this.persistence.chmod(this.file, 0o600); } catch (_) { /* best effort on unusual filesystems */ }
      this._committed = this._snapshot();
    } catch (error) {
      if (fd !== undefined) {
        try { this.persistence.close(fd); } catch (_) { /* cleanup is best effort */ }
      }
      if (!renamed) {
        try { this.persistence.unlink(temporary); } catch (_) { /* preserve original error */ }
        if (rollbackOnError) this._restore(this._committed);
      }
      throw error;
    }
  }

  pending() {
    return this.events.map((row) => clone(row));
  }

  send(event) {
    const value = sourceEvent(event);
    const now = new Date(this.clock()).toISOString();
    const row = this._commit(() => {
      const next = {
        _id: newId(),
        created: now,
        updated: now,
        attempts: 0,
        event: value,
      };
      this.events.push(next);
      return next;
    });
    if (!this.publisher) return Promise.resolve({ queued: row._id });

    const drain = this.drain();
    return drain.then((result) => {
      const current = this.events.find((item) => item._id === row._id);
      if (current) throw failureFromRow(current);
      return result;
    });
  }

  /** Publish a snapshot and delete each row only after a successful ack. */
  drain() {
    if (!this.publisher) return Promise.resolve({ published: 0, retained: this.events.length });
    if (this.draining) {
      this.drainRequested = true;
      return this.draining;
    }
    this.draining = (async () => {
      let published = 0;
      for (const row of this.pending()) {
        if (!this.events.some((item) => item._id === row._id)) continue;
        try {
          await this.publisher(clone(row.event), clone(row));
          this._commit(() => {
            this.events = this.events.filter((item) => item._id !== row._id);
          });
          published += 1;
        } catch (error) {
          if (this.events.some((item) => item._id === row._id)) {
            try {
              this._commit(() => {
                const current = this.events.find((item) => item._id === row._id);
                if (!current) return;
                current.attempts = Number(current.attempts || 0) + 1;
                current.lastError = error?.message || String(error);
                current.updated = new Date(this.clock()).toISOString();
              });
            } catch (_) {
              // The source event remains in its last committed form. Recovery
              // can retry it after the local persistence problem is fixed.
            }
          }
        }
      }
      return { published, retained: this.events.length };
    })().finally(() => {
      this.draining = null;
      if (this.drainRequested) {
        this.drainRequested = false;
        queueMicrotask(() => { void this.drain().catch(() => {}); });
      }
    });
    return this.draining;
  }

  /** Consume durable rows with a local handler and ack after it resolves. */
  async consume(handler) {
    if (typeof handler !== 'function') throw new TypeError('event consumer must be a function');
    let consumed = 0;
    for (const row of this.pending()) {
      if (!this.events.some((item) => item._id === row._id)) continue;
      try {
        await handler(clone(row.event), clone(row));
        this._commit(() => {
          this.events = this.events.filter((item) => item._id !== row._id);
        });
        consumed += 1;
      } catch (error) {
        try {
          this._commit(() => {
            const current = this.events.find((item) => item._id === row._id);
            if (!current) return;
            current.attempts = Number(current.attempts || 0) + 1;
            current.lastError = error?.message || String(error);
            current.updated = new Date(this.clock()).toISOString();
          });
        } catch (_) { /* retain the last committed row */ }
        throw error;
      }
    }
    return { consumed, retained: this.events.length };
  }

  recover() {
    return this.drain();
  }
}

/** Build a bounded local HTTP EventSender consumer. */
export function createHttpInvitationEventPublisher(url, {
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  headers = {},
} = {}) {
  if (!url) throw new TypeError('event consumer URL is required');
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol)) {
    throw new TypeError('event consumer URL must use http: or https:');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is required for an HTTP event consumer');
  const timeout = numberOption(timeoutMs, DEFAULT_TIMEOUT_MS);
  return async function publishInvitationEvent(event, row = undefined) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetchImpl(target, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-phoenix-event-key': event.payload.eventKey,
          ...headers,
        },
        body: JSON.stringify(event),
        signal: controller.signal,
      });
      const body = await response.text();
      if (!response.ok) {
        const error = new Error(`event consumer HTTP ${response.status}: ${body}`);
        error.statusCode = response.status;
        error.eventId = row?._id;
        throw error;
      }
      return { status: response.status, body };
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Construct the durable sender from an explicit local URL/function configuration. */
export function createConfiguredInvitationEventSender({
  file = DEFAULT_EVENT_FILE,
  publisher = undefined,
  url = undefined,
  timeoutMs = undefined,
  headers = undefined,
} = {}) {
  const effectivePublisher = publisher || (url
    ? createHttpInvitationEventPublisher(url, { timeoutMs, headers })
    : null);
  return new InvitationEventOutbox(file || DEFAULT_EVENT_FILE, { publisher: effectivePublisher });
}
