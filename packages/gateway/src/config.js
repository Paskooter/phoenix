// Gateway configuration + skill registry.
//
// Mirrors HubConfig (HubConfigProvider.ts) and SkillConfigManager (config/SkillConfigManager.ts).
// Source NET_<svc> values are authorities prefixed with http://. Phoenix URL
// aliases and the shared skill host remain explicit deployment adapters.

import { loadRegistry } from './registry.js';

/**
 * Build the gateway runtime config from the environment.
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function loadConfig(env = process.env, registryOptions = {}) {
  // Resolve the supplied environment consistently; reading process.env here
  // used to make embedded callers silently select a different registry/peer.
  const peer = (name, fallback) => {
    const value = env[`NET_${name}`] || fallback;
    return /^https?:\/\//.test(value) ? value : `http://${value}`;
  };
  const sourcePeer = (name, fallback, alias) => env[`NET_${name}`]
    ? `http://${env[`NET_${name}`]}`
    : alias && env[alias] ? peer(name, env[alias]) : `http://${fallback}`;
  // A shared Phoenix skill host is an explicit deployment adapter. Without
  // that override, use the original index and each entry's complete URL.
  const explicitSkillsConfig = Boolean(env.ETCO_hub_skillsConfig);
  const skillsBase = !explicitSkillsConfig && (env.NET_skills || env.ETCO_hub_skillsUrl)
    ? peer('skills', env.ETCO_hub_skillsUrl)
    : '';
  const indexFile = env.ETCO_hub_skillsConfig || (skillsBase ? 'skills-phoenix.json' : 'skills-local.json');
  const skills = await loadRegistry({ ...registryOptions, skillsBase, env, indexFile });
  return {
    hubTokenSecret: env.ETCO_server_hubTokenSecret || '',
    disableAuth: env.ETCO_hub_disableAuth === 'true',
    // Optional per-robot validation: after the JWT signature checks out, confirm the token's
    // accessKeyId claim still maps to a live account (account service GET /api/verify). Unset
    // (the default) = shared-secret-only, i.e. any validly-signed token is accepted.
    accountUrl: (env.ETCO_hub_accountUrl || '').replace(/\/$/, ''),
    asrProvider: env.ETCO_server_asrProvider || 'none',
    parserURL: sourcePeer('parser', 'docker.for.mac.localhost:9005', 'ETCO_hub_parserUrl'),
    historyURL: sourcePeer('history', 'docker.for.mac.localhost:9006', 'ETCO_hub_historyUrl'),
    settingsURL: sourcePeer('settings', 'settings.jibo.aws'),
    recordSpeechHistory: env.ETCO_hub_recordSpeechHistory === 'true',
    recordLaunchHistory: (env.ETCO_hub_recordLaunchHistory || 'true') === 'true',
    skills,
  };
}
