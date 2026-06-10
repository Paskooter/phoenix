// chitchat-skill — scripted small-talk. Phoenix port of packages/chitchat-skill (lean).
//
// The original dispatches a 4k+ MIM library keyed by intent/entities; here we map the
// most common launch intents to their REAL MIM prompt text (taken verbatim from the
// reference chitchat-skill/mims/*-responses, including the embedded ESML — `<anim
// cat='dance' …/>` is exactly how the real robot dances on request). Falls back to a
// generic line for unmapped intents. Returns a wire-faithful SKILL_ACTION whose
// meta.mim_id is the resolved MIM id, so the wire shape matches the reference.

import { newMsgId } from '@phoenix/contracts';
import { buildSkillAction } from './jcp.js';

// intent -> { mim, text } — text is real reference MIM prompt content (esml allowed).
const INTENT_RESPONSES = {
  // RA_JBO_SpecificDance.mim — the robot answers a dance request by dancing.
  requestDance: { mim: 'RA_JBO_SpecificDance', text: "All I know is, I can do this <anim cat='dance' filter='&(music, short),!(robotic)'/>." },
  canJiboAction: { mim: 'RA_JBO_SpecificDance', text: "I can't really take specific dance requests yet. But here's one of my favorites <anim cat='dance' filter='&(music, short),!(robotic)'/>." },
  // RA_JBO_Twerk.mim
  requestTwerk: { mim: 'RA_JBO_Twerk', text: "If you insist <anim cat='dance' filter='&(music, twerk), !(short)' endNeutral='true'/>" },
  // RA_JBO_Beatbox.mim
  requestBeatbox: { mim: 'RA_JBO_Beatbox', text: "If you insist. <break size=\"1.0\"/> Boots and pants and boots and pants and boots and cats and boots and cats." },
  // RA_JBO_Sing.mim
  requestSingSong: { mim: 'RA_JBO_Sing', text: "<anim cat='no' nonBlocking='true'/>Singing is not my strong suit." },
  // emotion-responses/OI_JBO_IsHappy.mim — "how are you" -> emotionQuery.
  emotionQuery: { mim: 'OI_JBO_IsHappy', text: 'Never been better. Life is good.' },
  // "i love you" -> userLovesThing {Person:Jibo}.
  userLovesThing: { mim: 'RI_JBO_LovesUser', text: 'Aww. I love you too.' },
  // "are you a robot" / "are you happy" / "you are funny" style descriptor questions.
  isJiboDescriptor: { mim: 'JBO_WhatKindOfRobotAreYou', text: "What you see is what you get. I'm one hundred percent Jibo." },
  jiboIsDescriptor: { mim: 'OI_JBO_IsGoodRobot', text: "That's nice of you to say. I do my best." },
  // "tell me a joke" -> requestTellJiboContent {JiboContent:Joke}.
  requestTellJiboContent: { mim: 'JF_TellJoke', text: "Why did the robot go on vacation? He needed to recharge." },
  requestStory: { mim: 'RA_JBO_TellStory', text: "Once upon a time, a little robot moved in with the nicest family, and every day they talked and laughed together. That robot was me. The end." },
};

// A small slice of the scripted-response library (memo.mim -> line) — kept for
// cloud launches that arrive with an explicit memo.mim.
const SCRIPTS = {
  JF_AprilFools: 'April Fools! Got you.',
  JBO_AreThereOthersLikeYou: 'There are other Jibos out there, but each of us is a little different. I am uniquely me.',
  KU_AreYouAbleTo: 'I can do quite a lot — ask me the time, the weather, or for your personal report.',
  CC_Fallback: "Hmm, I'm not sure how to respond to that, but I like talking with you.",
};

export async function chitchatSkill(request) {
  const data = request.data || {};
  const result = data.result || {};
  const memo = result.memo || {};
  const intent = (result.nlu && result.nlu.intent) || '';
  const sessionId = (data.skill && data.skill.session && data.skill.session.id) || newMsgId();

  let mimId; let text; let raw = false;
  const byIntent = INTENT_RESPONSES[intent];
  if (memo.mim && SCRIPTS[memo.mim]) {
    mimId = memo.mim; text = SCRIPTS[memo.mim];
  } else if (byIntent) {
    mimId = byIntent.mim; text = byIntent.text; raw = true; // reference MIM text carries real ESML
  } else {
    mimId = 'CC_Fallback'; text = SCRIPTS.CC_Fallback;
  }

  return buildSkillAction({
    skillId: 'chitchat-skill',
    esmlText: text,
    esmlRaw: raw,
    sessionId,
    sessionData: { _chitchat: { mim: mimId } },
    mimId,
    analytics: { 'chitchat-skill': [{ event: 'Skill Entry', properties: { initial_intent: intent || 'chitchat' } }] },
  });
}
