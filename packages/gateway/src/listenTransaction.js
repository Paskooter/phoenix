// Listen transaction — port of hub/listen/ListenTransactionHandler.ts (+ TransactionHandler.ts).
//
// One WebSocket == one transaction. State machine:
//   WAIT_LISTEN -> (ASR | WAIT_CLIENT_ASR | WAIT_CLIENT_NLU) -> NLU -> ROUTE -> DONE  (STOP from any)
// Robot-facing messages emitted: SOS, EOS (data:null), LISTEN (final iff on-robot/no-match),
// SKILL_ACTION/SKILL_REDIRECT (skill response forwarded verbatim, only final+timings overwritten),
// ERROR (final). Timeouts: transaction 60s, ASR 40s, CONTEXT-wait 5s, parser 10s, skill 10s.

import { newMsgId, now, ResponseType, RequestType, HubErrorCode, Timeouts } from '@phoenix/contracts';
import { readTrace } from '@phoenix/common';
import { preprocessContext, validateContextMessage } from './preprocessor.js';
import { isRedirect } from './skillClient.js';

const State = {
  WAIT_LISTEN: 'WAIT_LISTEN',
  WAIT_CLIENT_ASR: 'WAIT_CLIENT_ASR',
  WAIT_CLIENT_NLU: 'WAIT_CLIENT_NLU',
  ASR: 'ASR',
  NLU: 'NLU',
  ROUTE: 'ROUTE',
  DONE: 'DONE',
  STOP: 'STOPPED',
};

export class HubError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function defer() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const TIMEOUT = Symbol('timeout');
function withTimeout(promise, ms) {
  let t;
  const timer = new Promise((resolve) => { t = setTimeout(() => resolve(TIMEOUT), ms); t.unref?.(); });
  return Promise.race([promise.then((v) => { clearTimeout(t); return v; }), timer]);
}

export class ListenTransaction {
  /**
   * @param {import('ws').WebSocket} socket
   * @param {object} components { parser, intentRouter, skillClient, skillConfigManager, asr, history, config }
   * @param {import('./responseWrapper.js').ResponseWrapper} response
   * @param {object} log
   */
  constructor(socket, components, response, log) {
    this.socket = socket;
    this.components = components;
    this.response = response;
    this.log = log;
    this.trace = readTrace({ headers: socket._jiboHeaders || {} });
    this.auth = socket._auth || null;

    this.state = State.WAIT_LISTEN;
    this.stateTrace = [this.state];
    this.startTime = now();
    this.timings = {};

    this.listenMessage = null;
    this.contextPr = defer();
    this.asrData = null;
    this.nluData = null;
    this.audioChunks = [];
    this.redirectCount = 0;

    this._handle = defer();
    // whole-transaction timeout (60s)
    this._txTimer = setTimeout(() => this.reject(new HubError(HubErrorCode.INTERNAL, `Maximum transaction time of ${Timeouts.transaction} exceeded`)), Timeouts.transaction);
    this._txTimer.unref?.();
  }

  /** Resolves when the transaction completes (success or failure handled internally). */
  get done() { return this._handle.promise; }

  // --- message intake -------------------------------------------------------

  handleMessage({ json, audio }) {
    if (audio) { this.audioChunks.push(audio); return; }
    if (!json) return this.reject(new Error('Message has no audio and no data'));
    // CONTEXT is preprocessed (identity defaults + validation) before dispatch.
    try {
      if (json.type === RequestType.CONTEXT) preprocessContext(json, this.auth, this.socket._remoteAddress);
    } catch (err) { return this.reject(err); }
    this._handleJSON(json).catch((err) => this.reject(err));
  }

  async _handleJSON(message) {
    switch (message.type) {
      case RequestType.LISTEN: return this._handleListen(message);
      case RequestType.CONTEXT: return this._handleContext(message);
      case RequestType.CLIENT_ASR: return this._handleClientASR(message);
      case RequestType.CLIENT_NLU: return this._handleClientNLU(message);
      case 'SPEAKER_ID': this.log.warn('ignoring deprecated SPEAKER_ID'); return;
      default: throw new Error(`Unknown message type: ${message.type}`);
    }
  }

  async _handleListen(message) {
    this.listenMessage = message;
    const mode = message.data.mode;
    if (!mode) {
      this._gotoState(State.ASR);
    } else if (mode === 'CLIENT_ASR') {
      this._emitSOS(-1);
      this._gotoState(State.WAIT_CLIENT_ASR);
    } else if (mode === 'CLIENT_NLU') {
      this._emitSOS(-1);
      this._gotoState(State.WAIT_CLIENT_NLU);
    } else {
      throw new Error(`Invalid value for mode '${mode}'`);
    }
  }

  async _handleClientASR(message) {
    this.asrData = { text: message.data.text, confidence: 1 };
    this.timings.asr = -1;
    this._emitEOS(-1);
    this._gotoState(State.NLU);
  }

  async _handleClientNLU(message) {
    this.nluData = message.data;
    this.timings.nlu = -1;
    this.asrData = { text: '', confidence: 1 };
    this.timings.asr = -1;
    this._emitEOS(-1);
    this._gotoState(State.ROUTE);
  }

  _handleContext(message) {
    this.contextPr.resolve(validateContextMessage(message));
  }

  // --- state machine --------------------------------------------------------

  _gotoState(target) {
    const allowed = {
      [State.ASR]: [State.WAIT_LISTEN],
      [State.NLU]: [State.ASR, State.WAIT_CLIENT_ASR, State.WAIT_CLIENT_NLU],
      [State.ROUTE]: [State.ASR, State.NLU, State.WAIT_CLIENT_ASR, State.WAIT_CLIENT_NLU],
      [State.DONE]: [State.ROUTE, State.ASR],
      [State.STOP]: 'ALL',
      [State.WAIT_CLIENT_ASR]: [State.WAIT_LISTEN],
      [State.WAIT_CLIENT_NLU]: [State.WAIT_LISTEN],
    }[target];
    if (target === State.WAIT_LISTEN) return;
    if (allowed !== 'ALL' && (!allowed || allowed.indexOf(this.state) === -1)) {
      this.log.info(`bad transition to '${target}' from '${this.state}'`);
      return;
    }
    this.stateTrace.push(target);
    this.state = target;
    const exec = {
      [State.ASR]: () => this._performASR(),
      [State.NLU]: () => this._performNLU(),
      [State.ROUTE]: () => this._performRouting(),
      [State.DONE]: () => this._finish(),
      [State.STOP]: () => this._finish(),
      [State.WAIT_CLIENT_ASR]: async () => {},
      [State.WAIT_CLIENT_NLU]: async () => {},
    }[target];
    exec().catch((err) => this.reject(err));
  }

  async _performASR() {
    // Server-side ASR (Parakeet + VAD) is milestone M8. Real robots streaming audio land here;
    // CLIENT_ASR / CLIENT_NLU robots are fully supported now.
    const provider = this.components.asr;
    if (!provider) {
      throw new HubError(HubErrorCode.NOT_IMPLEMENTED, 'server-side ASR not implemented yet (milestone M8); use CLIENT_ASR/CLIENT_NLU mode');
    }
    const out = await withTimeout(provider.run({ listen: this.listenMessage.data, audio: () => this.audioChunks, emitSOS: () => this._emitSOS(), emitEOS: () => this._emitEOS() }), Timeouts.asr);
    if (out === TIMEOUT) throw new HubError(HubErrorCode.TIMEOUT_PARSER, `Timeout of ${Timeouts.asr} while waiting for ASR`);
    this.asrData = out;
    this.timings.asr = out.time ?? this.timings.asr;
    if (out.annotation === 'GARBAGE') {
      this.nluData = { intent: null, rules: [], entities: {} };
      this._emitListenResult(null, true);
      return this._gotoState(State.DONE);
    }
    this._gotoState(State.NLU);
  }

  async _performNLU() {
    const context = await this._awaitContext();
    const t0 = now();
    const parserPr = this.components.parser.handleNLU(
      {
        text: this.asrData.text,
        rules: this.listenMessage.data.rules,
        external: this.listenMessage.data.agents,
        loop: { users: loopUsers(context) },
      },
      this.trace,
    );
    const result = await withTimeout(parserPr, Timeouts.parser);
    if (result === TIMEOUT) throw new HubError(HubErrorCode.TIMEOUT_PARSER, `Timeout of ${Timeouts.parser} while waiting for parser`);
    this.nluData = result;
    this.timings.nlu = now() - t0;
    this._gotoState(State.ROUTE);
  }

  async _performRouting() {
    const context = await this._awaitContext();
    const decision = this.components.intentRouter.getSkillIDFromNLU(this.nluData);
    if (decision) {
      await this._onSkillMatch(decision.skillID, context, decision.memo, false);
    } else if (context.data && context.data.skill && context.data.skill.id && !this.listenMessage.data.hotphrase) {
      await this._onSkillMatch(context.data.skill.id, context, null, true);
    } else {
      this._emitListenResult(null, true);
    }
    this._gotoState(State.DONE);
  }

  async _onSkillMatch(skillID, context, memo, isUpdate) {
    const onRobot = this.components.skillConfigManager.isOnRobotSkill(skillID);
    const matchData = { skillID, launch: !isUpdate, onRobot };
    if (onRobot) {
      this._emitListenResult(matchData, true);
      return;
    }
    this._emitListenResult(matchData, false);

    const t0 = now();
    let skillOutput = await withTimeout(
      this.components.skillClient.launchOrUpdate(skillID, { context: context.data, nlu: this.nluData, asr: this.asrData, memo }, this.trace, isUpdate),
      Timeouts.skill,
    );
    if (skillOutput === TIMEOUT) throw new HubError(HubErrorCode.TIMEOUT_SKILL, `Timeout of ${Timeouts.skill} while waiting for the skill response from '${skillID}'`);

    if (skillOutput.response && isRedirect(skillOutput.response)) {
      skillOutput = await this._handleRedirect(skillOutput.response, context);
    }
    this.timings.skill = now() - t0;
    this._emitSkillResult(skillOutput, true);
  }

  async _handleRedirect(redirect, context) {
    this._emitSkillRedirectNotification(redirect.data);
    const out = await withTimeout(
      this.components.skillClient.launch(redirect.data.skillID, { context: context.data, nlu: redirect.data.nlu, asr: redirect.data.asr, memo: redirect.data.memo }, this.trace),
      Timeouts.skill,
    );
    if (out === TIMEOUT) throw new HubError(HubErrorCode.TIMEOUT_SKILL, `Timeout while waiting for the redirect skill response`);
    if (out.response && isRedirect(out.response)) throw new Error('Too many redirects');
    return out;
  }

  async _awaitContext() {
    const ctx = await withTimeout(this.contextPr.promise, Timeouts.context);
    if (ctx === TIMEOUT) throw new HubError(HubErrorCode.TIMEOUT_CONTEXT, `Timeout of ${Timeouts.context} while waiting for the context message`);
    return ctx;
  }

  // --- emitters (robot-facing wire shapes) ----------------------------------

  _emitSOS(total) {
    this.response.write({ type: ResponseType.SOS, data: null, msgID: newMsgId(), ts: now(), timings: { total: total ?? now() - this.startTime } });
  }
  _emitEOS(total) {
    this.response.write({ type: ResponseType.EOS, data: null, msgID: newMsgId(), ts: now(), timings: { total: total ?? now() - this.startTime } });
  }
  _emitListenResult(match, final) {
    this.response.write({
      type: ResponseType.LISTEN,
      msgID: newMsgId(),
      ts: now(),
      data: { asr: this.asrData, nlu: this.nluData, match },
      final,
      timings: { total: now() - this.startTime, asr: this.timings.asr, nlu: this.timings.nlu },
    });
  }
  _emitSkillResult(skillOutput, final) {
    if (skillOutput.error) {
      this.response.write({ type: ResponseType.ERROR, final, ts: now(), msgID: newMsgId(), data: { message: errMsg(skillOutput.error) } });
      return;
    }
    // Forward the skill's response VERBATIM, overwriting only final + timings (gotcha #4).
    const out = Object.assign({}, skillOutput.response, { final, timings: { total: now() - this.startTime, skill: this.timings.skill } });
    this.response.write(out);
  }
  _emitSkillRedirectNotification(redirectData) {
    const onRobot = this.components.skillConfigManager.isOnRobotSkill(redirectData.skillID);
    this.response.write({
      type: ResponseType.SKILL_REDIRECT,
      msgID: newMsgId(),
      ts: now(),
      final: onRobot,
      data: { match: { skillID: redirectData.skillID, launch: true, onRobot }, nlu: redirectData.nlu, asr: redirectData.asr, memo: redirectData.memo },
    });
  }

  // --- lifecycle ------------------------------------------------------------

  _finish() { this.resolve(); return Promise.resolve(); }

  resolve() {
    clearTimeout(this._txTimer);
    this._handle.resolve();
  }

  reject(err) {
    clearTimeout(this._txTimer);
    this.state = State.STOP;
    this._handle.reject(err);
  }
}

function loopUsers(contextMessage) {
  const runtime = contextMessage && contextMessage.data && contextMessage.data.runtime;
  const users = (runtime && runtime.loop && runtime.loop.users) || [];
  return users.map((u) => ({ firstName: u.firstName, lastName: u.lastName, id: u.id }));
}

function errMsg(e) { return e instanceof Error ? e.message : (e && e.message) || String(e); }
