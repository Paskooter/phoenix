// NLU service (Pegasus parser equivalent). Milestone M5.
//
// POST /v1/parse : body = { type:'NLU', data:{ text, rules, loop?, external? } }
//              -> { type:'NLU', data: NLUResult }   (hub reads response.data.data, gotcha #8)
//
// Two-stage pipeline mirroring the reference (ParseRequestHandler.ts):
//   1. grammar match (deterministic). A confident match short-circuits.
//   2. LLM fallback (phoenix: LM Studio + Gemma tool-calling) when grammar misses AND
//      ETCO_parser_llmUrl is configured. Off by default -> a miss returns the no-match NLUResult.

import { createService, sendJson } from '@phoenix/common';
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
  // Stage 1: grammar — the REAL grammar union first (the reference has exactly one
  // grammar pass: the robust-parser FST union). The corpus runner proved the legacy
  // stages were shadowing it: the sim-vendored who-am-i/clock grammars (no weights)
  // short-circuited with selfID/askForDay on utterances the real grammars parse
  // correctly (im hungry -> userIsDescriptor, do you like christmas ->
  // doesJiboLikeThing). Legacy stages remain only as fallbacks for anything the
  // real union misses.
  let parser = null;
  const full = fullParse(text);
  if (full && (full.intent || (full.entities && full.entities.skill))) parser = full;
  if (!parser) {
    const launch = await launchParse(text);
    if (launch && (launch.intent || (launch.entities && launch.entities.skill))) parser = launch;
  }
  if (!parser) {
    const g = grammarParse(text);
    if (g.intent) parser = g;
  }
  // GQA continuity (DIVERGENCE B6): the reference sends general-knowledge questions
  // to chitchat, whose GQA path deflected to Wolfram (dead). Phoenix answers them via
  // answer-skill (Wikipedia/LLM) instead.
  if (parser) parser = applyGqaContinuity(parser);
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

// DIVERGENCE B6 — GQA continuity. The real union parses knowledge questions into
// chitchat intents (whoIsPerson{GivenName,LastName}, requestTellAboutThing,
// general*Questions) and the reference routed them to chitchat, whose GQA path was
// a Wolfram deflector (dead service). Phoenix instead answers them: remap to the
// general* intents the answer-skill manifest registers (answer-skill is registered
// before chitchat, so the intent decision tree picks it on ties), carrying the
// subject as the person/thing entity. Personality questions (about Jibo/the user)
// are untouched — the GQA deflector keeps them with chitchat.
function applyGqaContinuity(parser) {
  const ent = parser.entities || {};
  const intent = parser.intent || '';
  const subject = [ent.GivenName, ent.LastName].filter(Boolean).join(' ') || ent.Thing || ent.thing || '';
  if (intent === 'whoIsPerson') {
    const entities = { ...ent, person: subject };
    delete entities.skill;
    return { ...parser, intent: 'generalWhoQuestions', entities };
  }
  if (intent === 'requestTellAboutThing' || intent === 'whatDoesThingMean' || intent === 'whatIsThing') {
    const entities = { ...ent, thing: subject };
    delete entities.skill;
    return { ...parser, intent: intent === 'requestTellAboutThing' ? 'requestTellAboutThing' : 'generalWhatQuestions', entities };
  }
  if (/^general\w*Questions$/.test(intent) && ent.skill === '@be/chitchat') {
    const entities = { ...ent };
    delete entities.skill;
    return { ...parser, entities };
  }
  // Weather continuity: chitchat's requestWeather memo was a deflector ("ask the
  // report") — phoenix routes weather questions straight to report-skill's weather
  // subskill (requestWeatherPR), which is what the deflector pointed users at.
  if (intent === 'requestWeather') {
    const entities = { ...ent };
    delete entities.skill;
    return { ...parser, intent: 'requestWeatherPR', entities };
  }
  return parser;
}

export function start(port = Number(process.env.PORT) || DefaultPort.nlu) {
  const svc = createService({
    name: 'nlu',
    routes: {
      'POST /v1/parse': async ({ body, res }) => {
        // Reference ParseRequestHandler.ts:28-30 — 400 on a malformed request
        // (data.text must be a string), not a silent coercion to ''.
        if (!body || !body.data || typeof body.data.text !== 'string') {
          sendJson(res, 400, { error: `Bad request: ${JSON.stringify(body)}` });
          return undefined;
        }
        const nlu = await parse(body.data.text);
        return message(ResponseType.NLU, nlu); // { type:'NLU', msgID, ts, data: NLUResult }
      },
      // Reference StateRequestHandler: GET /state -> ServiceStateData. Phoenix's
      // grammar engine is in-process (no robust-parser subprocess) and Dialogflow
      // is dead-era, so those report their steady-state equivalents.
      'GET /state': () => ({
        state: 'RUNNING',
        robustParserProcess: 'RUNNING',
        robustParserClient: 'CONNECTED',
        dialogflowClient: 'CLOSED',
        llmClient: process.env.ETCO_parser_llmUrl ? 'READY' : 'DISABLED',
      }),
    },
  });
  return svc.listen(port);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch((e) => { console.error(e); process.exit(1); });
}
