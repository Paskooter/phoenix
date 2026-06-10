// NLU service (Pegasus parser equivalent). Milestone M5.
//
// POST /v1/parse : body = { type:'NLU', data:{ text, rules, loop?, external? } }
//              -> { type:'NLU', data: NLUResult }   (hub reads response.data.data, gotcha #8)
//
// Two-stage pipeline mirroring the reference (ParseRequestHandler.ts):
//   1. grammar match (deterministic). A confident match short-circuits.
//   2. LLM fallback (phoenix: LM Studio + Gemma tool-calling) when grammar misses AND
//      ETCO_parser_llmUrl is configured. Off by default -> a miss returns the no-match NLUResult.

import { createService } from '@phoenix/common';
import { message, ResponseType, DefaultPort } from '@phoenix/contracts';
import { grammarParse } from './grammar.js';
import { launchParse } from './launchRules.js';
import { fullParse } from './fullGrammar.js';
import { llmFallback } from './llmFallback.js';

/**
 * Parse an utterance into an NLUResult, mirroring the reference
 * ParseRequestHandler.getNLUResult + selectValidResult exactly:
 *
 *   Stage 1 — grammar (the reference's robust-parser FST union). Phoenix runs its
 *   grammar stages in order and takes the first usable match:
 *     1a. be-skill launch grammars (deterministic; emits the `skill` entity)
 *     1b. built-in question grammar (answer-skill question intents)
 *     1c. full real-grammar stage — every vendored Jibo launch grammar (chitchat,
 *         hue-control, report, …) with priority arbitration. Catches the long
 *         tail (sing/dance/love/lights/joke/…).
 *   A SKIP-priority parse is discarded (isParserResultValid). A HIGH-priority
 *   parse short-circuits — the LLM is never consulted.
 *
 *   Stage 2 — LLM fallback (off unless ETCO_parser_llmUrl is set), consulted when
 *   the grammar missed OR came back non-HIGH. Per selectValidResult, a valid LLM
 *   result BEATS a LOW/non-HIGH grammar parse; the grammar parse is returned only
 *   when the LLM produced nothing.
 */
export async function parse(text) {
  // Stage 1: grammar. First usable match across the grammar stages.
  let parser = null;
  const launch = await launchParse(text);
  if (launch && (launch.intent || (launch.entities && launch.entities.skill))) parser = launch;
  if (!parser) {
    const g = grammarParse(text);
    if (g.intent) parser = g;
  }
  if (!parser) {
    const full = fullParse(text);
    if (full && (full.intent || (full.entities && full.entities.skill))) parser = full;
  }
  const priority = parser && parser.entities ? parser.entities.priority : undefined;
  if (priority === 'SKIP') parser = null;               // isParserResultValid: SKIP → ignored
  if (parser && priority === 'HIGH') return parser;      // HIGH → skip the LLM round-trip

  // Stage 2: LLM (only on miss or non-HIGH). Valid LLM beats a non-HIGH parse.
  const llm = await llmFallback(text);
  if (llm && parser) return llm;                         // parser was LOW/non-HIGH → LLM wins
  if (parser) return parser;                             // no LLM result → keep the parse
  if (llm) return llm;
  return { rules: [], intent: null, entities: {} };      // EMPTY_NLU
}

export function start(port = Number(process.env.PORT) || DefaultPort.nlu) {
  const svc = createService({
    name: 'nlu',
    routes: {
      'POST /v1/parse': async ({ body }) => {
        const text = (body && body.data && body.data.text) || '';
        const nlu = await parse(text);
        return message(ResponseType.NLU, nlu); // { type:'NLU', msgID, ts, data: NLUResult }
      },
    },
  });
  return svc.listen(port);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch((e) => { console.error(e); process.exit(1); });
}
