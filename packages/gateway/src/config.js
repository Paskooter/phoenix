// Gateway configuration + skill registry.
//
// Mirrors HubConfig (HubConfigProvider.ts) and SkillConfigManager (config/SkillConfigManager.ts).
// Peers are discovered via NET_<svc> (defaulting to local dev ports so the gateway boots
// standalone); the skill registry maps intents -> skill URLs the IR routes to.

import { net, etco, boolEnv } from '@phoenix/common';
import { DefaultPort } from '@phoenix/contracts';
import { loadRegistry } from './registry.js';

/**
 * Build the gateway runtime config from the environment.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function loadConfig(env = process.env) {
  // NET_skills (single-host dev mode) overrides every cloud skill's baseURL. When a registry
  // index is selected explicitly (ETCO_hub_skillsConfig — the compose contract), default to the
  // per-skill baseURLs from that index instead, like the reference hub.
  const skillsBase = (env.ETCO_hub_skillsConfig && !env.NET_skills)
    ? '' // per-skill baseURLs from the selected registry index
    : net('skills', { required: false, default: env.ETCO_hub_skillsUrl || `localhost:${DefaultPort.skills}` });
  let skills;
  try {
    skills = loadRegistry({ skillsBase }); // full vendored registry (be-skills + cloud)
    if (!skills.length) throw new Error('empty registry');
  } catch {
    skills = defaultSkillRegistry(skillsBase); // fallback: answer-skill only
  }
  return {
    hubTokenSecret: env.ETCO_server_hubTokenSecret || '',
    disableAuth: boolEnv(env.ETCO_hub_disableAuth, false),
    asrProvider: etco('server', 'asrProvider', 'none'), // 'none' until M8; 'parakeet' later
    parserURL: net('parser', { required: false, default: env.ETCO_hub_parserUrl || `localhost:${DefaultPort.nlu}` }),
    historyURL: net('history', { required: false, default: env.ETCO_hub_historyUrl || `localhost:${DefaultPort.history}` }),
    recordLaunchHistory: boolEnv(env.ETCO_hub_recordLaunchHistory, false),
    skills,
  };
}

// Default skill registry. The answer-skill intents are copied verbatim from the reference
// manifest (hub/pegasus-skills/answer_skill_manifest.json); URL = baseURL + /v1/main
// (SkillUtils.preprocessManifest). On-robot skills carry onRobot:true and no URL.
function defaultSkillRegistry(skillsBase) {
  const base = skillsBase.replace(/\/$/, '');
  return [
    {
      id: 'answer-skill',
      URL: `${base}/v1/main`,
      onRobot: false,
      intents: [
        { name: 'doesJiboKnowPersonThing', memo: { type: 'generic' } },
        { name: 'gqa', memo: { type: 'generic' } },
        { name: 'generalHowQuestions', memo: { type: 'how' } },
        { name: 'generalQuestions', memo: { type: 'generic' } },
        { name: 'generalWhatQuestions', memo: { type: 'what' } },
        { name: 'generalWhenQuestions', memo: { type: 'when' } },
        { name: 'generalWhereQuestions', memo: { type: 'where' } },
        { name: 'generalWhoQuestions', memo: { type: 'who' } },
        { name: 'generalWhyQuestions', memo: { type: 'why' } },
        { name: 'requestTellAboutThing', memo: { type: 'generic' } },
        { name: 'answerQuestion', memo: { type: 'generic' } },
      ],
    },
  ];
}
