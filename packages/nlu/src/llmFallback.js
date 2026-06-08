// LLM fallback NLU — phoenix's replacement for the dead Dialogflow stage (parser/src/llm,
// commit 715e0dd0). Calls an OpenAI-compatible /chat/completions with a small tool catalog so a
// single tool call = intent + entities. Off unless ETCO_parser_llmUrl is set; returns null when
// disabled or on any failure (so the parser falls through to the grammar's no-match result).
//
// This is a faithful-but-minimal scaffold for M5: the intent catalog mirrors the answer-skill
// question intents. Expand the catalog + entity extraction as the corpus demands.

const LLM_URL = process.env.ETCO_parser_llmUrl || '';
const LLM_MODEL = process.env.ETCO_parser_llmModel || 'gemma-3';
const LLM_TIMEOUT_MS = Number(process.env.ETCO_parser_llmTimeoutMs) || 12000;

const INTENT_TOOLS = [
  'generalWhoQuestions', 'generalWhatQuestions', 'generalWhenQuestions',
  'generalWhereQuestions', 'generalWhyQuestions', 'generalHowQuestions',
  'requestTellAboutThing', 'chitChat',
].map((name) => ({
  type: 'function',
  function: {
    name,
    description: `Classify the utterance as the "${name}" intent`,
    parameters: { type: 'object', properties: { entities: { type: 'object' } } },
  },
}));

/**
 * @param {string} text
 * @returns {Promise<null|{rules:string[], intent:string, entities:object}>}
 */
export async function llmFallback(text) {
  if (!LLM_URL || !text) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LLM_TIMEOUT_MS);
  try {
    const res = await fetch(`${LLM_URL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: 'system', content: 'Classify the user utterance by calling exactly one intent tool. Put any extracted slots in `entities`.' },
          { role: 'user', content: text },
        ],
        tools: INTENT_TOOLS,
        tool_choice: 'required',
        temperature: 0,
        stream: false,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const json = await res.json();
    const call = json?.choices?.[0]?.message?.tool_calls?.[0];
    if (!call) return null;
    let entities = {};
    try { entities = JSON.parse(call.function.arguments || '{}').entities || {}; } catch { /* ignore */ }
    return { rules: ['launch'], intent: call.function.name, entities };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
