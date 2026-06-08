// Grammar matcher — the deterministic stage of NLU (Pegasus parser stage 1, the FST engine).
//
// This is a hand-written rule set covering the core "launch" question intents that route to
// answer-skill. It is intentionally small and explicit; milestone M5's full plan is to port the
// reference's 117 .rule grammars (risk R1). Returns a reference-shaped NLUResult: matched intents
// carry rules:['launch']; no match yields {intent:null, rules:[], entities:{}} (gotcha #7).
//
// Text is lowercased + trimmed first (parser normalizes; FSTs are lowercase-only).

const RULES = [
  { re: /^who\s+(?:is|was|are|were)\s+(.+)$/, intent: 'generalWhoQuestions', entity: 'person' },
  { re: /^what(?:'s| is| are| was)\s+(.+)$/, intent: 'generalWhatQuestions', entity: 'thing' },
  { re: /^when\s+(?:is|was|did|does|do|will)\s+(.+)$/, intent: 'generalWhenQuestions', entity: 'thing' },
  { re: /^where\s+(?:is|was|are|can|do|does)\s+(.+)$/, intent: 'generalWhereQuestions', entity: 'thing' },
  { re: /^why\s+(.+)$/, intent: 'generalWhyQuestions', entity: 'thing' },
  { re: /^how\s+(.+)$/, intent: 'generalHowQuestions', entity: 'thing' },
  { re: /^(?:tell me about|tell me|what do you know about)\s+(.+)$/, intent: 'requestTellAboutThing', entity: 'thing' },
  { re: /^(?:define|definition of)\s+(.+)$/, intent: 'generalWhatQuestions', entity: 'thing' },
];

const NO_MATCH = Object.freeze({ rules: [], intent: null, entities: {} });

/**
 * @param {string} text raw ASR text
 * @returns {{rules:string[], intent:(string|null), entities:object}}
 */
export function grammarParse(text) {
  const norm = String(text || '').trim().toLowerCase().replace(/[?.!]+$/, '').trim();
  if (!norm) return { ...NO_MATCH };
  for (const r of RULES) {
    const m = norm.match(r.re);
    if (m) {
      const entities = {};
      if (r.entity && m[1]) entities[r.entity] = m[1].trim();
      return { rules: ['launch'], intent: r.intent, entities };
    }
  }
  return { ...NO_MATCH };
}
