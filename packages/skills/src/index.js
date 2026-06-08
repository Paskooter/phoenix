// Skills service host (Pegasus baseskill + skills equivalent). Milestone M7.
//
// Hosts the answer-skill at POST /v1/main (the gateway's default registry points answer-skill
// here). Additional skills (chitchat, report) become additional hosts/paths as they are built.

import { DefaultPort } from '@phoenix/contracts';
import { createSkillService } from './skillService.js';
import { answerSkill } from './answerSkill.js';

export { createSkillService } from './skillService.js';
export { buildSkillAction, escapeForEsml } from './jcp.js';
export { answerSkill } from './answerSkill.js';

export function start(port = Number(process.env.PORT) || DefaultPort.skills) {
  const svc = createSkillService({ name: 'skills', skillId: 'answer-skill', handler: answerSkill });
  return svc.listen(port);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch((e) => { console.error(e); process.exit(1); });
}
