// History service client — port of @jibo/history-client (the bits the hub uses).
// Fire-and-forget skill-launch writes + IHQuery reads (count / latest) for the proactive engine.

import { writeTrace } from '@phoenix/common';

export class HistoryClient {
  constructor(historyURL) { this.base = (historyURL || '').replace(/\/$/, ''); }

  async _post(path, body, trace) {
    const res = await fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...writeTrace(trace) },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`history ${path} ${res.status}`);
    return res.json();
  }

  /** Fire-and-forget; never throws into the caller. */
  writeSkillLaunch(data, trace) {
    return this._post('/skill/launch', data, trace).catch(() => null);
  }

  async getSkillLaunchCount(query, trace) {
    const r = await this._post('/skill/launch/count', query, trace);
    return r.count;
  }

  getLatestSkillLaunch(query, trace) {
    return this._post('/skill/launch/latest', query, trace); // record or null
  }
}
