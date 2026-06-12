// The update catalog: the set of OTA packages this server can offer, indexed for the three
// Update operations the robot uses (ListUpdates / ListUpdatesFrom / GetUpdateFrom).
//
// An entry only becomes "available" once its package file exists on disk — at load time we
// stream the file to compute its real length + SHA-1 (the robot's jibo-download-update verifies
// both, so they MUST be exact). Entries whose file is missing are skipped with a warning, so the
// server is safe to run before `scripts/build-ota-packages.sh` has produced anything.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

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

export class Catalog {
  /** @param {{ dataDir: string, log?: any }} opts */
  constructor({ dataDir, log = console } = {}) {
    this.dataDir = dataDir;
    this.log = log;
    /** @type {Array<object>} available (file-backed) entries */
    this.entries = [];
  }

  /** Build a catalog, resolving + hashing each entry's package file. */
  static async load({ entries = [], dataDir, log = console } = {}) {
    const cat = new Catalog({ dataDir, log });
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
  // subsystem: exact (a missing request subsystem matches anything).
  // filter:    the request filter is a PREFIX of the entry's filter ("gr" matches "green");
  //            an entry with an empty filter is a wildcard that matches any request filter.
  // applicable(fromVersion): entry.fromVersion must equal the requested version, unless the
  //            entry uses "*" (matches any). Never offer an update whose toVersion the robot
  //            already runs — that's the loop-guard for "*" entries.

  _matchSubsystem(e, subsystem) {
    return !subsystem || e.subsystem === subsystem;
  }

  _matchFilter(e, filter) {
    if (!filter) return true;
    if (!e.filter) return true;
    return e.filter.startsWith(filter);
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

  /** The single optimal (highest toVersion) applicable update, or null. */
  getUpdateFrom(params = {}) {
    const candidates = this.listUpdatesFrom(params);
    if (!candidates.length) return null;
    return candidates.slice().sort((a, b) => cmpVersion(b.toVersion, a.toVersion))[0];
  }

  findById(id) {
    return this.entries.find((e) => e.id === id) || null;
  }

  /** Render an internal entry as the wire `Update` shape the robot expects. */
  toUpdate(e, { baseUrl, fromVersion, filter } = {}) {
    const out = {
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
      dependencies: e.dependencies,
    };
    // Present the update on the filter the robot asked for: a wildcard ("") entry echoes the
    // requested filter, so a robot on e.g. "fcs" sees an "fcs"-tagged update and won't skip it.
    const outFilter = e.filter || filter;
    if (outFilter) out.filter = outFilter;
    return out;
  }
}
