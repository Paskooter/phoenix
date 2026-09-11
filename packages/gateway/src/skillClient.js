// Skill client — SkillConfigManager (config/SkillConfigManager.ts) + SkillRequestMaker
// (skill/SkillRequestMaker.ts) + SkillRequestHelper (skill/SkillRequestHelper.ts).
//
// Builds LISTEN_LAUNCH / LISTEN_UPDATE requests and POSTs them to the skill's /v1/main URL,
// returning { skillID, response } or { skillID, error }. Injects nlu.entities.loopMemberReferent
// into runtime.dialog.referent (SkillRequestHelper.injectDialogContext).

import { message, SkillRequestType, ResponseType } from '@phoenix/contracts';
import { writeTrace } from '@phoenix/common';
import { deepFreeze, legacyConfigError, validateSkillConfig } from './skillConfigValidation.js';

export const SkillRequestError = Object.freeze({
  SKILL_NOT_FOUND: 'SKILL_NOT_FOUND',
  TIMEOUT: 'TIMEOUT',
});

export class SkillConfigManager {
  constructor(configs) {
    this.configs = new Map();
    try { configs.forEach(entry => this.addSkillConfig(entry)); }
    catch (error) { throw legacyConfigError(error); }
  }
  addSkillConfig(entry) {
    try {
      const config = deepFreeze(entry);
      validateSkillConfig(config);
      this.configs.set(config.id.toLowerCase(), config);
    } catch (error) { throw legacyConfigError(error); }
  }
  getSkillConfig(id) {
    try { return this.configs.get(id.toLowerCase()); }
    catch (error) { throw legacyConfigError(error); }
  }
  getSkillConfigs() { return Array.from(this.configs.values()); }
  getProactiveSkillConfigs() {
    return this.getSkillConfigs().filter(config => !!config.proactives).map(config => ({ skillID: config.id, proactives: config.proactives, IHQueries: config.IHQueries }));
  }
  get(id) { return this.getSkillConfig(id); }
  isOnRobotSkill(id) { const c = this.get(id); return !!(c && c.onRobot); }
}

export class SkillClient {
  constructor(skillConfigManager) {
    this.mgr = skillConfigManager;
  }

  /** Build + send a LISTEN_LAUNCH (or LISTEN_UPDATE when update=true). */
  async launchOrUpdate(skillID, input, trace, update = false) {
    const req = update ? buildListenUpdate(skillID, input) : buildListenLaunch(skillID, input);
    return this._send(skillID, req, trace);
  }

  /** Build + send a fresh LISTEN_LAUNCH (used for redirects). */
  async launch(skillID, input, trace) {
    return this._send(skillID, buildListenLaunch(skillID, input), trace);
  }

  /** Build + send a PROACTIVE_LAUNCH. */
  async proactiveLaunch(skillID, input, trace) {
    return this._send(skillID, buildProactiveLaunch(skillID, input), trace);
  }

  async _send(skillID, skillRequest, trace) {
    const cfg = this.mgr.get(skillID);
    if (!cfg) return { skillID, error: { code: SkillRequestError.SKILL_NOT_FOUND, message: `Skill "${skillID}" does not exist` } };
    if (cfg.onRobot) return { skillID, error: { code: SkillRequestError.SKILL_NOT_FOUND, message: `Skill "${skillID}" is a robot skill` } };
    try {
      const res = await fetch(cfg.URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...writeTrace(trace) },
        body: JSON.stringify(skillRequest),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        // Faithful to SkillRequestMaker.getSkillResponseFromURL (SkillRequestMaker.ts:119-123),
        // whose message is `Error from URL '<url>': <status> <axios message> :: <json body>`.
        // axios's message for a non-2xx is `Request failed with status code <status>` and its
        // parsed body is re-serialized with JSON.stringify (a non-JSON body survives as a
        // quoted string); both are reproduced here from the raw response text.
        // `code` reproduces SkillRequestMaker.getSkillResponseFromID's catch
        // (SkillRequestMaker.ts:74-76): `error.code || message.startsWith('timeout') ? TIMEOUT
        // : SKILL_NOT_FOUND`. The thrown envelope always carries a truthy `code`, so every
        // request-path failure is TIMEOUT — the value the speech record stores as
        // `skill.error.code` (source oracle: skillFailure / redirectDestinationFailure).
        return { skillID, error: { code: SkillRequestError.TIMEOUT, message: `Error from URL '${cfg.URL}': ${res.status} Request failed with status code ${res.status} :: ${serializeResponseBody(text)}` } };
      }
      return { skillID, response: await res.json() };
    } catch (error) {
      return { skillID, error: { code: SkillRequestError.TIMEOUT, message: `Error from URL '${cfg.URL}': ${error.message}` } };
    }
  }
}

/** A skill response is a redirect iff type === SKILL_REDIRECT (SkillUtils.isRedirect). */
export function isRedirect(response) {
  return !!response && response.type === ResponseType.SKILL_REDIRECT;
}

/**
 * Reproduce axios's `JSON.stringify(error.response.data)` from a raw body: a
 * JSON body is parsed and re-serialized compactly, anything else stays a string
 * and is quoted. (SkillRequestMaker.ts:119-123.)
 */
function serializeResponseBody(text) {
  try { return JSON.stringify(JSON.parse(text)); }
  catch { return JSON.stringify(text); }
}

function injectDialogContext(input) {
  const referent = input.nlu && input.nlu.entities && input.nlu.entities.loopMemberReferent;
  if (referent && (!Array.isArray(referent) || referent.length)) {
    const resolved = Array.isArray(referent) ? referent[0] : referent;
    input.context.runtime = input.context.runtime || {};
    input.context.runtime.dialog = input.context.runtime.dialog || {};
    input.context.runtime.dialog.referent = resolved;
  }
}

function buildListenLaunch(skillID, input) {
  injectDialogContext(input);
  const m = message(SkillRequestType.LISTEN_LAUNCH, {
    general: input.context.general,
    runtime: input.context.runtime,
    skill: { id: skillID },
    result: { nlu: input.nlu, asr: input.asr, memo: input.memo },
  });
  return m;
}

function buildProactiveLaunch(skillID, input) {
  if (!input.context || !input.context.general) throw new Error('Malformed context--missing general');
  if (!input.context || !input.context.runtime) throw new Error('Malformed context--missing runtime');
  return message(SkillRequestType.PROACTIVE_LAUNCH, {
    general: input.context.general,
    runtime: input.context.runtime,
    skill: { id: skillID },
    result: { nlu: input.nlu, memo: input.memo },
  });
}

function buildListenUpdate(skillID, input) {
  injectDialogContext(input);
  if (!input.context.skill || !input.context.skill.session) throw new Error('Skill update error: no session data');
  if (input.context.skill.id !== skillID) {
    throw new Error(`Skill update error: skill ID in context is ${input.context.skill.id} but request is sent to ${skillID}`);
  }
  return message(SkillRequestType.LISTEN_UPDATE, {
    general: input.context.general,
    runtime: input.context.runtime,
    skill: { id: skillID, session: input.context.skill.session },
    result: { nlu: input.nlu, asr: input.asr },
  });
}
