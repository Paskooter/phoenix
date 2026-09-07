// Source-backed Wolfram Alpha provider for the opt-in GQA adapter.
//
// The recovered implementation is
// jiborobot/srv-gqa-ws@ebe1a7d38f511570060c1fbf61bec89d58419b26,
// gqa/wolfram.py.  The adapter stays separate from the default Phoenix
// registry: its endpoint and app id are deployment configuration and must be
// supplied by the caller.

export const WOLFRAM_SOURCE_REVISION = 'ebe1a7d38f511570060c1fbf61bec89d58419b26';
export const WOLFRAM_SOURCE_MODULE = 'gqa/wolfram.py';
export const WOLFRAM_SOURCE_CONFIG_KEY = 'wolfram_api';
export const WOLFRAM_SOURCE_TOTAL_TIMEOUT = '3';
export const WOLFRAM_SOURCE_SCAN_TIMEOUT = '1.0';
export const WOLFRAM_SOURCE_ANSWER_POD_INDEX = '2';

const BAD_SYMBOLS = Object.freeze(['{', '}', '$', '\n', '-', '<', '>', '|']);

function pythonTruthy(value) {
  // JSON values are the provider boundary.  Python treats empty containers as
  // false while JavaScript treats them as true.
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

function hasKey(mapping, key) {
  return Object.prototype.hasOwnProperty.call(mapping, key);
}

function required(mapping, key, label) {
  if (!hasKey(mapping, key)) throw new TypeError(`${label} is missing '${key}'`);
  return mapping[key];
}

function requiredPods(queryResult, label) {
  const pods = required(queryResult, 'pods', label);
  if (!Array.isArray(pods)) throw new TypeError(`${label}.pods must be a list`);
  return pods;
}

/** Source gqa.wolfram.extract_pod_answer(result_json). */
export function extractWolframPodAnswer(resultJson) {
  const root = requireMapping(resultJson, 'result_json');
  const queryResult = requireMapping(required(root, 'queryresult', 'result_json'), 'result_json.queryresult');
  const pods = requiredPods(queryResult, 'result_json.queryresult');
  let output = '';
  for (let index = 0; index < pods.length; index += 1) {
    const pod = requireMapping(pods[index], `result_json.queryresult.pods[${index}]`);
    // The Python source tests for key presence, rather than requiring
    // `primary` to be truthy.  Preserve that unusual boundary.
    if (hasKey(pod, 'primary') && hasKey(pod, 'subpods') && hasKey(pod, 'title')
      && pod.title === 'Result') {
      const subpods = pod.subpods;
      if (!Array.isArray(subpods)) throw new TypeError(`result_json.queryresult.pods[${index}].subpods must be a list`);
      const subpod = requireMapping(subpods[0], `result_json.queryresult.pods[${index}].subpods[0]`);
      output = required(subpod, 'plaintext', `result_json.queryresult.pods[${index}].subpods[0]`);
    }
  }
  return output;
}

/** Source gqa.wolfram.extract_spoken_answer(result_json). */
export function extractWolframSpokenAnswer(resultJson) {
  const root = requireMapping(resultJson, 'result_json');
  const queryResult = requireMapping(required(root, 'queryresult', 'result_json'), 'result_json.queryresult');
  let output = '';

  if (hasKey(queryResult, 'pods')) {
    const pods = requiredPods(queryResult, 'result_json.queryresult');
    for (let index = 0; index < pods.length; index += 1) {
      const pod = requireMapping(pods[index], `result_json.queryresult.pods[${index}]`);
      if (required(pod, 'title', `result_json.queryresult.pods[${index}]`) === 'Response') return '';
    }
  }

  if (hasKey(queryResult, 'spokenresult')) {
    const spokenResult = requireMapping(queryResult.spokenresult, 'result_json.queryresult.spokenresult');
    if (spokenResult.generictemplate !== 'EntityInformation') {
      if (hasKey(spokenResult, 'srtemplate')) {
        const template = requireMapping(spokenResult.srtemplate, 'result_json.queryresult.spokenresult.srtemplate');
        output = required(template, 'sampletext', 'result_json.queryresult.spokenresult.srtemplate');
        // The source applies this replacement only to srtemplate output.
        // Python str.replace replaces every occurrence when no count is
        // supplied; preserve repeated source placeholders in the template.
        output = output.replaceAll(' for Date ', ' ');
      } else if (hasKey(spokenResult, 'sampletext')) {
        output = spokenResult.sampletext;
      }
    }
  }

  if (hasKey(queryResult, 'pods') && output === '') return extractWolframPodAnswer(resultJson);
  return output;
}

/** Source gqa.wolfram.clean_answer(output). */
export function cleanWolframAnswer(output) {
  // Source expects text from Wolfram.  Keeping this explicit makes malformed
  // JSON shapes fail at the same post-HTTP boundary rather than becoming a
  // silent no-answer result.
  if (typeof output !== 'string') throw new TypeError('Wolfram answer must be a string');
  let cleaned = output;
  if (BAD_SYMBOLS.some((symbol) => cleaned.includes(symbol))) cleaned = '';
  if (cleaned.includes('is an empty list')) cleaned = '';
  if (cleaned.includes('RegularExpression')) cleaned = '';
  if (cleaned.endsWith('the first one is: ')) cleaned = '';
  if (cleaned.includes('I have an image for you')) cleaned = '';
  if (cleaned.startsWith('(')) cleaned = '';
  cleaned = cleaned.replaceAll('(', '').replaceAll(')', '');
  return cleaned;
}

function quotePlus(value) {
  return encodeURIComponent(String(value))
    .replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/gu, '+');
}

function sourceQueryValue(value) {
  if (value === null || value === undefined) return undefined;
  if (value === true) return 'True';
  if (value === false) return 'False';
  return String(value);
}

function contextField(context, primary, alias, fallback = undefined) {
  if (hasKey(context, primary)) return context[primary];
  if (hasKey(context, alias)) return context[alias];
  return fallback;
}

function requestUrl(endpoint, query, apiKey, ipAddress, latitude, longitude) {
  const url = new URL(String(endpoint));
  const params = [
    ['input', query],
    ['appid', apiKey],
    ['output', 'JSON'],
    ['spokenresult', 'true'],
    ['totaltimeout', WOLFRAM_SOURCE_TOTAL_TIMEOUT],
    ['scantimeout', WOLFRAM_SOURCE_SCAN_TIMEOUT],
    ['podindex', WOLFRAM_SOURCE_ANSWER_POD_INDEX],
    ['ip', ipAddress],
  ];
  if (latitude && longitude) {
    // gqa.gqa casts these values to strings before calling wolfram.call. A
    // direct non-string call would fail in Python's `latitude + ","` before
    // the request/output try block; retain that source boundary.
    if (typeof latitude !== 'string' || typeof longitude !== 'string') {
      throw new TypeError('latitude and longitude must be strings when supplied');
    }
    params.push(['latlong', `${latitude},${longitude}`]);
  }
  for (const [key, value] of params) {
    const encoded = sourceQueryValue(value);
    // requests omits query parameters whose value is None.
    if (encoded !== undefined) url.searchParams.append(key, encoded);
  }
  return url;
}

function errorText(error) {
  if (error instanceof Error) return `${error.name || 'Error'}: ${error.message || ''}`.trim();
  return String(error);
}

function sourceInputFromUrl(value) {
  const parsed = new URL(String(value));
  // urllib.parse.parse_qs drops blank values by default and retains the first
  // value for the source's `param_dict["input"][0]` access.
  const values = parsed.searchParams.getAll('input').filter((item) => item !== '');
  return values.length > 0 ? values[0] : undefined;
}

function buildResultUrl(responseUrl, requestUrlValue) {
  const sourceUrl = responseUrl === undefined || responseUrl === null ? requestUrlValue : responseUrl;
  const input = sourceInputFromUrl(sourceUrl);
  if (input === undefined) return undefined;
  return `https://www.wolframalpha.com/input/?i=${quotePlus(input)}`;
}

/**
 * Create an opt-in provider for createGqaProviderPipeline.
 *
 * `endpoint` is the source CONFIG_DICT["wolfram_api"] value. `fetchImpl` is a
 * test/deployment transport seam; the default follows redirects like the
 * source requests.Session. The source has no HTTP timeout argument: its three
 * and one-second limits are query parameters, so timeoutMs is intentionally
 * not invented here.
 */
export function createWolframProvider({
  endpoint,
  apiKey,
  fetchImpl = globalThis.fetch,
  headers = {},
  clock = Date.now,
} = {}) {
  if (endpoint === undefined || endpoint === null || endpoint === '') {
    throw new TypeError('Wolfram endpoint must be configured from source CONFIG_DICT["wolfram_api"]');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('Wolfram fetchImpl must be a function');
  if (typeof clock !== 'function') throw new TypeError('Wolfram clock must be a function');
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    throw new TypeError('Wolfram headers must be a mapping');
  }

  return async function wolframProvider(context = {}) {
    // Preserve explicitly supplied nulls: Python requests omits a None query
    // parameter, while converting it to an empty string would send input=.
    const query = contextField(context, 'queryText', 'query', '');
    const ipAddress = contextField(context, 'ipAddress', 'ip_address');
    const latitude = contextField(context, 'latitude', 'lat');
    const longitude = contextField(context, 'longitude', 'lng');
    const url = requestUrl(endpoint, query, apiKey, ipAddress, latitude, longitude);
    const output = { source: 'Wolfram Alpha', timestamps: {} };
    let response;
    let parsed;
    output.timestamps.wolfram_request = Math.trunc(clock());
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { ...headers },
        signal: context.signal,
      });
      output.timestamps.wolfram_response = Math.trunc(clock());
      // requests.raise_for_status rejects 4xx/5xx, while redirects are
      // normally followed by the requests/fetch transport itself.
      if (!response || (response.status !== undefined && response.status >= 400)) {
        throw new Error(`HTTP ${response?.status ?? 'unknown'}`);
      }
      const responseUrl = response && typeof response.url === 'string' ? response.url : undefined;
      const resultUrl = buildResultUrl(responseUrl, url.href);
      if (resultUrl !== undefined) output.url = resultUrl;
      if (response && typeof response.json !== 'function') throw new TypeError('Wolfram response has no json() method');
      parsed = await response.json();
    } catch (error) {
      // The recovered source only records wolfram_response after a response
      // object has been returned. A connection failure therefore has the
      // request timestamp alone; do not invent a completion timestamp.
      output.message = `Unexpected exception: ${errorText(error)}`;
      return output;
    }

    if (pythonTruthy(parsed)) {
      const root = requireMapping(parsed, 'result_json');
      const queryResult = requireMapping(required(root, 'queryresult', 'result_json'), 'result_json.queryresult');
      // The source indexes success directly before extraction. A missing key
      // is therefore an uncaught post-HTTP boundary, even though a present
      // value of 0/null is not identical to Python False.
      if (required(queryResult, 'success', 'result_json.queryresult') === false) return output;
      const answerText = cleanWolframAnswer(extractWolframSpokenAnswer(parsed));
      if (answerText) output.response = { type: 'string', payload: answerText };
    }
    return output;
  };
}

export const wolframProviderContract = Object.freeze({
  source: 'Wolfram Alpha',
  request: ['input', 'appid', 'output', 'spokenresult', 'totaltimeout', 'scantimeout', 'podindex', 'ip', 'latlong'],
  success: 'response:{type:string,payload:string}',
  noAnswer: 'source/timestamps/url with no response for empty or success:false results',
  errors: 'message:{Unexpected exception: ...} with wolfram_request/wolfram_response timestamps',
  sourceConfig: 'wolfram_api endpoint and WOLFRAM_KEY are explicit deployment configuration',
});
