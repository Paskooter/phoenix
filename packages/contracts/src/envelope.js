// The universal message envelope (docs/atlas/message-protocol.md §2,
// interfaces/src/service.ts:9-37). Everything on every hop is a BaseMessage; responses
// may additionally carry `final` and `timings`.
//
// Builders here mirror the reference emitters byte-for-byte in shape:
//   - ListenHandler/ListenTransactionHandler (listen responses, SOS/EOS)
//   - TransactionHandler.emitSkillRedirectNotification (SKILL_REDIRECT)
//   - ProactiveTransactionHandler.emitMatchResponse/emitNoActionResponse (PROACTIVE)
//   - hub-client ListenClientSession.writeClientASR/writeClientNLU (CLIENT_*)

import { randomUUID } from 'node:crypto';
import {
  ResponseType,
  HubErrorCode,
  RequestType,
  ListenResultState,
} from './constants.js';

/** @typedef {{ type: string, msgID: string, ts: number, data: unknown }} BaseMessage */
/** @typedef {BaseMessage & { final?: boolean, timings?: Record<string, number> }} BaseResponse */

export const now = () => Date.now();
export const newMsgId = () => randomUUID();

/**
 * Build a request/inner message.
 * @param {string} type
 * @param {unknown} data
 * @returns {BaseMessage}
 */
export function message(type, data) {
  return { type, msgID: newMsgId(), ts: now(), data };
}

/**
 * Build a response message, optionally final and/or with timings.
 * @param {string} type
 * @param {unknown} data
 * @param {{ final?: boolean, timings?: Record<string, number> }} [opts]
 * @returns {BaseResponse}
 */
export function response(type, data, opts = {}) {
  const m = message(type, data);
  if (opts.final !== undefined) m.final = opts.final;
  if (opts.timings !== undefined) m.timings = opts.timings;
  return m;
}

/**
 * Build the standard error envelope (always final). Mirrors hub error emission
 * (ListenHandler.ts:48-60) and the skill error shape (BaseSkill.ts:36-48).
 * @param {string} msg
 * @param {string} [code] one of HubErrorCode
 * @param {Record<string, unknown>} [extra] merged into data (e.g. { skill: { id } })
 * @returns {BaseResponse}
 */
export function errorResponse(msg, code = HubErrorCode.INTERNAL, extra = {}) {
  return response(ResponseType.ERROR, { message: msg, code, ...extra }, { final: true });
}

// SOS/EOS carry null data; in CLIENT_ASR/CLIENT_NLU modes timings.total is -1
// (message-protocol.md hop 5).
export const sos = (timings) => response(ResponseType.SOS, null, { timings });
export const eos = (timings) => response(ResponseType.EOS, null, { timings });

// --- robot -> hub requests --------------------------------------------------

/**
 * Proactive TRIGGER request (hub/proactive ProactiveTransactionHandler; the robot
 * sends it on the /proactive socket). `triggerData.looperID` is optional; without a
 * triggerData the reference transaction errors out.
 * @param {'NEW_ARRIVAL'|'SURPRISE'} triggerSource
 * @param {{ looperID?: string }} [triggerData]
 */
export function triggerRequest(triggerSource, triggerData = {}) {
  return message(RequestType.TRIGGER, { triggerSource, triggerData });
}

/**
 * CLIENT_ASR request (hub-client ListenClientSession.writeClientASR).
 * @param {string} text
 */
export function clientAsr(text) {
  return message(RequestType.CLIENT_ASR, { text });
}

/**
 * CLIENT_NLU request (hub-client ListenClientSession.writeClientNLU) — data IS the
 * NLUResult.
 * @param {object} nlu
 */
export function clientNlu(nlu) {
  return message(RequestType.CLIENT_NLU, nlu);
}

// --- hub -> robot responses -------------------------------------------------

/**
 * SKILL_REDIRECT notification (TransactionHandler.emitSkillRedirectNotification).
 * The hub always wraps the redirect in match = { skillID, launch: true, onRobot }.
 * @param {{ skillID: string, onRobot?: boolean }} match
 * @param {{ memo?: unknown, asr?: object|null, nlu?: object|null, final?: boolean, timings?: object }} [opts]
 */
export function skillRedirect(match, opts = {}) {
  const data = {
    match: { skillID: match.skillID, launch: true, onRobot: match.onRobot ?? false },
  };
  if (opts.memo !== undefined) data.memo = opts.memo;
  if (opts.asr !== undefined) data.asr = opts.asr;
  if (opts.nlu !== undefined) data.nlu = opts.nlu;
  const m = response(ResponseType.SKILL_REDIRECT, data, opts);
  return m;
}

/**
 * PROACTIVE response (ProactiveTransactionHandler.emitMatchResponse /
 * emitNoActionResponse). With a match the body is { match }; without one it is the
 * literal `{}` — both are legal (the reference emits exactly those two shapes).
 * @param {object|null} [match] GlobalMatchResponseData
 * @param {{ final?: boolean, timings?: object }} [opts]
 */
export function proactiveResponse(match = null, opts = {}) {
  return response(ResponseType.PROACTIVE, match ? { match } : {}, opts);
}

// --- ListenResult precedence ------------------------------------------------

/**
 * Resolve a LISTEN result to its state, exactly as ListenResult.state does
 * (interfaces/src/hub/response.ts):
 *   1. NLU result with an intent OR non-empty entities  -> 'match'
 *   2. otherwise, no ASR text (or no ASR at all)        -> 'noInput'
 *   3. otherwise (heard something, nothing matched)     -> 'noMatch'
 * The entities getter is null-safe (entities:null counts as empty).
 * @param {{ text?: string }|null|undefined} asr
 * @param {{ intent?: string|null, entities?: object|null }|null|undefined} nlu
 * @returns {'noInput'|'noMatch'|'match'}
 */
export function listenResultState(asr, nlu) {
  const entities = nlu && nlu.entities ? nlu.entities : {};
  if (nlu && (nlu.intent || Object.keys(entities).length)) {
    return ListenResultState.match;
  }
  if (!asr || !asr.text) {
    return ListenResultState.noInput;
  }
  return ListenResultState.noMatch;
}