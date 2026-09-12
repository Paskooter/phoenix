// History service client — port of @jibo/history-client (the bits the hub uses).
//   skill-launch: fire-and-forget writes + IHQuery reads (count / latest) for the proactive engine.
//   speech:       SpeechHistoryClient.save / createRecord / updateRecord (the speech log sink).
//
// Reference: pegasus 5c0a7390539663ba749d360de348a428c088505c
//   packages/history-client/src/base/BaseHistoryServiceClient.ts   (URL join / verbs)
//   packages/history-client/src/skill-launch/SkillLaunchHistoryClient.ts
//   packages/history-client/src/speech/SpeechHistoryClient.ts
//   packages/history-client/src/speech/SpeechHistoryRecord.ts

import { writeTrace } from '@phoenix/common';
import { boundedSignal, DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS, signalFromOptions } from './requestSignal.js';

export class HistoryClient {
  constructor(historyURL, options = {}) {
    this.base = (historyURL || '').replace(/\/$/, '');
    this.timeoutMs = typeof options === 'number'
      ? options
      : (options.timeoutMs ?? DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS);
  }

  async _post(path, body, trace, options) {
    const res = await fetch(`${this.base}${path}`, {
      method: 'POST',
      signal: boundedSignal(this.timeoutMs, signalFromOptions(options)),
      headers: { 'content-type': 'application/json', ...writeTrace(trace) },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`history ${path} ${res.status}`);
    return res.json();
  }

  async _put(path, body, trace, options) {
    const res = await fetch(`${this.base}${path}`, {
      method: 'PUT',
      signal: boundedSignal(this.timeoutMs, signalFromOptions(options)),
      headers: { 'content-type': 'application/json', ...writeTrace(trace) },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`history ${path} ${res.status}`);
    return res.json();
  }

  /** Fire-and-forget; never throws into the caller. */
  writeSkillLaunch(data, trace, options) {
    return this._post('/v1/skill/launch', data, trace, options).catch(() => null);
  }

  async getSkillLaunchCount(query, trace, options) {
    const r = await this._post('/v1/skill/launch/count', query, trace, options);
    return r.count;
  }

  getLatestSkillLaunch(query, trace, options) {
    return this._post('/v1/skill/launch/latest', query, trace, options); // record or null
  }

  /** POST /v1/speech — persist a new speech record, returns its id (SpeechHistoryClient.createRecord). */
  createSpeechRecord(data, trace, options) {
    return this._post('/v1/speech', data, trace, options).then((r) => r.id);
  }

  /** PUT /v1/speech/:id — partial update, returns the id (SpeechHistoryClient.updateRecord). */
  updateSpeechRecord(id, data, trace, options) {
    return this._put(`/v1/speech/${id}`, data, trace, options).then((r) => r.id);
  }

  /**
   * SpeechHistoryClient.save: create when the record has no id, update otherwise, and set
   * `record.id` from a create. The two failure envelopes are reproduced verbatim
   * (SpeechHistoryClient.ts:18-38): the message is prefixed and `stack` is cleared, then the
   * error is re-thrown for the caller's own (fire-and-forget) catch.
   */
  saveSpeechRecord(record, trace, options) {
    if (record.id) {
      return this.updateSpeechRecord(record.id, record.data, trace, options).catch((err) => {
        err.message = `Failed to update speech history record: ${err.message}`;
        err.stack = null;
        throw err;
      }).then(() => record);
    }
    return this.createSpeechRecord(record.data, trace, options).catch((err) => {
      err.message = `Failed to save speech history record: ${err.message}`;
      err.stack = null;
      throw err;
    }).then((id) => { record.id = id; return record; });
  }
}

/**
 * SpeechHistoryRecord builder (history-client/src/speech/SpeechHistoryRecord.ts). The hub only
 * uses `update()`; the reference's setASR/setNLU/setMatch/setRedirect/setSkillOutput/setError
 * helpers are thin `this.data.x = value` wrappers that the listen handler never calls.
 */
export class SpeechHistoryRecord {
  constructor(data) {
    this.id = undefined;
    this.data = Object.assign({}, data);
  }

  update(data) { Object.assign(this.data, data); }
}
