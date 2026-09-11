// Proactive transaction — port of hub/proactive/ProactiveTransactionHandler.ts.
// One WS == one proactive transaction: TRIGGER + CONTEXT -> collect manifest `proactives` ->
// filter (contextRules, IHRules, settingsRules) -> random pick -> PROACTIVE match
// (final for on-robot) or PROACTIVE_LAUNCH to a cloud skill -> forward its SKILL_ACTION.

import { newMsgId, now, RequestType, ResponseType, HubErrorCode, Timeouts } from '@phoenix/contracts';
import { readTrace } from '@phoenix/common';
import { preprocessContext, validateContextMessage } from '../preprocessor.js';
import { HubError } from '../listenTransaction.js';
import { checkContextRules, extractContextData, getAccountId } from './contextRules.js';
import { checkIHRules } from './ihRules.js';
import { checkSettingsRegistrations, getSkillSettingsMap } from './settingsRules.js';
import { validateIHQuery } from '../skillConfigValidation.js';

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
    this.timings = {};
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
    // RandomUtils.sample (lodash.sample) — a uniform pick, same index math as
    // `array[Math.floor(Math.random() * array.length)]`.
    const chosen = eligible.length ? eligible[Math.floor(Math.random() * eligible.length)] : null;
    const skipSurprises = req.data.triggerSource === 'SURPRISE';

    if (!chosen) { this._emitNoAction(); return; }

    if (this.components.skillConfigManager.isOnRobotSkill(chosen.skillID)) {
      this._emitMatch(chosen.skillID, true, skipSurprises);
      this._record(chosen.skillID, context);
      return;
    }
    this._emitMatch(chosen.skillID, false, skipSurprises);
    const skillStart = now();
    const out = await withTimeout(
      this.components.skillClient.proactiveLaunch(chosen.skillID, { context: context.data, memo: chosen.memo }, this.trace),
      Timeouts.skill,
    );
    if (out === TIMEOUT) throw new HubError(HubErrorCode.TIMEOUT_SKILL, `Timeout while waiting for proactive skill ${chosen.skillID}`);
    // TransactionHandler.emitSkillResult reports the skill round-trip as `timings.skill`.
    this.timings.skill = now() - skillStart;
    // ProactiveTransactionHandler.getSkillResponse records BEFORE the result frame is written.
    if (out && !out.error) this._record(chosen.skillID, context, out.response);
    this._emitSkillResult(out);
  }

  async _getEligible(context, reqData) {
    const configs = (this.components.skills || []).filter((c) => c.proactives && c.proactives.length);
    const robotID = context.data.general && context.data.general.robotID;
    const focusedPerson = extractContextData('FOCUSED_PERSON', context, reqData);
    const runtime = context.data.runtime || {};
    // ProactiveTransactionHandler.getTransactionData: the speaker's account is the loop
    // member whose id is the focused person; an unknown person (or one not in the loop)
    // has no account and therefore no settings to fetch. wakeUpTime is always null in the
    // source (ProactiveTransactionHandler.ts:116), so a SinceWaking IH offset always throws.
    const focusedPersonAccountID = focusedPerson && getAccountId(runtime, focusedPerson);
    const data = { robotID, loopID: runtime.loop && runtime.loop.loopId, focusedPerson, wakeUpTime: null };
    // To save calls to the settings service, consolidate them all into one request before
    // processing each skill config (source getEligibleActions step 3). A focus person with
    // no account, a missing loop id, or a settings-service error leaves the map empty, so
    // every settingsRules-bearing PR fails closed — the reference's documented outcome
    // ("Continuing with selection, but settingsRules will fail").
    let skillSettingsMap = new Map();
    if (focusedPersonAccountID) {
      try {
        skillSettingsMap = await getSkillSettingsMap(
          configs, focusedPersonAccountID, data.loopID,
          this.trace.transId, this.components.settingsClient, this.log,
        );
      } catch (e) {
        this.log?.error?.('Error fetching settings. Continuing with selection, but settingsRules will fail.', { error: e.message });
      }
    }
    const results = [];
    for (const c of configs) {
      let prs = c.proactives.map((pr) => ({ ...pr, skillID: c.id }));
      // ContextTools.checkContextRules throws for a malformed contain/containedIn rule and the
      // source does NOT catch it here (ProactiveTransactionHandler.ts:212-214), so the whole
      // transaction fails rather than silently dropping the registration.
      prs = prs.filter((pr) => checkContextRules(pr, context, reqData));
      prs = await checkIHRules(prs, c.IHQueries || {}, data, this.components.historyClient, validateIHQuery);
      prs = checkSettingsRegistrations(prs, skillSettingsMap);
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
    this.response.write(Object.assign({}, out.response, { final: true, timings: { total: now() - this.startTime, skill: this.timings.skill } }));
  }

  _record(skillID, context, skillResponse) {
    if (!this.components.config.recordLaunchHistory || !this.components.historyClient) return;
    const general = context.data.general || {};
    const runtime = context.data.runtime || {};
    const sessionID = (skillResponse && skillResponse.data && skillResponse.data.skill && skillResponse.data.skill.session && skillResponse.data.skill.session.id) || newMsgId();
    // TransactionHelper.getPersonIDs (utils/TransactionHelper.ts:9-14): the record's identity is
    // the speaker only, with the 'UNKNOWN' sentinel when no speaker was identified — the same
    // rule ListenTransaction.recordSkillLaunch follows. peoplePresent is NOT folded in.
    const speaker = runtime.perception && runtime.perception.speaker;
    this.components.historyClient.writeSkillLaunch({
      robotID: general.robotID, sessionID, skillID, intent: 'proactive',
      personIDs: speaker ? [speaker] : ['UNKNOWN'],
    }, this.trace);
  }

  resolve() { clearTimeout(this._txTimer); this._handle.resolve(); }
  reject(err) { clearTimeout(this._txTimer); this._handle.reject(err); }
}
