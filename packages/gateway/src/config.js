// Gateway configuration + skill registry.
//
// Mirrors HubConfig (HubConfigProvider.ts) and SkillConfigManager (config/SkillConfigManager.ts).
// Source NET_<svc> values are authorities prefixed with http://. Phoenix URL
// aliases and the shared skill host remain explicit deployment adapters.

import { readEnvVars } from '@phoenix/common';
import { loadRegistry } from './registry.js';

// HubConfigProvider.getConfig() reads exactly these names, in this order
// (packages/hub/src/config/HubConfigProvider.ts:24-33). ETCO_hub_speechConfig is read
// by the source and deliberately unused there ("@TODO: read google-speech.json",
// HubConfigProvider.ts:37); Phoenix keeps the name so an unmodified reference
// environment resolves identically.
export const HUB_ENV_DEFAULTS = Object.freeze({
  ETCO_hub_disableAuth: 'false',
  ETCO_hub_skillsConfig: 'skills-local.json',
  ETCO_hub_speechConfig: 'google-speech.json',
  NET_parser: 'docker.for.mac.localhost:9005',
  NET_history: 'docker.for.mac.localhost:9006',
  ETCO_hub_recordSpeechHistory: 'false',
  ETCO_hub_recordLaunchHistory: 'true',
  NET_settings: 'settings.jibo.aws',
});

// This bounds Phoenix's optional account lookup, which is separate from the
// original shared-secret authentication path. Include response-body reads.
export function accountVerifyTimeout(value = 5000) {
  const timeout = value === '' ? 5000 : Number(value);
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2147483647) {
    throw new TypeError('Account verification timeout must be a positive integer in milliseconds');
  }
  return timeout;
}

/**
 * Build the gateway runtime config from the environment.
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function loadConfig(env = process.env, registryOptions = {}) {
  const accountVerifyTimeoutMs = accountVerifyTimeout(env.ETCO_hub_accountVerifyTimeoutMs);
  // Resolve the supplied environment consistently; reading process.env here
  // used to make embedded callers silently select a different registry/peer.
  // readEnvVars applies the reference `process.env[key] || default` precedence,
  // so an empty source value also falls back to the source default.
  const envVars = readEnvVars(HUB_ENV_DEFAULTS, env);
  const peer = (value) => (/^https?:\/\//.test(value) ? value : `http://${value}`);
  // NET_<svc> is authoritative and the source always prefixes it with http://
  // (HubConfigProvider.ts:41-52). A Phoenix ETCO_*Url alias is consulted only when
  // the source name is absent; that alias is a deployment extension, not a source name.
  const sourcePeer = (key, alias) => env[key]
    ? `http://${env[key]}`
    : alias && env[alias] ? peer(env[alias]) : `http://${envVars[key]}`;
  // A shared Phoenix skill host is an explicit deployment adapter. Without
  // that override, use the original index and each entry's complete URL.
  const explicitSkillsConfig = Boolean(env.ETCO_hub_skillsConfig);
  const skillsBase = !explicitSkillsConfig && (env.NET_skills || env.ETCO_hub_skillsUrl)
    ? peer(env.NET_skills || env.ETCO_hub_skillsUrl)
    : '';
  const indexFile = env.ETCO_hub_skillsConfig || (skillsBase ? 'skills-phoenix.json' : envVars.ETCO_hub_skillsConfig);
  const skills = await loadRegistry({ ...registryOptions, skillsBase, env, indexFile });
  return {
    hubTokenSecret: env.ETCO_server_hubTokenSecret || '',
    disableAuth: envVars.ETCO_hub_disableAuth === 'true',
    // Optional per-robot validation: after the JWT signature checks out, confirm the token's
    // accessKeyId claim still maps to a live account (account service GET /api/verify). Unset
    // (the default) = shared-secret-only, i.e. any validly-signed token is accepted.
    accountUrl: (env.ETCO_hub_accountUrl || '').replace(/\/$/, ''),
    accountVerifyTimeoutMs,
    asrProvider: env.ETCO_server_asrProvider || 'none',
    parserURL: sourcePeer('NET_parser', 'ETCO_hub_parserUrl'),
    historyURL: sourcePeer('NET_history', 'ETCO_hub_historyUrl'),
    settingsURL: sourcePeer('NET_settings'),
    recordSpeechHistory: envVars.ETCO_hub_recordSpeechHistory === 'true',
    recordLaunchHistory: envVars.ETCO_hub_recordLaunchHistory === 'true',
    skills,
  };
}

/**
 * The startup log payload the source hub prints (cli/start.ts:28-39).
 *
 * `HubConfigProvider.getConfig()` returns a HubConfig
 * (interfaces.ts:14-21); `cli/start.ts` shallow-copies it and drops each skill's
 * `intents`, `settings` and `proactives` before logging "Starting hub with config: ".
 * Phoenix's flat gateway config is projected back onto that HubConfig shape so the
 * emitted setup record keeps the source field names and nesting.
 */
export function hubSetupConfig(config) {
  const skills = config.skills.map((skill) => {
    const skillCopy = { ...skill };
    delete skillCopy.intents;
    delete skillCopy.settings;
    delete skillCopy.proactives;
    return skillCopy;
  });
  return {
    disableAuth: config.disableAuth,
    parser: { baseURL: config.parserURL },
    history: { baseURL: config.historyURL },
    hubSettings: {
      recordSpeechHistory: config.recordSpeechHistory,
      recordLaunchHistory: config.recordLaunchHistory,
    },
    skills,
    settings: { baseURL: config.settingsURL },
  };
}
