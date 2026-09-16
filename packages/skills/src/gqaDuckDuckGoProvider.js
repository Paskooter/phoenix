// DuckDuckGo Instant Answer provider for the opt-in GQA adapter.
//
// Microsoft retired the Bing Search API behind gqa/bing.py
// (jiborobot/srv-gqa-ws@ebe1a7d38f511570060c1fbf61bec89d58419b26, gqa/bing.py),
// so the recovered multi-provider profile's first group can no longer call
// Bing.  This provider fills that slot with the DuckDuckGo Instant Answer API
// (https://api.duckduckgo.com/), which needs no API key and returns no plain
// web pages.  The mapping keeps the Bing adapter's discipline: only a
// ready-to-speak instant answer is accepted, the same
// BING_UNHELPFUL_SPOKEN_TEXT rejection list is applied, and an explicit guard
// refuses web-page-ish payloads so a future DuckDuckGo change cannot leak
// plain search results into the answer slot.

import { BING_UNHELPFUL_SPOKEN_TEXT } from './gqaBingProvider.js';
import { unidecodeForBingFilter } from './gqaUnidecodeFilter.js';

export const DUCKDUCKGO_SOURCE_API = 'https://api.duckduckgo.com/';
export const DUCKDUCKGO_SOURCE_PARAMS = Object.freeze([
  ['format', 'json'],
  ['no_html', '1'],
  ['skip_disambig', '1'],
]);

// Bing refused these answer types outright.  The Instant Answer API does not
// produce them today, but keeping the guard explicit means a future DuckDuckGo
// change cannot leak them into the answer slot.
const BLACKLISTED_ANSWER_TYPES = new Set(['webpages', 'images', 'videos', 'lyrics']);

// Bing's US/Canada whitelist is its answer-type license set.  DuckDuckGo has
// no comparable license, so the provider derives a whitelisted Bing answer
// type from the Instant Answer response: Type 'A' or a present Infobox maps to
// 'Entities', AnswerType 'calc' maps to 'Computation', and the recognizable
// chatter answer types map onto 'Facts'.  Any other DDG answer type is treated
// as NOT whitelisted and returns no answer.
const ANSWER_TYPE_MAP = Object.freeze({
  calc: 'Computation',
  color: 'Facts',
  info: 'Facts',
  ip: 'Facts',
  phone: 'Facts',
  unicode: 'Facts',
  upc: 'Facts',
  zip: 'Facts',
});

function pythonTruthy(value) {
  // Provider payloads are JSON, so these are the Python truthiness cases that
  // differ from JavaScript's truthiness for empty arrays and objects.
  if (value === null || value === undefined || value === false || value === 0 || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function requireMapping(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a mapping`);
  }
  return value;
}

function sourceGet(value, key, fallback, label) {
  const mapping = requireMapping(value, label);
  return Object.prototype.hasOwnProperty.call(mapping, key) ? mapping[key] : fallback;
}

function lowerFirst(value) {
  return value.slice(0, 1).toLowerCase() + value.slice(1);
}

function defaultUnidecode(value) {
  // The Bing adapter's unidecode is a filter predicate, not output
  // transliteration.  Reuse it for the same empty/unhelpful decision so the
  // rejection behavior matches across both providers.
  return unidecodeForBingFilter(value);
}

function asSpokenString(value) {
  // Spoken output must be a string.  Numbers are accepted (a JSON number
  // Answer is as safe to speak as its string form) and any other value, such
  // as a future nested structure, falls through to the AbstractText path
  // instead of throwing.
  if (typeof value === 'string' && pythonTruthy(value)) return value;
  if (typeof value === 'number' && Number.isFinite(value) && value !== 0) return String(value);
  return null;
}

function isBlacklistedAnswerType(value) {
  return BLACKLISTED_ANSWER_TYPES.has(String(value).toLowerCase());
}

function hasWebContentStructure(parsed) {
  // A future DuckDuckGo change that starts returning web-page-like payloads
  // would add a top-level key the Bing decoder already refused.  Keep the
  // blacklist total by key and by value instead of trusting Type/AnswerType.
  for (const key of Object.keys(parsed)) {
    if (BLACKLISTED_ANSWER_TYPES.has(key.toLowerCase()) && pythonTruthy(parsed[key])) {
      return true;
    }
  }
  return false;
}

/**
 * Decode a DuckDuckGo Instant Answer response after transport.
 * Empty result means no answer; a malformed top-level payload is also an
 * empty result, never an error.  response/type/url/image_url follow the
 * Bing adapter's output shape so the slot is interchangeable.
 */
export function extractDuckDuckGoAnswer(parsed, { unidecode = defaultUnidecode } = {}) {
  if (typeof unidecode !== 'function') throw new TypeError('DuckDuckGo unidecode must be a function');
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  if (isBlacklistedAnswerType(sourceGet(parsed, 'AnswerType', '', 'parsed'))
    || hasWebContentStructure(parsed)) {
    return {};
  }

  const type = sourceGet(parsed, 'Type', '', 'parsed');
  const infobox = sourceGet(parsed, 'Infobox', null, 'parsed');
  const answerType = String(sourceGet(parsed, 'AnswerType', '', 'parsed') ?? '').toLowerCase();

  let answerKind;
  if (String(type) === 'A' || pythonTruthy(infobox)) {
    answerKind = 'Entities';
  } else if (answerType === 'calc') {
    answerKind = 'Computation';
  } else {
    answerKind = ANSWER_TYPE_MAP[answerType];
  }
  if (!answerKind) return {};

  const answerValue = sourceGet(parsed, 'Answer', '', 'parsed');
  const abstractValue = sourceGet(parsed, 'AbstractText', '', 'parsed');
  let spokenText = asSpokenString(answerValue);
  if (spokenText === null) spokenText = asSpokenString(abstractValue);
  if (spokenText === null) return {};

  // The Bing source tests unidecode(spoken_text).strip('.') before every
  // unhelpful prefix.  Apply the identical decision so both providers reject
  // the same boilerplate.
  const normalized = unidecode(spokenText).replace(/^\.+|\.+$/gu, '');
  if (normalized === ''
    || BING_UNHELPFUL_SPOKEN_TEXT.some((prefix) => normalized.startsWith(prefix))) {
    return {};
  }

  const output = {
    response: { type: 'string', payload: spokenText.trim() },
    type: lowerFirst(answerKind),
  };
  const abstractUrl = sourceGet(parsed, 'AbstractURL', '', 'parsed');
  if (typeof abstractUrl === 'string' && abstractUrl !== '') output.url = abstractUrl;
  const image = sourceGet(parsed, 'Image', '', 'parsed');
  if (typeof image === 'string' && image !== '') output.image_url = image;
  return output;
}

function errorText(error) {
  if (error instanceof Error) return `${error.name || 'Error'}: ${error.message || ''}`.trim();
  return String(error);
}

function composeSignal(parentSignal, timeoutMs) {
  if (timeoutMs === undefined || timeoutMs === null) return { signal: parentSignal, cleanup: () => {} };
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new TypeError('DuckDuckGo timeoutMs must be a non-negative number');
  const controller = new AbortController();
  let timer;
  const abort = () => {
    if (!controller.signal.aborted) controller.abort(parentSignal?.reason);
  };
  if (parentSignal) {
    if (parentSignal.aborted) abort();
    else parentSignal.addEventListener('abort', abort, { once: true });
  }
  timer = setTimeout(() => controller.abort(new Error('DuckDuckGo request timed out')), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', abort);
    },
  };
}

function requestUrl(endpoint, query) {
  const url = new URL(String(endpoint));
  const params = [['q', query], ...DUCKDUCKGO_SOURCE_PARAMS];
  for (const [key, value] of params) {
    if (value !== undefined && value !== null) url.searchParams.append(String(key), String(value));
  }
  return url;
}

/**
 * Create a DuckDuckGo Instant Answer provider for createGqaProviderPipeline.
 *
 * The endpoint defaults to the public API and can be injected for a fixture
 * or deployment mirror; `fetchImpl` is the only transport seam and receives a
 * native-fetch GET URL and the combined caller/adapter AbortSignal.  Missing
 * answers are the API's normal state and are reported as an empty result, not
 * an error.
 */
export function createDuckDuckGoProvider({
  endpoint = DUCKDUCKGO_SOURCE_API,
  fetchImpl = globalThis.fetch,
  headers = {},
  timeoutMs,
  clock = Date.now,
  unidecode = defaultUnidecode,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('DuckDuckGo fetchImpl must be a function');
  if (typeof clock !== 'function') throw new TypeError('DuckDuckGo clock must be a function');
  if (typeof unidecode !== 'function') throw new TypeError('DuckDuckGo unidecode must be a function');
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    throw new TypeError('DuckDuckGo headers must be a mapping');
  }

  return async function duckDuckGoProvider(context = {}) {
    const query = context.queryText ?? context.query ?? '';
    const output = { source: 'DuckDuckGo', timestamps: {} };
    output.timestamps.duckduckgo_request = Math.trunc(clock());
    const requestState = composeSignal(context.signal, timeoutMs);
    let response;
    let parsed;
    try {
      const configuredEndpoint = typeof endpoint === 'function' ? endpoint(context) : endpoint;
      const url = requestUrl(configuredEndpoint, query);
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { ...headers },
        signal: requestState.signal,
      });
      output.timestamps.duckduckgo_response = Math.trunc(clock());
      if (!response || (response.status !== undefined && response.status >= 400)) {
        throw new Error(`HTTP ${response?.status ?? 'unknown'}`);
      }
      if (!response || typeof response.json !== 'function') {
        throw new TypeError('DuckDuckGo response has no json() method');
      }
      parsed = await response.json();
    } catch (error) {
      if (output.timestamps.duckduckgo_response === undefined) {
        output.timestamps.duckduckgo_response = Math.trunc(clock());
      }
      output.message = `Unexpected exception: ${errorText(error)}`;
      return output;
    } finally {
      requestState.cleanup();
    }

    if (pythonTruthy(parsed)) {
      Object.assign(output, extractDuckDuckGoAnswer(parsed, { unidecode }));
    }
    return output;
  };
}

export const duckDuckGoProviderContract = Object.freeze({
  source: 'DuckDuckGo',
  request: ['q', 'format', 'no_html', 'skip_disambig'],
  headers: [],
  success: 'response:{type:string,payload:string}, type, optional url/image_url',
  noAnswer: '{} merged into {source,timestamps}',
  errors: 'message:{Unexpected exception: ...} with duckduckgo_request/duckduckgo_response timestamps',
  licensing: 'none; Instant Answer API needs no API key and returns no web pages',
});