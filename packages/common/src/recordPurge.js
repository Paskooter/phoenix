// Administrator removal of a robot or loop, and account deletion, across a
// service's own stores.
//
// A robot leaves traces in every service that ever handled it: its account and
// loop, Classic's robot events, keys, backups, media, messages and notification
// tokens, and History's skill launches. Each service removes its own records
// in-process (never by editing another process's file behind its back), with the
// same rule: a record goes if its JSON mentions one of the target identifiers.
// Those are random 24-hex account and loop ids, a 20-character access key and a
// robot's four-word name, so a case-insensitive substring match is precise.
//
// A person who deletes their account is different. Their id also appears in
// records that belong to other people: every reader of a message is listed on
// it, and a loop's key backup names whoever made it. So a store forgets a person
// through its own `forget` function, which removes only what is theirs.

import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { logger } from './log.js';
import { sendJson } from './service.js';

const NEEDLE = /^[A-Za-z0-9][A-Za-z0-9-]{7,99}$/;

/** Normalise and validate the identifiers a removal targets. */
export function purgeNeedles(values) {
  const needles = [...new Set((values || []).filter((value) => typeof value === 'string')
    .map((value) => value.trim().toLowerCase()))];
  if (!needles.length || needles.some((value) => !NEEDLE.test(value))) {
    throw new TypeError('removal identifiers must be 8-100 letters, digits or hyphens');
  }
  return needles;
}

function mentions(key, value, needles) {
  const text = `${key === undefined ? '' : String(key)}\u0000${JSON.stringify(value) ?? ''}`.toLowerCase();
  return needles.some((needle) => text.includes(needle));
}

/**
 * Remove (or, with dryRun, only count) the entries of each collection that
 * mention a needle. Arrays are edited in place so other holders of the same
 * array see the change. Returns { collectionName: count } for non-zero counts.
 */
export function purgeCollections(collections, needles, { dryRun = false } = {}) {
  const counts = {};
  for (const [name, collection] of Object.entries(collections)) {
    let removed = 0;
    if (collection instanceof Map) {
      for (const [key, value] of [...collection.entries()]) {
        if (!mentions(key, value, needles)) continue;
        removed += 1;
        if (!dryRun) collection.delete(key);
      }
    } else if (Array.isArray(collection)) {
      for (let index = collection.length - 1; index >= 0; index -= 1) {
        if (!mentions(undefined, collection[index], needles)) continue;
        removed += 1;
        if (!dryRun) collection.splice(index, 1);
      }
    }
    if (removed) counts[name] = removed;
  }
  return counts;
}

/**
 * Copy files and move directories into a fresh backup folder before a removal.
 * Moving a per-loop directory is both its backup and its removal.
 */
export function backupBeforePurge(backupDir, { files = [], moveDirs = [] } = {}) {
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const saved = [];
  for (const file of files) {
    if (!file || !existsSync(file)) continue;
    const target = join(backupDir, basename(file));
    cpSync(file, target, { preserveTimestamps: true });
    saved.push(target);
  }
  for (const [label, dir] of moveDirs) {
    if (!dir || !existsSync(dir)) continue;
    const target = join(backupDir, label);
    renameSync(dir, target);
    saved.push(target);
  }
  return saved;
}

/** A filesystem-safe timestamp label for a removal backup folder. */
export function purgeStamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

const BACKUP_LABELS = new Set(['removal', 'deletion']);
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The folder one service's backup goes in: `removal-…` for an administrator's
 * removal, `deletion-…` for an account its owner deleted.
 */
export function purgeBackupDir(backupRoot, label, service, date = new Date()) {
  if (!BACKUP_LABELS.has(label)) throw new TypeError('label must be removal or deletion');
  return join(backupRoot, `${label}-${purgeStamp(date)}-${service}`);
}

/** Days an account deletion's backups are kept: PHOENIX_DELETION_BACKUP_DAYS, default 30. */
export function deletionBackupDays(env = process.env) {
  const days = Number(env.PHOENIX_DELETION_BACKUP_DAYS);
  return env.PHOENIX_DELETION_BACKUP_DAYS !== undefined && env.PHOENIX_DELETION_BACKUP_DAYS !== ''
    && Number.isFinite(days) && days >= 0 ? days : 30;
}

function backupTime(name, dir) {
  const stamp = /^deletion-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-/.exec(name);
  if (stamp) {
    const [, year, month, day, hour, minute, second] = stamp.map(Number);
    return Date.UTC(year, month - 1, day, hour, minute, second);
  }
  return statSync(dir).mtimeMs;
}

/**
 * Delete account-deletion backups older than the retention window, so a deleted
 * account's data outlives it only briefly, even in a backup. An administrator's
 * `removal-…` backups are kept until someone deletes them.
 */
export function pruneDeletionBackups(backupRoot, { days = deletionBackupDays(), now = Date.now() } = {}) {
  if (!backupRoot || !existsSync(backupRoot)) return [];
  const cutoff = now - days * DAY_MS;
  const pruned = [];
  for (const entry of readdirSync(backupRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('deletion-')) continue;
    const dir = join(backupRoot, entry.name);
    if (backupTime(entry.name, dir) > cutoff) continue;
    rmSync(dir, { recursive: true, force: true });
    pruned.push(dir);
  }
  return pruned;
}

function pruneQuietly(backupRoot, service) {
  try {
    const pruned = pruneDeletionBackups(backupRoot);
    if (pruned.length) logger('purge').info('deleted expired account-deletion backups', { service, count: pruned.length });
  } catch (error) {
    logger('purge').warn('could not prune account-deletion backups', { service, error: error.message });
  }
}

/**
 * Accept only a direct, token-authenticated call from a sibling service: the
 * shared internal peer token, and no reverse-proxy forwarding headers (a request
 * that came through the public edge carries them). Sends the refusal itself.
 */
export function requireInternalPeer(req, res, token = process.env.ETCO_account_internalPeerToken) {
  const presented = String(req?.headers?.['x-phoenix-internal-token'] || '');
  const proxied = req?.headers?.['x-forwarded-for'] || req?.headers?.['x-real-ip'];
  const ok = Boolean(token) && !proxied && presented.length === token.length
    && timingSafeEqual(Buffer.from(presented), Buffer.from(token));
  if (!ok) sendJson(res, token ? 403 : 503, { error: token ? 'forbidden' : 'internal peer token is not configured' });
  return ok;
}

const HEX_ID = /^[a-f0-9]{24}$/;

/** Validate the account ids of people being forgotten. */
function accountIds(values) {
  const ids = purgeNeedles(values);
  if (ids.some((value) => !HEX_ID.test(value))) throw new TypeError('accounts to forget must be 24-character account ids');
  return ids;
}

const optionalList = (value, parse) => (value === undefined || (Array.isArray(value) && !value.length) ? [] : parse(value));

/**
 * POST /internal/admin/purge: remove every record of a robot or loop, or of a
 * person who deleted their account, from this service's stores. Called only by
 * Account, over loopback with the internal peer token. Stores are edited here,
 * in the process that owns them: editing their files from outside would be
 * overwritten by the next write.
 *
 * Body: { ids, forget, dryRun, label }.
 *   ids     what is removed outright: a robot's account id, access key id and
 *           friendly name, and loop ids. Every record that mentions one goes.
 *   forget  account ids of people who deleted their account. Each store's
 *           `forget(ids, { dryRun })` removes the records that are theirs and
 *           returns { collection: count }; a store without one holds nothing
 *           personal. A folder named after the account (what they uploaded) goes.
 *   label   'removal' (the default) or 'deletion'; names the backup folder.
 * A dry run (the default) reports what would go; a real run first copies each
 * store file and moves each per-id directory into a fresh backup folder, then
 * removes and saves. Deletion backups are pruned after deletionBackupDays().
 *
 * @param {object} options
 * @param {string} options.service  names the backup folder
 * @param {Array<{name: string, file?: string|null, collections: () => object, save: () => void,
 *   forget?: (accountIds: string[], options: {dryRun: boolean}) => object}>} options.stores
 * @param {Array<[string, string|undefined]>} options.idDirectories  label + parent directory holding per-id folders
 * @param {string} options.backupRoot  where removal backup folders are created
 */
export function adminPurgeRoutes({ service, stores, idDirectories = [], backupRoot }) {
  // A server where nobody deletes an account for a while still lets old deletion backups go.
  pruneQuietly(backupRoot, service);
  return {
    'POST /internal/admin/purge': ({ req, res, body }) => {
      if (!requireInternalPeer(req, res)) return undefined;
      let needles;
      let people;
      try {
        needles = optionalList(body?.ids, purgeNeedles);
        people = optionalList(body?.forget, accountIds);
        if (!needles.length && !people.length) throw new TypeError('name what to remove (ids) or whom to forget (forget)');
      } catch (error) { return sendJson(res, 400, { error: error.message }); }
      const label = body?.label ?? 'removal';
      if (!BACKUP_LABELS.has(label)) return sendJson(res, 400, { error: 'label must be removal or deletion' });
      const dryRun = body?.dryRun !== false;

      const directories = [];
      for (const id of [...new Set([...needles, ...people])].filter((value) => HEX_ID.test(value))) {
        for (const [dirLabel, parent] of idDirectories) {
          const dir = parent ? join(parent, id) : null;
          if (dir && existsSync(dir)) directories.push([`${dirLabel}-${id}`, dir]);
        }
      }
      // `removed` counts records that mention an id, `forgotten` a person's own records.
      // A real run removes first, so forgetting counts only what is left; a dry run of
      // both can count one record twice.
      const counts = (dry) => stores.map((store) => {
        const removed = needles.length ? purgeCollections(store.collections(), needles, { dryRun: dry }) : {};
        const forgotten = people.length && typeof store.forget === 'function'
          ? Object.fromEntries(Object.entries(store.forget(people, { dryRun: dry }) || {}).filter(([, count]) => count > 0))
          : {};
        return { name: store.name, removed, forgotten, store };
      }).filter((entry) => Object.keys(entry.removed).length || Object.keys(entry.forgotten).length);
      const report = (entries) => entries.map(({ name, removed, forgotten }) => (
        Object.keys(forgotten).length ? { name, removed, forgotten } : { name, removed }));

      if (dryRun) {
        return {
          dryRun: true,
          stores: report(counts(true)),
          directories: directories.map(([dirLabel]) => dirLabel),
        };
      }

      pruneQuietly(backupRoot, service);
      const backupDir = purgeBackupDir(backupRoot, label, service);
      const saved = backupBeforePurge(backupDir, {
        files: stores.map((store) => store.file).filter(Boolean),
        moveDirs: directories,
      });
      const removed = counts(false);
      for (const { store } of removed) store.save();
      return {
        dryRun: false,
        backupDir,
        backedUp: saved.length,
        stores: report(removed),
        directories: directories.map(([dirLabel]) => dirLabel),
      };
    },
  };
}
