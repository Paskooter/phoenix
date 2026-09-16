// Explicit multi-provider GQA service profile.
//
// The source profile is the recovered srv-gqa-ws SERVICE_PATTERN:
// Bing and Wikipedia start together with a three-second group deadline, then
// Wolfram Alpha starts with a four-second deadline.  This module wires the
// three source-shaped adapters into that existing orchestration without
// changing the default answer-skill registry.
//
// Microsoft retired the Bing Search API, so the first-group slot defaults to
// the DuckDuckGo Instant Answer provider (no API key, public API).  Bing
// remains selectable for that slot when a source `bing_api` endpoint is
// configured; Wikipedia and Wolfram Alpha endpoints are still required from
// the caller so selecting this profile cannot contact a live provider
// accidentally.

import { createService } from '@phoenix/common';
import {
  createGqaAnswerSkill,
  createGqaHttpRoute,
  createGqaProviderPipeline,
} from './gqaAnswerSkill.js';
import { createBingProvider } from './gqaBingProvider.js';
import {
  createDuckDuckGoProvider,
  DUCKDUCKGO_SOURCE_API,
} from './gqaDuckDuckGoProvider.js';
import { createWikipediaProvider } from './gqaWikipediaProvider.js';
import { createWolframProvider } from './gqaWolframProvider.js';
import {
  createGqaAccountLookup,
  createGqaAttributionStore,
  createGqaFileAttributionStore,
  createGqaRetrieveAttributionRoute,
  createGqaWipeAttributionRoute,
} from './gqaAccountAttribution.js';

export const GQA_MULTI_PROVIDER_PROFILE = 'multi-provider';
export const GQA_MULTI_PROVIDER_SKILL_ID = 'answer';
export const GQA_MULTI_PROVIDER_BASE_PATH = '/answer_skill';
export const GQA_MULTI_PROVIDER_TIMEOUTS = Object.freeze([3000, 4000]);

function providerSection(value, name) {
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`GQA ${name} provider configuration must be a mapping`);
  }
  return value;
}

function configuredEndpoint(value, name) {
  if ((typeof value !== 'string' && typeof value !== 'function')
    || (typeof value === 'string' && value.length === 0)) {
    throw new TypeError(`GQA ${name} endpoint must be configured explicitly`);
  }
  return value;
}

// The recovered Bing stage is dead upstream, so the first-group slot defaults
// to DuckDuckGo unless a caller configures a source Bing endpoint explicitly.
function bingEndpointConfigured(value) {
  return typeof value === 'function' || (typeof value === 'string' && value.length > 0);
}

function configuredTimeout(value, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new TypeError(`${label} must be a non-negative number`);
  }
  return parsed;
}

function configuredTimeouts(value) {
  if (value === undefined) return [...GQA_MULTI_PROVIDER_TIMEOUTS];
  if (!Array.isArray(value) || value.length < GQA_MULTI_PROVIDER_TIMEOUTS.length) {
    throw new TypeError('GQA provider timeouts must contain the Bing/Wikipedia and Wolfram groups');
  }
  return value.slice(0, GQA_MULTI_PROVIDER_TIMEOUTS.length).map((item, index) => configuredTimeout(
    item,
    GQA_MULTI_PROVIDER_TIMEOUTS[index],
    `GQA provider timeout ${index}`,
  ));
}

function configuredAccountLookup(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'function') return value;
  if (typeof value === 'object' && !Array.isArray(value)) return createGqaAccountLookup(value);
  throw new TypeError('GQA account configuration must be a function or mapping');
}

function configuredAttribution(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'object' && !Array.isArray(value)
    && typeof value.insert === 'function'
    && typeof value.search === 'function'
    && typeof value.wipe === 'function') return value;
  if (typeof value === 'object' && !Array.isArray(value) && value.collection) {
    return createGqaAttributionStore(value);
  }
  if (typeof value === 'object' && !Array.isArray(value) && value.file) {
    return createGqaFileAttributionStore(value);
  }
  throw new TypeError('GQA attribution configuration must provide a store or collection');
}

function sourceProfileWikipediaProvider(provider) {
  // The source worker owns two Wikipedia phase timestamps in addition to the
  // provider result.  Preserve those fields in the final response while the
  // shared pipeline adds its measured group timing (`wiki`).
  return async (context) => {
    const output = await provider(context);
    if (!output || typeof output !== 'object') return {};
    const timestamps = output.timestamps || {};
    const timings = { ...(output.timings || {}) };
    if (timestamps.wiki_response !== undefined && timestamps.wikipedia_fork !== undefined) {
      timings.wiki = Math.max(0, timestamps.wiki_response - timestamps.wikipedia_fork) / 1000;
    }
    if (timestamps.wikipedia_fork !== undefined && timestamps.wiki_begin_tokenization !== undefined) {
      timings.wiki_tokenization = Math.max(0, timestamps.wikipedia_fork - timestamps.wiki_begin_tokenization) / 1000;
    }
    return { ...output, timings };
  };
}

/**
 * Public, keyless endpoints so the profile can start unconfigured.
 *
 * This profile used to require every endpoint explicitly, so that importing or
 * selecting it could not contact a live provider by accident. That made sense
 * while it was opt-in. It is now the default answer profile (the owner's
 * decision), and a default that refuses to start unless three endpoints are set
 * is not a working default.
 *
 * Only keyless public endpoints are defaulted. Wolfram's app id is NOT
 * defaulted -- without `ETCO_gqa_wolframKey` that provider answers with a
 * provider message per request rather than failing startup, which keeps the
 * recovered three-provider plan intact (gqaAnswerSkill's pipeline requires all
 * three to be present) while degrading honestly.
 *
 * Recorded as divergence Q01e.
 */
export const GQA_PUBLIC_ENDPOINTS = Object.freeze({
  duckduckgo: 'https://api.duckduckgo.com/',
  wikipedia: 'https://en.wikipedia.org/w/api.php',
  wolfram: 'https://api.wolframalpha.com/v2/query',
});

/**
 * Read the multi-provider profile configuration from an environment.
 * An endpoint the environment does not set falls back to its public keyless
 * default above; an explicitly configured endpoint always wins.
 */
export function readGqaMultiProviderProfileConfig(env = process.env) {
  return {
    bing: {
      // Microsoft retired the Bing Search API. An explicitly configured Bing
      // endpoint still selects the Bing adapter; otherwise the slot is served
      // by DuckDuckGo's Instant Answer API, which like Bing returns typed
      // answer cards and never plain web pages.
      endpoint: env.ETCO_gqa_bingApi,
      apiKey: env.ETCO_gqa_bingKey,
      duckDuckGoEndpoint: env.ETCO_gqa_duckDuckGoApi || GQA_PUBLIC_ENDPOINTS.duckduckgo,
      timeoutMs: configuredTimeout(env.ETCO_gqa_bingTimeoutMs, undefined, 'ETCO_gqa_bingTimeoutMs'),
    },
    wikipedia: {
      endpoint: env.ETCO_gqa_wikiApi || GQA_PUBLIC_ENDPOINTS.wikipedia,
      timeoutMs: configuredTimeout(env.ETCO_gqa_wikiTimeoutMs, undefined, 'ETCO_gqa_wikiTimeoutMs'),
      userAgent: env.ETCO_gqa_wikiUserAgent || undefined,
    },
    wolfram: {
      endpoint: env.ETCO_gqa_wolframApi || GQA_PUBLIC_ENDPOINTS.wolfram,
      // Deliberately NOT defaulted: an app id is a credential.
      apiKey: env.ETCO_gqa_wolframKey,
    },
    timeouts: [
      configuredTimeout(env.ETCO_gqa_providerTimeoutMs, GQA_MULTI_PROVIDER_TIMEOUTS[0], 'ETCO_gqa_providerTimeoutMs'),
      configuredTimeout(env.ETCO_gqa_wolframGroupTimeoutMs, GQA_MULTI_PROVIDER_TIMEOUTS[1], 'ETCO_gqa_wolframGroupTimeoutMs'),
    ],
  };
}

/**
 * Construct the source-shaped provider map and answer handler without
 * starting a listener.  `fetchImpl` and `clock` are per-provider seams for
 * controlled tests or a deployment transport; the defaults use the normal
 * runtime HTTP client and wall clock.
 */
export function createGqaMultiProviderProfile({
  bing,
  wikipedia,
  wolfram,
  timeouts,
  random = Math.random,
  clock = Date.now,
  idFactory,
  messageId,
  skillId = GQA_MULTI_PROVIDER_SKILL_ID,
  account,
  attribution,
} = {}) {
  const bingConfig = providerSection(bing, 'Bing');
  const wikipediaConfig = providerSection(wikipedia, 'Wikipedia');
  const wolframConfig = providerSection(wolfram, 'Wolfram Alpha');
  const providerTimeouts = configuredTimeouts(timeouts);
  const accountLookup = configuredAccountLookup(account);
  const attributionStore = configuredAttribution(attribution);

  const bingProvider = bingEndpointConfigured(bingConfig.endpoint)
    ? createBingProvider({
      ...bingConfig,
      endpoint: configuredEndpoint(bingConfig.endpoint, 'Bing'),
      clock: bingConfig.clock || clock,
    })
    : createDuckDuckGoProvider({
      ...bingConfig,
      endpoint: bingConfig.duckDuckGoEndpoint || DUCKDUCKGO_SOURCE_API,
      clock: bingConfig.clock || clock,
    });
  const wikipediaProvider = createWikipediaProvider({
    ...wikipediaConfig,
    endpoint: configuredEndpoint(wikipediaConfig.endpoint, 'Wikipedia'),
    headers: {
      ...(wikipediaConfig.userAgent ? { 'user-agent': wikipediaConfig.userAgent } : {}),
      ...(wikipediaConfig.headers || {}),
    },
    clock: wikipediaConfig.clock || clock,
    random: wikipediaConfig.random || random,
  });
  const wolframProvider = createWolframProvider({
    ...wolframConfig,
    endpoint: configuredEndpoint(wolframConfig.endpoint, 'Wolfram Alpha'),
    clock: wolframConfig.clock || clock,
  });

  const providers = Object.freeze({
    Bing: bingProvider,
    Wikipedia: sourceProfileWikipediaProvider(wikipediaProvider),
    'Wolfram Alpha': wolframProvider,
  });
  const pipeline = createGqaProviderPipeline({
    providers,
    timeouts: providerTimeouts,
    clock,
  });
  const handler = createGqaAnswerSkill({
    provider: pipeline,
    rng: random,
    clock,
    skillId,
    idFactory,
    messageId,
    accountLookup,
    attribution: attributionStore,
  });

  return Object.freeze({
    profile: GQA_MULTI_PROVIDER_PROFILE,
    skillId,
    providers,
    pipeline,
    handler,
    timeouts: Object.freeze(providerTimeouts),
    accountLookup,
    attribution: attributionStore,
  });
}

/** Create the opt-in HTTP service for an already-selected multi-provider profile. */
export function createGqaMultiProviderService(options = {}) {
  const {
    profile,
    name = 'answer-gqa-multi-provider',
    ...profileOptions
  } = options;
  const selected = profile || createGqaMultiProviderProfile(profileOptions);
  if (!selected || typeof selected.handler !== 'function') {
    throw new TypeError('GQA multi-provider profile must contain a handler');
  }
  const route = createGqaHttpRoute({
    skillId: selected.skillId || GQA_MULTI_PROVIDER_SKILL_ID,
    handler: selected.handler,
  });
  const routes = {
    [`POST ${GQA_MULTI_PROVIDER_BASE_PATH}/v1/main`]: route,
    [`POST ${GQA_MULTI_PROVIDER_BASE_PATH}`]: route,
    'POST /v1/main': route,
  };
  if (selected.attribution) {
    routes['POST /wipeID'] = createGqaWipeAttributionRoute({ attribution: selected.attribution });
    if (selected.accountLookup) {
      routes['POST /retrieveAtt'] = createGqaRetrieveAttributionRoute({
        accountLookup: selected.accountLookup,
        attribution: selected.attribution,
      });
    }
  }
  return createService({
    name,
    routes,
  });
}

/** Start the explicitly selected profile using endpoint values from `env`. */
export function startGqaMultiProviderService(port, options = {}) {
  const { env = process.env, ...overrides } = options;
  const config = readGqaMultiProviderProfileConfig(env);
  const account = Object.prototype.hasOwnProperty.call(overrides, 'account')
    ? overrides.account
    : env.ETCO_server_accountService
      ? { endpoint: env.ETCO_server_accountService }
      : undefined;
  return createGqaMultiProviderService({
    ...config,
    ...overrides,
    account,
    bing: { ...config.bing, ...(overrides.bing || {}) },
    wikipedia: { ...config.wikipedia, ...(overrides.wikipedia || {}) },
    wolfram: { ...config.wolfram, ...(overrides.wolfram || {}) },
  }).listen(port);
}
