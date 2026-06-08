// NLU service (Pegasus parser equivalent). Milestone M5.
//
// Contract to fulfil (docs/atlas/packages/parser.md, message-protocol.md hop 6):
//   POST /v1/parse   body = NLU request { data: { text, rules, loop?, external? } }
//                    -> { type:'NLU', data: NLUResult { rules, intent, entities, external? } }
//                    Text is trimmed + lowercased. Stage 1: grammar/FST match
//                    ({nlu, priority: HIGH|LOW|SKIP}); HIGH returns immediately. Stage 2:
//                    LLM fallback (OpenAI tool-calling, ~15-intent catalog) when FST misses
//                    or is LOW. LoopMemberDetector resolves looper names to IDs.
//   Empty/garbage input -> { intent:null, rules:[], entities:{} } (not an error).
//
// Decide the grammar strategy first (atlas risk R1: the original ships a C++ FST engine +
// 117 .rule sources). See docs/atlas/packages/parser.md §8.

import { createService } from '@phoenix/common';
import { errorResponse, HubErrorCode, DefaultPort } from '@phoenix/contracts';

const { listen } = createService({
  name: 'nlu',
  routes: {
    'POST /v1/parse': () =>
      errorResponse('NLU parse not implemented (milestone M5)', HubErrorCode.NOT_IMPLEMENTED),
  },
});

listen(Number(process.env.PORT) || DefaultPort.nlu);
