// Decision layer: a fast typed classifier that reviews the grammar's parse of a
// global turn ("Hey Jibo, ...") and collapses other ways of saying a command
// onto the command itself.
//
// Jibo's grammar knows the phrasings it was written for. Anything else misses,
// comes back as a LOW parse, or lands in a catch-all question rule, so "what day
// is it today" went to the knowledge search while "what's today's date" got the
// date. The original cloud asked Dialogflow after a non-HIGH parse; that service
// is gone, and Phoenix's Laya and LLM intent fallbacks are disabled (Laya failed
// its holdout; see docs/LAYA-INTENT.md).
//
// This layer asks one question of a decision model: which of a short list of
// commands the person wants. A chosen command is answered with the grammar's own
// parse of that command's canonical phrase, so the turn reaches the skill exactly
// as the phrase the grammar was written for does. Nothing here invents an
// intent, an entity or a skill.
//
// When it asks, and what may change:
//   review          the grammar missed, gave a non-HIGH parse, or chose a
//                   catch-all question rule: a command or a knowledge question
//                   at minProbability or above replaces the parse.
//   second opinion  any other HIGH parse that is not already one of these
//                   commands (chitchat, a screen command, a misheard fragment):
//                   only a command at overrideProbability or above replaces it.
//   never           a turn that is not a global one (a skill waiting for its
//                   own answers), or a parse that already names a command.
// Chitchat, "none", a low probability, a timeout or any error keeps the
// grammar's parse, so the worst case is today's behaviour.
//
// The engine is Jev (TypeSafe's typed decision model) through OpenRouter's
// decisions endpoint. It returns one of the listed options with calibrated
// probabilities and cannot answer outside the list. See docs/DECISION-LAYER.md
// for the evaluation behind the commands, wording and thresholds.

import { logger } from '@phoenix/common';
import { parseRequestDetailedAsync } from './requestParser.js';

const log = logger('nlu.decision');

/**
 * The commands the layer can choose, each with the canonical phrase whose
 * grammar parse it answers with and the intent that parse must produce. The
 * descriptions are the evaluated wording; change them only with a fresh run of
 * scripts/decision-layer-eval.mjs.
 */
export const DECISION_COMMANDS = Object.freeze({
  time: { phrase: 'what time is it', intent: 'askForTime', description: 'Asks for the current time of day.' },
  date: { phrase: "what's today's date", intent: 'askForDate', description: "Asks for today's date, the day of the week, or the month." },
  weather_today: { phrase: "what's the weather", intent: 'requestWeatherPR', description: 'Asks about the weather, temperature, rain, or what to wear today or right now, where they are.' },
  weather_tomorrow: { phrase: "what's the weather tomorrow", intent: 'requestWeatherPR', description: 'Asks about the weather, temperature or rain tomorrow, where they are.' },
  news: { phrase: 'tell me the news', intent: 'requestNews', description: 'Wants to hear the news, headlines or current events.' },
  report: { phrase: 'give me my report', intent: 'launchPersonalReport', description: 'Wants their personal report or daily briefing (weather, calendar, commute and news together).' },
  calendar: { phrase: "what's on my calendar", intent: 'requestCalendar', description: 'Asks about their own calendar, schedule, appointments or meetings.' },
  commute: { phrase: "how's my commute", intent: 'requestCommute', description: 'Asks about traffic or how long their drive or commute will take.' },
  photo: { phrase: 'take a picture', intent: 'createOnePhoto', description: 'Wants Jibo to take a photo or selfie now.' },
  gallery: { phrase: 'show me my photos', intent: 'galleryOpen', description: 'Wants to see photos Jibo has already taken.' },
  who_am_i: { phrase: 'who am i', intent: 'launchWhoAmI', description: 'Asks Jibo to recognize or name the person speaking.' },
  what_can_you_do: { phrase: 'what can you do', intent: 'whatCanIDo', description: 'Asks what Jibo can do or how Jibo can help.' },
  game: { phrase: "let's play a game", intent: 'launchGame', description: 'Wants to play a game with Jibo.' },
  dance: { phrase: 'dance', intent: 'requestDance', description: 'Wants Jibo to dance.' },
  sing: { phrase: 'sing me a song', intent: 'requestSingSong', description: 'Wants Jibo to sing.' },
  joke: { phrase: 'tell me a joke', intent: 'requestTellJiboContent', description: 'Wants a joke or something to make them laugh.' },
  fun_fact: { phrase: 'tell me a fun fact', intent: 'requestTellJiboContent', description: 'Wants a fun fact or to learn something interesting.' },
  volume_up: { phrase: 'turn up the volume', intent: 'volumeUp', description: 'Wants Jibo to speak louder or turn the volume up.' },
  volume_down: { phrase: 'turn down the volume', intent: 'volumeDown', description: 'Wants Jibo to speak more quietly or turn the volume down.' },
  knowledge: { description: 'A general knowledge or factual question about the world: people, places, history, science, math, words or measurements.' },
  chitchat: { description: "Small talk with Jibo: about Jibo himself, feelings, greetings, thanks, compliments, or the person's own mood." },
  none: { description: 'Something Jibo cannot do (shopping, calls, messages, smart-home control, navigation, money) or that is unclear.' },
});

export const DECISION_INSTRUCTIONS = 'A person just said this to Jibo, a social home robot. Which of these do they want?';
const CRITERIA = Object.freeze(Object.fromEntries(Object.entries(DECISION_COMMANDS).map(([key, { description }]) => [key, description])));
const COMMAND_INTENTS = new Set(Object.values(DECISION_COMMANDS).map(({ intent }) => intent).filter(Boolean));

// Grammar rules that catch any question of a shape and send it to the knowledge
// search. Their parse is a guess about the kind of sentence, not a decision
// about what the person wants.
export const CATCH_ALL_INTENTS = Object.freeze(new Set([
  'generalQuestions', 'generalWhatQuestions', 'generalWhoQuestions', 'generalHowQuestions',
  'generalWhenQuestions', 'generalWhereQuestions', 'generalWhyQuestions',
  'requestWeather', 'requestTellAboutThing', 'whatDoesThingMean',
]));
// A question about a named person already belongs to the knowledge search.
const KNOWLEDGE_INTENTS = new Set([...CATCH_ALL_INTENTS, 'whoIsPerson']);
// What the knowledge search is reached with when the grammar found no question rule.
const KNOWLEDGE_NLU = Object.freeze({ intent: 'generalQuestions', entities: {}, rules: ['launch'] });

const DEFAULT_URL = 'https://openrouter.ai/api/alpha/decisions';
const DEFAULT_MODEL = 'typesafe/jev-1.13';
const DEFAULT_TIMEOUT_MS = 800;
const DEFAULT_MIN_PROBABILITY = 0.5;
const DEFAULT_OVERRIDE_PROBABILITY = 0.9;

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (value === undefined || value === '' || !Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (value === undefined || value === '' || !Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

/** The layer's settings. It is off unless an engine and its key are both configured. */
export function decisionConfig(env = process.env) {
  const engine = String(env.ETCO_parser_decisionEngine || '').trim().toLowerCase() === 'jev' ? 'jev' : 'off';
  const apiKey = String(env.ETCO_parser_decisionApiKey || env.OPENROUTER_API_KEY || '').trim();
  const url = String(env.ETCO_parser_decisionUrl || DEFAULT_URL).trim();
  return {
    enabled: engine === 'jev' && Boolean(apiKey) && /^https?:\/\//.test(url),
    engine,
    url,
    apiKey,
    model: String(env.ETCO_parser_decisionModel || DEFAULT_MODEL).trim() || DEFAULT_MODEL,
    timeoutMs: boundedInteger(env.ETCO_parser_decisionTimeoutMs, DEFAULT_TIMEOUT_MS, 50, 5_000),
    minProbability: boundedNumber(env.ETCO_parser_decisionMinProbability, DEFAULT_MIN_PROBABILITY, 0, 1),
    overrideProbability: boundedNumber(env.ETCO_parser_decisionOverrideProbability, DEFAULT_OVERRIDE_PROBABILITY, 0, 1),
  };
}

/** A well-formed answer: one of the listed options, which is also the most probable one. */
function validAnswer(answer) {
  if (!answer || typeof answer !== 'object' || typeof answer.choice !== 'string') return null;
  if (!Object.hasOwn(CRITERIA, answer.choice)) return null;
  const probabilities = answer.probabilities;
  if (!probabilities || typeof probabilities !== 'object' || Array.isArray(probabilities)) return null;
  const values = Object.values(probabilities);
  if (!values.length || values.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)) return null;
  const probability = probabilities[answer.choice];
  if (typeof probability !== 'number' || probability < Math.max(...values)) return null;
  return { choice: answer.choice, probability };
}

/**
 * @param {Partial<ReturnType<typeof decisionConfig>> & {fetch?: typeof fetch}} [input]
 */
export function createDecisionClient(input = {}) {
  const config = { ...decisionConfig(), ...input };
  const fetchImpl = input.fetch || globalThis.fetch;
  /** @returns {Promise<null|{choice:string, probability:number}>} */
  async function choose(text) {
    if (!config.enabled || !text || typeof fetchImpl !== 'function') return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await fetchImpl(config.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: config.model,
          state: { utterance: text },
          questions: { command: { type: 'choice', instructions: DECISION_INSTRUCTIONS, criteria: CRITERIA } },
        }),
        signal: controller.signal,
      });
      if (response.status !== 200) {
        log.warn('decision engine refused', { status: response.status });
        return null;
      }
      const body = await response.json();
      return validAnswer(body?.answers?.command);
    } catch (error) {
      log.warn('decision engine unavailable', { error: error?.name === 'AbortError' ? 'timeout' : error?.message });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    get enabled() { return Boolean(config.enabled); },
    get config() { return { ...config, apiKey: config.apiKey ? '[configured]' : '' }; },
    choose,
  };
}

let defaultClient;
export function getDecisionClient() {
  if (!defaultClient) defaultClient = createDecisionClient();
  return defaultClient;
}

/** Replace (or, with no argument, reset) the process-wide client. */
export function setDecisionClientForTest(client) {
  defaultClient = client;
}

/**
 * A "Hey Jibo" turn asks for `launch` and the global rules only. A skill that is
 * waiting for its own answers asks for its own rules, and is never second-guessed.
 */
export function isGlobalTurn(rules) {
  return Array.isArray(rules) && rules.includes('launch')
    && rules.every((rule) => rule === 'launch' || (typeof rule === 'string' && rule.startsWith('globals/')));
}

/**
 * Whether a parse gets reviewed, a second opinion, or neither.
 * @param {{nlu?: object, priority?: string}|null} parsed
 * @param {string[]} rules the request's rules
 * @returns {'review'|'second-opinion'|null}
 */
export function decisionKind(parsed, rules) {
  if (!isGlobalTurn(rules)) return null;
  const nlu = parsed?.nlu;
  if (!nlu?.intent) return 'review';
  // The report grammars spell it `high`; the source compares case-sensitively.
  if (String(parsed.priority || '').toUpperCase() !== 'HIGH') return 'review';
  if (CATCH_ALL_INTENTS.has(nlu.intent)) return 'review';
  if (COMMAND_INTENTS.has(nlu.intent) || KNOWLEDGE_INTENTS.has(nlu.intent)) return null;
  return 'second-opinion';
}

const canonicalCache = new Map();
/** The grammar's own parse of a command's canonical phrase, for these rules. */
async function canonicalNlu(key, rules) {
  const command = DECISION_COMMANDS[key];
  const cacheKey = `${key}\u0000${rules.join('\u0000')}`;
  if (!canonicalCache.has(cacheKey)) {
    canonicalCache.set(cacheKey, parseRequestDetailedAsync({ text: command.phrase, rules: [...rules] }).then((parsed) => {
      if (parsed?.nlu?.intent !== command.intent) {
        // The grammar no longer parses the phrase the way this table expects;
        // answering with that parse could launch something unintended.
        log.warn('decision command phrase no longer parses as expected', { command: key, intent: parsed?.nlu?.intent ?? null });
        return null;
      }
      return parsed.nlu;
    }, () => null));
  }
  const nlu = await canonicalCache.get(cacheKey);
  return nlu ? structuredClone(nlu) : null;
}

/**
 * Review a grammar parse. Returns the NLU result to use instead, or null to keep
 * the grammar's own result (and continue with the existing fallbacks).
 *
 * @param {{text: string, rules?: string[]}} request
 * @param {{nlu?: object, priority?: string}|null} parsed
 * @param {{client?: ReturnType<typeof createDecisionClient>}} [options]
 */
export async function decideCommand(request, parsed, { client = getDecisionClient() } = {}) {
  const rules = Array.isArray(request?.rules) ? request.rules : [];
  const kind = decisionKind(parsed, rules);
  if (!kind || !client?.enabled || typeof request?.text !== 'string' || !request.text.trim()) return null;
  const started = Date.now();
  const answer = await client.choose(request.text);
  const elapsedMs = Date.now() - started;
  const from = parsed?.nlu?.intent ?? null;
  if (!answer) return null;
  const { choice, probability } = answer;
  const command = DECISION_COMMANDS[choice];
  let result = null;
  if (command.intent) {
    const needed = kind === 'review' ? client.config.minProbability : client.config.overrideProbability;
    if (probability >= needed && command.intent !== from) result = await canonicalNlu(choice, rules);
  } else if (choice === 'knowledge' && kind === 'review' && probability >= client.config.minProbability
    && !KNOWLEDGE_INTENTS.has(from)) {
    result = structuredClone(KNOWLEDGE_NLU);
  }
  // Intents and probabilities only: the utterance itself is never logged.
  const fields = { kind, from, choice, probability: Number(probability.toFixed(3)), ms: elapsedMs };
  if (result) log.info('decision changed the parse', { ...fields, to: result.intent });
  else log.debug('decision kept the parse', fields);
  return result;
}
