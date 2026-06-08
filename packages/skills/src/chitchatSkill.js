// chitchat-skill — scripted small-talk. Phoenix port of packages/chitchat-skill (lean).
// The original dispatches a 4k+ MIM library keyed by the matched intent's memo.mim; here we map
// a handful of representative scripted responses and fall back to a generic line. Returns a
// wire-faithful SKILL_ACTION whose meta.mim_id is the resolved MIM (so the wire shape matches).

import { newMsgId } from '@phoenix/contracts';
import { buildSkillAction } from './jcp.js';

// A small slice of the scripted-response library (memo.mim -> line).
const SCRIPTS = {
  JF_AprilFools: 'April Fools! Got you.',
  JBO_AreThereOthersLikeYou: 'There are other Jibos out there, but each of us is a little different. I am uniquely me.',
  KU_AreYouAbleTo: "I can do quite a lot — ask me the time, the weather, or for your personal report.",
  CC_Fallback: "Hmm, I'm not sure how to respond to that, but I like talking with you.",
};

export async function chitchatSkill(request) {
  const data = request.data || {};
  const result = data.result || {};
  const memo = result.memo || {};
  const intent = (result.nlu && result.nlu.intent) || '';
  const mimId = memo.mim || intent || 'CC_Fallback';
  const sessionId = (data.skill && data.skill.session && data.skill.session.id) || newMsgId();

  const text = SCRIPTS[mimId] || SCRIPTS[intent] || SCRIPTS.CC_Fallback;

  return buildSkillAction({
    skillId: 'chitchat-skill',
    esmlText: text,
    sessionId,
    sessionData: { _chitchat: { mim: mimId } },
    mimId,
    analytics: { 'chitchat-skill': [{ event: 'Skill Entry', properties: { initial_intent: intent || 'chitchat' } }] },
  });
}
