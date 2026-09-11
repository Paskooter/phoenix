// Fallback arbitration — the restored Pegasus hybrid NLU selection contract.
//
// Pinned source, read through the Jibo archive MCP this session:
//   jiboV2/pegasus@715e0dd0719ecca5164959d713862a1402430623
//     packages/parser/src/handlers/ParseRequestHandler.ts
//
// getNLUResult (ParseRequestHandler.ts:50-83):
//   1. Stage 1 robust parser. A valid HIGH result returns immediately and the
//      fallback is never consulted (:67-70).
//   2. Stage 2 LLM fallback only when stage 1 missed or came back LOW (:72-82).
// selectValidResult (ParseRequestHandler.ts:85-106):
//   - an invalid parser result becomes null, an invalid fallback result becomes
//     null (:86-91)
//   - both valid -> the FALLBACK wins over a LOW parser (:93-96)
//   - parser only -> parser.nlu (:97-100)
//   - fallback only -> fallback (:101-104)
//   - neither -> EMPTY_NLU (:105)
// isParserResultValid (:108-119): missing parser, missing nlu/intent, or
//   priority SKIP -> invalid.
// isFallbackResultValid (:121-132): missing fallback, missing intent, or the
//   DECOY_INTENT -> invalid.

import { DECOY_INTENT } from './externalAgents.js';

// ParseRequestHandler.ts:13-17 — the source EMPTY_NLU uses JSON null entities.
export const EMPTY_NLU = Object.freeze({ intent: null, entities: null, rules: [] });

// ParseRequestHandler.ts:67 — HIGH short-circuits before the fallback call.
export function isHighPriority(parserResult) {
  return isParserResultValid(parserResult) && parserResult.priority === 'HIGH';
}

// ParseRequestHandler.ts:108-119
export function isParserResultValid(parserResult) {
  if (!parserResult) return false;
  if (!parserResult.nlu || !parserResult.nlu.intent) return false;
  if (parserResult.priority === 'SKIP') return false;
  return true;
}

// ParseRequestHandler.ts:121-132
export function isFallbackResultValid(fallbackResult) {
  if (!fallbackResult) return false;
  if (!fallbackResult.intent) return false;
  if (fallbackResult.intent === DECOY_INTENT) return false;
  return true;
}

// ParseRequestHandler.ts:85-106
export function selectValidResult(parserResult, fallbackResult, empty = EMPTY_NLU) {
  if (!isParserResultValid(parserResult)) parserResult = null;
  if (!isFallbackResultValid(fallbackResult)) fallbackResult = null;
  if (parserResult && fallbackResult) return fallbackResult;
  if (parserResult) return parserResult.nlu;
  if (fallbackResult) return fallbackResult;
  return empty;
}

/**
 * The full ParseRequestHandler.getNLUResult orchestration
 * (ParseRequestHandler.ts:50-83): a valid HIGH parser result returns immediately
 * and `callFallback` is NEVER invoked; otherwise the fallback is consulted and
 * any fallback error becomes null before selection.
 *
 * Why a callback rather than a value: the source short-circuits the expensive
 * LLM round-trip on HIGH (ParseRequestHandler.ts:67-70), so the fallback must
 * not be evaluated at all in that case.
 *
 * @param {null|{nlu:object,priority?:string}} parserResult
 * @param {() => (object|null|Promise<object|null>)} callFallback
 * @param {object} [empty]
 */
export async function resolveHybridNLU(parserResult, callFallback, empty = EMPTY_NLU) {
  if (isHighPriority(parserResult)) return parserResult.nlu;
  let fallbackResult = null;
  try { fallbackResult = await callFallback(); } catch { fallbackResult = null; }
  return selectValidResult(parserResult, fallbackResult, empty);
}
