// Shared-host wiring for the recovered GQA answer service.
//
// Pegasus's source registry calls this service `answer` and sends it to
// /answer_skill/v1/main.  Phoenix's co-hosted deployment has an established
// `answer-skill` alias and exposes it at /v1/answer-skill/main (plus the
// default /v1/main route).  This adapter keeps that deployment identity while
// using the source GQA HTTP route and provider pipeline.

import { createGqaHttpRoute } from './gqaAnswerSkill.js';
import {
  createGqaMultiProviderProfile,
  readGqaMultiProviderProfileConfig,
} from './gqaMultiProviderService.js';

export const GQA_DEFAULT_PROFILE = 'multi-provider';
export const GQA_DEFAULT_PROFILE_ENV = 'PHOENIX_GQA_DEFAULT_PROFILE';
export const GQA_DEFAULT_SKILL_ID = 'answer-skill';
export const GQA_SOURCE_SKILL_ID = 'answer';
export const GQA_SOURCE_BASE_PATH = '/answer_skill';

function own(options, key) {
  return Object.prototype.hasOwnProperty.call(options, key);
}

/**
 * Build the answer-skill descriptor for the co-hosted skills service.
 *
 * Every provider endpoint remains an explicit deployment input.  The
 * profile factory rejects an omitted endpoint before a listener is created;
 * there is no public-URL fallback and no LLM substitution on this path.
 * `options` accepts the same controlled seams as the standalone profile
 * factory (fetch, clock, random, account and attribution).
 */
export function createGqaDefaultSkill({ env = process.env, ...options } = {}) {
  const sourceConfig = readGqaMultiProviderProfileConfig(env);
  const merged = {
    ...sourceConfig,
    ...options,
    // Preserve environment values while allowing tests/deployments to
    // replace an individual provider with an explicitly supplied seam.
    bing: { ...sourceConfig.bing, ...(options.bing || {}) },
    wikipedia: { ...sourceConfig.wikipedia, ...(options.wikipedia || {}) },
    wolfram: { ...sourceConfig.wolfram, ...(options.wolfram || {}) },
    skillId: GQA_DEFAULT_SKILL_ID,
  };
  if (!own(options, 'account') && env.ETCO_server_accountService) {
    merged.account = { endpoint: env.ETCO_server_accountService };
  }
  const profile = createGqaMultiProviderProfile(merged);
  const route = createGqaHttpRoute({
    skillId: GQA_DEFAULT_SKILL_ID,
    handler: profile.handler,
  });
  return Object.freeze({
    id: GQA_DEFAULT_SKILL_ID,
    handler: profile.handler,
    route,
    profile,
    sourceSkillId: GQA_SOURCE_SKILL_ID,
    sourceBasePath: GQA_SOURCE_BASE_PATH,
  });
}

/**
 * Validate the shared-host selector without constructing provider clients.
 * A caller can use `undefined`/empty to retain the ordinary Phoenix answer
 * handler; any non-empty value must be the known source-backed profile.
 */
export function validateGqaDefaultProfile(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (value !== GQA_DEFAULT_PROFILE) {
    throw new Error(`Unknown ${GQA_DEFAULT_PROFILE_ENV} '${value}'`);
  }
  return value;
}
