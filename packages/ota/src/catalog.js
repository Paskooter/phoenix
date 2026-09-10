// The update catalog: the set of OTA packages this server can offer, indexed for the
// Update service's operations (ListUpdates / ListUpdatesFrom / GetUpdateFrom /
// CreateUpdate / RemoveUpdate / ListUniqueFilters) and the per-robot target map
// (SetTarget / ListTargets).
//
// Rebuilt against the pinned server jiborobot/srv-update-ws
// (src/controllers/update.ctrl.ts, src/controllers/targeted.ctrl.ts,
// src/schemes/update.ts, src/schemes/target.ts) and the API models
// apis/update-2016-03-01.normal.json + apis/updateadmin-2016-03-01.normal.json.
//
// The source kept the records in Mongo and the package bytes in S3; Phoenix has
// neither, so an entry is a manifest record plus one real file under `dataDir`, and the
// target map is a small JSON file there. An entry only becomes "available" once its file
// exists on disk — at load time we stream the file to compute its real length + SHA-1
// (the robot's jibo-download-update verifies both, so they MUST be exact). Entries whose
// file is missing are skipped with a warning, so the server is safe to run before
// `scripts/build-ota-packages.sh` has produced anything.

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { UPDATE_ALREADY_EXISTS, UpdateError } from './errors.js';

// jiborobot/srv-update-ws src/controllers/update.ctrl.ts:11-12
export const DEFAULT_SUBSYSTEM = 'main';
export const DEFAULT_FILTER = '';

/** Compare dotted numeric versions (e.g. "12.10.0" vs "3.3.4"). Non-numeric segments compare as strings. */
export function cmpVersion(a, b) {
  const pa = String(a).split('.');
  const pb = String(b).split('.');
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const xa = pa[i] ?? '0';
    const xb = pb[i] ?? '0';
    const na = Number(xa);
    const nb = Number(xb);
    if (Number.isInteger(na) && Number.isInteger(nb)) {
      if (na !== nb) return na - nb;
    } else if (xa !== xb) {
      return xa < xb ? -1 : 1;
    }
  }
  return 0;
}

function sha1File(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha1');
    const s = createReadStream(file);
    s.on('data', (c) => h.update(c));
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * The source's `getCondition` filter rule (update.ctrl.ts:37-41): with no effective filter
 * the record's filter must be EXACTLY the empty string; with a filter it is a PREFIX match
 * (the source compiled `{$regex: "^" + escaped(filter)}`). Both directions matter — a
 * filterless request must not see a "green" record, and a filtered request must not see an
 * unfiltered record.
 */
export function filterMatches(entryFilter, requestFilter) {
  if (requestFilter) return String(entryFilter || '').startsWith(requestFilter);
  return (entryFilter || '') === '';
}

export class Catalog {
  /** @param {{ dataDir: string, log?: any, serialOf?: ((friendlyId: string) => Promise<string|undefined|null>)|null }} opts */
  constructor({ dataDir, log = console, serialOf = null } = {}) {
    this.dataDir = dataDir;
    this.log = log;
    /** @type {Array<object>} available (file-backed) entries */
    this.entries = [];
    /** serial -> OTA target ("filter"); the source's Target collection. */
    this.targets = new Map();
    // Source TargetedController.getFilter resolves friendlyId -> serial via robotread
    // (Robot_20160225.GetRobot). Injectable so a deployment can wire the hop; when absent
    // the credential identity is used as the target key directly.
    this.serialOf = serialOf;
    this._targetsFile = dataDir ? path.join(dataDir, 'targets.json') : null;
  }

  /** Build a catalog, resolving + hashing each entry's package file. */
  static async load({ entries = [], dataDir, log = console, serialOf = null } = {}) {
    const cat = new Catalog({ dataDir, log, serialOf });
    await cat.loadTargets();
    for (const e of entries) await cat.ingest(e);
    return cat;
  }

  async ingest(e) {
    if (!e || !e.id || !e.subsystem || !e.toVersion || !e.file) {
      this.log.warn?.('ota: ignoring malformed manifest entry', { entry: e });
      return null;
    }
    const file = path.resolve(this.dataDir, e.file);
    let length;
    try {
      length = (await stat(file)).size;
    } catch {
      this.log.warn?.('ota: package file missing — entry unavailable until built', { id: e.id, file });
      return null;
    }
    const sha1 = await sha1File(file);
    const entry = {
      id: e.id,
      subsystem: e.subsystem,
      fromVersion: e.fromVersion ?? '*',
      toVersion: e.toVersion,
      changes: e.changes ?? '',
      filter: e.filter ?? '',
      dependencies: e.dependencies ?? {},
      created: e.created ?? 0,
      accountId: e.accountId ?? 'phoenix-ota',
      _file: file,
      length,
      sha1,
    };
    if (e.sha1 && e.sha1 !== sha1) {
      this.log.warn?.('ota: manifest sha1 mismatch — using computed value', { id: e.id, manifest: e.sha1, computed: sha1 });
    }
    this.entries.push(entry);
    this.log.info?.('ota: package ready', { id: entry.id, subsystem: entry.subsystem, toVersion: entry.toVersion, length, sha1 });
    return entry;
  }

  // --- matching ------------------------------------------------------------
  // subsystem: the source ALWAYS scopes a query to a subsystem, defaulting an omitted one
  //            to "main" (update.ctrl.ts:30-32) — it is never a match-all.
  // filter:    see filterMatches().
  // applicable(fromVersion): entry.fromVersion must equal the requested version, unless the
  //            entry uses "*" (a Phoenix extension that lets one package serve any installed
  //            version — see DIVERGENCES candidate A8). Never offer an update whose toVersion
  //            the robot already runs — that's the loop-guard for "*" entries.

  _matchSubsystem(e, subsystem) {
    return e.subsystem === (subsystem || DEFAULT_SUBSYSTEM);
  }

  _matchFilter(e, filter) {
    return filterMatches(e.filter, filter);
  }

  _applicable(e, fromVersion) {
    if (!fromVersion) return true;
    if (fromVersion === e.toVersion) return false; // already at target
    if (e.fromVersion === '*') return cmpVersion(fromVersion, e.toVersion) < 0;
    return e.fromVersion === fromVersion;
  }

  listUpdates({ subsystem, filter } = {}) {
    return this.entries.filter((e) => this._matchSubsystem(e, subsystem) && this._matchFilter(e, filter));
  }

  listUpdatesFrom({ fromVersion, subsystem, filter } = {}) {
    return this.listUpdates({ subsystem, filter }).filter((e) => this._applicable(e, fromVersion));
  }

  /**
   * The optimal update: the highest toVersion, choosing at RANDOM among entries that share
   * that version — source getUpdateFrom (update.ctrl.ts:105-112) filters to
   * `toVersion === updates[0].toVersion` and indexes with `Math.random()`. null when none.
   */
  getUpdateFrom(params = {}) {
    const candidates = this.listUpdatesFrom(params);
    if (!candidates.length) return null;
    const top = candidates.slice().sort((a, b) => cmpVersion(b.toVersion, a.toVersion));
    const best = top[0].toVersion;
    const tied = candidates.filter((e) => e.toVersion === best);
    return tied[Math.floor(Math.random() * tied.length)];
  }

  findById(id) {
    return this.entries.find((e) => e.id === id) || null;
  }

  /** Source UpdateController.listUniqueFilters — `Update.distinct("filter")`. */
  listUniqueFilters() {
    return [...new Set(this.entries.map((e) => e.filter || DEFAULT_FILTER))];
  }

  // --- admin publication ---------------------------------------------------
  // Source TargetedController (targeted.ctrl.ts): the target map is keyed by serial and a
  // robot's server-side target overrides whatever filter it asks with.

  async loadTargets() {
    if (!this._targetsFile) return;
    try {
      const raw = JSON.parse(await readFile(this._targetsFile, 'utf8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [serial, target] of Object.entries(raw)) this.targets.set(serial, target);
      }
    } catch {
      /* no target map yet — first SetTarget creates it */
    }
  }

  async _saveTargets() {
    if (!this._targetsFile) return;
    await mkdir(path.dirname(this._targetsFile), { recursive: true });
    const obj = {};
    for (const [serial, target] of this.targets) obj[serial] = target;
    await writeFile(this._targetsFile, `${JSON.stringify(obj, null, 2)}\n`);
  }

  /**
   * Source TargetedController.setTarget: replace an existing serial's target, create the
   * mapping when it is new, and REMOVE the mapping when the target is empty (ClearOTATarget).
   */
  async setTarget(serial, target) {
    if (target) this.targets.set(serial, target);
    else this.targets.delete(serial);
    await this._saveTargets();
  }

  /** Source TargetedController.listTargets — `[{serial, target}]`. */
  listTargets() {
    return [...this.targets].map(([serial, target]) => ({ serial, target }));
  }

  /** Source TargetedController.getFilter: friendlyId -> serial -> target (null when unmapped). */
  async getFilter(friendlyId) {
    if (!friendlyId) return undefined;
    const serial = this.serialOf ? await this.serialOf(friendlyId) : friendlyId;
    if (!serial) return undefined;
    const target = this.targets.get(serial);
    return target === undefined ? null : target;
  }

  /**
   * Source getCondition (update.ctrl.ts:29-43): a robot's server-side target WINS over the
   * filter it asked with; when neither is set the effective filter is the empty string.
   */
  async effectiveFilter(filter, friendlyId) {
    const targeted = await this.getFilter(friendlyId);
    return targeted ? targeted : filter;
  }

  // --- publication (create / remove) ---------------------------------------

  /**
   * Source UpdateController.create (update.ctrl.ts:57-87): reject a duplicate
   * (fromVersion, toVersion, subsystem, filter-condition), stamp created/accountId, digest
   * the uploaded bytes for shaHash + length, and keep the bytes. Returns the stored entry.
   */
  async createUpdate({ accountId = null, fromVersion, toVersion, changes, data, dependencies = {}, subsystem, filter } = {}) {
    const sub = subsystem || DEFAULT_SUBSYSTEM;
    const flt = filter || DEFAULT_FILTER;
    const existing = this.entries.find((e) => e.fromVersion === fromVersion
      && e.toVersion === toVersion
      && e.subsystem === sub
      && filterMatches(e.filter, flt));
    if (existing) throw new UpdateError(UPDATE_ALREADY_EXISTS);

    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data ?? '');
    const id = randomBytes(12).toString('hex'); // ObjectId-shaped, like mongoose's _id
    const file = path.join(this.dataDir, `${id}.tar`);
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(file, buf);
    const entry = {
      id,
      subsystem: sub,
      fromVersion,
      toVersion,
      changes: changes ?? '',
      filter: flt,
      dependencies: dependencies || {},
      created: Date.now(),
      accountId,
      _file: file,
      length: buf.length,
      sha1: createHash('sha1').update(buf).digest('hex'),
    };
    this.entries.push(entry);
    this.log.info?.('ota: update created', { id, subsystem: sub, fromVersion, toVersion, filter: flt, length: entry.length, accountId });
    return entry;
  }

  /** Source UpdateController.remove — drop the record (and, like the S3 delete, the bytes). */
  async removeUpdate(id) {
    const entry = this.findById(id);
    if (!entry) return null;
    this.entries = this.entries.filter((e) => e !== entry);
    try {
      await unlink(entry._file);
    } catch {
      /* bytes already gone — the record removal is what the source's findByIdAndRemove returns */
    }
    this.log.info?.('ota: update removed', { id });
    return entry;
  }

  /** Render an internal entry as the wire `Update` shape the robot expects. */
  toUpdate(e, { baseUrl, fromVersion } = {}) {
    return {
      _id: e.id,
      created: e.created,
      accountId: e.accountId,
      fromVersion: e.fromVersion === '*' ? (fromVersion ?? e.fromVersion) : e.fromVersion,
      toVersion: e.toVersion,
      changes: e.changes,
      url: `${baseUrl}/ota/package?id=${encodeURIComponent(e.id)}`,
      shaHash: e.sha1,
      length: e.length,
      subsystem: e.subsystem,
      ...(e.filter ? { filter: e.filter } : {}),
      dependencies: e.dependencies,
    };
  }
}
