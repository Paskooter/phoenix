// Explicit answer-service profile backed by the source-shaped Wikipedia
// provider.  This profile is opt-in and intentionally does not manufacture
// Bing/Wolfram adapters or attribution storage.

import { createService } from '@phoenix/common';
import {
  createGqaAnswerSkill,
  createGqaHttpRoute,
  createGqaProviderPipeline,
} from './gqaAnswerSkill.js';
import {
  createWikipediaProvider,
  WIKIPEDIA_SOURCE_API,
} from './gqaWikipediaProvider.js';
import {
  createGqaAccountLookup,
  createGqaAttributionStore,
  createGqaRetrieveAttributionRoute,
  createGqaWipeAttributionRoute,
} from './gqaAccountAttribution.js';

export const GQA_WIKIPEDIA_PROFILE = 'wikipedia';
export const GQA_WIKIPEDIA_SKILL_ID = 'answer';
export const GQA_WIKIPEDIA_BASE_PATH = '/answer_skill';

function configuredTimeout(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new TypeError('ETCO_gqa_wikiTimeoutMs must be a non-negative number');
  }
  return parsed;
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
  throw new TypeError('GQA attribution configuration must provide a store or collection');
}

// In the source route controls, Wikipedia runs inside GqaParallelQuery.  A
// provider's `{source, message}` result is recorded in the service log and
// contributes no answer; choose_slim then emits the normal no-answer MIM.
// Keep the direct provider factory's diagnostic result intact for callers that
// need that lower-level contract, while adapting this one-provider profile to
// the observable source answer route.
function sourceProfileProvider(provider) {
  return async (context) => {
    const output = await provider(context);
    if (!output || typeof output !== 'object') return {};
    const payload = output.response && output.response.payload;
    if (!payload) return {};
    // gqa.wiki.call reports worker checkpoints and the source route combines
    // them with the parent fork boundary: `wiki` is response minus fork and
    // `wiki_tokenization` is fork minus tokenization start. Preserve those
    // keys while leaving their measured values runtime-owned.
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

/** Read the explicit profile's environment without changing the default host. */
export function readGqaWikipediaProfileConfig(env = process.env) {
  return {
    endpoint: env.ETCO_gqa_wikiApi || WIKIPEDIA_SOURCE_API,
    timeoutMs: configuredTimeout(env.ETCO_gqa_wikiTimeoutMs),
    userAgent: env.ETCO_gqa_wikiUserAgent || undefined,
  };
}

/**
 * Create the source-registered answer service with exactly one configured
 * provider.  The original endpoint is /answer_skill/v1/main; /answer_skill
 * is retained as the source's legacy route and /v1/main is an explicit
 * Phoenix single-service convenience route for this profile only.
 */
export function createGqaWikipediaService({
  endpoint = WIKIPEDIA_SOURCE_API,
  fetchImpl,
  headers,
  timeoutMs,
  signal,
  clock,
  random,
  idFactory,
  messageId,
  account,
  attribution,
  name = 'answer-wikipedia',
} = {}) {
  const configuredRequestTimeout = configuredTimeout(timeoutMs);
  const accountLookup = configuredAccountLookup(account);
  const attributionStore = configuredAttribution(attribution);
  const provider = createWikipediaProvider({
    endpoint,
    fetchImpl,
    headers: headers || {},
    timeoutMs: configuredRequestTimeout,
    signal,
    clock,
    random,
  });
  const handler = createGqaAnswerSkill({
    provider: createGqaProviderPipeline({
      providers: {
        Bing: async () => ({}),
        Wikipedia: sourceProfileProvider(provider),
        'Wolfram Alpha': async () => ({}),
      },
    }),
    // The source uses one random stream for both provider disambiguation and
    // the selected GQA MIM prompt.  Sharing the injected stream also makes
    // source-shaped controls deterministic without changing production's
    // default Math.random behavior.
    rng: random,
    skillId: GQA_WIKIPEDIA_SKILL_ID,
    idFactory,
    messageId,
    clock,
    accountLookup,
    attribution: attributionStore,
  });
  const route = createGqaHttpRoute({
    skillId: GQA_WIKIPEDIA_SKILL_ID,
    handler,
  });

  const routes = {
    [`POST ${GQA_WIKIPEDIA_BASE_PATH}/v1/main`]: route,
    [`POST ${GQA_WIKIPEDIA_BASE_PATH}`]: route,
    'POST /v1/main': route,
  };
  if (attributionStore) {
    routes['POST /wipeID'] = createGqaWipeAttributionRoute({ attribution: attributionStore });
    if (accountLookup) {
      routes['POST /retrieveAtt'] = createGqaRetrieveAttributionRoute({
        accountLookup,
        attribution: attributionStore,
      });
    }
  }
  return createService({
    name,
    routes,
  });
}

/** Start the profile using only the explicit GQA environment configuration. */
export function startGqaWikipediaService(port, options = {}) {
  const env = options.env || process.env;
  const config = readGqaWikipediaProfileConfig(env);
  const account = Object.prototype.hasOwnProperty.call(options, 'account')
    ? options.account
    : env.ETCO_server_accountService
      ? { endpoint: env.ETCO_server_accountService }
      : undefined;
  const service = createGqaWikipediaService({
    endpoint: options.endpoint || config.endpoint,
    fetchImpl: options.fetchImpl,
    headers: {
      ...(config.userAgent ? { 'user-agent': config.userAgent } : {}),
      ...(options.headers || {}),
    },
    timeoutMs: options.timeoutMs === undefined
      ? config.timeoutMs
      : configuredTimeout(options.timeoutMs),
    signal: options.signal,
    clock: options.clock,
    random: options.random,
    idFactory: options.idFactory,
    messageId: options.messageId,
    account,
    attribution: options.attribution,
  });
  return service.listen(port);
}
