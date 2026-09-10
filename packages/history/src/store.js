// In-memory history store — Phoenix port of the skill-launch + speech collections
// (history/skilllaunch/db/SkillLaunchCollection.ts, speech/db/SpeechHistoryRecordsCollection.ts).
// The reference uses a sharded Mongo; the datastore is an implementation detail behind the same
// black-box HTTP contract, so an in-memory store is a faithful default (swap for a real DB
// without changing the wire).
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

import { newMsgId, now } from '@phoenix/contracts';
import { buildPredicate } from './query.js';

const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

// Fields a saved launch record may expose on the wire, mirroring the reference mongoose schema
// (type/_id/__v are dropped server-side). Unknown request fields are dropped the way mongoose
// strict mode drops them.
const RECORD_FIELDS = ['id', 'timestamp', 'sessionID', 'robotID', 'skillID', 'intent', 'personIDs', 'payload', 'payloadSize'];

// The reference SpeechHistoryRecordsCollection.updateRecord whitelists exactly these fields and
// removes null/undefined values before $set.
const SPEECH_UPDATE_FIELDS = ['audioFileURL', 'asr', 'personIDs', 'nlu', 'match', 'redirect', 'skill', 'error'];

export class HistoryStore {
  constructor() {
    this.skillLaunches = []; // insertion order preserved
    this.speech = new Map(); // id -> record
    this._seq = 0;
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
    return id;
  }

  // --- internals ------------------------------------------------------------

  _pruneExpired() {
    const cutoff = now() - RETENTION_MS;
    if (this.skillLaunches.length && this.skillLaunches[0].timestamp < cutoff) {
      this.skillLaunches = this.skillLaunches.filter((r) => r.timestamp >= cutoff);
    }
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