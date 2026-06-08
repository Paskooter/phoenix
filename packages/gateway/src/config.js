// Gateway configuration + skill registry.
//
// Mirrors HubConfig (HubConfigProvider.ts) and SkillConfigManager (config/SkillConfigManager.ts).
// Peers are discovered via NET_<svc> (defaulting to local dev ports so the gateway boots
// standalone); the skill registry maps intents -> skill URLs the IR routes to.

import { net, etco, boolEnv } from '@phoenix/common';
import { DefaultPort } from '@phoenix/contracts';

/**
 * Build the gateway runtime config from the environment.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function loadConfig(env = process.env) {
  const skillsBase = net('skills', { required: false, default: env.ETCO_hub_skillsUrl || `localhost:${DefaultPort.skills}` });
  return {
    hubTokenSecret: env.ETCO_server_hubTokenSecret || '',
    disableAuth: boolEnv(env.ETCO_hub_disableAuth, false),
    asrProvider: etco('server', 'asrProvider', 'none'), // 'none' until M8; 'parakeet' later
    parserURL: net('parser', { required: false, default: env.ETCO_hub_parserUrl || `localhost:${DefaultPort.nlu}` }),
    historyURL: net('history', { required: false, default: env.ETCO_hub_historyUrl || `localhost:${DefaultPort.history}` }),
    recordLaunchHistory: boolEnv(env.ETCO_hub_recordLaunchHistory, false),
    skills: defaultSkillRegistry(skillsBase),
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
