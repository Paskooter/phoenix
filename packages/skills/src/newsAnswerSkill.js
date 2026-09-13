// Source-backed legacy AP news service.
//
// Reference: jiborobot/srv-gqa-ws@ebe1a7d38f511570060c1fbf61bec89d58419b26,
// gqa/gqa.py:news_pegasus, gqa/ap.py, gqa/analytics.py and the three
// NEWS_* files under pegasus_mims.  The AP/Mongo boundary is deliberately a
// replaceable function: Phoenix does not invent a news database or a live AP
// credential when this legacy profile is selected.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newJcpId } from './jcpId.js';
import {
  GQA_BAD_REQUEST_HTML,
  GQA_MISSING_TRANSID_HTML,
  buildGqaResponse,
  buildGqaSlimFromMim,
  buildGqaSkillEntryAnalytics,
  sourceJsonDumps,
} from './gqaAnswerSkill.js';

export const NEWS_SOURCE_REVISION = 'ebe1a7d38f511570060c1fbf61bec89d58419b26';
export const NEWS_SOURCE_MODULE = 'gqa/gqa.py';
export const NEWS_VERSION = '5.2.15';
export const NEWS_SOURCE_PATHS = Object.freeze([
  '/news_skill',
  '/news_skill/v1/main',
  '/v1/news/main',
]);

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const MIM_DIR = join(MODULE_DIR, '../resources/mims/news');
const MIM_NAMES = ['NEWS_preamble', 'NEWS_content', 'NEWS_postamble'];

// Source make_response_for_hub calls str(uuid.uuid4()), retaining the
// canonical 36-character hyphenated UUID representation.
const sourceNewsMessageId = () => randomUUID();

function loadMim(name) {
  const value = JSON.parse(readFileSync(join(MIM_DIR, `${name}.mim`), 'utf8'));
  if (!value.mim_id) value.mim_id = name;
  return value;
}

const MIMS = Object.freeze(Object.fromEntries(MIM_NAMES.map((name) => [name, loadMim(name)])));

function weightedChoice(entries, rng) {
  const total = entries.reduce((sum, entry) => sum + (entry.weight || 1), 0);
  let remaining = rng() * total;
  for (const entry of entries) {
    remaining -= entry.weight || 1;
    if (remaining <= 0) return entry.value;
  }
  return entries[entries.length - 1].value;
}

function choosePrompt(mim, rng) {
  return weightedChoice(
    (mim.prompts || []).map((prompt) => ({ value: prompt, weight: prompt.weight || 1 })),
    rng,
  );
}

export function newsMimPromptIds(mimId) {
  const mim = MIMS[mimId];
  if (!mim) throw new Error(`Unknown News MIM '${mimId}'`);
  return mim.prompts.map((prompt) => prompt.prompt_id);
}

/** Source pegasus_mims.slim_from_mim for NEWS_* prompts. */
export function buildNewsSlimFromMim(mimId, { rng = Math.random, idFactory = newJcpId } = {}) {
  const mim = MIMS[mimId];
  if (!mim) throw new Error(`Unknown News MIM '${mimId}'`);
  const prompt = choosePrompt(mim, rng);
  const playId = idFactory();
  const slimId = idFactory();
  return {
    id: slimId,
    type: 'SLIM',
    config: {
      play: {
        id: playId,
        type: 'PLAY',
        esml: prompt.prompt,
        meta: { prompt_id: prompt.prompt_id },
      },
      display: null,
    },
  };
}

/** Source gqa.slim_from_text, used after NEWS_content template expansion. */
export function buildNewsSlimFromText(text, sourceId, idFactory = newJcpId) {
  const playId = idFactory();
  const slimId = idFactory();
  return {
    id: slimId,
    type: 'SLIM',
    config: {
      play: {
        id: playId,
        type: 'PLAY',
        esml: text,
        meta: { prompt_id: sourceId },
      },
    },
  };
}

/** Source gqa.sequence_from_slims. */
export function buildNewsSequence(slims, idFactory = newJcpId) {
  return {
    id: idFactory(),
    type: 'SEQUENCE',
    children: slims,
  };
}

function sourceInteger(value) {
  // Python int() accepts numeric strings and numbers, which are the values
  // emitted by the Hub loop payload. Keep malformed values visible as a
  // provider/request error instead of silently classifying the speaker.
  let number;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^[+-]?\d+$/.test(trimmed)) throw new TypeError('News speaker birthdate must be numeric');
    number = Number(trimmed);
  } else {
    number = Number(value);
  }
  if (!Number.isFinite(number)) throw new TypeError('News speaker birthdate must be numeric');
  return Math.trunc(number);
}

function subtractYears(date, years) {
  const result = new Date(date.getTime());
  const targetYear = result.getUTCFullYear() - years;
  const month = result.getUTCMonth();
  const day = result.getUTCDate();
  // dateutil.relativedelta clamps February 29 to February 28 when the target
  // year is not a leap year. Date.setUTCFullYear would normalize to March 1.
  result.setUTCFullYear(targetYear, month, 1);
  result.setUTCDate(Math.min(day, new Date(Date.UTC(targetYear, month + 1, 0)).getUTCDate()));
  return result;
}

/** Source `news_pegasus` child/adult selection, with an injectable clock. */
export function isNewsChild(request, clock = Date.now) {
  const runtime = request.data.runtime;
  const perception = sourceMappingGet(runtime, 'perception');
  const loop = sourceMappingGet(runtime, 'loop');
  // The source calls `.get()` on both mappings. sourceMappingGet preserves
  // that mapping-only boundary while allowing absent fields on valid maps.
  const speakerId = sourceMappingGet(perception, 'speaker');
  const users = sourceMappingGet(loop, 'users');
  if (!sourceTruthy(speakerId) || !sourceTruthy(users)) return false;

  if (!Array.isArray(users)) throw new TypeError("'users' must be iterable");
  let speaker;
  for (const user of users) {
    // Python's looper['id'] raises for a missing key and for non-mapping
    // elements. A JavaScript optional property read would incorrectly turn
    // both cases into an adult/default request.
    if (!isSourceMapping(user) || !Object.prototype.hasOwnProperty.call(user, 'id')) {
      throw new TypeError("looper['id'] is required");
    }
    if (user.id === speakerId) {
      speaker = user;
      break;
    }
  }
  if (!speaker || !speaker.birthdate) return false;

  const nowValue = typeof clock === 'function' ? clock() : clock;
  const now = nowValue instanceof Date ? new Date(nowValue.getTime()) : new Date(nowValue);
  if (Number.isNaN(now.getTime())) throw new TypeError('News clock must return a valid date');
  const birthday = new Date(sourceInteger(speaker.birthdate));
  if (Number.isNaN(birthday.getTime())) throw new RangeError('News speaker birthdate is out of range');
  return subtractYears(now, 13) < birthday;
}

/** Source analytics.build_news_analytics. */
export function buildNewsAnalytics(success) {
  return {
    event: 'News Query',
    properties: { type: 'AP', success },
  };
}

function sourceTruthy(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

function isSourceMapping(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sourceMappingGet(value, key) {
  if (!isSourceMapping(value)) throw new TypeError(`Object has no attribute 'get' for ${key}`);
  return value[key];
}

function normalizeHeadlines(value) {
  if (!sourceTruthy(value)) return [];
  if (!Array.isArray(value)) throw new TypeError('News provider must return an array of AP headlines');
  // gqa.ap.search_db owns Mongo's `.limit(5)`. A replacement provider must
  // keep that bound too; reject an out-of-contract result rather than silently
  // changing its ordering or hiding a provider bug here.
  if (value.length > 5) throw new RangeError('News provider returned more than five AP headlines');
  return value.map((headline) => decodeSummary(headline));
}

function decodeSummary(value) {
  if (!Buffer.isBuffer(value)) return value;
  // Python bytes.decode('utf-8') raises on malformed sequences; TextDecoder's
  // fatal mode keeps that provider failure visible instead of inserting U+FFFD.
  return new TextDecoder('utf-8', { fatal: true }).decode(value);
}

async function collectNewsRows(value) {
  const resolved = await value;
  if (resolved && typeof resolved.toArray === 'function') return resolved.toArray();
  if (resolved && typeof resolved[Symbol.asyncIterator] === 'function') {
    const rows = [];
    for await (const row of resolved) rows.push(row);
    return rows;
  }
  if (resolved && typeof resolved[Symbol.iterator] === 'function') return [...resolved];
  throw new TypeError('AP news store find() must return rows or an iterable cursor');
}

function newsThreshold(clock) {
  const value = typeof clock === 'function' ? clock() : clock;
  const numeric = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(numeric)) throw new TypeError('AP news clock must return a finite timestamp');
  return Math.trunc(numeric) - (24 * 60 * 60 * 1000);
}

/**
 * Adapt a replaceable AP collection/store to the source `gqa.ap.search_db`
 * contract. The store receives the source Mongo predicate and query options;
 * it may be a Mongo collection wrapper, an in-memory fixture, or another
 * explicitly configured AP cache.
 */
export function createApNewsProvider({ store, clock = Date.now } = {}) {
  if (!store || typeof store.find !== 'function') {
    throw new TypeError('AP news store must provide find(query, options)');
  }
  return async function apNewsProvider({ isKid = false } = {}) {
    const queryFeed = async (feedId) => {
      const query = {
        // search_id_news computes the UTC one-day threshold per feed query.
        storedTime: { $gt: newsThreshold(clock) },
        feedID: feedId,
        ...(isKid ? { adult: false } : {}),
      };
      const rows = await collectNewsRows(store.find(query, {
        projection: { _id: 0 },
        sort: { storedTime: -1 },
        limit: 5,
      }));
      // Mongo applies the sort/limit. Repeating those operations here keeps
      // the replaceable store seam deterministic when a simple fixture store
      // accepts the options but does not implement Mongo cursor methods.
      return rows
        .slice()
        .sort((left, right) => Number(right.storedTime) - Number(left.storedTime))
        .slice(0, 5);
    };

    let rows = await queryFeed('42210');
    if (rows.length === 0) rows = await queryFeed('41664');
    return rows.map((story) => {
      if (!story || !Object.prototype.hasOwnProperty.call(story, 'summary')) {
        throw new Error('AP news story is missing summary');
      }
      return decodeSummary(story.summary);
    });
  };
}

function responseTimings(start, end) {
  const seconds = Math.max(0, end - start) / 1000;
  // Python's str(float) keeps a trailing `.0` for integral elapsed values.
  return { total: Number.isInteger(seconds) ? `${seconds}.0` : String(seconds) };
}

/**
 * Create the source `/news_skill` handler.
 *
 * `newsProvider` is the only AP-specific seam. It receives
 * `{isKid, request}` and must resolve to the already ordered AP summary list
 * used by `gqa.ap.search_db`; a missing provider is an explicit empty store,
 * so this legacy profile fails closed with the source GQA_error MIM.
 */
export function createNewsAnswerSkill({
  newsProvider,
  apStore,
  rng = Math.random,
  clock = Date.now,
  skillId = 'news',
  idFactory = newJcpId,
  messageId = sourceNewsMessageId,
} = {}) {
  if (newsProvider !== undefined && apStore !== undefined) {
    throw new TypeError('Configure either newsProvider or apStore, not both');
  }
  const selectedProvider = newsProvider
    || (apStore ? createApNewsProvider({ store: apStore, clock }) : async () => []);
  if (typeof selectedProvider !== 'function') throw new TypeError('News provider must be a function');
  return async function newsAnswerSkill(request) {
    const start = clock();
    const skillEntry = buildGqaSkillEntryAnalytics(request);
    const isKid = isNewsChild(request, clock);
    const headlines = normalizeHeadlines(await selectedProvider({ isKid, request }));

    let jcp;
    if (headlines.length) {
      const slims = headlines.map((headline) => {
        // The archived route first builds and discards a NEWS_content SLIM to
        // resolve the template, then allocates the speaking SLIM from text.
        // Preserve both its random draw and its two opaque IDs.
        const base = buildNewsSlimFromMim('NEWS_content', { rng, idFactory });
        // Python str.format inserts the AP summary literally. A JavaScript
        // string replacement would reinterpret `$&`, `$`` and `$'` in a
        // headline, so use a callback replacement to keep source text exact.
        const rendered = base.config.play.esml.replace('{0}', () => String(headline));
        return buildNewsSlimFromText(rendered, base.config.play.meta.prompt_id, idFactory);
      });
      slims.unshift(buildNewsSlimFromMim('NEWS_preamble', { rng, idFactory }));
      slims.push(buildNewsSlimFromMim('NEWS_postamble', { rng, idFactory }));
      jcp = buildNewsSequence(slims, idFactory);
    } else {
      // Empty AP data intentionally reuses the source GQA error prompt. This
      // is a successful HTTP response with an audible error, as in Flask.
      jcp = buildGqaSlimFromMim('GQA_error', undefined, { rng, idFactory });
    }

    const end = clock();
    return buildGqaResponse({
      jcp,
      timings: responseTimings(start, end),
      analytics: { news: [skillEntry, buildNewsAnalytics(headlines.length > 0)] },
      skillId,
      messageId,
    });
  };
}

export const newsAnswerSkill = createNewsAnswerSkill();

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateNewsEnvelope(body) {
  if (!isRecord(body)) throw new TypeError('News request JSON must be an object');
  // Source analytics indexes request["type"] before the transID check.
  if (!Object.prototype.hasOwnProperty.call(body, 'type')) {
    throw new Error('Missing News request field type');
  }
  buildGqaSkillEntryAnalytics(body);
  return body;
}

function headerValues(headers, request = {}, wanted) {
  if (Array.isArray(request.rawHeaders)) {
    const values = [];
    for (let index = 0; index + 1 < request.rawHeaders.length; index += 2) {
      if (String(request.rawHeaders[index]).toLowerCase() === wanted) values.push(request.rawHeaders[index + 1]);
    }
    if (values.length) return values;
  }
  const source = headers && typeof headers === 'object' ? headers : {};
  const name = Object.keys(source).find((key) => key.toLowerCase() === wanted);
  if (!name) return [];
  const value = source[name];
  return Array.isArray(value) ? value.slice() : value === undefined ? [] : [value];
}

function transIdHeaderValues(headers, request = {}) {
  return headerValues(headers, request, 'x-jibo-transid');
}

function loggingConfigHeaderValues(headers, request = {}) {
  return headerValues(headers, request, 'x-jibo-logging-config');
}

function requestContentType(request) {
  const headers = request?.headers || {};
  const value = headers['content-type'] ?? headers['Content-Type'];
  if (value === undefined || value === null) return undefined;
  return String(value).split(';', 1)[0].trim().toLowerCase();
}

function isSourceJsonRequest(request) {
  const type = requestContentType(request);
  return type === 'application/json' || (type?.startsWith('application/') && type.endsWith('+json'));
}

function emptyJsonEntity(request) {
  if (!isSourceJsonRequest(request)) return false;
  if (Buffer.isBuffer(request?.rawBody)) return request.rawBody.length === 0;
  const length = Number(request?.headers?.['content-length']);
  return Number.isFinite(length) && length === 0;
}

function sendSourceBody(context, status, body, html = false) {
  const response = context?.res;
  if (!response) return undefined;
  if (response.status && response.setHeader && response.end && html) {
    response.status(status);
    response.setHeader('Content-Type', 'text/html');
    response.setHeader('Content-Length', String(Buffer.byteLength(body)));
    response.end(body);
    return undefined;
  }
  if (response.status && response.type && response.send) {
    response.status(status).type('html').send(body);
    return undefined;
  }
  return undefined;
}

function sourceError(error) {
  const normalized = error instanceof Error ? error : new Error(String(error));
  return { version: NEWS_VERSION, message: normalized.message, stacktrace: normalized.stack };
}

function sourceErrorBody(context, error) {
  const body = sourceJsonDumps(sourceError(error));
  if (context?.res) return sendSourceBody(context, 500, body);
  const wrapped = error instanceof Error ? error : new Error(String(error));
  wrapped.statusCode = 500;
  throw wrapped;
}

function sourceBadRequest(context, message) {
  if (context?.res) return sendSourceBody(context, 400, message, true);
  const error = new Error(message.includes('Missing X-JIBO-transID')
    ? 'Missing X-JIBO-transID header'
    : 'The browser (or proxy) sent a request that this server could not understand.');
  error.statusCode = 400;
  throw error;
}

/** Source Flask HTTP framing for both legacy news aliases. */
export function createNewsHttpRoute({ skillId = 'news', handler = newsAnswerSkill } = {}) {
  if (typeof handler !== 'function') throw new TypeError('News HTTP handler must be a function');
  const route = async function newsHttpRoute(context = {}) {
    const request = context.req || {};
    if (emptyJsonEntity(request)) return sourceBadRequest(context, GQA_BAD_REQUEST_HTML);
    try {
      validateNewsEnvelope(context.body);
    } catch (error) {
      return sourceErrorBody(context, error);
    }

    const ids = transIdHeaderValues(request.headers, request);
    if (!ids.length) return sourceBadRequest(context, GQA_MISSING_TRANSID_HTML);
    // Flask's getlist(...)[0] is a scalar assignment in the archived route;
    // preserve that value for handlers and provider seams.
    context.body.transID = ids[0];
    const loggingConfigs = loggingConfigHeaderValues(request.headers, request);
    if (loggingConfigs.length) context.body['logging-config'] = loggingConfigs[0];

    try {
      const result = await handler(context.body, { trace: context.trace, log: context.log, req: request, skillId });
      if (context.res) return sendSourceBody(context, 200, sourceJsonDumps(result));
      return result;
    } catch (error) {
      context.log?.error?.('News handler failed', { error });
      return sourceErrorBody(context, error);
    }
  };
  route.jsonStrict = false;
  route.jsonTypes = ['application/json', 'application/*+json'];
  route.parserError = (context) => sendSourceBody(context, 400, GQA_BAD_REQUEST_HTML, true);
  route.bodyDefault = {};
  return route;
}
