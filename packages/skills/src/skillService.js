// Skill host — Phoenix equivalent of baseskill/SkillService.ts. Hosts one skill at the
// unauthenticated POST /v1/main, validating the inbound SkillRequest and wrapping handler
// errors in the reference error shape ({type:'ERROR', data:{message, skill:{id}}};
// baseskill/BaseSkill.ts:36-48). Skills are stateless: all session state round-trips in the
// request/response `skill.session` blob (message-protocol.md hop 12).

import { createService } from '@phoenix/common';
import { newMsgId, now, validate, schemas, SkillResponseType } from '@phoenix/contracts';

/**
 * @param {{ name:string, skillId:string, handler:(req:object,ctx:object)=>Promise<object>|object }} def
 * @returns {{ service: import('http').Server-ish, listen:(port:number)=>Promise<any> }}
 */
export function createSkillService({ name, skillId, handler }) {
  return createService({
    name,
    routes: {
      'POST /v1/main': async ({ body, trace, log }) => {
        const { valid, errors } = validate(schemas.skillRequest, body);
        if (!valid) {
          log.warn('invalid SkillRequest', { errors });
          return errorResponse(skillId, `invalid SkillRequest: ${errors.join('; ')}`);
        }
        try {
          return await handler(body, { trace, log });
        } catch (err) {
          log.error('skill handler threw', { error: err.message });
          return errorResponse(skillId, err.message);
        }
      },
    },
  });
}

function errorResponse(skillId, message) {
  return { type: SkillResponseType.ERROR, msgID: newMsgId(), ts: now(), data: { message, skill: { id: skillId } } };
}
