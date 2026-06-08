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
import { llmFallback } from './llmFallback.js';

/**
 * Parse an utterance into an NLUResult. Pipeline (reference ParseRequestHandler order):
 *   1. be-skill launch grammars (deterministic; emits the `skill` entity for routing)
 *   2. built-in question grammar (answer-skill question intents)
 *   3. LLM fallback (off unless ETCO_parser_llmUrl is set)
 */
export async function parse(text) {
  const launch = await launchParse(text);
  if (launch && (launch.intent || (launch.entities && launch.entities.skill))) return launch;
  const grammar = grammarParse(text);
  if (grammar.intent) return grammar;
  const llm = await llmFallback(text);
  return llm || grammar; // grammar here is the no-match shape
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
