// SkillConversation — port of test-utils/src/skill-test/SkillConversation.ts: a chaining HTTP
// client for skill behavior tests. Drives a real skills service over the wire (POST
// /v1/<id>/main with trace headers), tracking the session between launch() and actionResult()
// like the robot/hub do. Frozen-world context via mockRuntimeData (the Jetsons loop).

import { mockRuntimeData } from './mockRuntimeData.js';

const MOCK_GENERAL_DATA = { accountID: 'some-account-id', robotID: 'some-robot-id', lang: 'en', release: '8.67.5309' };

const deepMerge = (a, b) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = (v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object') ? deepMerge(a[k], v) : v;
  }
  return out;
};

export class SkillConversation {
  /**
   * @param {{listen:(port:number)=>Promise<object>}|string} serviceOrUrl a skills service module
   *   ({start}/{listen}) to boot on an ephemeral port, or a base URL of a running one.
   * @param {string} skillId the skill to converse with (path /v1/<skillId>/main)
   */
  constructor(serviceOrUrl, skillId) {
    this.serviceOrUrl = serviceOrUrl;
    this.skillId = skillId;
    this.response = null;
    this.errorMessage = null;
    this.session = undefined;
    this.speakerId = true;
    this.injectReferent = false;
    this.iso = '2017-12-11T16:05:52.585-05:00';
    this.server = null;
    this.baseUrl = null;
  }

  /** Boot the service (ephemeral port) or adopt the given URL. Call before sending requests. */
  async init() {
    if (typeof this.serviceOrUrl === 'string') {
      this.baseUrl = this.serviceOrUrl.replace(/\/$/, '');
      return this;
    }
    this.server = await this.serviceOrUrl.start(0);
    const addr = this.server.address();
    this.baseUrl = `http://localhost:${addr.port}`;
    return this;
  }

  async close() {
    if (this.server) await new Promise((r) => this.server.close(r));
  }

  /** @param {boolean|{id,accountId}} speakerId */
  withSpeakerId(speakerId) { this.speakerId = speakerId; return this; }
  withReferent(injectReferent) { this.injectReferent = injectReferent; return this; }
  atISOTime(iso) { this.iso = iso; return this; }

  /**
   * LISTEN_LAUNCH. nluData: intent string or partial NLUResult; data merges over {nlu, asr}.
   */
  async launch(nluData, skill = { id: this.skillId }, data = {}) {
    const nlu = (typeof nluData === 'string')
      ? { rules: [], intent: nluData, entities: {} }
      : { rules: nluData.rules || [], intent: nluData.intent || '', entities: nluData.entities || {} };
    const result = deepMerge({ nlu, asr: { text: '', confidence: 1 } }, data);
    await this._post({
      type: 'LISTEN_LAUNCH', msgID: cryptoRandom(), ts: Date.now(),
      data: { general: MOCK_GENERAL_DATA, runtime: mockRuntimeData(this.speakerId, this.injectReferent, this.iso), skill, result },
    });
    return this;
  }

  /** LISTEN_UPDATE with the tracked session (or an explicit one on skillData.session). */
  async actionResult(skillData = { id: this.skillId }, data = {}) {
    const result = deepMerge({ nlu: { rules: [], intent: null, entities: {} }, asr: { text: '', confidence: 1 } }, data);
    const skill = (typeof skillData.session === 'undefined') ? { ...skillData, session: this.session } : { ...skillData };
    await this._post({
      type: 'LISTEN_UPDATE', msgID: cryptoRandom(), ts: Date.now(),
      data: { general: MOCK_GENERAL_DATA, runtime: mockRuntimeData(this.speakerId, this.injectReferent, this.iso), skill, result },
    });
    return this;
  }

  /** PROACTIVE_LAUNCH with a memo. */
  async proactiveLaunch(memo, skill = { id: this.skillId }) {
    await this._post({
      type: 'PROACTIVE_LAUNCH', msgID: cryptoRandom(), ts: Date.now(),
      data: { general: MOCK_GENERAL_DATA, runtime: mockRuntimeData(this.speakerId, this.injectReferent, this.iso), skill, result: { nlu: null, memo } },
    });
    return this;
  }

  async _post(body) {
    const res = await fetch(`${this.baseUrl}/v1/${this.skillId}/main`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-jibo-transid': 'tid:1234' },
      body: JSON.stringify(body),
    });
    this.response = await res.json();
    const skillOut = this.response.data && this.response.data.skill;
    if (skillOut && skillOut.session) this.session = skillOut.session;
    this.errorMessage = (this.response.type === 'ERROR') ? (this.response.data && this.response.data.message) : null;
  }
}

function cryptoRandom() { return `m-${Math.random().toString(36).slice(2)}`; }
