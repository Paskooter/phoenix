// In-memory history store — Phoenix port of the skill-launch + speech collections
// (history/skilllaunch/db/SkillLaunchCollection.ts, speech/db/*). The reference uses a sharded
// Mongo; the datastore is an implementation detail behind the same black-box HTTP contract, so
// an in-memory store is a faithful default (swap for a real DB without changing the wire).
//
// Contracts preserved: payloadSize = key count on write; getLatest sorts by timestamp desc then
// insertion order desc; no match returns null (not 404); 14-day retention on skill launches;
// partial speech updates do not erase existing fields.

import { newMsgId, now } from '@phoenix/contracts';
import { buildPredicate } from './query.js';

const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

export class HistoryStore {
  constructor() {
    this.skillLaunches = []; // insertion order preserved
    this.speech = new Map(); // id -> record
    this._seq = 0;
  }

  // --- skill launch ---------------------------------------------------------

  addSkillLaunch(data) {
    this._pruneExpired();
    const rec = {
      ...data,
      id: newMsgId(),
      timestamp: data.timestamp ?? now(),
      payload: data.payload,
      payloadSize: data.payload ? Object.keys(data.payload).length : 0,
      type: 'SKILL_LAUNCH',
      _seq: this._seq++,
    };
    this.skillLaunches.push(rec);
    return this._toJSON(rec);
  }

  saveSkillPayload(data) {
    // findOneAndUpdate({sessionID, robotID, skillID}) — most recent wins.
    const rec = [...this.skillLaunches]
      .reverse()
      .find((r) => r.sessionID === data.sessionID && r.robotID === data.robotID && r.skillID === data.skillID);
    if (!rec) return null;
    rec.payload = data.payload;
    rec.payloadSize = Object.keys(data.payload || {}).length;
    return this._toJSON(rec);
  }

  getLatest(query) {
    this._pruneExpired();
    const pred = buildPredicate(query);
    const matches = this.skillLaunches.filter(pred);
    if (!matches.length) return null;
    // sort: timestamp desc, then insertion order desc (tie-break)
    matches.sort((a, b) => b.timestamp - a.timestamp || b._seq - a._seq);
    return this._toJSON(matches[0]);
  }

  getCount(query) {
    this._pruneExpired();
    return this.skillLaunches.filter(buildPredicate(query)).length;
  }

  // --- speech (write-only; non-erasing partial updates) ---------------------

  addSpeech(data) {
    const rec = { ...data, id: newMsgId(), timestamp: data.timestamp ?? now() };
    this.speech.set(rec.id, rec);
    return rec.id;
  }

  updateSpeech(id, patch) {
    const rec = this.speech.get(id);
    if (!rec) return null;
    Object.assign(rec, patch); // partial update; existing fields preserved
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
    const { _seq, type, ...rest } = rec; // not necessary for client (documentToJSON)
    return JSON.parse(JSON.stringify(rest));
  }
}
