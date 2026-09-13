// Persistent JSON-file store for the account service — accounts / loops / tokens / sessions.
// The handoff requires persistence (robot credentials must survive restarts); a single JSON
// file with atomic writes (tmp + rename) is plenty at household scale and keeps Phoenix
// zero-dependency. Collections are Maps keyed by _id; every mutation schedules a flush.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, openSync, closeSync, unlinkSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_FILE = join(dirname(fileURLToPath(import.meta.url)), '../data/store.json');
// `settings` holds per-account report-skill PersonalReportSettingsData (keyed by _id = accountId).
// `oauthClients` holds the admin OAuth-client registry (OauthClients_20171108), keyed by _id.
const COLLECTIONS = ['accounts', 'loops', 'tokens', 'sessions', 'settings', 'notificationOutbox', 'emailResets', 'phoneVerifications', 'oauthClients'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function restoreReference(reference, value) {
  if (!reference || typeof reference !== 'object' || !value || typeof value !== 'object') return clone(value);
  for (const key of Object.keys(reference)) delete reference[key];
  Object.assign(reference, clone(value));
  return reference;
}

export class Store {
  /** @param {string} [file] JSON file path (ETCO_account_dataFile overrides the default) */
  constructor(file = process.env.ETCO_account_dataFile || DEFAULT_FILE) {
    this.file = file;
    for (const c of COLLECTIONS) this[c] = new Map();
    this._load();
  }

  _cleanupStaleTemps() {
    const directory = dirname(this.file);
    const prefix = `${basename(this.file)}.`;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith('.tmp')) continue;
      const uuid = entry.name.slice(prefix.length, -'.tmp'.length);
      if (!UUID_RE.test(uuid)) continue;
      try {
        unlinkSync(join(directory, entry.name));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }

  _load() {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      for (const c of COLLECTIONS) {
        for (const item of raw[c] || []) this[c].set(item._id, item);
      }
    } catch (err) {
      throw new Error(`account store unreadable (${this.file}): ${err.message}`);
    }
    // SIGKILL can leave a UUID temp behind after its write but before rename.
    // Keep the parsed committed snapshot authoritative, then remove only the
    // temp names this store creates. A missing primary is left alone so a
    // possible first-snapshot recovery artifact is not discarded blindly.
    this._cleanupStaleTemps();
  }

  /** Replace the snapshot atomically, keeping credential bytes private. */
  flush() {
    const out = {};
    for (const c of COLLECTIONS) out[c] = [...this[c].values()];
    const serialized = JSON.stringify(out, null, 2);
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    // An exclusive, private temporary file avoids inheriting permissions from
    // an old temporary snapshot. Do not rely on a particular caller's umask.
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      try {
        writeFileSync(fd, serialized);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, this.file);
    } finally {
      // Only remove the temporary file this invocation created. Preserve the
      // original write/rename error if cleanup is also unavailable.
      try { unlinkSync(tmp); } catch { /* renamed or cleanup unavailable */ }
    }
  }

  /**
   * Capture every collection before a multi-record operation mutates it.
   * Entries retain their original object reference so rollback restores callers
   * that still hold a hydrated record, while the JSON copy restores fields that
   * an in-place mutation changed.
   */
  snapshot() {
    const snapshot = {};
    for (const collection of COLLECTIONS) {
      snapshot[collection] = new Map([...this[collection]].map(([key, value]) => [key, {
        reference: value,
        value: clone(value),
      }]));
    }
    return snapshot;
  }

  /** Restore a snapshot without touching the durable file. */
  restore(snapshot) {
    for (const collection of COLLECTIONS) {
      const target = this[collection];
      target.clear();
      for (const [key, entry] of snapshot[collection] || []) {
        target.set(key, restoreReference(entry.reference, entry.value));
      }
    }
  }

  /**
   * Run a synchronous multi-collection mutation and commit exactly one Store
   * snapshot. Existing helpers call `store.flush()` at their individual save
   * boundaries; suppress those calls while this transaction is open so a
   * rejected final flush cannot expose a partial topology.
   */
  transaction(mutator) {
    if (typeof mutator !== 'function') throw new TypeError('store transaction requires a function');
    const before = this.snapshot();
    const flush = this.flush;
    let active = true;
    this.flush = (...args) => {
      if (active) return undefined;
      return flush.apply(this, args);
    };
    try {
      const result = mutator();
      if (result && typeof result.then === 'function') {
        throw new TypeError('store transaction callback must be synchronous');
      }
      active = false;
      this.flush = flush;
      flush.apply(this);
      return result;
    } catch (error) {
      active = false;
      this.flush = flush;
      this.restore(before);
      throw error;
    }
  }

  // -- convenience finders ----------------------------------------------------

  accountByEmail(email) {
    const needle = String(email).toLowerCase();
    return [...this.accounts.values()].find((a) => a.email && a.email.toLowerCase() === needle) || null;
  }

  accountByFriendlyId(friendlyId) {
    return [...this.accounts.values()].find((a) => a.friendlyId === friendlyId) || null;
  }

  accountByAccessKeyId(accessKeyId) {
    return [...this.accounts.values()].find((a) => a.accessKeyId === accessKeyId) || null;
  }

  loopsByOwner(accountId) {
    return [...this.loops.values()].filter((l) => l.owner === accountId);
  }

  /** Every robot account (an Account with a friendlyId), with its loop + owner resolved. */
  allRobots() {
    return [...this.accounts.values()]
      .filter((a) => a.friendlyId)
      .map((robot) => {
        const loop = [...this.loops.values()].find((l) => l.robot === robot._id) || null;
        const owner = loop ? this.accounts.get(loop.owner) || null : null;
        return { robot, loop, owner };
      });
  }
}

let defaultStore = null;
/** Process-wide store singleton (tests construct their own with a temp file). */
export function getStore() {
  if (!defaultStore) defaultStore = new Store();
  return defaultStore;
}
export function resetStore() { defaultStore = null; }
