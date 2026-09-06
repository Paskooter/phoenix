// Source-backed GQA answer service slice.
//
// This module follows the standalone srv-gqa-ws Pegasus path at
// jiborobot/srv-gqa-ws@ebe1a7d38f511570060c1fbf61bec89d58419b26:
// gqa/gqa.py:gqa_pegasus -> choose_slim -> make_response_for_hub and
// gqa/pegasus_mims.py.  It is deliberately exposed as a factory.  The
// existing Phoenix answer-skill handler remains an explicit Phoenix profile;
// callers that have a replaceable GQA provider can host this handler under
// the original `answer` registration without changing the shared registry.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newJcpId } from './jcpId.js';

export const GQA_SOURCE_REVISION = 'ebe1a7d38f511570060c1fbf61bec89d58419b26';
export const GQA_VERSION = '5.2.15';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const MIM_DIR = join(MODULE_DIR, '../resources/mims/gqa');
const MIM_NAMES = [
  'GQA_error',
  'GQA_no_answer_generic',
  'GQA_no_answer_how',
  'GQA_no_answer_what',
  'GQA_no_answer_when',
  'GQA_no_answer_where',
  'GQA_no_answer_which',
  'GQA_no_answer_who',
  'GQA_no_answer_why',
  'GQA_pii_filter',
];

function loadMim(name) {
  const value = JSON.parse(readFileSync(join(MIM_DIR, `${name}.mim`), 'utf8'));
  // The original loader derives a missing id from the filename.  The
  // recovered Pegasus files intentionally have no mim_id field.
  if (!value.mim_id) value.mim_id = name;
  return value;
}

const MIMS = Object.freeze(Object.fromEntries(MIM_NAMES.map((name) => [name, loadMim(name)])));

// This list is the question-word list used by gqa/nlp.py.  Keeping it here
// preserves the source cleaning boundary before a provider sees the query.
const WH_PHRASES = [
  'what', 'where', 'when', 'who', 'how', 'which',
  'waddya', 'watcha', 'whadaya', 'whadda', 'whaddaya', 'whaddo', 'whaddya',
  'whadiya', 'whadja', 'whadya', 'whatcha', 'whatchu', 'whatchya', "what's",
  "what'd", "what'll", "what'm", "what're", "what've", 'whatya',
  "when'd", "whene'er", "when'll", "when's", 'where\'d', 'wheredja',
  "where'er", "where'm", "where're", "where's", "where've", "who'd",
  "who'da", "who'd've", "who'll", "who'm", "who're", "who's", "who've",
  'whoze', 'wossat', 'wossit', 'wotcha',
];
// Longest-first preserves contractions (for example `what's`) before their
// shorter `what` member when the alternatives share a word boundary.
const WH_REMOVAL_RE = new RegExp(`^.*?\\b(${WH_PHRASES.slice().sort((a, b) => b.length - a.length).map(escapeRegExp).join('|')})\\b`, 'i');
const JIBO_REMOVAL_RE = /^((hey )?Jibo)+\s*/i;
const PHONE_RE_1 = /(?:(?<![\d-])(?:\+?\d{1,3}[-.\s*]?)?(?:\(?\d{3}\)?[-.\s*]?)?\d{3}[-.\s*]?\d{4}(?![\d-]))/;
const PHONE_RE_2 = /(?:(?<![\d-])(?:(?:\(\+?\d{2}\))|(?:\+?\d{2}))\s*\d{2}\s*\d{3}\s*\d{4}(?![\d-]))/;
const EMAIL_RE = /([a-z0-9!#$%&'*+\/=?^_`{|.}~-]+@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)/i;
const CREDIT_CARD_RE = /((?:(?:\d{4}[- ]?){3}\d{4}|\d{15,16}))(?![\d])/;
const SSN_RE = /\d{3}-?\d{2}-?\d{4}/;

const INTENT_TO_QUESTION_TYPE = Object.freeze({
  gqa: 'generic',
  generalHowQuestions: 'how',
  generalWhatQuestions: 'what',
  generalWhenQuestions: 'when',
  generalWhereQuestions: 'where',
  generalWhichQuestions: 'which',
  generalWhoQuestions: 'who',
  generalWhyQuestions: 'why',
  whenIsBirthday: 'when',
  whoIsPerson: 'who',
  whereIsPerson: 'where',
  isUnknownDescriptor: 'generic',
  whyIsUnknownDescriptor: 'why',
  howDescriptorIsUnknown: 'how',
  howDescriptorIsPerson: 'how',
  scripted: 'scripted',
});
const SCRIPTED_MIM_TO_QUESTION_TYPE = Object.freeze({
  USR_HowOldAmI: 'how',
  USR_WhoIsLoopMember: 'who',
  RN_WhereIsLoopMember: 'where',
  KU_WhereIsMy: 'where',
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Source gqa.get_question_type(request_data), including scripted MIM aliases. */
export function getGqaQuestionType(request) {
  // gqa.py indexes these members directly. Valid source requests always carry
  // the NLU object; leaving the access direct keeps malformed requests visible
  // instead of converting them into a generic answer.
  const nlu = request.data.result.nlu;
  let type = INTENT_TO_QUESTION_TYPE[sourceString(nlu.intent)] || 'generic';
  if (type === 'scripted') type = SCRIPTED_MIM_TO_QUESTION_TYPE[sourceString(nlu.entities.mimId)] || 'generic';
  return type;
}

/** Source gqa.nlp.clean_input for the question text boundary. */
export function cleanGqaInput(value) {
  const text = String(value).replace(/\?/g, '');
  return text.replace(WH_REMOVAL_RE, '$1').replace(JIBO_REMOVAL_RE, '').trim();
}

/** Source gqa.nlp.pii_filter for the request-level internal block. */
export function gqaPiiFilter(text) {
  return PHONE_RE_1.test(text)
    || PHONE_RE_2.test(text)
    || EMAIL_RE.test(text)
    || CREDIT_CARD_RE.test(text)
    || SSN_RE.test(text);
}

/** Source random.choices([questionType, generic], weights=[.25, .75]). */
export function chooseGqaNoAnswerType(questionType, rng = Math.random) {
  return weightedChoice([
    { value: questionType, weight: 0.25 },
    { value: 'generic', weight: 0.75 },
  ], rng);
}

function weightedChoice(entries, rng) {
  const total = entries.reduce((sum, entry) => sum + (entry.weight || 1), 0);
  let remaining = rng() * total;
  for (const entry of entries) {
    remaining -= entry.weight || 1;
    if (remaining <= 0) return entry.value;
  }
  return entries[entries.length - 1].value;
}

/** Source random.choices over one MIM's prompt list. */
export function chooseGqaPrompt(mim, rng = Math.random) {
  const entries = (mim.prompts || []).map((prompt) => ({ value: prompt, weight: prompt.weight || 1 }));
  return weightedChoice(entries, rng);
}

function sourceFloat(value) {
  return { __gqaSourceFloat: value };
}

function sourceString(value) {
  // Python's str(None), used by the original route for request fields, is
  // spelled `None`; all ordinary source requests carry strings/numbers.
  return value === null || value === undefined ? 'None' : String(value);
}

// Python's json.dumps, used by create_text_display, emits spaces after
// separators, escapes non-ASCII by default, and keeps 640.0 as a float. A
// small recursive serializer keeps the DISPLAY context string source-shaped
// without depending on Python at runtime.
export function sourceJsonDumps(value) {
  if (value && typeof value === 'object' && value.__gqaSourceFloat !== undefined) {
    return `${value.__gqaSourceFloat}.0`;
  }
  if (Array.isArray(value)) return `[${value.map(sourceJsonDumps).join(', ')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${sourceJsonDumps(item)}`).join(', ')}}`;
  }
  if (typeof value === 'string') return escapeNonAscii(JSON.stringify(value));
  return JSON.stringify(value);
}

function escapeNonAscii(jsonString) {
  return jsonString.replace(/[\u0080-\uFFFF]/g, (character) => {
    const code = character.charCodeAt(0).toString(16).padStart(4, '0');
    return `\\u${code}`;
  });
}

/** Exact object shape from gqa/pegasus_mims.py:create_text_display. */
export function createGqaTextDisplay(textToShow, idFactory = newJcpId) {
  const componentConfigs = [{
    id: 'bottom',
    type: 'Label',
    text: `"${textToShow}"`,
    style: {
      fontSize: '120',
      fontFamily: 'Proxima Nova Soft',
      fontStyle: 'bold',
      fill: '#b6b6c2',
      wordWrap: true,
      wordWrapWidth: 1240,
      align: 'center',
    },
    position: { x: sourceFloat(1280 / 2), y: sourceFloat(720 / 2) },
    targetAnchor: { x: 0.5, y: 0.5 },
  }];
  const viewConfig = {
    componentConfigs,
    viewConfig: { type: 'View', id: 'helpful_gqa_text' },
    open: { transitionOpen: 'trans_in', removeAll: true },
  };
  const mimGui = {
    type: 'Javascript',
    data: sourceJsonDumps(viewConfig),
    pause: true,
  };
  const skillDisplay = {
    type: 'SKILL',
    name: 'MIM_VIEW',
    context: mimGui,
  };
  return {
    id: idFactory(),
    type: 'DISPLAY',
    name: 'GQA_NO_ANSWER_VIEW',
    view: skillDisplay,
    layer: 0,
    visible: true,
    keepDisplay: false,
    onCancel: { type: 'HIDE_DISPLAY', name: 'HIDE_MIM_VIEW' },
  };
}

/** Exact source slim_from_text shape. */
export function buildGqaSlimFromText(text, sourceId, idFactory = newJcpId) {
  const play = {
    id: idFactory(),
    type: 'PLAY',
    esml: text,
    meta: { prompt_id: sourceId },
  };
  return {
    id: idFactory(),
    type: 'SLIM',
    config: { play },
  };
}

/** Exact source slim_from_mim shape, including optional no-answer DISPLAY. */
export function buildGqaSlimFromMim(mimId, textToShow, { rng = Math.random, idFactory = newJcpId } = {}) {
  const mim = MIMS[mimId];
  if (!mim) throw new Error(`Unknown GQA MIM '${mimId}'`);
  const prompt = chooseGqaPrompt(mim, rng);
  const play = {
    id: idFactory(),
    type: 'PLAY',
    esml: prompt.prompt,
    meta: { prompt_id: prompt.prompt_id },
  };
  return {
    id: idFactory(),
    type: 'SLIM',
    config: {
      play,
      display: textToShow ? createGqaTextDisplay(textToShow, idFactory) : null,
    },
  };
}

export function gqaMimPromptIds(mimId) {
  const mim = MIMS[mimId];
  if (!mim) throw new Error(`Unknown GQA MIM '${mimId}'`);
  return mim.prompts.map((prompt) => prompt.prompt_id);
}

/** Source analytics.build_skill_entry_analytics(request). */
export function buildGqaSkillEntryAnalytics(request) {
  const launch = request?.type === 'LISTEN_LAUNCH';
  return {
    event: 'Skill Entry',
    properties: {
      initial_intent: 'n/a',
      domain: '',
      was_hey_jibo_launch: launch,
      user_initiated: launch,
      last_skill: 'n/a',
    },
  };
}

/** Source analytics.build_answer_analytics(output). */
export function buildGqaAnswerAnalytics(output) {
  let source;
  let category;
  const success = Object.prototype.hasOwnProperty.call(output, 'source');
  if (success) {
    if (output.source === 'Bing') source = 'bing';
    else if (output.source === 'Wolfram Alpha') source = 'wolfram';
    else if (output.source === 'Wikipedia') source = 'wiki';
    if (Object.prototype.hasOwnProperty.call(output, 'type')) category = output.type;
  }
  const properties = { success };
  if (source) properties.type = source;
  if (category) properties.category = category;
  return { event: 'Answer Query', properties };
}

function buildGqaTimings(start, end, providerTimings = {}) {
  const elapsed = Math.max(0, end - start);
  return {
    ...providerTimings,
    initialization_part: providerTimings.initialization_part ?? 0,
    finalization_part: providerTimings.finalization_part ?? elapsed / 1000,
    total: providerTimings.total ?? elapsed,
  };
}

/** Source make_response_for_hub, represented as an object for the Phoenix host. */
export function buildGqaResponse({ jcp, timings, analytics, skillId = 'answer', messageId = randomUUID }) {
  return {
    type: 'SKILL_ACTION',
    msgID: messageId(),
    data: {
      skill: { id: skillId, version: GQA_VERSION },
      action: { type: 'JCP', config: { version: '2.0', jcp } },
      analytics,
      final: true,
      fireAndForget: true,
    },
    timings,
  };
}

function requestContext(request, queryText, questionType) {
  const data = request.data;
  const location = data.runtime.location;
  const general = data.general;
  return {
    request,
    queryText,
    questionType,
    latitude: sourceString(location.lat),
    longitude: sourceString(location.lng),
    countryCode: sourceString(location.countryCode),
    ipAddress: general.remoteAddress ?? null,
    accountId: general.accountID ?? null,
  };
}

function sourceQuestionText(request) {
  // The source indexes these fields directly. Throwing here keeps malformed
  // requests visible to the surrounding skill service instead of silently
  // manufacturing a question or invoking a provider with an empty string.
  return sourceString(request.data.result.asr.text);
}

function normalizeProviderOutput(value) {
  if (!value || typeof value !== 'object') return {};
  return value;
}

const SOURCE_PROVIDER_PLAN = Object.freeze([
  Object.freeze([
    ['Bing', 'Bing'],
    ['Wikipedia', 'Wikipedia'],
  ]),
  Object.freeze([
    ['Wolfram Alpha', 'Wolfram Alpha'],
  ]),
]);

function hasGqaPayload(output) {
  return Boolean(output && output.response && output.response.payload);
}

/**
 * Build the source provider fallback boundary around named local adapters.
 *
 * The original starts Bing and Wikipedia together, gives Bing priority when
 * both answer, then tries Wolfram Alpha only after that group has no usable
 * result. Individual adapter failures are private failed results, matching
 * GqaParallelQuery.make_async_call; they do not become the client-facing
 * GQA_error response. The local fixture adapters used by the controls resolve
 * immediately, so this helper intentionally leaves the original wall-clock
 * timeout policy to the deployment adapter.
 */
export function createGqaProviderPipeline({ providers = {} } = {}) {
  for (const group of SOURCE_PROVIDER_PLAN) {
    for (const [name, key] of group) {
      if (typeof (providers[name] || providers[key]) !== 'function') {
        throw new TypeError(`Missing GQA provider adapter: ${name}`);
      }
    }
  }
  return async function gqaProviderPipeline(context) {
    for (const group of SOURCE_PROVIDER_PLAN) {
      const results = await Promise.all(group.map(async ([name, key]) => {
        const adapter = providers[name] || providers[key];
        try {
          return normalizeProviderOutput(await adapter(context));
        } catch (_error) {
          return {};
        }
      }));
      for (const result of results) {
        if (hasGqaPayload(result)) return result;
      }
    }
    return {};
  };
}

/**
 * Create the source-shaped answer handler.
 *
 * `provider` is the replaceable boundary for Bing/Wikipedia/Wolfram or a
 * local fake. It receives the original request and cleaned/provider fields,
 * and returns the source GqaParallelQuery output shape:
 * `{source, response:{payload, ...}, type?, url?, timings?}` for a useful
 * result, `{}` for no answer, or `{message}` for an explicit service error.
 * A thrown provider error is treated as a failed provider call; the source
 * GqaParallelQuery records that failure privately and, when no provider
 * succeeds, choose_slim emits the normal no-answer MIM instead of GQA_error.
 */
export function createGqaAnswerSkill({ provider = async () => ({}), providers, rng = Math.random, clock = Date.now, skillId = 'answer', idFactory = newJcpId, messageId = randomUUID } = {}) {
  if (typeof provider !== 'function') throw new TypeError('GQA provider must be a function');
  const invokeProvider = providers ? createGqaProviderPipeline({ providers }) : provider;
  return async function gqaAnswerSkill(request) {
    const start = clock();
    const rawText = sourceQuestionText(request);
    const queryText = cleanGqaInput(rawText);
    const questionType = getGqaQuestionType(request);
    const context = requestContext(request, queryText, questionType);

    let output = {};
    let slim;
    // Match the source's request-level blocks before starting providers:
    // missing robot IP is an internal GQA_error, while PII gets its own MIM.
    // The source checks IP first, so preserve that ordering when both apply.
    if (!context.ipAddress) {
      output = { message: 'Robot IP address not supplied!' };
      slim = buildGqaSlimFromMim('GQA_error', undefined, { rng, idFactory });
    } else if (gqaPiiFilter(queryText)) {
      slim = buildGqaSlimFromMim('GQA_pii_filter', undefined, { rng, idFactory });
    } else {
      try {
        output = normalizeProviderOutput(await invokeProvider(context));
      } catch (error) {
        // GqaParallelQuery catches each provider exception, records it in its
        // private service log, and continues to the next provider. If every
        // provider fails, its returned output has no `message` field; source
        // choose_slim therefore takes the ordinary no-answer MIM path. Keep
        // the exception private. An explicit provider `{message}` remains
        // the separate source error contract above.
        output = {};
      }
    }

    if (!slim) {
      if (output.message) {
        slim = buildGqaSlimFromMim('GQA_error', undefined, { rng, idFactory });
      } else if (output.response && output.response.payload) {
        if (typeof output.response.payload !== 'string') {
          throw new TypeError('GQA provider payload must be a string');
        }
        if (typeof output.source !== 'string') {
          throw new Error('GQA provider success is missing source');
        }
        let answer = output.response.payload;
        if (!answer.endsWith('.')) answer += '.';
        slim = buildGqaSlimFromText(answer, output.source, idFactory);
        output = { ...output, response: { ...output.response, payload: answer } };
      } else {
        const responseType = chooseGqaNoAnswerType(questionType, rng);
        slim = buildGqaSlimFromMim(`GQA_no_answer_${responseType}`, queryText, { rng, idFactory });
      }
    }

    const end = clock();
    const timings = buildGqaTimings(start, end, output.timings || {});
    const analytics = {
      answer: [buildGqaSkillEntryAnalytics(request), buildGqaAnswerAnalytics(output)],
    };
    return buildGqaResponse({ jcp: slim, timings, analytics, skillId, messageId });
  };
}

// Explicit source-registration profile. It is exported for a caller that
// hosts the original `answer` service; the shared Phoenix answer-skill alias
// remains unchanged until its deployment selects this profile deliberately.
export const gqaAnswerSkill = createGqaAnswerSkill();
