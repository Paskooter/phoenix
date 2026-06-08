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

export { createSkillsService, createSkillService } from './skillService.js';
export { buildSkillAction, buildJcpAction, escapeForEsml } from './jcp.js';
export { createGraphSkill } from './graph/graphSkill.js';
export { Node, FnNode } from './graph/node.js';
export { GraphManager } from './graph/graphManager.js';
export { answerSkill } from './answerSkill.js';
export { reportSkill } from './reportSkill.js';
export { chitchatSkill } from './chitchatSkill.js';
export { colorSkill } from './colorSkill.js';

export const SKILLS = [
  { id: 'answer-skill', handler: answerSkill },
  { id: 'report-skill', handler: reportSkill },
  { id: 'chitchat-skill', handler: chitchatSkill },
  { id: 'color-skill', handler: colorSkill },
];

export function start(port = Number(process.env.PORT) || DefaultPort.skills) {
  return createSkillsService({ name: 'skills', skills: SKILLS, defaultId: 'answer-skill' }).listen(port);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch((e) => { console.error(e); process.exit(1); });
}
