// Settings an administrator saves from the console.
//
// They live in their own file in the data directory, never in the server's
// environment file: that file belongs to whoever installed the server (and on a
// hardened install the services cannot write it). The launcher reads this file
// when it starts a service and layers it over the environment file
// (scripts/console-settings-env.mjs), so a value saved here wins, and removing it
// here falls back to the server's value.
//
//   {
//     "version": 1,
//     "revision": 7,                       bumped by every save
//     "settings": {
//       "LOG_LEVEL": { "value": "debug", "revision": 7, "changedAt": 1790…, "changedBy": "a@example.com" },
//       "TOMTOM_API_KEY": { "value": null, "revision": 5, … }    value null: removed at revision 5
//     },
//     "history": [ { "revision": 7, "at": 1790…, "by": "a@example.com", "changes": [ … ] } ]
//   }
//
// A removed setting keeps its entry with a null value: a service started before
// that revision still has the old value, and the console says so until it restarts.
// History never holds a secret's value, only that it was replaced or removed.
//
// Writes are atomic (a private temporary file, then rename) so a crash cannot
// leave half a file for the launcher to read at the next start.

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { BY_KEY, isEditable } from './configCatalog.js';

export const CONSOLE_SETTINGS_VERSION = 1;
const HISTORY_LIMIT = 100;

/** Where console settings are kept: the launcher's choice, else beside the account store. */
export function consoleSettingsFile({ env = process.env, storeFile } = {}) {
  if (env.PHOENIX_CONSOLE_SETTINGS_FILE) return env.PHOENIX_CONSOLE_SETTINGS_FILE;
  if (env.PHOENIX_DATA_DIR) return join(env.PHOENIX_DATA_DIR, 'config', 'console-settings.json');
  return join(dirname(storeFile || join(process.cwd(), 'packages/account/data/store.json')), 'config', 'console-settings.json');
}

export function emptyConsoleSettings() {
  return { version: CONSOLE_SETTINGS_VERSION, revision: 0, settings: {}, history: [] };
}

/**
 * Read the file. A missing file is an empty state. A file that cannot be read
 * or parsed is reported, not thrown: the console must still load so an
 * administrator can see what is wrong.
 * @returns {{state: object, error: string|null}}
 */
export function readConsoleSettings(file) {
  if (!file || !existsSync(file)) return { state: emptyConsoleSettings(), error: null };
  try {
    return { state: normalize(JSON.parse(readFileSync(file, 'utf8'))), error: null };
  } catch (error) {
    return { state: emptyConsoleSettings(), error: `could not read ${file}: ${error.message}` };
  }
}

function normalize(raw) {
  const state = emptyConsoleSettings();
  if (!raw || typeof raw !== 'object') return state;
  state.revision = Number.isSafeInteger(raw.revision) && raw.revision > 0 ? raw.revision : 0;
  for (const [key, entry] of Object.entries(raw.settings || {})) {
    if (!BY_KEY.has(key) || !entry || typeof entry !== 'object') continue;
    state.settings[key] = {
      value: typeof entry.value === 'string' ? entry.value : null,
      revision: Number.isSafeInteger(entry.revision) ? entry.revision : state.revision,
      changedAt: Number.isFinite(entry.changedAt) ? entry.changedAt : null,
      changedBy: typeof entry.changedBy === 'string' ? entry.changedBy : null,
    };
  }
  state.history = Array.isArray(raw.history) ? raw.history.filter((item) => item && typeof item === 'object') : [];
  return state;
}

/** Atomic, private write. */
export function writeConsoleSettings(file, state) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(file), `.console-settings.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* never created, or already renamed */ }
    throw error;
  }
}

/** The values in force here: settings with a value, by key. */
export function consoleValues(state) {
  const out = {};
  for (const [key, entry] of Object.entries(state.settings)) if (entry.value !== null) out[key] = entry.value;
  return out;
}

/**
 * Apply a batch of changes. `changes` maps a key to its new value, or to null or
 * '' to remove it here. Only editable keys are accepted; validation is the
 * caller's job. Returns the next state and the keys that really changed — saving
 * a value that is already in force is not a change and bumps nothing.
 */
export function applyConsoleChanges(state, changes, { actor = null, now = Date.now() } = {}) {
  const next = {
    ...state,
    settings: { ...state.settings },
    history: [...state.history],
  };
  const revision = state.revision + 1;
  const changed = [];
  const record = [];

  for (const [key, raw] of Object.entries(changes)) {
    if (!isEditable(key)) throw new TypeError(`${key} cannot be changed from the console`);
    const value = raw === null || raw === undefined || String(raw).trim() === '' ? null : String(raw);
    const before = state.settings[key]?.value ?? null;
    if (before === value) continue;
    next.settings[key] = { value, revision, changedAt: now, changedBy: actor };
    changed.push(key);

    const secret = BY_KEY.get(key)?.type === 'secret';
    if (value === null) record.push({ key, action: 'removed' });
    else if (secret) record.push({ key, action: before === null ? 'set' : 'replaced' });
    else record.push({ key, action: before === null ? 'set' : 'changed', from: before, to: value });
  }

  if (!changed.length) return { state, changed };
  next.revision = revision;
  next.history.unshift({ revision, at: now, by: actor, changes: record });
  next.history.length = Math.min(next.history.length, HISTORY_LIMIT);
  return { state: next, changed };
}
