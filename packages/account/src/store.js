// Persistent JSON-file store for the account service — accounts / loops / tokens / sessions.
// The handoff requires persistence (robot credentials must survive restarts); a single JSON
// file with atomic writes (tmp + rename) is plenty at household scale and keeps Phoenix
// zero-dependency. Collections are Maps keyed by _id; every mutation schedules a flush.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_FILE = join(dirname(fileURLToPath(import.meta.url)), '../data/store.json');
// `settings` holds per-account report-skill PersonalReportSettingsData (keyed by _id = accountId).
const COLLECTIONS = ['accounts', 'loops', 'tokens', 'sessions', 'settings', 'notificationOutbox', 'emailResets'];

export class Store {
  /** @param {string} [file] JSON file path (ETCO_account_dataFile overrides the default) */
  constructor(file = process.env.ETCO_account_dataFile || DEFAULT_FILE) {
    this.file = file;
    for (const c of COLLECTIONS) this[c] = new Map();
    this._load();
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
