// Skill host — Phoenix equivalent of baseskill/SkillService.ts. Hosts one or more skills, each
// at an unauthenticated POST /v1/<skillId>/main (the gateway registry points each cloud skill's
// URL there), and wrapping handler errors in the reference error shape
// ({type:'ERROR', data:{message, skill:{id}}}; baseskill/BaseSkill.ts:36-48). Skills are
// stateless: all session state round-trips in the request/response `skill.session` blob. The
// source BaseSkill passes arbitrary parsed body objects to each skill; transport JSON parsing and
// framing remain the common service boundary.

import { createService } from '@phoenix/common';
import { newMsgId, now, SkillResponseType } from '@phoenix/contracts';

// Pegasus BaseService decorates each incoming skill request with
// `req.jibo = new JiboHeaders(req.headers)`. Keep the same three trace headers
// and defaults at the skills boundary without copying authentication or other
// caller headers into downstream provider requests.
export function sourceJiboHeaders(headers = {}) {
  const values = {
    transID: headers['x-jibo-transid'] || 'unknown',
    robotID: headers['x-jibo-robotid'] || 'unknown',
    loggingConfig: headers['x-jibo-logging-config'] || '{}',
  };
  return {
    ...values,
    toHeader() {
      return {
        'x-jibo-transid': this.transID,
        ...(this.robotID ? { 'x-jibo-robotid': this.robotID } : {}),
        ...(this.loggingConfig ? { 'x-jibo-logging-config': this.loggingConfig } : {}),
      };
    },
  };
}

/** Wrap a skill handler into the source error-enveloping route handler. */
export function skillRoute(skillId, handler) {
  return async ({ body, trace, log, req }) => {
    // BaseSkill starts its timer immediately before invoking the skill and
    // overwrites any handler-supplied timings field after the awaited result.
    // Keep this assignment inside the try block: a handler that resolves
    // undefined follows the source path and becomes an ERROR response when
    // assigning `timings` fails.
    const startTime = Date.now();
    try {
      const response = await handler(body, {
        trace,
        log,
        req: { jibo: sourceJiboHeaders(req && req.headers), log },
      });
      setResponseTimings(response, Date.now() - startTime);
      return response;
    } catch (err) {
      // BaseSkill logs the original thrown value, then uses the shared
      // getErrorMessage helper for the wire-visible error message.
      log.error('skill handler threw', { error: err });
      return errorResponse(skillId, getErrorMessage(err));
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

// The original BaseSkill performs a strict-mode property assignment. Node 8
// and current Node versions phrase the primitive/null/undefined failures
// differently. Localize only those wrapper-generated messages, then perform
// the real assignment so inherited setters and Proxy traps retain source
// semantics. Errors raised by a handler or a custom setter remain untouched.
function setResponseTimings(response, total) {
  if (response === undefined) throw new TypeError("Cannot set property 'timings' of undefined");
  if (response === null) throw new TypeError("Cannot set property 'timings' of null");

  const type = typeof response;
  if (type === 'number' || type === 'boolean' || type === 'string') {
    throw new TypeError(`Cannot create property 'timings' on ${type} '${String(response)}'`);
  }

  response.timings = { total };
}

// Equivalent to @jibo/utils-common's getErrorMessage used by BaseSkill. Keep
// the direct property access: null/undefined thrown values fail in the same
// outer-service path as the original implementation.
function getErrorMessage(error) {
  if (error === null) throw new TypeError("Cannot read property 'message' of null");
  if (error === undefined) throw new TypeError("Cannot read property 'message' of undefined");
  if (typeof error === 'string') return error;
  if (typeof error.message === 'string') return error.message;
  return `Error: ${JSON.stringify(error)}`;
}
