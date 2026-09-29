// Administrator removal of a robot or loop across a service's own stores.
//
// A robot leaves traces in every service that ever handled it: its account and
// loop, Classic's robot events, keys, backups, media, messages and notification
// tokens, and History's skill launches. Each service removes its own records
// in-process (never by editing another process's file behind its back), with the
// same rule: a record goes if its JSON mentions one of the target identifiers.
// Those are random 24-hex account and loop ids, a 20-character access key and a
// robot's four-word name, so a case-insensitive substring match is precise.

import { cpSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { basename, join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
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

/**
 * POST /internal/admin/purge: remove every record of a robot or loop from this
 * service's stores. Called only by Account's administrator removal, over loopback
 * with the internal peer token. Stores are edited here, in the process that owns
 * them: editing their files from outside would be overwritten by the next write.
 *
 * Body: { ids: [...], dryRun }. `ids` are the robot account id, its access key id,
 * its friendly name and the loop ids. A dry run (the default) reports what would go;
 * a real run first copies each store file and moves each per-id directory into a
 * fresh backup folder, then removes and saves.
 *
 * @param {object} options
 * @param {string} options.service  names the backup folder
 * @param {Array<{name: string, file?: string|null, collections: () => object, save: () => void}>} options.stores
 * @param {Array<[string, string|undefined]>} options.idDirectories  label + parent directory holding per-id folders
 * @param {string} options.backupRoot  where removal backup folders are created
 */
export function adminPurgeRoutes({ service, stores, idDirectories = [], backupRoot }) {
  return {
    'POST /internal/admin/purge': ({ req, res, body }) => {
      if (!requireInternalPeer(req, res)) return undefined;
      let needles;
      try { needles = purgeNeedles(body?.ids); } catch (error) { return sendJson(res, 400, { error: error.message }); }
      const dryRun = body?.dryRun !== false;

      const directories = [];
      for (const id of needles.filter((value) => HEX_ID.test(value))) {
        for (const [label, parent] of idDirectories) {
          const dir = parent ? join(parent, id) : null;
          if (dir && existsSync(dir)) directories.push([`${label}-${id}`, dir]);
        }
      }
      const counts = (dry) => stores.map((store) => ({
        name: store.name,
        removed: purgeCollections(store.collections(), needles, { dryRun: dry }),
        store,
      })).filter((entry) => Object.keys(entry.removed).length);

      if (dryRun) {
        return {
          dryRun: true,
          stores: counts(true).map(({ name, removed }) => ({ name, removed })),
          directories: directories.map(([label]) => label),
        };
      }

      const backupDir = join(backupRoot, `removal-${purgeStamp()}-${service}`);
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
        stores: removed.map(({ name, removed: collections }) => ({ name, removed: collections })),
        directories: directories.map(([label]) => label),
      };
    },
  };
}
