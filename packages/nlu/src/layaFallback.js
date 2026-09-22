// Private Laya fallback client.
//
// This is intentionally narrower than the generic LLM fallback: Laya chooses
// among a server-owned hierarchy but does not extract entities.  Consequently
// only catalog intents with no entity fields can cross this boundary.  A bad,
// stale, or unavailable classifier result is a no-match, never an arbitrary
// intent sent to the robot router.

import { readFileSync } from 'node:fs';

const SOURCE_TOOLS = JSON.parse(readFileSync(new URL('./generatedIntentCatalog.json', import.meta.url), 'utf8')).tools;
// The generated entity schema currently omits the optional `group` output
// produced by hue-control for `lightsUp`/`lightsDown`. Keep these out of Laya's
// acceptance set until the request text's light-group values are validated.
const LAYA_INTENTS_BY_PROFILE = new Map([
  ['phoenix-information', new Set(['requestCalendar', 'requestCommute', 'launchPersonalReport'])],
  ['phoenix-home', new Set(['galleryOpen'])],
  ['phoenix-play', new Set(['requestDrawPicture', 'requestDance', 'jokeKnockKnock', 'goodBye'])],
  ['phoenix-system', new Set(['stop', 'restart', 'wifiStatus'])],
]);
const LAYA_PROFILE_INTENTS = new Set([...LAYA_INTENTS_BY_PROFILE.values()].flatMap((intents) => [...intents]));

function isEntityless(tool) {
  const properties = tool?.entities?.type === 'object' ? tool.entities.properties : null;
  return properties != null && Object.keys(properties).length === 0;
}

export const LAYA_ENTITYLESS_INTENTS = new Set(
  SOURCE_TOOLS.filter((tool) => isEntityless(tool)
    && (tool.launch || tool.scope === 'global')
    && LAYA_PROFILE_INTENTS.has(tool.name)).map((tool) => tool.name),
);

const DEFAULT_TIMEOUT_MS = 700;
const MIN_TIMEOUT_MS = 50;
const MAX_TIMEOUT_MS = 2_000;
const DEFAULT_CONFIDENCE = 0.45;

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

export function envLayaConfig() {
  const url = (process.env.ETCO_parser_layaUrl || '').trim().replace(/\/$/, '');
  const token = (process.env.ETCO_parser_layaToken || '').trim();
  const fallback = process.env.ETCO_parser_layaSecondaryFallback === 'llm' ? 'llm' : 'none';
  return {
    // A token is mandatory even for a private target.  An enabled flag without
    // URL/token is deliberately treated as disabled, not as a noisy network
    // failure on every utterance.
    enabled: process.env.ETCO_parser_layaEnabled === 'true' && Boolean(url) && Boolean(token),
    url,
    token,
    profile: (process.env.ETCO_parser_layaProfile || 'phoenix-core').trim() || 'phoenix-core',
    timeoutMs: boundedInteger(process.env.ETCO_parser_layaTimeoutMs, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
    minConfidence: boundedNumber(process.env.ETCO_parser_layaMinConfidence, DEFAULT_CONFIDENCE, 0, 1),
    secondaryFallback: fallback,
  };
}

function isValidResponse(result, config) {
  if (!result || typeof result !== 'object' || result.unknown !== false) return false;
  if (typeof result.intent !== 'string' || !LAYA_ENTITYLESS_INTENTS.has(result.intent)) return false;
  if (typeof result.confidence !== 'number' || !Number.isFinite(result.confidence)) return false;
  // `confidence` from Laya is an entropy score. The server's explicit
  // top_probability is the quantity gated against profile.min_confidence;
  // comparing entropy confidence with that threshold rejected nearly every
  // otherwise valid result (for example, 0.15 entropy vs 0.85 probability).
  if (typeof result.top_probability !== 'number' || !Number.isFinite(result.top_probability)) return false;
  if (result.top_probability < config.minConfidence || result.top_probability < 0 || result.top_probability > 1) return false;
  const probabilities = result.probabilities;
  if (!probabilities || typeof probabilities !== 'object' || Array.isArray(probabilities)) return false;
  const rankedProbabilities = Object.values(probabilities);
  if (rankedProbabilities.length < 2 || rankedProbabilities.some((value) => typeof value !== 'number'
    || !Number.isFinite(value) || value < 0 || value > 1)) return false;
  const selectedProbability = probabilities[result.intent];
  const sortedProbabilities = [...rankedProbabilities].sort((left, right) => right - left);
  if (selectedProbability !== sortedProbabilities[0]) return false;
  if (selectedProbability < config.minConfidence || Math.abs(selectedProbability - result.top_probability) > 0.0001) return false;
  const expectedMargin = sortedProbabilities[0] - sortedProbabilities[1];
  if (typeof result.margin !== 'number' || !Number.isFinite(result.margin)
    || Math.abs(expectedMargin - result.margin) > 0.0001) return false;
  // The service's leaf profile is the only place an intent is returned.  This
  // makes a compromised/incorrect root category harmless to Phoenix.
  if (typeof result.profile !== 'string' || !LAYA_INTENTS_BY_PROFILE.get(result.profile)?.has(result.intent)) return false;
  if (!Array.isArray(result.route) || result.route.length !== 2
    || result.route[0] !== 'phoenix-core' || result.route[1] !== result.profile) return false;
  return true;
}

/**
 * @param {{enabled?:boolean,url?:string,token?:string,profile?:string,timeoutMs?:number,minConfidence?:number,fetch?:typeof fetch}} [input]
 */
export function createLayaClient(input = {}) {
  const config = {
    ...envLayaConfig(),
    ...input,
  };
  const fetchImpl = input.fetch || globalThis.fetch;
  async function handleNLU(request) {
    if (!config.enabled || !request?.text || typeof fetchImpl !== 'function') return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await fetchImpl(`${config.url}/v1/classify`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ text: request.text, profile: config.profile }),
        signal: controller.signal,
      });
      if (response.status !== 200) return null;
      const result = await response.json();
      if (!isValidResponse(result, config)) return null;
      return { intent: result.intent, entities: {}, rules: Array.isArray(request.rules) ? request.rules : [] };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    get enabled() { return Boolean(config.enabled); },
    get config() { return { ...config, token: config.token ? '[configured]' : '' }; },
    handleNLU,
  };
}

let defaultClient;
export function getLayaClient() {
  if (!defaultClient) defaultClient = createLayaClient();
  return defaultClient;
}

export function resetLayaClientForTest() {
  defaultClient = undefined;
}

export async function layaFallback(text, request = {}) {
  if (!text) return null;
  return getLayaClient().handleNLU({ ...request, text });
}
