// Skill host — Phoenix equivalent of baseskill/SkillService.ts. Hosts one or more skills, each
// at an unauthenticated POST /v1/<skillId>/main (the gateway registry points each cloud skill's
// URL there), validating the inbound SkillRequest and wrapping handler errors in the reference
// error shape ({type:'ERROR', data:{message, skill:{id}}}; baseskill/BaseSkill.ts:36-48). Skills
// are stateless: all session state round-trips in the request/response `skill.session` blob.

import { createService } from '@phoenix/common';
import { newMsgId, now, validate, schemas, SkillResponseType } from '@phoenix/contracts';

/** Wrap a skill handler into a validating, error-enveloping route handler. */
export function skillRoute(skillId, handler) {
  return async ({ body, trace, log }) => {
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
  };
}

/**
 * Host several skills. Each gets POST /v1/<id>/main; `defaultId` (or the first) is also served at
 * POST /v1/main for back-compat.
 * @param {{ name?:string, skills:Array<{id:string, handler:Function}>, defaultId?:string }} opts
 */
export function createSkillsService({ name = 'skills', skills, defaultId }) {
  const routes = {};
  for (const { id, handler } of skills) routes[`POST /v1/${id}/main`] = skillRoute(id, handler);
  const def = skills.find((s) => s.id === defaultId) || skills[0];
  if (def) routes['POST /v1/main'] = skillRoute(def.id, def.handler);
  return createService({ name, routes });
}

/** Back-compat single-skill host. */
export function createSkillService({ name, skillId, handler }) {
  return createSkillsService({ name, skills: [{ id: skillId, handler }], defaultId: skillId });
}

function errorResponse(skillId, message) {
  return { type: SkillResponseType.ERROR, msgID: newMsgId(), ts: now(), data: { message, skill: { id: skillId } } };
}
