// Listen transaction — port of hub/listen/ListenTransactionHandler.ts (+ TransactionHandler.ts).
//
// One WebSocket == one transaction. State machine:
//   WAIT_LISTEN -> (ASR | WAIT_CLIENT_ASR | WAIT_CLIENT_NLU) -> NLU -> ROUTE -> DONE  (STOP from any)
// Robot-facing messages emitted: SOS, EOS (data:null), LISTEN (final iff on-robot/no-match),
// SKILL_ACTION/SKILL_REDIRECT (skill response forwarded verbatim, only final+timings overwritten),
// ERROR (final). Timeouts: transaction 60s, ASR 40s, CONTEXT-wait 5s, parser 10s, skill 10s.

import { newMsgId, now, ResponseType, RequestType, HubErrorCode, Timeouts } from '@phoenix/contracts';
import {
  createVoiceTurnId,
  logVoiceTurnComplete,
  logVoiceTurnSpan,
  recordVoiceTurnAsrBreakdown,
  recordVoiceTurnStart,
  readTrace,
} from '@phoenix/common';
import { SpeechHistoryRecord } from './historyClient.js';
import { preprocessContext, validateContextMessage } from './preprocessor.js';
import { isRedirect } from './skillClient.js';
import { startSession as startASRSession, cleanHintsEOS } from './asr/factory.js';
import { normalizeString } from './stringNormalizer.js';
import { mediateDecision } from './decisionMediator.js';

// The rules a global turn parses against.
//
// `launch` is the union of the twenty domain launch.rule grammars; the
// global-command grammars are NOT in it -- the parser exposes them as four
// separate public rules (packages/nlu/resources/rule-inventory.json). This
// default previously asked for a rule called `global`, which is not a name the
// parser knows, so it was dropped silently: "turn up the volume" reached the
// settings skill's volumeQuery instead of volumeUp, and "stop" and "go to
// sleep" parsed to nothing at all.
//
// Provenance of the names. The robot builds its own rule list in
// be-12.0.0 jibo/src/bt/mim/behaviors/Mim.ts:210-212,1242-1252: it takes the
// MIM config's ruleNames and appends `globals/gui_nav` always,
// `globals/mim_repeat` when there is an entry prompt to repeat, and
// `globals/mim_thanks` unless thanks handling is IGNORE. Those three names are
// confirmed robot-sent. `globals/global_commands_launch` is a public rule the
// parser exposes, but no recovered artifact shows the robot requesting it --
// it would come from a top-level MIM config, and no .mim files survive in the
// captured firmware. It is included here because a global turn is exactly the
// no-skill-running case those commands exist for; confirming it against Moth
// is the outstanding check.
//
// Requesting them alongside launch is safe because the source arbitration
// already makes them lose ties: RobustParserClient's LOW_PRIORITY_RULES
// (/^launch$|^globals\//) drops both from a tied top score whenever any other
// rule tied, which is why "thank you" still resolves to chitchat's
// thankJiboForAction rather than the globals `thanks`.
export const GLOBAL_TURN_RULES = Object.freeze([
  'launch',
  'globals/global_commands_launch',
  'globals/gui_nav',
  'globals/mim_repeat',
  'globals/mim_thanks',
]);

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
    // The reference socket is wrapped in JiboHeaders before a transaction is
    // created.  That wrapper supplies the same defaults for absent/empty
    // tracing headers that it sends to every parser, skill, and history peer.
    // Phoenix receives the raw upgrade headers, so materialize those defaults
    // at the transaction boundary instead of silently dropping trace context.
    const trace = readTrace({ headers: socket._jiboHeaders || {} });
    this.trace = {
      transId: trace.transId || 'unknown',
      robotId: trace.robotId || 'unknown',
      loggingConfig: trace.loggingConfig || '{}',
      // Do not reuse a caller-supplied value here. The gateway is the trust
      // boundary and each listen socket gets a fresh, opaque correlation ID.
      turnId: createVoiceTurnId(),
    };
    this.auth = socket._auth || null;

    // Speech-history log sink (ListenTransactionHandler.ts:73-82). Created once per
    // transaction when the hub config enables it; every later update mutates this record and
    // the whole thing is written on transaction completion (success or failure).
    this.speechRecord = this.components.config && this.components.config.recordSpeechHistory
      ? new SpeechHistoryRecord({
        robotID: this.auth ? this.auth.friendlyId : undefined,
        accountID: this.auth ? this.auth.id : undefined,
        transID: this.trace.transId,
        timestamp: now(),
        audioFileURL: null,
      })
      : null;

    this.state = State.WAIT_LISTEN;
    this.stateTrace = [this.state];
    this.startTime = now();
    this.timings = {};
    this.contextSpanRecorded = false;
    this.turnCompleted = false;
    this.log.info('voice_turn_started', {
      event: 'voice_turn_started',
      turnId: this.trace.turnId,
      entrypoint: 'gateway_listen',
    });
    recordVoiceTurnStart(this.trace, this.startTime);

    this.listenMessage = null;
    this.contextPr = defer();
    this.asrData = null;
    this.nluData = null;
    this.audioChunks = [];
    this.redirectCount = 0;
    // ASR phase bookkeeping. asrCancelled mirrors the reference's stopASR()
    // effect: once a client-supplied turn (or any state exit) supersedes the
    // ASR phase, that phase may no longer emit SOS/EOS or contribute a result.
    this.asrCancelled = false; // mirrors the reference's stopASR() effect
    // Mirrors the reference's `audioStream`: live from construction, ended and
    // nulled by stopASR(), after which handleAudio drops what arrives.
    this.audioStreamClosed = false;
    this.abandoned = false;    // peer closed: no write can be delivered any more
    this.sosTimer = null;
    this.maxSpeechTimer = null;

    this._handle = defer();
    // The reference TransactionHandler wraps its internal ExtPromise with a
    // timeout promise. A timeout rejects the outer handle promise but does not
    // call reject(), stop the state machine, or add a HubError code; an
    // in-flight skill may still complete and resolve the internal transaction.
    // Keep those two settlement layers separate here as well.
    this._timeout = defer();
    this._done = Promise.race([this._handle.promise, this._timeout.promise]);
    this._txTimer = setTimeout(() => {
      this._txTimer = null;
      this._timeout.reject(new Error(`Maximum transaction time of ${Timeouts.transaction} exceeded`));
    }, Timeouts.transaction);
    this._txTimer.unref?.();
  }

  /** Resolves when the transaction completes (success or failure handled internally). */
  get done() { return this._done; }

  // --- message intake -------------------------------------------------------

  handleMessage({ json, audio }) {
    if (audio) {
      // Binary frames = raw 16 kHz 16-bit mono PCM. Stream straight into a live
      // ASR session (reference: audioStream.on('data') -> provideAudio); buffer
      // anything that arrives before the session exists so no audio is lost.
      //
      // Once the ASR phase has stopped, the reference DROPS audio instead of
      // buffering it: `stopASR()` ends and nulls `audioStream`, and `handleAudio`
      // logs "Got audio packet but audio stream is closed". Without that, a robot
      // that keeps streaming after its turn is recognised leaves frames in a
      // buffer no consumer will ever read -- retained until the socket closes
      // (closeAfterFinal) on the settled path, and for the whole NLU + skill legs
      // on the normal path. Same rule here, so the retained set matches the
      // reference's.
      if (this.audioStreamClosed) return;
      if (this.asrSession) this.asrSession.provideAudio(audio);
      else this.audioChunks.push(audio);
      return;
    }
    if (!json) return this.reject(new Error('Message has no audio and no data'));
    // CONTEXT is preprocessed (identity defaults + validation) before dispatch.
    try {
      if (json.type === RequestType.CONTEXT) preprocessContext(json, this.auth, this.socket._remoteAddress);
    } catch (err) {
      // A CONTEXT the preprocessor rejects is almost always shaped wrong rather
      // than merely wrong-valued.  Report the shape -- key names and types only,
      // never the values, which carry loop member names and household data.
      if (json && json.type === RequestType.CONTEXT) {
        const shape = (o) => (o && typeof o === 'object'
          ? Object.fromEntries(Object.keys(o).map((k) => [k, Array.isArray(o[k]) ? `array[${o[k].length}]` : o[k] === null ? 'null' : typeof o[k]]))
          : typeof o);
        this.log.error('CONTEXT rejected', {
          reason: err.message,
          dataKeys: shape(json.data),
          // Do not add robot/account/network identity to voice diagnostics.
          // The request's correlation headers remain available to operators.
          hasRobotID: !!(json.data && json.data.general && json.data.general.robotID),
        });
      }
      return this.reject(err);
    }
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
    // Reference: "If we're already doing ASR then we cancel that"
    // (ListenTransactionHandler.ts:253-256). Without it the stale server ASR
    // session keeps running and its late result overwrites the transcript the
    // client just supplied.
    if (this.state === State.ASR) this._cancelASR();
    if (!this.listenMessage) this._beginGlobalTurn(State.WAIT_CLIENT_ASR);
    this.asrData = { text: message.data.text, confidence: 1 };
    this.timings.asr = -1;
    this._updateSpeech({ asr: this.asrData }); // ListenTransactionHandler.ts:261
    this._emitEOS(-1);
    this._gotoState(State.NLU);
  }

  async _handleClientNLU(message) {
    // Same cancellation guard as CLIENT_ASR (ListenTransactionHandler.ts:272-276).
    if (this.state === State.ASR) this._cancelASR();
    if (!this.listenMessage) this._beginGlobalTurn(State.WAIT_CLIENT_NLU, message.data && message.data.rules);
    this.nluData = message.data;
    this.timings.nlu = -1;
    this.asrData = { text: '', confidence: 1 };
    this.timings.asr = -1;
    this._updateSpeech({ asr: this.asrData, nlu: this.nluData }); // ListenTransactionHandler.ts:283
    this._emitEOS(-1);
    this._gotoState(State.ROUTE);
  }

  // Global turn: a CLIENT_ASR/CLIENT_NLU arrives with no preceding LISTEN/CONTEXT (the sim's
  // mimic_global_turn, transID 'GLOBAL'). Synthesize a minimal listen + context so the state
  // machine can route immediately instead of waiting for a context that never comes.
  _beginGlobalTurn(state, rules) {
    this.global = true;
    this.listenMessage = {
      data: { lang: 'en-US', hotphrase: false, rules: Array.isArray(rules) && rules.length ? rules : GLOBAL_TURN_RULES },
    };
    this.state = state; // make the subsequent NLU/ROUTE transition valid
    this.contextPr.resolve({
      data: {
        general: {
          accountID: this.auth ? this.auth.id : 'anonymous-account',
          robotID: this.auth ? this.auth.friendlyId : 'anonymous-robot',
          lang: 'en',
          release: '1.9.0',
        },
        runtime: {},
        skill: { id: null },
      },
    });
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
    // Reference _exitCurrentState(): leaving ASR stops the ASR session
    // (ListenTransactionHandler.ts:207-226).
    if (this.state === State.ASR) this._cancelASR();
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
    // Server-side ASR (M8) — port of the reference performASR/_performASR:
    // ASRFactory session (Parakeet energy-VAD), real SOS/EOS emission, sosTimeout/
    // maxSpeechTimeout annotations, 40 s budget, transcript normalization, and the
    // GARBAGE short-circuit. Real robots stream raw PCM here; the sim's mic mode
    // follows the same path.
    const t0 = now();
    let outcome = 'ok';
    this.asrCancelled = false;
    // A fresh ASR phase reopens the audio path, matching a reference transaction
    // that had not yet reached stopASR().
    this.audioStreamClosed = false;
    try {
      const out = await withTimeout(this._runASRSession(), Timeouts.asr).finally(() => {
        // Reference stopASR(): always stop the session when the ASR phase settles.
        this._stopASR();
      });
      if (out === TIMEOUT) throw new HubError(HubErrorCode.TIMEOUT_ASR, `Timeout of ${Timeouts.asr} while waiting for ASR`);
      // A cancelled phase contributes nothing: the reference stops the session so
      // it cannot answer, and its performASR guards the assignment with
      // `if (asrData)`. Both matter here because a Phoenix provider session keeps
      // running until it is told to stop.
      if (this.asrCancelled || this.state !== State.ASR) {
        outcome = 'cancelled';
        return;
      }
      // `if (asrData)` in the reference: an ASR phase that produced no result
      // must not overwrite data the client already supplied.
      if (out) {
        this.asrData = out;
        this.timings.asr = now() - t0;
        // Record the RAW ASR before normalization (ListenTransactionHandler.ts:465); the clone
        // keeps the logged transcript from following the in-place normalizeString below.
        this._updateSpeech({ asr: Object.assign({}, this.asrData) });
        this.asrData.text = normalizeString(this.asrData.text);
        if (out.annotation === 'GARBAGE') {
          this.nluData = { intent: null, rules: [], entities: {} };
          this._emitListenResult(null, true);
          return this._gotoState(State.DONE);
        }
      }
    } catch (err) {
      outcome = metricOutcome(err);
      // The reference's outer catch re-wraps EVERY ASR failure — including its
      // own TIMEOUT_ASR throw — as HubErrorCode.ASR, so TIMEOUT_ASR never
      // reaches the robot (ListenTransactionHandler.ts:452-484).
      throw new HubError(HubErrorCode.ASR, errMsg(err));
    } finally {
      this._span('asr', t0, outcome);
    }
    this._gotoState(State.NLU);
  }

  /** Reference _performASR: build the session config, wire SOS/EOS, feed audio. */
  _runASRSession() {
    return new Promise((resolve, reject) => {
      const listenData = this.listenMessage.data;
      const asrData = (listenData.asr && listenData.asr !== 'FAKE') ? listenData.asr : {};
      const config = Object.assign({ lang: listenData.lang }, asrData);
      // The provider needs to know this is a wake-phrase turn: its audio always
      // opens with the tail of the wake phrase, which is not an utterance.
      config.hotphrase = !!listenData.hotphrase;
      config.hints = asrData.hints ? cleanHintsEOS(asrData.hints, true, this.log) : undefined;
      config.earlyEOS = asrData.earlyEOS ? cleanHintsEOS(asrData.earlyEOS, false, this.log) : undefined;
      config.maxSpeechTimeout = asrData.maxSpeechTimeout || 60 * 1000;

      // Parakeet already emits its useful audio/silence/recognition breakdown.
      // Scope only that provider logger so those existing fields gain the same
      // opaque turn correlation without changing the supplied transaction log
      // object or provider/test interface.
      const session = (this.components.asrProvider || startASRSession)(config, this._asrLog());
      this.asrSession = session;

      // Only the phase that started this closure may emit or resolve; after a
      // cancel the reference's session is stopped and its timers cleared, so a
      // superseded phase must go quiet rather than answer.
      const live = () => !this.asrCancelled;

      if (config.sosTimeout > 0) {
        this.sosTimer = setTimeout(() => {
          if (live()) resolve({ text: '', confidence: 0, annotation: 'SOS_TIMEOUT' });
        }, config.sosTimeout);
        this.sosTimer.unref?.();
      }
      session.onStartOfSpeech(() => {
        if (!live()) return;
        clearTimeout(this.sosTimer);
        this.sosTimer = null;
        this._emitSOS();
        if (config.maxSpeechTimeout > 0) {
          this.maxSpeechTimer = setTimeout(() => {
            if (!live()) return;
            const last = session.getLastIncremental();
            const settle = (text, confidence) => {
              if (!live()) return;
              resolve({ text: text || '', confidence: confidence || 0, annotation: 'MAX_SPEECH_TIMEOUT' });
            };
            // A batch recognizer holds the words until it is asked to recognize;
            // the reference's incremental seam would report them here, so ask for
            // them instead of settling the turn with an empty no-match result.
            if (typeof session.finalizeNow === 'function') {
              session.finalizeNow().then(
                (batchText) => (batchText
                  ? settle(batchText, 1.0)
                  : settle(last && last.text, last && last.confidence)),
                (err) => { this.log.warn('batch finalize on max-speech timeout failed', { error: err.message }); settle(last && last.text, last && last.confidence); },
              );
            } else {
              settle(last && last.text, last && last.confidence);
            }
          }, config.maxSpeechTimeout);
          this.maxSpeechTimer.unref?.();
        }
      });
      session.onEndOfSpeech(() => {
        if (!live()) return;
        clearTimeout(this.maxSpeechTimer);
        this.maxSpeechTimer = null;
        this._emitEOS();
      });

      session.start()
        .then((data) => { this._clearASRTimers(); resolve(data); })
        .catch((err) => { this._clearASRTimers(); reject(err); });

      // Flush audio that arrived before the session existed, then handleMessage
      // streams subsequent frames directly (push-style, like audioStream.on('data')).
      for (const chunk of this.audioChunks.splice(0)) session.provideAudio(chunk);
    });
  }

  /**
   * Reference stopASR() (ListenTransactionHandler.ts:439-450): stop the session,
   * drop the audio path and clear the SOS / max-speech timers.
   */
  _stopASR() {
    if (this.asrSession) {
      try { this.asrSession.stop(); } catch { /* already done */ }
      this.asrSession = null;
    }
    this._clearASRTimers();
    // Reference stopASR() ends AND nulls `audioStream`, so every later packet
    // takes the "audio stream is closed" branch and is dropped. That is the only
    // thing bounding pre-session audio to the ASR phase; without it, audio arriving
    // during the NLU and skill legs (up to the parser and skill budgets) sits in a
    // buffer nothing reads. A fresh ASR phase reopens the stream.
    this.audioStreamClosed = true;
    if (this.asrCancelled) this.audioChunks.length = 0;
  }

  _clearASRTimers() {
    if (this.sosTimer) { clearTimeout(this.sosTimer); this.sosTimer = null; }
    if (this.maxSpeechTimer) { clearTimeout(this.maxSpeechTimer); this.maxSpeechTimer = null; }
  }

  /** Cancel the in-flight ASR phase: stop it and make it invisible from then on. */
  _cancelASR() {
    this.asrCancelled = true;
    this._stopASR();
  }

  /**
   * The peer is gone (socket close): nothing this transaction writes can be
   * delivered any more, so make the in-flight ASR phase silent AND cheap. Setting
   * asrCancelled first makes live() false, which suppresses the EOS and the LISTEN
   * result that the running session would otherwise emit into an ended response
   * ("can't write after response ended" — after a hotword re-trigger or a
   * cancel_local_turn the robot closes the socket, and without this the phase ran
   * on until maxSpeechTimeout and recognized audio for a dead peer).
   */
  abandon() {
    if (this.abandoned) return;
    this.abandoned = true;
    this.asrCancelled = true;
    // The peer is gone: nothing can consume audio any more, so close the path the
    // same way stopASR() does rather than letting later frames accumulate.
    this.audioStreamClosed = true;
    const session = this.asrSession;
    if (session) {
      try {
        if (typeof session.abort === 'function') session.abort();
        else session.stop();
      } catch { /* the peer is gone; nothing to recover */ }
      this.asrSession = null;
    }
    this._clearASRTimers();
    this.audioChunks.length = 0;
    this._markFinalResponse('abandoned');
  }

  async _performNLU() {
    const context = await this._awaitContext();
    const t0 = now();
    let outcome = 'ok';
    const parserPr = this.components.parser.handleNLU(
      {
        text: this.asrData.text,
        rules: this.listenMessage.data.rules,
        external: this.listenMessage.data.agents,
        loop: { users: loopUsers(context) },
      },
      this.trace,
    );
    try {
      const result = await withTimeout(parserPr, Timeouts.parser);
      if (result === TIMEOUT) throw new HubError(HubErrorCode.TIMEOUT_PARSER, `Timeout of ${Timeouts.parser} while waiting for parser`);
      this.nluData = result;
      this.timings.nlu = now() - t0;
    } catch (err) {
      outcome = metricOutcome(err);
      // The reference wraps the whole parser block in a catch that re-throws
      // HubErrorCode.PARSER — including its own TIMEOUT_PARSER throw, so even a
      // parser timeout reaches the robot as 'PARSER'
      // (ListenTransactionHandler.ts:304-321; captured in the original
      // hub-listen-provider-failure transaction as
      // {"code":"PARSER","message":"Request failed with status code 503"}).
      throw new HubError(HubErrorCode.PARSER, errMsg(err));
    } finally {
      this._span('nlu', t0, outcome);
    }
    this._updateSpeech({ nlu: this.nluData }); // ListenTransactionHandler.ts:323
    this._gotoState(State.ROUTE);
  }

  async _performRouting() {
    const context = await this._awaitContext();
    const t0 = now();
    const decision = this.components.intentRouter.getSkillIDFromNLU(this.nluData);
    const finalDecision = decision
      ? (mediateDecision(decision, this.asrData, this.nluData, context.data.general.release) || decision)
      : null;
    this._span('route', t0, finalDecision ? 'matched' : 'unmatched');
    if (finalDecision) {
      await this._onSkillMatch(finalDecision.skillID, context, finalDecision.memo, false);
    } else if (context.data && context.data.skill && context.data.skill.id && !this.listenMessage.data.hotphrase) {
      await this._onSkillMatch(context.data.skill.id, context, null, true);
    } else {
      this._emitListenResult(null, true);
    }
    this._gotoState(State.DONE);
  }

  async _onSkillMatch(skillID, context, memo = null, isUpdate = false) {
    const onRobot = this.components.skillConfigManager.isOnRobotSkill(skillID);
    const matchData = { skillID, launch: !isUpdate, onRobot };
    if (onRobot) {
      this._emitListenResult(matchData, true);
      this._record(skillID, context);
      return;
    }
    this._emitListenResult(matchData, false);

    const t0 = now();
    let skillOutcome = 'ok';
    let skillOutput;
    try {
      skillOutput = await withTimeout(
        this._skillLaunchOrUpdate(skillID, { context: context.data, nlu: this.nluData, asr: this.asrData, memo }, this.trace, isUpdate),
        Timeouts.skill,
      );
      if (skillOutput === TIMEOUT) {
        skillOutcome = 'timeout';
        throw new HubError(HubErrorCode.TIMEOUT_SKILL, `Timeout of ${Timeouts.skill} while waiting for the skill response from '${skillID}'`);
      }
      if (skillOutput.error) skillOutcome = 'remote_error';
    } catch (err) {
      if (skillOutcome === 'ok') skillOutcome = metricOutcome(err);
      throw err;
    } finally {
      this._span('skill', t0, skillOutcome);
    }
    // The reference times this leg with utils.common.time() (ListenTransactionHandler.ts:395-397)
    // and, when a redirect follows, OVERWRITES timings.skill with the redirect leg's own
    // duration (lines 404-410). A redirected SKILL_ACTION therefore reports only the second
    // call, not the sum of both.
    this.timings.skill = now() - t0;

    // The reference records each successful request as it completes. This is
    // deliberately before redirect handling: the initial skill launch remains
    // in history even when it asks the hub to launch another skill.
    if (!skillOutput.error) this._record(skillID, context, skillOutput.response);

    if (skillOutput.response && isRedirect(skillOutput.response)) {
      const redirectStart = now();
      let redirectOutcome = 'ok';
      try {
        skillOutput = await this._handleRedirect(skillOutput.response, context, skillID);
        if (skillOutput.error) redirectOutcome = 'remote_error';
      } catch (err) {
        redirectOutcome = metricOutcome(err);
        throw err;
      } finally {
        this._span('skill_redirect', redirectStart, redirectOutcome);
      }
      this.timings.skill = now() - redirectStart;
    }
    this._emitSkillResult(skillOutput, true);
  }

  // Fire-and-forget skill-launch history record (TransactionHandler.recordSkillLaunch).
  _record(skillID, context, skillResponse) {
    if (!this.components.config.recordLaunchHistory || !this.components.historyClient) return;
    const general = (context.data && context.data.general) || {};
    const runtime = (context.data && context.data.runtime) || {};
    const perception = runtime.perception || {};
    // TransactionHelper.getPersonIDs in the reference intentionally uses the
    // speaker only. UNKNOWN is a history-query sentinel when no speaker was
    // identified; peoplePresent is not folded into launch identity.
    const personIDs = perception.speaker ? [perception.speaker] : ['UNKNOWN'];
    const sessionID = (skillResponse && skillResponse.data && skillResponse.data.skill && skillResponse.data.skill.session && skillResponse.data.skill.session.id) || newMsgId();
    const startedAt = now();
    this.components.historyClient.writeSkillLaunch({ robotID: general.robotID, sessionID, skillID, intent: this.nluData && this.nluData.intent, personIDs }, this.trace)
      .then((result) => this._span('history_launch', startedAt, result === null ? 'error' : 'ok'))
      .catch(() => this._span('history_launch', startedAt, 'error'));
  }

  // --- speech-history log sink (ListenTransactionHandler.ts:84-108) -----------

  /** Mutate the in-flight speech record (no-op when recordSpeechHistory is off). */
  _updateSpeech(data) {
    if (this.speechRecord) this.speechRecord.update(data);
  }

  /**
   * Fire-and-forget write of the whole speech record (ListenTransactionHandler.saveSpeechHistoryRecord).
   * Never throws into the transaction: a history outage is logged, exactly as the reference does.
   */
  _saveSpeech() {
    if (!this.speechRecord || !this.components.historyClient) return;
    const startedAt = now();
    this.components.historyClient.saveSpeechRecord(this.speechRecord, this.trace)
      .then(() => this._span('history_speech', startedAt, 'ok'))
      .catch((err) => {
        this._span('history_speech', startedAt, 'error');
        this.log.error(err.message);
      });
  }

  /**
   * Reference getSkillResponse (ListenTransactionHandler.ts:586-608): the skill output is
   * recorded on the call's own settlement, not after the outer timeout race, so the record
   * reflects whatever the skill call resolves with (the source records a late error envelope the
   * same way). Mirrors `getSkillResponse`'s `updateSpeechHistoryRecord({ skill })` before any
   * redirect handling.
   */
  async _skillLaunchOrUpdate(skillID, input, trace, isUpdate) {
    const out = await this.components.skillClient.launchOrUpdate(skillID, input, trace, isUpdate);
    this._updateSpeech({ skill: out });
    return out;
  }

  /** Reference handleSkillRedirect's skill launch (ListenTransactionHandler.ts:623-632). */
  async _skillLaunch(skillID, input, trace) {
    const out = await this.components.skillClient.launch(skillID, input, trace);
    this._updateSpeech({ skill: out });
    return out;
  }

  async _handleRedirect(redirect, context, sourceSkillID) {
    // The reference records the redirect payload BEFORE emitting the notification and before
    // the second skill call (ListenTransactionHandler.ts:619).
    this._updateSpeech({ redirect: redirect.data });
    this._emitSkillRedirectNotification(redirect.data);
    const out = await withTimeout(
      // TransactionHelper's redirect launch omits ASR. The redirect NLU and
      // memo are supplied by the redirect notification instead.
      this._skillLaunch(redirect.data.skillID, { context: context.data, nlu: redirect.data.nlu, memo: redirect.data.memo }, this.trace),
      Timeouts.skill,
    );
    // The reference's redirect timeout message names the ORIGINAL skill: the
    // throw is raised in onSkillMatch while `skillOutput` still refers to the
    // first response (ListenTransactionHandler.ts:406-407).
    if (out === TIMEOUT) throw new HubError(HubErrorCode.TIMEOUT_SKILL, `Timeout of ${Timeouts.skill} while waiting for the redirect skill response from '${sourceSkillID}'`);
    // A successful redirected launch gets its own history row and session.
    // Errors are emitted to the client but must not look like successful
    // launches in history. The source performs this before checking for a
    // second redirect, so a successful second redirect is also recorded before
    // the transaction rejects as too many redirects.
    if (!out.error) this._record(redirect.data.skillID, context, out.response);
    if (out.response && isRedirect(out.response)) throw new Error('Too many redirects');
    return out;
  }

  async _awaitContext() {
    const t0 = now();
    let outcome = 'ok';
    try {
      const ctx = await withTimeout(this.contextPr.promise, Timeouts.context);
      if (ctx === TIMEOUT) {
        outcome = 'timeout';
        throw new HubError(HubErrorCode.TIMEOUT_CONTEXT, `Timeout of ${Timeouts.context} while waiting for the context message`);
      }
      return ctx;
    } catch (err) {
      if (outcome === 'ok') outcome = metricOutcome(err);
      throw err;
    } finally {
      if (!this.contextSpanRecorded) {
        this.contextSpanRecorded = true;
        this._span('context_wait', t0, outcome);
      }
    }
  }

  // --- emitters (robot-facing wire shapes) ----------------------------------

  _emitSOS(total) {
    this.response.write({ type: ResponseType.SOS, data: null, msgID: newMsgId(), ts: now(), timings: { total: total ?? now() - this.startTime } });
  }
  _emitEOS(total) {
    this.response.write({ type: ResponseType.EOS, data: null, msgID: newMsgId(), ts: now(), timings: { total: total ?? now() - this.startTime } });
  }
  _emitListenResult(match, final) {
    this._updateSpeech({ match }); // ListenTransactionHandler.ts:676 — recorded even when match is null
    const wrote = this.response.write({
      type: ResponseType.LISTEN,
      msgID: newMsgId(),
      ts: now(),
      data: { asr: this.asrData, nlu: this.nluData, match },
      final,
      timings: { total: now() - this.startTime, asr: this.timings.asr, nlu: this.timings.nlu },
    });
    if (final && wrote !== false) this._markFinalResponse('listen');
  }
  _emitSkillResult(skillOutput, final) {
    if (skillOutput.error) {
      const wrote = this.response.write({ type: ResponseType.ERROR, final, ts: now(), msgID: newMsgId(), data: { message: errMsg(skillOutput.error) } });
      if (final && wrote !== false) this._markFinalResponse('error');
      return;
    }
    // Forward the skill's response VERBATIM, overwriting only final + timings (gotcha #4).
    const out = Object.assign({}, skillOutput.response, { final, timings: { total: now() - this.startTime, skill: this.timings.skill } });
    const wrote = this.response.write(out);
    if (final && wrote !== false) this._markFinalResponse('skill');
  }
  _emitSkillRedirectNotification(redirectData) {
    const onRobot = this.components.skillConfigManager.isOnRobotSkill(redirectData.skillID);
    const wrote = this.response.write({
      type: ResponseType.SKILL_REDIRECT,
      msgID: newMsgId(),
      ts: now(),
      final: onRobot,
      data: { match: { skillID: redirectData.skillID, launch: true, onRobot }, nlu: redirectData.nlu, asr: redirectData.asr, memo: redirectData.memo },
    });
    if (onRobot && wrote !== false) this._markFinalResponse('redirect');
  }

  // --- lifecycle ------------------------------------------------------------

  _finish() { this.resolve(); return Promise.resolve(); }

  /** Called by the gateway error writer after it queues its final ERROR frame. */
  markErrorResponse() { this._markFinalResponse('error'); }

  _span(stage, startedAt, outcome = 'ok') {
    logVoiceTurnSpan(this.log, this.trace, stage, startedAt, outcome);
  }

  _asrLog() {
    const parent = this.log;
    return {
      ...parent,
      info: (message, fields) => {
        // The ASR breakdown always supplies an object. Leave a non-object
        // supplied logger call unchanged rather than inventing a new shape.
        if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
          return parent.info?.(message, fields);
        }
        if (message === 'ASR turn') recordVoiceTurnAsrBreakdown(this.trace, fields);
        return parent.info?.(message, { ...fields, turnId: this.trace.turnId });
      },
    };
  }

  _markFinalResponse(outcome) {
    if (this.turnCompleted) return;
    this._span('response_ready', this.startTime, outcome);
    this.turnCompleted = true;
    logVoiceTurnComplete(this.log, this.trace, this.startTime, outcome);
  }

  resolve() {
    clearTimeout(this._txTimer);
    this._handle.resolve();
    this._saveSpeech(); // TransactionHandler.onTransactionSuccess
  }

  reject(err) {
    clearTimeout(this._txTimer);
    this.state = State.STOP;
    this._handle.reject(err);
    // TransactionHandler.reject runs onTransactionError (record the error, then save) and then
    // stop() -> gotoState(STOP) -> done() -> resolve() -> onTransactionSuccess, which saves the
    // SAME record a second time. Both calls are fire-and-forget creates while the record still
    // has no id, so a failed turn writes the speech record TWICE. Observed on the pinned
    // original in docs/parity/evidence/2026-09-11/h08-speech-history/source-speech-history.json
    // (tooManyRedirects / parserFailure: two speechSave events, both recordId=<undefined>).
    this._updateSpeech({ error: err });
    this._saveSpeech();
    this._saveSpeech();
  }
}

function loopUsers(contextMessage) {
  const runtime = contextMessage && contextMessage.data && contextMessage.data.runtime;
  const users = (runtime && runtime.loop && runtime.loop.users) || [];
  return users.map((u) => ({ firstName: u.firstName, lastName: u.lastName, id: u.id }));
}

// Keep the log taxonomy small and content-free. Error messages can include a
// provider response or malformed client payload, so they never cross into
// latency telemetry.
function metricOutcome(error) {
  if (error === TIMEOUT || String(error?.code || '').startsWith('TIMEOUT')) return 'timeout';
  return 'error';
}

function errMsg(e) { return e instanceof Error ? e.message : (e && e.message) || String(e); }
