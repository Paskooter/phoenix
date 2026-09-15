// PROVENANCE CORRECTION (2026-09-15): revision 715e0dd0 is the OWNER'S OWN 2026
// restoration work, not original Jibo code. It is known to be incomplete and is
// NOT an oracle. "Source-exact" below means "matches that restoration", not
// "matches Jibo". The authoritative Jibo source is
// 5c0a7390539663ba749d360de348a428c088505c. Improving on anything attributed to
// 715e0dd0 is permitted and does NOT count as a divergence from Jibo.
// See docs/parity/SOURCES.md.

// LLM fallback NLU client — source-exact restoration of the Pegasus LLM stage.
//
// Pinned source, read through the Jibo archive MCP this session:
//   jiboV2/pegasus@715e0dd0719ecca5164959d713862a1402430623 ("Add LLM fallback
//   NLU client (LM Studio + Gemma) replacing dead Dialogflow"):
//     packages/parser/src/llm/LLMClient.ts
//     packages/parser/src/llm/states.ts
//     packages/parser/src/handlers/ParseRequestHandler.ts
//     packages/parser/src/ParserService.ts
//
// This replaces phoenix's earlier 8-tool scaffold. The source contract:
//   - LLMClientConfig { enabled, url, model, timeoutMs? = 8000, temperature? = 0 }
//     (LLMClient.ts:10-16, 18)
//   - init() state machine: !enabled -> DISABLED; missing url/model -> NOT_READY;
//     otherwise READY (LLMClient.ts:59-72)
//   - handleNLU returns null unless READY (LLMClient.ts:76-79)
//   - a 15-entry INTENT_TOOLS catalog, each with JSON-Schema entity types
//     (LLMClient.ts:36-52)
//   - tool_choice 'auto'; temperature defaults 0 (LLMClient.ts:117-120)
//   - no tool call -> null; tool "unknown" -> null (LLMClient.ts:175-184)
//   - entities are the parsed tool arguments DIRECTLY, not an `.entities` field
//     (LLMClient.ts:186-195)
//   - rules are the request's requested rules, not a fixed ['launch']
//     (LLMClient.ts:196-200)
//   - any error (including the request timeout) -> null (LLMClient.ts:124-128,
//     159-163)
//
// Off by default. The default timeout is 8000 ms, which stays inside the
// gateway's 10 s parser budget (packages/contracts/src/constants.js Timeouts.parser).

// LLMClient.ts:18
import { readFileSync } from 'node:fs';
import { resolveLlmProvider, llmRequestHeaders, llmCompletionsUrl } from '@phoenix/contracts';

export const LLM_DEFAULT_TIMEOUT_MS = 8000;

// llm/states.ts
export const LLM_STATE = Object.freeze({
  NOT_READY: 'NOT_READY',
  READY: 'READY',
  DISABLED: 'DISABLED',
});

// LLMClient.ts:36-52 — name, description and entity JSON-Schema types, verbatim.
export const LLM_INTENT_TOOLS = Object.freeze([
  { name: 'whatsUp', description: 'User greets Jibo or asks how Jibo is doing (e.g. "hey", "what\'s up", "how are you").' },
  { name: 'doYouLike', description: 'User asks whether Jibo likes a particular thing.', entities: { thing: 'string' } },
  { name: 'whoAmI', description: 'User asks Jibo to identify them or asks who Jibo is talking to.' },
  { name: 'tellMeAboutYourself', description: 'User asks Jibo to describe Jibo themselves.' },
  { name: 'tellAJoke', description: 'User asks Jibo to tell a joke or be funny.' },
  { name: 'tellMeATip', description: 'User asks Jibo for a tip, fact, or advice.' },
  { name: 'launchSkill', description: 'User asks Jibo to launch or open a specific skill or feature by name.', entities: { skillId: 'string' } },
  { name: 'whatTimeIsIt', description: 'User asks for the current time.' },
  { name: 'thanks', description: 'User thanks Jibo.' },
  { name: 'goodbye', description: 'User says goodbye, bye, or signals end of conversation.' },
  { name: 'cancel', description: 'User wants to stop, cancel, or never mind whatever is happening.' },
  { name: 'yes', description: 'User affirms (yes, yeah, sure, ok).' },
  { name: 'no', description: 'User declines (no, nope, not now).' },
  { name: 'chitchat', description: 'General small-talk that does not match any specific intent above. Catch-all for friendly conversation.' },
  { name: 'unknown', description: 'Could not confidently classify with any of the available intents.' },
]);

/**
 * The intent catalog generated from Jibo's own parsers: every intent in
 * robust-parser/rules_src plus the Dialogflow agent's, with the scoping the
 * runtime used. See scripts/parity-nlu-catalog/build.mjs and
 * docs/parity/evidence/2026-09-15/nlu-intent-surface/.
 *
 * This exists because the restored catalog above is not Jibo's. Ten of its
 * fifteen names appear nowhere in the reference tree: Jibo had `askForTime`,
 * not `whatTimeIsIt`; `launchWhoAmI`, not `whoAmI`; three distinct joke intents
 * rather than one `tellAJoke`. A classifier that returns an invented name has
 * recognised nothing, because no handler downstream answers to it.
 */
export const SOURCE_INTENT_TOOLS = Object.freeze(
  JSON.parse(readFileSync(new URL('./generatedIntentCatalog.json', import.meta.url), 'utf8')).tools,
);

/**
 * What Jibo could hear with no skill running: the union of every domain's
 * launch.rule -- which the runtime compiled into a single launch.fst -- plus
 * globals, which has no launch.rule because it is never launched into and is
 * simply always loaded. An intent outside this set (timerValue, get_track)
 * exists only once its skill's rule set is loaded, so offering it at idle
 * invites a match the rest of the system cannot act on.
 */
export const SOURCE_IDLE_TOOLS = Object.freeze(
  SOURCE_INTENT_TOOLS.filter((tool) => tool.launch || tool.scope === 'global'),
);

export const LLM_CATALOGS = Object.freeze({
  restored: () => LLM_INTENT_TOOLS,
  source: () => SOURCE_IDLE_TOOLS,
  'source-full': () => SOURCE_INTENT_TOOLS,
});

export const LLM_DEFAULT_CATALOG = 'restored';

/**
 * Select the catalog by name, falling back to the default rather than throwing:
 * a typo in deployment configuration must not take the NLU stage down.
 * @param {string} [name] PHOENIX_LLM_CATALOG
 */
export function resolveIntentCatalog(name = process.env.PHOENIX_LLM_CATALOG) {
  const pick = LLM_CATALOGS[name] || LLM_CATALOGS[LLM_DEFAULT_CATALOG];
  return pick();
}

const SYSTEM_PROMPT = [
  'You are an NLU intent classifier for the Jibo social robot.',
  'You will be given a single user utterance.',
  'Pick the ONE tool whose description best matches the user\'s intent.',
  'If no tool fits well, call "unknown" with no arguments.',
  'Always call exactly one tool. Do not chain tools.',
  'Extract entity arguments verbatim from the utterance when present.',
].join(' ');

function buildTools(catalog = resolveIntentCatalog()) {
  // LLMClient.ts:81-97
  //
  // Two entity shapes are accepted. The restored catalog writes a name -> type
  // map ({ thing: 'string' }) and marks every entity required, which is what
  // the source did. The generated catalog carries a real JSON Schema, with
  // nothing required, because a rule slot is genuinely optional -- "what time
  // is it" fills none of askForTime's four.
  return catalog.map((tool) => {
    const entities = tool.entities;
    const schema = entities && entities.type === 'object'
      ? { type: 'object', properties: entities.properties || {}, required: entities.required || [] }
      : {
        type: 'object',
        properties: entities
          ? Object.keys(entities).reduce((acc, key) => { acc[key] = { type: entities[key] }; return acc; }, {})
          : {},
        required: entities ? Object.keys(entities) : [],
      };
    return { type: 'function', function: { name: tool.name, description: tool.description, parameters: schema } };
  });
}

/**
 * Create an LLM fallback client matching LLMClient.ts.
 *
 * `apiKey` and `headers` are Phoenix additions carried alongside the source's
 * five fields so a hosted OpenAI-compatible provider can be used. They affect
 * only the request headers; with neither set the request is byte-identical to
 * the source's.
 *
 * @param {{enabled?:boolean,url?:string,model?:string,timeoutMs?:number,temperature?:number,apiKey?:string,headers?:object}} [config]
 */
export function createLLMClient(config = {}) {
  const cfg = {
    enabled: Boolean(config.enabled),
    url: config.url || '',
    model: config.model || '',
    timeoutMs: config.timeoutMs,
    temperature: config.temperature,
    apiKey: config.apiKey || '',
    headers: config.headers || {},
    // Which intent catalog this client offers the model. Carried alongside the
    // source's five fields like apiKey/headers; `undefined` defers to
    // PHOENIX_LLM_CATALOG.
    catalog: config.catalog,
  };
  // LLMClient.ts:55 — the constructor leaves the client NOT_READY.
  let state = LLM_STATE.NOT_READY;

  // LLMClient.ts:59-72
  function init() {
    if (!cfg.enabled) { state = LLM_STATE.DISABLED; return state; }
    if (!cfg.url || !cfg.model) { state = LLM_STATE.NOT_READY; return state; }
    state = LLM_STATE.READY;
    return state;
  }

  function timeoutMs() {
    return cfg.timeoutMs != null ? cfg.timeoutMs : LLM_DEFAULT_TIMEOUT_MS;
  }

  // LLMClient.ts:131-168 — POST /chat/completions with a request timeout that
  // aborts; the caller turns any rejection into null.
  async function postChatCompletion(body) {
    const ms = timeoutMs();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      // Headers come from the shared provider layer so any OpenAI-compatible
      // host works. With no API key configured this is exactly the source's
      // `{ 'content-type': 'application/json' }`.
      const res = await fetch(llmCompletionsUrl(cfg) || `${cfg.url.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: llmRequestHeaders(cfg),
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (res.status !== 200) throw new Error(`LLM ${res.status}: ${text.slice(0, 300)}`);
      try { return JSON.parse(text); } catch (error) { throw new Error(`Could not parse LLM JSON: ${error}`); }
    } finally {
      clearTimeout(timer);
    }
  }

  // LLMClient.ts:170-203
  function parseToolCallResponse(response, request) {
    const call = response?.choices?.[0]?.message?.tool_calls?.[0];
    if (!call || !call.function || !call.function.name) return null;
    const intent = call.function.name;
    if (intent === 'unknown') return null;
    let entities = {};
    try {
      const args = call.function.arguments;
      if (args) entities = typeof args === 'string' ? JSON.parse(args) : args;
    } catch { /* logged in source; keep parsing failure as empty entities */ }
    return { intent, entities, rules: request.rules || [] };
  }

  // LLMClient.ts:76-129
  async function handleNLU(request) {
    if (state !== LLM_STATE.READY) return null;
    try {
      const response = await postChatCompletion({
        model: cfg.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Utterance: "${request.text}"` },
        ],
        tools: buildTools(cfg.catalog ? resolveIntentCatalog(cfg.catalog) : undefined),
        tool_choice: 'auto',
        temperature: cfg.temperature != null ? cfg.temperature : 0,
      });
      return parseToolCallResponse(response, request);
    } catch {
      return null;
    }
  }

  return {
    get state() { return state; },
    get enabled() { return state === LLM_STATE.READY; },
    config: cfg,
    timeoutMs,
    init,
    handleNLU,
  };
}

export function envLlmConfig() {
  // Endpoint resolution is shared (see @phoenix/contracts llmProvider): the
  // historical ETCO_parser_llm* names still win, with PHOENIX_LLM_* as the
  // deployment-wide fallback, plus an optional bearer token and extra headers.
  const resolved = resolveLlmProvider('parser', { defaultModel: 'gemma-3' });
  return {
    // The source has an explicit `enabled` flag; phoenix keeps the historical
    // ETCO_parser_llmUrl switch and honours an explicit enable as well.
    enabled: process.env.ETCO_parser_llmEnabled === 'true' || Boolean(resolved.url),
    url: resolved.url,
    model: resolved.model,
    apiKey: resolved.apiKey,
    headers: resolved.headers,
    timeoutMs: resolved.timeoutMs,
    temperature: resolved.temperature,
  };
}

let defaultClient;
export function getLLMClient() {
  if (!defaultClient) {
    defaultClient = createLLMClient(envLlmConfig());
    defaultClient.init();
  }
  return defaultClient;
}

/**
 * Backward-compatible entry used by the legacy parse(text) pipeline.
 * @param {string} text
 * @param {{rules?:string[]}} [request]
 * @returns {Promise<null|{intent:string,entities:object,rules:string[]}>}
 */
export async function llmFallback(text, request = {}) {
  if (!text) return null;
  return getLLMClient().handleNLU({ ...request, text });
}
