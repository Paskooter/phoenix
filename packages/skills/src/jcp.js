// JCP/SLIM behavior construction — faithful to answer-skill/server.js:196-248 (the wire shape
// the robot executes). A SKILL_ACTION carries action.config.jcp = a SEQUENCE of SLIM nodes; a
// SLIM's play.esml is the embodied-speech string. This is robot-facing, so the shape is fixed.

import { newMsgId, now, SkillResponseType } from '@phoenix/contracts';

/** Escape user/answer text so it can't inject ESML markup (answer-skill/server.js:188-200). */
export function escapeForEsml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/[<>{}]/g, '');
}

/**
 * Build a JCP action (the `action` field of a SKILL_ACTION): SEQUENCE > SLIM > PLAY, plus an
 * optional `listen` (generated for question/optional-response MIMs from a rule_name).
 * @param {{ esmlText:string, mimId?:string, mimType?:string, promptSubCategory?:string,
 *           listenRule?:string }} opts
 */
export function buildJcpAction({ esmlText, mimId = 'Reply', mimType = 'announcement', promptSubCategory = 'AN', listenRule } = {}) {
  const slimConfig = {
    play: {
      id: newMsgId(),
      type: 'PLAY',
      autoRuleConfig: true,
      esml: escapeForEsml(esmlText),
      meta: { mim_id: mimId, mim_type: mimType, prompt_sub_category: promptSubCategory },
    },
  };
  if (listenRule) slimConfig.listen = { id: newMsgId(), type: 'LISTEN', rule: listenRule };
  return {
    type: 'JCP',
    config: {
      version: '2.0',
      jcp: { id: newMsgId(), type: 'SEQUENCE', children: [{ id: newMsgId(), type: 'SLIM', config: slimConfig }] },
    },
  };
}

/**
 * Build a full SKILL_ACTION response (single-turn skills). For graph skills, nodes return a JCP
 * action via buildJcpAction and the GraphSkill wrapper attaches skill/session/final.
 * @param {{ skillId:string, esmlText:string, sessionId:string, sessionData?:object,
 *           mimId?:string, mimType?:string, promptSubCategory?:string, analytics?:object,
 *           final?:boolean, listenRule?:string }} opts
 */
export function buildSkillAction(opts) {
  const { skillId, esmlText, sessionId, sessionData = {}, mimId, mimType, promptSubCategory, analytics, final = true, listenRule } = opts;
  return {
    type: SkillResponseType.SKILL_ACTION,
    msgID: newMsgId(),
    ts: now(),
    data: {
      skill: { id: skillId, session: { id: sessionId, nodeID: 1, data: sessionData, trace: [] } },
      action: buildJcpAction({ esmlText, mimId, mimType, promptSubCategory, listenRule }),
      ...(analytics ? { analytics } : {}),
      final,
      fireAndForget: false,
    },
  };
}
