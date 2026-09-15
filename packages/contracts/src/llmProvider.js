// Configurable LLM endpoint resolution, shared by every Phoenix LLM caller.
//
// WHY THIS EXISTS
// The two LLM integrations Phoenix inherited were each written against one
// specific local host. `packages/nlu/src/llmFallback.js` is a source-exact port
// of pegasus@715e0dd0's LM Studio client, and `packages/skills/src/answerSkill.js`
// followed the same shape. Neither sent an Authorization header, because a
// local LM Studio needs none. That makes both unusable against any hosted
// OpenAI-compatible provider (OpenRouter, Together, Groq, vLLM behind a proxy),
// which is a deployment limitation rather than anything the source dictated.
//
// This module centralises the endpoint decision so a deployment can point every
// LLM caller at whatever provider it likes, with a bearer token and arbitrary
// extra headers, without touching either call site.
//
// DIVERGENCE, RECORDED
// Sending an Authorization header is an addition to the pinned source contract.
// It is additive and inert by default: with no key configured the request is
// byte-identical to the source's, so the source-exact behaviour is preserved
// unless a deployment opts in. Nothing else about the request or the response
// parsing is touched here.
//
// PRECEDENCE
// A scope-specific variable always beats the shared one, so a deployment can run
// (say) a small fast model for NLU and a larger one for answers:
//
//   ETCO_<scope>_llmUrl        ->  PHOENIX_LLM_URL
//   ETCO_<scope>_llmModel      ->  PHOENIX_LLM_MODEL
//   ETCO_<scope>_llmApiKey     ->  PHOENIX_LLM_API_KEY  ->  OPENROUTER_API_KEY
//   ETCO_<scope>_llmTimeoutMs  ->  PHOENIX_LLM_TIMEOUT_MS
//   ETCO_<scope>_llmTemperature->  PHOENIX_LLM_TEMPERATURE
//   ETCO_<scope>_llmHeaders    ->  PHOENIX_LLM_HEADERS      (JSON object)
//
// `scope` is the existing service prefix: `parser` for NLU, `answer` for the
// answer skill. Those names are kept exactly so existing deployments keep
// working.

/** Providers that need extra headers to attribute or route a request. */
const KNOWN_HOST_HEADERS = Object.freeze({
  'openrouter.ai': Object.freeze({
    'HTTP-Referer': 'https://pvindex.org/phoenix',
    'X-Title': 'Phoenix',
  }),
});

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return '';
}

function parseNumber(value) {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseHeaders(raw, label) {
  if (!raw || !raw.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${label} must be a JSON object of header name to value`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object of header name to value`);
  }
  const out = {};
  for (const [name, value] of Object.entries(parsed)) out[name] = String(value);
  return out;
}

/** Host-specific headers, applied only when the caller has not set them itself. */
function hostHeadersFor(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return KNOWN_HOST_HEADERS[host] || {};
  } catch {
    return {};
  }
}

/**
 * Resolve the LLM endpoint for one caller.
 *
 * @param {string} scope service prefix, e.g. 'parser' or 'answer'
 * @param {object} [options]
 * @param {object} [options.env] environment to read (defaults to process.env)
 * @param {string} [options.defaultModel] model when nothing is configured
 * @param {number} [options.defaultTimeoutMs] timeout when nothing is configured
 * @returns {{url:string, model:string, apiKey:string, headers:object, timeoutMs:(number|undefined), temperature:(number|undefined), configured:boolean}}
 */
export function resolveLlmProvider(scope, { env = process.env, defaultModel = '', defaultTimeoutMs } = {}) {
  const scoped = (name) => env[`ETCO_${scope}_llm${name}`];

  const url = firstNonEmpty(scoped('Url'), env.PHOENIX_LLM_URL);
  const model = firstNonEmpty(scoped('Model'), env.PHOENIX_LLM_MODEL, defaultModel);
  const apiKey = firstNonEmpty(scoped('ApiKey'), env.PHOENIX_LLM_API_KEY, env.OPENROUTER_API_KEY);

  const timeoutMs = parseNumber(scoped('TimeoutMs') ?? env.PHOENIX_LLM_TIMEOUT_MS) ?? defaultTimeoutMs;
  const temperature = parseNumber(scoped('Temperature') ?? env.PHOENIX_LLM_TEMPERATURE);

  const configuredHeaders = {
    ...parseHeaders(env.PHOENIX_LLM_HEADERS, 'PHOENIX_LLM_HEADERS'),
    ...parseHeaders(scoped('Headers'), `ETCO_${scope}_llmHeaders`),
  };

  return {
    url,
    model,
    apiKey,
    headers: configuredHeaders,
    timeoutMs,
    temperature,
    configured: url !== '' && model !== '',
  };
}

/**
 * The request headers for a resolved provider.
 *
 * With no API key this returns exactly `{ 'content-type': 'application/json' }`,
 * which is what the pinned source sent.
 */
export function llmRequestHeaders(provider) {
  const headers = { 'content-type': 'application/json' };
  if (!provider) return headers;
  if (provider.url) Object.assign(headers, hostHeadersFor(provider.url));
  Object.assign(headers, provider.headers || {});
  if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
  return headers;
}

/** The chat-completions URL for a resolved provider, with no doubled slash. */
export function llmCompletionsUrl(provider) {
  if (!provider || !provider.url) return '';
  return `${provider.url.replace(/\/+$/, '')}/chat/completions`;
}

/** Redacted view for logs and receipts — never carries the key itself. */
export function describeLlmProvider(provider) {
  if (!provider) return { configured: false };
  return {
    url: provider.url || null,
    model: provider.model || null,
    authenticated: Boolean(provider.apiKey),
    extraHeaderNames: Object.keys(provider.headers || {}).sort(),
    timeoutMs: provider.timeoutMs ?? null,
    temperature: provider.temperature ?? null,
    configured: provider.configured,
  };
}
