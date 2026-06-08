// Proactive transaction — port of hub/proactive/ProactiveTransactionHandler.ts.
// One WS == one proactive transaction: TRIGGER + CONTEXT -> collect manifest `proactives` ->
// filter (contextRules, IHRules, settingsRules[permissive]) -> random pick -> PROACTIVE match
// (final for on-robot) or PROACTIVE_LAUNCH to a cloud skill -> forward its SKILL_ACTION.

import { newMsgId, now, RequestType, ResponseType, HubErrorCode, Timeouts } from '@phoenix/contracts';
import { readTrace } from '@phoenix/common';
import { preprocessContext, validateContextMessage } from '../preprocessor.js';
import { HubError } from '../listenTransaction.js';
import { checkContextRules, extractContextData, getPersonIDs } from './contextRules.js';
import { checkIHRules } from './ihRules.js';

const CONTEXT_TIMEOUT = 30_000;

function defer() { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; }
const TIMEOUT = Symbol('timeout');
function withTimeout(p, ms) { let t; const timer = new Promise((r) => { t = setTimeout(() => r(TIMEOUT), ms); t.unref?.(); }); return Promise.race([p.then((v) => { clearTimeout(t); return v; }), timer]); }

export class ProactiveTransaction {
  constructor(socket, components, response, log) {
    this.socket = socket;
    this.components = components;
    this.response = response;
    this.log = log;
    this.trace = readTrace({ headers: socket._jiboHeaders || {} });
    this.auth = socket._auth || null;
    this.startTime = now();
    this.contextPr = defer();
    this._handle = defer();
    this._txTimer = setTimeout(() => this.reject(new HubError(HubErrorCode.INTERNAL, `Maximum transaction time of ${Timeouts.transaction} exceeded`)), Timeouts.transaction);
    this._txTimer.unref?.();
  }

  get done() { return this._handle.promise; }

  handleMessage({ json }) {
    if (!json) return;
    if (json.type === RequestType.CONTEXT) {
      try { preprocessContext(json, this.auth, this.socket._remoteAddress); this.contextPr.resolve(validateContextMessage(json)); }
      catch (e) { this.reject(e); }
      return;
    }
    if (json.type === RequestType.TRIGGER) { this._handleTrigger(json).catch((e) => this.reject(e)); }
  }

  async _handleTrigger(req) {
    const context = await withTimeout(this.contextPr.promise, CONTEXT_TIMEOUT);
    if (context === TIMEOUT) throw new HubError(HubErrorCode.TIMEOUT_CONTEXT, `Timeout of ${CONTEXT_TIMEOUT} while waiting for the context message`);
    // A trigger person becomes the speaker so skills recognize them.
    if (req.data && req.data.triggerData && req.data.triggerData.looperID) {
      context.data.runtime = context.data.runtime || {};
      context.data.runtime.perception = context.data.runtime.perception || {};
      context.data.runtime.perception.speaker = req.data.triggerData.looperID;
    }
    await this._chooseAction(req, context);
    this.resolve();
  }

  async _chooseAction(req, context) {
    const eligible = await this._getEligible(context, req.data);
    const chosen = eligible.length ? eligible[Math.floor(Math.random() * eligible.length)] : null;
    const skipSurprises = req.data.triggerSource === 'SURPRISE';

    if (!chosen) { this._emitNoAction(); return; }

    if (this.components.skillConfigManager.isOnRobotSkill(chosen.skillID)) {
      this._emitMatch(chosen.skillID, true, skipSurprises);
      this._record(chosen.skillID, context);
      return;
    }
    this._emitMatch(chosen.skillID, false, skipSurprises);
    const out = await withTimeout(
      this.components.skillClient.proactiveLaunch(chosen.skillID, { context: context.data, memo: chosen.memo }, this.trace),
      Timeouts.skill,
    );
    if (out === TIMEOUT) throw new HubError(HubErrorCode.TIMEOUT_SKILL, `Timeout while waiting for proactive skill ${chosen.skillID}`);
    this._emitSkillResult(out);
    if (out && !out.error) this._record(chosen.skillID, context, out.response);
  }

  async _getEligible(context, reqData) {
    const configs = (this.components.skills || []).filter((c) => c.proactives && c.proactives.length);
    const robotID = context.data.general && context.data.general.robotID;
    const focusedPerson = extractContextData('FOCUSED_PERSON', context, reqData);
    const results = [];
    for (const c of configs) {
      let prs = c.proactives.map((pr) => ({ ...pr, skillID: c.id }));
      prs = prs.filter((pr) => { try { return checkContextRules(pr, context, reqData); } catch { return false; } });
      prs = await checkIHRules(prs, c.IHQueries || {}, { robotID, focusedPerson }, this.components.historyClient);
      // settingsRules: the settings service is dead -> permissive (accept all).
      results.push(...prs);
    }
    return results;
  }

  _emitMatch(skillID, final, skipSurprises) {
    this.response.write({
      type: ResponseType.PROACTIVE, msgID: newMsgId(), ts: now(), final,
      data: { match: { skillID, onRobot: this.components.skillConfigManager.isOnRobotSkill(skillID), isProactive: true, launch: true, skipSurprises } },
    });
  }

  _emitNoAction() {
    this.response.write({ type: ResponseType.PROACTIVE, msgID: newMsgId(), ts: now(), final: true, data: {} });
  }

  _emitSkillResult(out) {
    if (out.error) {
      this.response.write({ type: ResponseType.ERROR, final: true, ts: now(), msgID: newMsgId(), data: { message: (out.error && out.error.message) || 'skill error' } });
      return;
    }
    this.response.write(Object.assign({}, out.response, { final: true, timings: { total: now() - this.startTime } }));
  }

  _record(skillID, context, skillResponse) {
    if (!this.components.config.recordLaunchHistory || !this.components.historyClient) return;
    const general = context.data.general || {};
    const sessionID = (skillResponse && skillResponse.data && skillResponse.data.skill && skillResponse.data.skill.session && skillResponse.data.skill.session.id) || newMsgId();
    this.components.historyClient.writeSkillLaunch({
      robotID: general.robotID, sessionID, skillID, intent: 'proactive',
      personIDs: [...getPersonIDs(context.data.runtime || {}, { triggerData: {} })],
    }, this.trace);
  }

  resolve() { clearTimeout(this._txTimer); this._handle.resolve(); }
  reject(err) { clearTimeout(this._txTimer); this._handle.reject(err); }
}
