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
import { gqaBannedWordPresent } from './gqaBannedWords.js';

export const GQA_SOURCE_REVISION = 'ebe1a7d38f511570060c1fbf61bec89d58419b26';
export const GQA_VERSION = '5.2.15';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const MIM_DIR = join(MODULE_DIR, '../resources/mims/gqa');
const MIM_NAMES = [
  'GQA_banned_word',
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
  // The recovered Python helper indexes request["type"] directly.  The
  // route preflight performs the mapping/shape check before this function is
  // called, while keeping this access direct preserves the source null
  // boundary for callers that use the helper itself.
  const launch = request.type === 'LISTEN_LAUNCH';
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

function requestContext(request, queryText) {
  const data = request.data;
  const location = data.runtime.location;
  const general = data.general;
  return {
    request,
    queryText,
    // Keep the field access order from gqa_pegasus: query, latitude,
    // longitude, country, IP, question type, account.  The values are read
    // before this object is returned so malformed source-shaped requests
    // retain their observable failure precedence.
    latitude: sourceString(location.lat),
    longitude: sourceString(location.lng),
    countryCode: sourceString(location.countryCode),
    ipAddress: general.remoteAddress ?? null,
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

function sourceTruthy(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

function hasGqaPayload(output) {
  // Python's output.get('response', {}).get('payload') distinguishes an
  // absent response from an explicitly null/non-mapping response. The latter
  // escapes the source route as an HTTP500 instead of a no-answer response.
  const response = Object.prototype.hasOwnProperty.call(output, 'response') ? output.response : {};
  if (response === null || typeof response !== 'object' || Array.isArray(response)) {
    throw new TypeError('GQA provider response must be a mapping');
  }
  return sourceTruthy(response.payload);
}

/**
 * Build the source provider fallback boundary around named local adapters.
 *
 * The original starts Bing and Wikipedia together, gives Bing priority when
 * both answer, and advances to Wolfram Alpha only after the first group has
 * failed or reached its three-second deadline.  A late result from an older
 * group remains eligible while a later group is running.  That detail is
 * observable with a slow provider and is why this is an event/deadline loop
 * rather than Promise.all: Promise.all would wait for a timed-out worker and
 * would let a lower-priority answer win too early.
 */
export function createGqaProviderPipeline({
  providers = {},
  timeouts = [3000, 4000],
  clock = Date.now,
} = {}) {
  for (const group of SOURCE_PROVIDER_PLAN) {
    for (const [name, key] of group) {
      if (typeof (providers[name] || providers[key]) !== 'function') {
        throw new TypeError(`Missing GQA provider adapter: ${name}`);
      }
    }
  }

  if (!Array.isArray(timeouts) || timeouts.length < SOURCE_PROVIDER_PLAN.length
    || timeouts.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new TypeError('GQA provider timeouts must contain one non-negative number per source group');
  }

  return async function gqaProviderPipeline(context) {
    const results = new Map();
    const startedAt = new Map();
    const finishedAt = new Map();
    const previousServices = [];
    const waiters = new Set();
    let resultVersion = 0;

    const notify = () => {
      resultVersion += 1;
      for (const wake of [...waiters]) wake();
    };

    const start = ([name, key]) => {
      const adapter = providers[name] || providers[key];
      startedAt.set(name, clock());
      // Deliberately detach workers from the caller's await.  The source
      // leaves timed-out threads alive and a late result can still be chosen
      // while the next service group is active.
      Promise.resolve()
        .then(() => adapter(context))
        .then((value) => normalizeProviderOutput(value), () => ({}))
        .then((value) => {
          results.set(name, value);
          finishedAt.set(name, clock());
          notify();
        }, () => {
          // normalizeProviderOutput is intentionally defensive, but keep the
          // worker boundary total if a hostile thenable throws during adopt.
          results.set(name, {});
          finishedAt.set(name, clock());
          notify();
        });
    };

    const waitForEventOrDeadline = (observedVersion, deadline) => {
      if (resultVersion !== observedVersion) return Promise.resolve(true);
      const remaining = deadline - clock();
      if (remaining <= 0) return Promise.resolve(false);
      return new Promise((resolve) => {
        let done = false;
        let timer;
        const finish = (event) => {
          if (done) return;
          done = true;
          if (timer !== undefined) clearTimeout(timer);
          waiters.delete(wake);
          resolve(event);
        };
        const wake = () => finish(true);
        waiters.add(wake);
        timer = setTimeout(() => finish(false), remaining);
        // A worker can complete between the version check and registration.
        // Re-check after registering to avoid losing that event.
        if (resultVersion !== observedVersion) finish(true);
      });
    };

    const pickWinner = (currentGroup) => {
      for (const [name] of currentGroup) {
        if (!previousServices.includes(name)) previousServices.push(name);
      }
      for (const name of previousServices) {
        if (results.has(name)) {
          const result = results.get(name);
          if (hasGqaPayload(result)) return { status: 'SUCCESS', output: result };
          continue;
        }
        if (currentGroup.some(([currentName]) => currentName === name)) {
          return { status: 'KEEP WAITING' };
        }
      }
      return { status: 'FAIL' };
    };

    const addProviderTiming = (name, output) => {
      if (!output || typeof output !== 'object') return output;
      const finished = finishedAt.get(name);
      const started = startedAt.get(name);
      if (finished === undefined || started === undefined) return output;
      const key = name === 'Wolfram Alpha' ? 'wolfram' : name === 'Wikipedia' ? 'wiki' : 'bing';
      return {
        ...output,
        timings: { ...(output.timings || {}), [key]: Math.max(0, finished - started) / 1000 },
      };
    };

    for (let groupIndex = 0; groupIndex < SOURCE_PROVIDER_PLAN.length; groupIndex += 1) {
      const group = SOURCE_PROVIDER_PLAN[groupIndex];
      for (const service of group) start(service);
      const deadline = clock() + timeouts[groupIndex];
      let observedVersion = resultVersion;
      while (true) {
        const event = await waitForEventOrDeadline(observedVersion, deadline);
        observedVersion = resultVersion;
        const picked = pickWinner(event ? group : []);
        if (picked.status === 'SUCCESS') return addProviderTiming(
          previousServices.find((name) => results.get(name) === picked.output),
          picked.output,
        );
        if (!event || picked.status === 'FAIL') break;
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
    // gqa_pegasus reads location and IP, resolves the NLU question type, and
    // then reads accountID before cleaning the query.  Keep that sequence so
    // malformed requests and account/provider seams fail at the same stage.
    const context = requestContext(request, rawText);
    const questionType = getGqaQuestionType(request);
    context.questionType = questionType;
    context.accountId = request.data.general.accountID ?? null;
    const queryText = cleanGqaInput(rawText);
    context.queryText = queryText;

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
    } else if (gqaBannedWordPresent(queryText)) {
      slim = buildGqaSlimFromMim('GQA_banned_word', undefined, { rng, idFactory });
    } else {
      try {
        output = normalizeProviderOutput(await invokeProvider(context));
      } catch (error) {
        // Individual adapters are caught by the pipeline's worker boundary.
        // A rejected pipeline is an orchestration/result-shape failure and
        // the original Flask route exposes it as HTTP500.
        if (providers) throw error;
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
      if (sourceTruthy(output.message)) {
        slim = buildGqaSlimFromMim('GQA_error', undefined, { rng, idFactory });
      } else if (hasGqaPayload(output)) {
        if (!Object.prototype.hasOwnProperty.call(output, 'source')) {
          throw new Error('GQA provider success is missing source');
        }
        let answer = output.response.payload;
        if (typeof answer === 'string') {
          if (!answer.endsWith('.')) answer += '.';
        } else if (Array.isArray(answer)) {
          // Source list += '.' appends one element; preserve the JSON value
          // instead of silently stringifying it at this boundary.
          if (answer[answer.length - 1] !== '.') answer = [...answer, '.'];
        } else {
          throw new TypeError('GQA provider payload is not subscriptable');
        }
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

// The recovered Flask route rejects a request before invoking gqa_pegasus when
// X-JIBO-transID is absent.  Keep this boundary in a GQA-owned adapter so the
// common skillRoute can continue to serve the other source services unchanged.
// The diagnostic HTML renderer may differ from Flask 0.12.2; the source
// status, media type and client-visible failure path are preserved.
export const GQA_MISSING_TRANSID_HTML = '<!doctype html>\n<html lang=en>\n<title>400 Bad Request</title>\n<h1>Bad Request</h1>\n<p>Missing X-JIBO-transID header</p>\n';
export const GQA_BAD_REQUEST_HTML = '<!doctype html>\n<html lang=en>\n<title>400 Bad Request</title>\n<h1>Bad Request</h1>\n<p>Bad Request</p>\n';

function transIdHeaderValues(headers, request = {}) {
  // Node folds duplicate HTTP fields into one comma-joined value on
  // req.headers, while Flask's getlist() preserves each field separately.
  // rawHeaders is the transport-level source of truth for this one header;
  // use it when available and keep the object/array path for direct callers.
  if (Array.isArray(request.rawHeaders)) {
    const values = [];
    for (let index = 0; index + 1 < request.rawHeaders.length; index += 2) {
      if (String(request.rawHeaders[index]).toLowerCase() === 'x-jibo-transid') {
        values.push(request.rawHeaders[index + 1]);
      }
    }
    if (values.length > 0) return values;
  }
  const sourceHeaders = headers && typeof headers === 'object' ? headers : {};
  const name = Object.keys(sourceHeaders).find((key) => key.toLowerCase() === 'x-jibo-transid');
  if (!name) return [];
  const value = sourceHeaders[name];
  if (Array.isArray(value)) return value.slice();
  return value === undefined ? [] : [value];
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireOwn(record, key, label) {
  if (!Object.prototype.hasOwnProperty.call(record, key)) {
    throw new Error(`Missing GQA request field ${label}`);
  }
  return record[key];
}

/**
 * Validate only the source fields read before the transID branch.  The Flask
 * route first evaluates request.json and analytics["type"], so a valid JSON
 * object without `type` is a 500 even when its header is absent.  This helper
 * intentionally does not inspect `data` until after the header check.
 */
export function validateGqaRequestEnvelope(body) {
  if (!isRecord(body)) throw new TypeError('GQA request JSON must be an object');
  requireOwn(body, 'type', 'type');
  // Keep the source helper call in the boundary, rather than duplicating its
  // launch comparison in the HTTP adapter.
  buildGqaSkillEntryAnalytics(body);
  return body;
}

/**
 * Evaluate the direct body accesses in gqa_pegasus after transID mutation.
 * This turns source KeyError/TypeError cases into the GQA source 500 branch
 * before the common skillRoute can turn them into an HTTP-200 ERROR object.
 */
export function validateGqaRequestBody(body) {
  const data = requireOwn(body, 'data', 'data');
  if (!isRecord(data)) throw new TypeError('GQA request data must be an object');
  const result = requireOwn(data, 'result', 'data.result');
  if (!isRecord(result)) throw new TypeError('GQA request result must be an object');
  const asr = requireOwn(result, 'asr', 'data.result.asr');
  if (!isRecord(asr)) throw new TypeError('GQA request ASR must be an object');
  requireOwn(asr, 'text', 'data.result.asr.text');

  const runtime = requireOwn(data, 'runtime', 'data.runtime');
  if (!isRecord(runtime)) throw new TypeError('GQA request runtime must be an object');
  const location = requireOwn(runtime, 'location', 'data.runtime.location');
  if (!isRecord(location)) throw new TypeError('GQA request location must be an object');
  requireOwn(location, 'lat', 'data.runtime.location.lat');
  requireOwn(location, 'lng', 'data.runtime.location.lng');

  const general = requireOwn(data, 'general', 'data.general');
  if (!isRecord(general)) throw new TypeError('GQA request general must be an object');

  // get_question_type is evaluated after location/IP and before accountID.
  const nlu = requireOwn(result, 'nlu', 'data.result.nlu');
  if (!isRecord(nlu)) throw new TypeError('GQA request NLU must be an object');
  requireOwn(nlu, 'intent', 'data.result.nlu.intent');
  if (sourceString(nlu.intent) === 'scripted') {
    const entities = requireOwn(nlu, 'entities', 'data.result.nlu.entities');
    if (!isRecord(entities)) throw new TypeError('GQA request NLU entities must be an object');
  }
  // accountID is optional in the source mapping, but the read itself belongs
  // after question type resolution.
  void general.accountID;
  return body;
}

function sourceErrorPayload(error) {
  return {
    version: GQA_VERSION,
    message: error?.message || String(error),
    stacktrace: error?.stack,
  };
}

function respondGqaSourceError(context, status, error) {
  const response = context.res;
  if (response && typeof response.status === 'function'
    && typeof response.type === 'function' && typeof response.send === 'function') {
    response.status(status).type('html').send(JSON.stringify(sourceErrorPayload(error)));
    return undefined;
  }
  const wrapped = error instanceof Error ? error : new Error(String(error));
  wrapped.statusCode = status;
  throw wrapped;
}

function respondGqaBadRequest(context, error) {
  const response = context.res;
  if (response && typeof response.status === 'function'
    && typeof response.type === 'function' && typeof response.send === 'function') {
    response.status(400).type('html').send(GQA_BAD_REQUEST_HTML);
    return undefined;
  }
  const wrapped = error instanceof Error ? error : new Error(String(error));
  wrapped.statusCode = 400;
  throw wrapped;
}

function hasEmptyJsonEntity(request) {
  const contentType = String(request?.headers?.['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (!['application/json', 'application/x-amz-json-1.1'].includes(contentType)) return false;
  if (Buffer.isBuffer(request?.rawBody)) return request.rawBody.length === 0;
  const length = Number(request?.headers?.['content-length']);
  return Number.isFinite(length) && length === 0;
}

/**
 * Create the source GQA HTTP boundary, including its failure status and body.
 *
 * The adapter applies the source-specific validation and transID mutation:
 * source gqa_pegasus stores the first Flask header value as a one-element
 * `request_data.transID` list before reading the rest of the body.  A service
 * route receives the Express response object and can therefore preserve the
 * source 400 status without changing the shared error envelope.  Direct
 * callers without a response receive a statusCode-bearing Error instead.
 */
export function createGqaHttpRoute({ skillId = 'answer', handler = gqaAnswerSkill } = {}) {
  if (typeof handler !== 'function') throw new TypeError('GQA HTTP handler must be a function');
  const gqaHttpRoute = async function gqaHttpRoute(context = {}) {
    const request = context.req || {};
    if (hasEmptyJsonEntity(request)) {
      const error = new Error('Unexpected end of JSON input');
      return respondGqaBadRequest(context, error);
    }

    try {
      // Source analytics runs before header lookup.  Do not validate nested
      // data here: Flask would still return the missing-header 400 first for
      // a typed request whose data is malformed.
      validateGqaRequestEnvelope(context.body);
    } catch (error) {
      return respondGqaSourceError(context, 500, error);
    }

    const values = transIdHeaderValues(request.headers, request);
    if (values.length === 0) {
      const response = context.res;
      if (response && typeof response.status === 'function'
        && typeof response.type === 'function' && typeof response.send === 'function') {
        response.status(400).type('html').send(GQA_MISSING_TRANSID_HTML);
        return undefined;
      }
      const error = new Error('Missing X-JIBO-transID header');
      error.statusCode = 400;
      throw error;
    }

    context.body.transID = values.slice(0, 1);
    try {
      validateGqaRequestBody(context.body);
    } catch (error) {
      return respondGqaSourceError(context, 500, error);
    }
    try {
      // GQA is a Flask service, not a BaseSkill endpoint. Its response already
      // contains provider timings; its uncaught failures use the source HTTP
      // error handler. The generic skill wrapper changes both contracts.
      return await handler(context.body, { trace: context.trace, log: context.log, req: request });
    } catch (error) {
      context.log?.error?.('GQA handler failed', { error });
      return respondGqaSourceError(context, 500, error);
    }
  };
  // The source Flask request.json accepts top-level null/arrays/primitives and
  // reaches its own 500 branch.  Common services stay strict by default; this
  // opt-in is consumed by the narrow parser selection in createService.
  gqaHttpRoute.jsonStrict = false;
  return gqaHttpRoute;
}
