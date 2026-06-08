// The universal message envelope (docs/atlas/message-protocol.md §2,
// interfaces/src/service.ts:9-37). Everything on every hop is a BaseMessage; responses
// may additionally carry `final` and `timings`.

import { randomUUID } from 'node:crypto';
import { ResponseType, HubErrorCode } from './constants.js';

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
