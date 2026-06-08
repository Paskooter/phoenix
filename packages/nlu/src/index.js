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
import { llmFallback } from './llmFallback.js';

/** Pure parse used by the service and by tests. */
export async function parse(text) {
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
