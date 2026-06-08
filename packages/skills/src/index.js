// Skill framework + skill host (Pegasus baseskill + skills equivalent). Milestone M7.
//
// Contract to fulfil (docs/atlas/packages/baseskill.md, skills.md, message-protocol.md hops 9-12):
//   POST /v1/main   body = SkillRequest (LISTEN_LAUNCH | LISTEN_UPDATE | PROACTIVE_LAUNCH)
//                   -> SkillResponse (SKILL_ACTION | SKILL_REDIRECT | ERROR).
//   Skills are STATELESS between calls: all session state round-trips through the robot in
//   data.skill.session { id, nodeID, data, trace }. The framework is a GraphSkill FSM whose
//   nodes emit MIM-derived SLIM behaviors (prompt filter -> condition eval -> weighted pick).
//   final:true ends the session; fireAndForget:true + action:null = nothing to perform.
//
// Compare round-trip only for session blobs — node-ID assignment is the new implementation's
// own business. This shell hosts one skill at /v1/main; the real impl will host several
// (chitchat 9004, report 9003, answer 9009) selected by config.

import { createService } from '@phoenix/common';
import { errorResponse, HubErrorCode, DefaultPort } from '@phoenix/contracts';

const { listen } = createService({
  name: 'skills',
  routes: {
    'POST /v1/main': () =>
      errorResponse('skill framework not implemented (milestone M7)', HubErrorCode.NOT_IMPLEMENTED),
  },
});

listen(Number(process.env.PORT) || DefaultPort.skills);
