// Skill client — SkillConfigManager (config/SkillConfigManager.ts) + SkillRequestMaker
// (skill/SkillRequestMaker.ts) + SkillRequestHelper (skill/SkillRequestHelper.ts).
//
// Builds LISTEN_LAUNCH / LISTEN_UPDATE requests and POSTs them to the skill's /v1/main URL,
// returning { skillID, response } or { skillID, error }. Injects nlu.entities.loopMemberReferent
// into runtime.dialog.referent (SkillRequestHelper.injectDialogContext).

import { message, SkillRequestType, ResponseType } from '@phoenix/contracts';
import { writeTrace } from '@phoenix/common';

export const SkillRequestError = Object.freeze({
  SKILL_NOT_FOUND: 'SKILL_NOT_FOUND',
  TIMEOUT: 'TIMEOUT',
});

export class SkillConfigManager {
  constructor(skillConfigs) {
    this.configs = new Map();
    for (const c of skillConfigs) this.configs.set(c.id.toLowerCase(), c);
  }
  get(id) { return this.configs.get(String(id).toLowerCase()); }
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
        return { skillID, error: { code: SkillRequestError.SKILL_NOT_FOUND, message: `Error from URL '${cfg.URL}': ${res.status} :: ${text}` } };
      }
      return { skillID, response: await res.json() };
    } catch (error) {
      return { skillID, error: { code: SkillRequestError.SKILL_NOT_FOUND, message: `Error from URL '${cfg.URL}': ${error.message}` } };
    }
  }
}

/** A skill response is a redirect iff type === SKILL_REDIRECT (SkillUtils.isRedirect). */
export function isRedirect(response) {
  return !!response && response.type === ResponseType.SKILL_REDIRECT;
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
