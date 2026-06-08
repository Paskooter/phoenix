// GraphSkill — port of baseskill/GraphSkill.handle. Turns an FSM graph into a skill handler:
// LISTEN_LAUNCH/PROACTIVE_LAUNCH -> GraphManager.start; LISTEN_UPDATE -> GraphManager.exitNode;
// a node's EnterResponse {action, final} becomes a SKILL_ACTION (final:false keeps the skill open
// for the next turn — multi-turn); no action/redirect -> terminal SKILL_ACTION (final, fireAndForget).

import { newMsgId, now, SkillRequestType, SkillResponseType } from '@phoenix/contracts';
import { GraphManager } from './graphManager.js';

/**
 * @param {{ name:string, build:(gm:GraphManager)=>object }} def
 *   build(gm) registers nodes (gm.addNode) + transitions and returns the initial node.
 * @returns {(request:object)=>Promise<object>} a skill handler for createSkillsService
 */
export function createGraphSkill({ name, build }) {
  const gm = new GraphManager();
  const initial = build(gm);

  return async function handle(request) {
    const body = request;
    const data = Object.assign({}, body.data, { analytics: {}, local: {} });
    data.skill = data.skill || { id: name };
    if (!data.skill.id) data.skill.id = name;
    if (data.skill.id !== name) throw new Error(`Incoming skill name doesn't match. This: '${name}', incoming: '${data.skill.id}'`);

    let nodeResponse;
    if (body.type === SkillRequestType.LISTEN_LAUNCH || body.type === SkillRequestType.PROACTIVE_LAUNCH) {
      if (data.skill.session) delete data.skill.session; // a launch must start a fresh session
      nodeResponse = await gm.start(initial, data);
    } else if (body.type === SkillRequestType.LISTEN_UPDATE) {
      if (!data.skill.session) throw new Error('LISTEN_UPDATE without a session');
      nodeResponse = await gm.exitNode(data);
    } else {
      throw new Error(`Unknown request type '${body.type}'`);
    }

    if (nodeResponse && nodeResponse.redirect) {
      return { type: SkillResponseType.SKILL_REDIRECT, msgID: newMsgId(), ts: now(), data: Object.assign({}, nodeResponse.redirect, { skill: data.skill }) };
    }
    if (nodeResponse && nodeResponse.action) {
      return {
        type: SkillResponseType.SKILL_ACTION, msgID: newMsgId(), ts: now(),
        data: { skill: data.skill, action: nodeResponse.action, analytics: data.analytics, final: nodeResponse.final || false, fireAndForget: false },
      };
    }
    // No action/redirect -> last node reached, transaction finished.
    return {
      type: SkillResponseType.SKILL_ACTION, msgID: newMsgId(), ts: now(),
      data: { skill: data.skill, action: null, analytics: data.analytics, final: true, fireAndForget: true },
    };
  };
}
