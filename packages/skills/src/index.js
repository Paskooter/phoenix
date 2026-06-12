// Skills service host (Pegasus baseskill + skills equivalent). Milestone M7.
//
// Hosts the cloud skills, each at POST /v1/<id>/main (the gateway registry points each cloud
// skill's URL there); answer-skill is also at /v1/main for back-compat.

import { DefaultPort } from '@phoenix/contracts';
import { createSkillsService, createSkillService } from './skillService.js';
import { answerSkill } from './answerSkill.js';
import { reportSkill } from './reportSkill.js';
import { chitchatSkill } from './chitchatSkill.js';
import { colorSkill } from './colorSkill.js';
import { exampleSkill } from './exampleSkill.js';
import { templateSkill } from './templateSkill.js';

export { createSkillsService, createSkillService } from './skillService.js';
export { buildSkillAction, buildJcpAction, buildJcpFromSlim, escapeForEsml } from './jcp.js';
export { createGraphSkill, SkillFacade } from './graph/graphSkill.js';
export { Node, FnNode } from './graph/node.js';
export { Graph, TransitionContainer } from './graph/graph.js';
export * as nodes from './graph/nodes.js';
export * as mimFactories from './graph/mims/factories.js';
export { OptInFactory, OptInType, OptInTransition, RouteNode, YesNoWrongIDNode } from './graph/mims/optIn.js';
export { unifyMims } from './graph/mims/unify.js';
export { loadMims, prepareMim } from './graph/mims/utils.js';
export { GraphManager } from './graph/graphManager.js';
export { generateSlim, generateSlimSequence, generateSlimFromMim, generateDisplay, weightedSample, newMimState, MimTypes, PromptCategory, PromptSubCategory } from './graph/mims/slimmer.js';
export { buildPromptData, loadMimFile } from './graph/mims/promptData.js';
export { answerSkill } from './answerSkill.js';
export { reportSkill } from './reportSkill.js';
export { chitchatSkill } from './chitchatSkill.js';
export { colorSkill } from './colorSkill.js';
export { exampleSkill } from './exampleSkill.js';
export { templateSkill } from './templateSkill.js';

export const SKILLS = [
  { id: 'answer-skill', handler: answerSkill },
  { id: 'report-skill', handler: reportSkill },
  { id: 'chitchat-skill', handler: chitchatSkill },
  { id: 'color-skill', handler: colorSkill },
  { id: 'example-skill', handler: exampleSkill },
  { id: 'template-skill', handler: templateSkill },
];

export function start(port = Number(process.env.PORT) || DefaultPort.skills) {
  return createSkillsService({ name: 'skills', skills: SKILLS, defaultId: 'answer-skill' }).listen(port);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch((e) => { console.error(e); process.exit(1); });
}
