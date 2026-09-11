// In-memory history store — Phoenix port of the skill-launch + speech collections
// (history/skilllaunch/db/SkillLaunchCollection.ts, speech/db/SpeechHistoryRecordsCollection.ts).
// The reference uses a sharded Mongo; the datastore is an implementation detail behind the same
// black-box HTTP contract, so a store behind the same wire is a faithful default (swap for a real
// DB without changing the wire).
//
// Pegasus contracts preserved here:
// - POST /skill/launch returns the full saved record with NO computed payloadSize (payloadSize is
//   only attached by PUT /skill/launch/payload, which sets it to the key count).
// - personIDs are sorted in place before save (Preformatter.preformatSkillLaunchData) so EXACT
//   array comparisons are order-independent.
// - getLatest sorts by timestamp desc then insertion order desc; no match returns null, never 404.
// - PUT /skill/launch/payload attaches payload/payloadSize to the most recent record matching
//   {sessionID, robotID, skillID} and returns the updated record, or null when none matched.
// - Speech updates apply ONLY the eight updatable fields (audioFileURL, asr, personIDs, nlu,
//   match, redirect, skill, error); null/undefined values are dropped and existing fields are
//   never erased. Updating an unknown id throws (the reference null-derefs `record._id`), which
//   surfaces as the standard 500 error envelope.
// - 14-day retention on skill launches.
//
// I-03 — RETENTION AND DURABILITY (AUDIT F08, probe P12):
// - The reference retention rule is Mongo's TTL index: SkillLaunchSchema.ts sets
//   `expires: config.skillLaunch.eventExpirationSeconds` on the `timestamp` path, and
//   HistoryServiceConfigProvider.ts sets `eventExpirationSeconds: 14 * 86400`. Mongo's TTL monitor
//   deletes EVERY document whose `timestamp` passes 14 days — selection is by timestamp value, in
//   any position, never by insertion order — and the rows live in a database, so they outlive the
//   server process. There is no row cap on skill launches, and the speech collection has no
//   `expires` at all (SpeechHistoryRecordSchema.ts), i.e. speech records are retained indefinitely.
// - The previous local port only pruned when the OLDEST row was already expired, so an
//   out-of-order insert carrying a stale timestamp survived forever. `_pruneExpired` now filters
//   every expired row wherever it sits; the eventual Mongo sweep is applied eagerly on access.
// - Passing a `file` makes the store durable: the snapshot is loaded on construction and rewritten
//   atomically (tmp + rename) after every mutation, so a record written over the wire survives a
//   SIGKILL restart with no graceful shutdown. The history service entrypoint passes
//   `ETCO_history_dataFile`; a bare `new HistoryStore()` stays process-local so unit tests never
//   share state.

import { existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { newMsgId, now } from '@phoenix/contracts';
import { buildPredicate } from './query.js';

/** Mongoose `expires: config.skillLaunch.eventExpirationSeconds` = 14 * 86400 s (HistoryServiceConfigProvider.ts). */
export const SKILL_LAUNCH_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

// Fields a saved launch record may expose on the wire, mirroring the reference mongoose schema
// (type/_id/__v are dropped server-side). Unknown request fields are dropped the way mongoose
// strict mode drops them.
const RECORD_FIELDS = ['id', 'timestamp', 'sessionID', 'robotID', 'skillID', 'intent', 'personIDs', 'payload', 'payloadSize'];

// The reference SpeechHistoryRecordsCollection.updateRecord whitelists exactly these fields and
// removes null/undefined values before $set.
const SPEECH_UPDATE_FIELDS = ['audioFileURL', 'asr', 'personIDs', 'nlu', 'match', 'redirect', 'skill', 'error'];

export class HistoryStore {
  /**
   * @param {string|null} [file] durable JSON snapshot path. `null` (the default) keeps the store
   *   process-local, which is what the unit tests and the in-process probes construct. The history
   *   service entrypoint passes `ETCO_history_dataFile` so the running service survives a restart.
   */
  constructor(file = null) {
    this.file = file;
    this.skillLaunches = []; // insertion order preserved
    this.speech = new Map(); // id -> record
    this._seq = 0;
    if (this.file) this._load();
  }

  // --- skill launch ---------------------------------------------------------

  addSkillLaunch(data) {
    this._pruneExpired();
    // Reference: Preformatter.preformatSkillLaunchData sorts personIDs before persisting.
    if (Array.isArray(data.personIDs)) data.personIDs.sort();
    const rec = {
      ...data,
      id: newMsgId(),
      timestamp: data.timestamp || now(),
      type: 'SKILL_LAUNCH',
      _seq: this._seq++,
    };
    this.skillLaunches.push(rec);
    this._flush();
    return this._toJSON(rec);
  }

  saveSkillPayload(data) {
    // findOneAndUpdate({sessionID, robotID, skillID}, {$set: {payload, payloadSize}}); most recent wins.
    //
    // The reference builds the `$set` document EAGERLY as the second argument to
    // findOneAndUpdate (SkillLaunchCollection.ts:48-53), so `Object.keys(data.payload)` throws
    // BEFORE the query is issued - even when no record matches. A missing or null `payload`
    // therefore always yields the 500 error envelope, never the 200 `null` no-match result.
    // Verified against the pinned compiled collection with the model call counted
    // (docs/parity/evidence/2026-09-10/i01-history-routes/w7-ref-routes-oracle.json).
    const payloadSize = Object.keys(data.payload).length;
    const rec = [...this.skillLaunches]
      .reverse()
      .find((r) => r.sessionID === data.sessionID && r.robotID === data.robotID && r.skillID === data.skillID);
    if (!rec) return null;
    rec.payload = data.payload;
    rec.payloadSize = payloadSize;
    this._flush();
    return this._toJSON(rec);
  }

  getLatest(query) {
    this._pruneExpired();
    const pred = buildPredicate(query);
    const matches = this.skillLaunches.filter(pred);
    if (!matches.length) return null;
    // sort: timestamp desc, then insertion order desc (tie-break; reference sorts {timestamp:-1,_id:-1})
    matches.sort((a, b) => b.timestamp - a.timestamp || b._seq - a._seq);
    return this._toJSON(matches[0]);
  }

  getCount(query) {
    this._pruneExpired();
    return this.skillLaunches.filter(buildPredicate(query)).length;
  }

  // --- speech (write-only; non-erasing partial updates) ---------------------

  addSpeech(data) {
    const rec = { ...data, id: newMsgId(), timestamp: data.timestamp || now() };
    this.speech.set(rec.id, rec);
    this._flush();
    return rec.id;
  }

  updateSpeech(id, patch) {
    const rec = this.speech.get(id);
    if (!rec) throw new Error("Cannot read properties of null (reading '_id')");
    const update = {};
    for (const key of SPEECH_UPDATE_FIELDS) {
      const value = patch[key];
      if (value !== null && value !== undefined) update[key] = value;
    }
    Object.assign(rec, update); // partial update; unlisted/existing fields preserved
    this._flush();
    return id;
  }

  // --- durability -----------------------------------------------------------

  _load() {
    if (!existsSync(this.file)) return;
    let raw;
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch (error) {
      throw new Error(`history store unreadable (${this.file}): ${error.message}`);
    }
    for (const rec of raw.skillLaunches || []) {
      if (rec && typeof rec.id === 'string') this.skillLaunches.push(rec);
    }
    // Resume the insertion counter so post-restart timestamp ties keep breaking by _seq.
    this._seq = this.skillLaunches.reduce((max, rec) => Math.max(max, Number.isFinite(rec._seq) ? rec._seq + 1 : 0), 0);
    for (const rec of raw.speech || []) {
      if (rec && typeof rec.id === 'string') this.speech.set(rec.id, rec);
    }
  }

  /** Replace the snapshot atomically (private tmp file + rename), like the other Phoenix stores. */
  _flush() {
    if (!this.file) return;
    const serialized = JSON.stringify({ skillLaunches: this.skillLaunches, speech: [...this.speech.values()] }, null, 2);
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

  // --- internals ------------------------------------------------------------

  // Mongo TTL semantics: every document whose `timestamp` passes `expires` is eventually removed,
  // regardless of where it sits in the collection. The old port inspected only `skillLaunches[0]`
  // (the oldest insert), so an out-of-order record with a stale timestamp was never pruned.
  _pruneExpired() {
    if (!this.skillLaunches.length) return;
    const cutoff = now() - SKILL_LAUNCH_RETENTION_MS;
    const kept = this.skillLaunches.filter((rec) => rec.timestamp >= cutoff);
    if (kept.length === this.skillLaunches.length) return;
    this.skillLaunches = kept;
    this._flush(); // persist the eviction so a restart cannot resurrect it
  }

  _toJSON(rec) {
    if (!rec) return null;
    const out = {};
    for (const key of RECORD_FIELDS) {
      if (rec[key] !== undefined) out[key] = rec[key];
    }
    return JSON.parse(JSON.stringify(out)); // same deep-copy/undefined-drop as documentToJSON
  }
}
