// Source-backed Bing provider for the opt-in GQA adapter.

import { unidecodeForBingFilter } from './gqaUnidecodeFilter.js';

// The recovered srv-gqa-ws implementation is
// jiborobot/srv-gqa-ws@ebe1a7d38f511570060c1fbf61bec89d58419b26,
// gqa/bing.py.  This module keeps the provider separate from the default
// Phoenix registry.  A caller must provide the source CONFIG_DICT["bing_api"]
// value explicitly; the recovered configuration is deployment data, not a
// safe product default.

export const BING_SOURCE_REVISION = 'ebe1a7d38f511570060c1fbf61bec89d58419b26';
export const BING_SOURCE_MODULE = 'gqa/bing.py';
export const BING_SOURCE_CONFIG_KEY = 'bing_api';

const US_COUNTRY_CODES = new Set(['US', 'AS', 'GU', 'MP', 'PR', 'UM', 'VI']);
const CANADA_COUNTRY_CODE = 'CA';
const US_MARKET = 'en-US';
const CANADA_MARKET = 'en-CA';

const US_WHITELIST = Object.freeze([
  'Weather', 'SportsTeam', 'SportsMatches', 'Facts', 'Entities',
  'Computation', 'Flights', 'FoodAndDrink', 'Places', 'Showtimes',
]);
const CANADA_WHITELIST = Object.freeze([
  'Weather', 'SportsTeam', 'SportsMatches', 'Facts', 'Entities',
  'Computation', 'Flights',
]);
const BLACKLISTED_ANSWER_TYPES = new Set(['WebPages', 'Images', 'Videos', 'Lyrics']);

// The source comments that the final period is intentionally omitted from
// these prefixes.  Matching is case-sensitive, as Python str.startswith is.
export const BING_UNHELPFUL_SPOKEN_TEXT = Object.freeze([
  'I found this',
  'Here is what I found',
  "Here's what I found",
  'Take a look at this',
  'Here are some new articles, hot off the presses',
  "Here's some information that might help",
  'I pulled up some results',
  'This is what I found',
  'Moist sang ? (Heart) Is',
  "I've got this for you on",
  'Here is a peek around',
  "Here's a peek around",
  "Here's a look around",
  'Here is a look around',
  "I've got games around",
  "Here's a list",
  "Here's your answer",
]);

export const BING_SUPPRESS_IN_SPOKEN_TEXT = Object.freeze([
  "You'll find more in your Cortana app history.",
  "I'll put more in the Cortana app.",
  'I put more in your Cortana app history.',
  "I'll leave more in your Cortana app.",
  'You can check out more in your Cortana app history.',
  "I'll drop more in your Cortana app.",
  'Check your Cortana app history for more.',
  "You've got more in the Cortana app.",
  'I pulled up more for you in the Cortana app history.',
]);

function pythonTruthy(value) {
  // Provider payloads are JSON, so these are the Python truthiness cases that
  // differ from JavaScript's truthiness for empty arrays and objects.
  if (value === null || value === undefined || value === false || value === 0 || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function pythonValue(value) {
  // str.format(None) in the source emits `None`; absent answerType also
  // reaches that branch through dict.get's default.
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'string') return value;
  return String(value);
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

function sourceField(value, key, label) {
  const mapping = requireMapping(value, label);
  if (!Object.prototype.hasOwnProperty.call(mapping, key)) {
    throw new TypeError(`${label} is missing '${key}'`);
  }
  return mapping[key];
}

function cleanParentheses(value) {
  let result = value;
  let next;
  do {
    next = result.replace(/\([^()]*\)/gu, '');
    if (next === result) break;
    result = next;
  } while (true);
  return result;
}

function defaultUnidecode(value) {
  // The source's Unidecode call is a filter predicate, not output
  // transliteration.  Keep the source decision table in the helper and
  // preserve the original Unicode spoken text below.
  return unidecodeForBingFilter(value);
}

function lowerFirst(value) {
  return value.slice(0, 1).toLowerCase() + value.slice(1);
}

function sourceAnswerTypeError(answerType, market) {
  if (market === 'en-ca') return `Bing answer type '${pythonValue(answerType)}' not licensed for use in Canada`;
  return `Unknown Bing answer type '${pythonValue(answerType)}'`;
}

/**
 * Decode the source Bing response after licensing and ranking selection.
 * Empty object means no answer; a message is a visible licensing/unknown
 * type result; response/type/url/image_url follow gqa/bing.py exactly.
 */
export function extractBingSpokenAnswer(parsed, market, { unidecode = defaultUnidecode } = {}) {
  if (typeof unidecode !== 'function') throw new TypeError('Bing unidecode must be a function');
  const rankingResponse = sourceGet(parsed, 'rankingResponse', {}, 'parsed');
  const mainline = sourceGet(rankingResponse, 'mainline', {}, 'rankingResponse');
  const items = sourceGet(mainline, 'items', [], 'rankingResponse.mainline');
  if (!pythonTruthy(items)) return {};
  if (!Array.isArray(items)) throw new TypeError('rankingResponse.mainline.items must be a list');

  const firstItem = sourceGet(items[0], 'answerType', undefined, 'rankingResponse.mainline.items[0]');
  const answerType = firstItem;
  if (BLACKLISTED_ANSWER_TYPES.has(answerType)) return {};

  const marketLower = market ? String(market).toLowerCase() : null;
  if (marketLower === 'en-ca') {
    if (!CANADA_WHITELIST.includes(answerType)) {
      return { message: sourceAnswerTypeError(answerType, 'en-ca') };
    }
  } else if (marketLower === 'en-us') {
    if (!US_WHITELIST.includes(answerType)) {
      return { message: sourceAnswerTypeError(answerType, 'en-us') };
    }
  } else if (!US_WHITELIST.includes(answerType)) {
    return { message: sourceAnswerTypeError(answerType, marketLower) };
  }

  const key = lowerFirst(answerType);
  const firstAnswer = sourceField(parsed, key, 'parsed');
  const conversation = sourceGet(firstAnswer, 'conversation', {}, `${key} answer`);
  const spokenText = sourceGet(conversation, 'spokenText', '', `${key}.conversation`);
  if (typeof spokenText !== 'string') throw new TypeError(`${key}.conversation.spokenText must be a string`);

  // unidecode(spoken_text).strip('.') is only used by the source as the
  // empty/unhelpful test.  The response retains the original Unicode string.
  // The source strips ASCII periods from both ends before it checks the
  // unhelpful prefixes.  Do this after the complete per-codepoint mapping:
  // a dot-only mapping is empty at an edge, but remains significant when it
  // occurs inside the assembled string.
  const normalized = unidecode(spokenText).replace(/^\.+|\.+$/gu, '');
  if (normalized === ''
    || BING_UNHELPFUL_SPOKEN_TEXT.some((prefix) => normalized.startsWith(prefix))) {
    return {};
  }

  let cleaned = spokenText;
  for (const phrase of BING_SUPPRESS_IN_SPOKEN_TEXT) cleaned = cleaned.split(phrase).join('');
  cleaned = cleanParentheses(cleaned).trim();
  const output = {
    response: { type: 'string', payload: cleaned },
    type: key,
  };

  if (Object.prototype.hasOwnProperty.call(firstAnswer, 'screenshot')) {
    const screenshot = sourceField(firstAnswer, 'screenshot', `${key} answer`);
    output.url = sourceField(screenshot, 'webSearchUrl', `${key}.screenshot`);
    output.image_url = sourceField(screenshot, 'thumbnailUrl', `${key}.screenshot`);
  } else if (key === 'entities') {
    const values = sourceField(firstAnswer, 'value', `${key} answer`);
    const firstValue = values[0];
    const screenshot = sourceField(firstValue, 'screenshot', `${key}.value[0]`);
    output.url = sourceField(screenshot, 'webSearchUrl', `${key}.value[0].screenshot`);
    output.image_url = sourceField(screenshot, 'thumbnailUrl', `${key}.value[0].screenshot`);
  } else if (key === 'sportsTeam') {
    const value = sourceField(firstAnswer, 'value', `${key} answer`);
    const matches = sourceField(value, 'matches', `${key}.value`);
    const screenshot = sourceField(matches[0], 'screenshot', `${key}.value.matches[0]`);
    output.url = sourceField(screenshot, 'webSearchUrl', `${key}.value.matches[0].screenshot`);
    output.image_url = sourceField(screenshot, 'thumbnailUrl', `${key}.value.matches[0].screenshot`);
  }
  return output;
}

function quotePlus(value) {
  return encodeURIComponent(String(value))
    .replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/gu, '+');
}

function fallbackSearchUrl(responseUrl, requestUrl) {
  let parsed;
  try {
    parsed = new URL(String(responseUrl || requestUrl));
  } catch {
    return undefined;
  }
  const query = parsed.searchParams.get('q');
  if (query === null) return undefined;
  return `https://www.bing.com/search?q=${quotePlus(query)}`;
}

function responseHeader(response, name) {
  if (response?.headers && typeof response.headers.get === 'function') return response.headers.get(name);
  const headers = response?.headers;
  if (!headers || typeof headers !== 'object') return undefined;
  const wanted = name.toLowerCase();
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === wanted);
  return key === undefined ? undefined : headers[key];
}

function errorText(error) {
  if (error instanceof Error) return `${error.name || 'Error'}: ${error.message || ''}`.trim();
  return String(error);
}

function composeSignal(parentSignal, timeoutMs) {
  if (timeoutMs === undefined || timeoutMs === null) return { signal: parentSignal, cleanup: () => {} };
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new TypeError('Bing timeoutMs must be a non-negative number');
  const controller = new AbortController();
  let timer;
  const abort = () => {
    if (!controller.signal.aborted) controller.abort(parentSignal?.reason);
  };
  if (parentSignal) {
    if (parentSignal.aborted) abort();
    else parentSignal.addEventListener('abort', abort, { once: true });
  }
  timer = setTimeout(() => controller.abort(new Error('Bing request timed out')), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', abort);
    },
  };
}

function requestUrl(endpoint, query, apiKey, market) {
  const url = new URL(String(endpoint));
  const params = [
    ['q', query],
    ['appid', apiKey],
    ['screenshotstyle', 'small'],
    ['conversation', 'true'],
    ['responseFilter', 'knowledge'],
    ['mkt', market],
  ];
  for (const [key, value] of params) {
    // requests omits query parameters whose value is None.
    if (value !== undefined && value !== null) url.searchParams.append(key, String(value));
  }
  return url;
}

function sourceCountry(countryCode) {
  // bing.call checks truthiness before upper().  The route has already cast
  // its location field to str, so this leaves an explicit "None" visible for
  // a missing source country while preserving direct-call falsy handling.
  if (!countryCode) return { error: 'Unable to determine country, which is required to use Bing' };
  const value = String(countryCode).toUpperCase();
  if (US_COUNTRY_CODES.has(value)) return { market: US_MARKET };
  if (value === CANADA_COUNTRY_CODE) return { market: CANADA_MARKET };
  return { error: `Not licensed to use Bing in country with code '${value}'` };
}

/**
 * Create an opt-in Bing provider for createGqaProviderPipeline.
 *
 * The source endpoint and key are deployment configuration.  Requiring the
 * endpoint prevents a test or default Phoenix host from contacting Bing by
 * accident.  `fetchImpl` is the only transport seam; it receives the source
 * GET URL, headers and combined caller/adapter AbortSignal.
 */
export function createBingProvider({
  endpoint,
  apiKey,
  fetchImpl = globalThis.fetch,
  headers = {},
  timeoutMs,
  clock = Date.now,
  unidecode = defaultUnidecode,
} = {}) {
  if (endpoint === undefined || endpoint === null || endpoint === '') {
    throw new TypeError('Bing endpoint must be configured from source CONFIG_DICT["bing_api"]');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('Bing fetchImpl must be a function');
  if (typeof clock !== 'function') throw new TypeError('Bing clock must be a function');
  if (typeof unidecode !== 'function') throw new TypeError('Bing unidecode must be a function');
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    throw new TypeError('Bing headers must be a mapping');
  }

  return async function bingProvider(context = {}) {
    const country = context.countryCode ?? context.country_code;
    const countryResult = sourceCountry(country);
    if (countryResult.error) return { message: countryResult.error };
    const market = countryResult.market;
    const query = context.queryText ?? context.query ?? '';
    const ipAddress = context.ipAddress ?? context.ip_address;
    const latitude = context.latitude ?? context.lat;
    const longitude = context.longitude ?? context.lng;
    const requestHeaders = { ...headers };
    if (ipAddress !== undefined && ipAddress !== null) requestHeaders['X-MSEdge-ClientIP'] = String(ipAddress);
    else delete requestHeaders['X-MSEdge-ClientIP'];
    if (latitude && longitude) {
      requestHeaders['X-Search-Location'] = `lat:${latitude},long:${longitude},re:22`;
    } else {
      delete requestHeaders['X-Search-Location'];
    }

    const output = { source: 'Bing', timestamps: {} };
    output.timestamps.bing_request = Math.trunc(clock());
    const requestState = composeSignal(context.signal, timeoutMs);
    let response;
    let parsed;
    let url;
    try {
      const configuredEndpoint = typeof endpoint === 'function' ? endpoint(context) : endpoint;
      url = requestUrl(configuredEndpoint, query, apiKey, market);
      response = await fetchImpl(url, {
        method: 'GET',
        headers: requestHeaders,
        signal: requestState.signal,
      });
      output.timestamps.bing_response = Math.trunc(clock());
      // requests.Response.raise_for_status only rejects 4xx/5xx.  A custom
      // fetch response's `ok` flag is intentionally ignored here because it
      // also marks 3xx responses false while the source client follows them.
      if (!response || (response.status !== undefined && response.status >= 400)) {
        throw new Error(`HTTP ${response?.status ?? 'unknown'}`);
      }
      if (!response || typeof response.json !== 'function') throw new TypeError('Bing response has no json() method');
      parsed = await response.json();
    } catch (error) {
      if (output.timestamps.bing_response === undefined) output.timestamps.bing_response = Math.trunc(clock());
      output.message = `Unexpected exception: ${errorText(error)}`;
      return output;
    } finally {
      requestState.cleanup();
    }

    const responseMarket = responseHeader(response, 'BingAPIs-Market');
    // Source calls .lower() outside its request try block; a missing header
    // therefore remains a visible provider exception instead of a fallback.
    if (responseMarket === undefined || responseMarket === null) {
      throw new TypeError("Bing response is missing 'BingAPIs-Market'");
    }
    const returnedMarket = String(responseMarket);
    // Source adopts the returned market for the licensing decoder.  The
    // mismatch is logged by the source and does not add a response field.
    if (pythonTruthy(parsed)) {
      Object.assign(output, extractBingSpokenAnswer(parsed, returnedMarket, { unidecode }));
      if (!Object.prototype.hasOwnProperty.call(output, 'url')) {
        const urlValue = fallbackSearchUrl(response?.url, url);
        if (urlValue) output.url = urlValue;
      }
    }
    return output;
  };
}

export const bingProviderContract = Object.freeze({
  source: 'Bing',
  request: ['q', 'appid', 'screenshotstyle', 'conversation', 'responseFilter', 'mkt'],
  headers: ['X-MSEdge-ClientIP', 'X-Search-Location'],
  success: 'response:{type:string,payload:string}, type, optional url/image_url',
  noAnswer: '{} merged into {source,timestamps}',
  errors: 'message:{Unexpected exception: ...} with bing_request/bing_response timestamps',
  licensing: 'US/US territories and Canada only; unsupported countries stop before HTTP',
});
