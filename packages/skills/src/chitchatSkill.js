// chitchat-skill — Phoenix port of packages/chitchat-skill, now running the REAL
// content library (4.4k vendored MIM files under resources/mims/chitchat).
//
// Dispatch mirrors the reference ProcessQueryNode:
//   1. The gateway matched a manifest intent entry and passed its memo
//      ({mim, type}) in result.memo — the memo names the MIM to play.
//   2. SemiSpecificResponse memos are stems (`X_SS`) resolved against the NLU
//      entity values via the semi-specific category CSVs.
//   3. The MIM id is validated against the scripted/emotion sets per memo.type;
//      anything unresolvable falls back to core-responses/CC_Fallback.
//   4. The MIM is rendered by the Slimmer (condition filter -> weighted pick ->
//      template -> ESML) against PromptData (speaker/loop/dt/... + Dice/Coin).

import { newMsgId, now, SkillResponseType } from '@phoenix/contracts';
import { join } from 'node:path';
import { generateSlimFromMim, PromptCategory, PromptSubCategory } from './graph/mims/slimmer.js';
import { buildPromptData, loadMimFile } from './graph/mims/promptData.js';
import { buildJcpFromSlim } from './jcp.js';
import { getLibrary, MIM_DIRS } from './chitchat/library.js';
import { Dice, Coin } from './chitchat/funAndGames.js';

// Reference Types.ts IntentType values (memo.type).
const IntentType = Object.freeze({
  ScriptedResponse: 'ScriptedResponse',
  SemiSpecificResponse: 'SemiSpecificResponse',
  EmotionQuery: 'EmotionQuery',
  SpecificEmotionQuery: 'SpecificEmotionQuery',
  EmotionCommand: 'EmotionCommand',
});

export async function chitchatSkill(request, { rng = Math.random } = {}) {
  const data = request.data || {};
  const result = data.result || {};
  const memo = result.memo || {};
  const entities = (result.nlu && result.nlu.entities) || {};
  const intent = (result.nlu && result.nlu.intent) || '';
  const sessionId = (data.skill && data.skill.session && data.skill.session.id) || newMsgId();
  const lib = getLibrary();

  // --- ProcessQueryNode.exit ---
  let mimID = memo.mim;
  const type = memo.type;
  if (type === IntentType.SemiSpecificResponse && mimID) {
    mimID = resolveSemiSpecificMim(mimID, entities, lib, rng) || mimID;
  }

  const inScripted = !!mimID && lib.scripted.has(mimID);
  const inEmotion = !inScripted && !!mimID && lib.emotion.has(mimID);
  let baseDir = inScripted ? MIM_DIRS.SCRIPTED : MIM_DIRS.EMOTION;

  const validIntent =
    ((type === IntentType.SpecificEmotionQuery || type === IntentType.EmotionQuery || type === IntentType.EmotionCommand) && inEmotion) ||
    (type === IntentType.ScriptedResponse && (inScripted || inEmotion)) ||  // "Be Happy" commands are labelled Scripted but live in emotion
    (type === IntentType.SemiSpecificResponse && inScripted);

  if (!validIntent) {
    baseDir = MIM_DIRS.FALLBACK;
    mimID = 'CC_Fallback';
  }

  // --- Slim the MIM (reference: the MIM node renders data.local.path) ---
  // Skill-provided prompt data lives under `skill.` (PromptData.ts constructor arg):
  // flip-a-coin/roll-the-dice templates read `${skill.coin.a}` / `${skill.dice.a}`.
  const dice = new Dice(6, rng); const coin = new Coin(rng);
  const promptData = buildPromptData(data.runtime || {}, { skill: { dice, coin }, dice, coin, entities, intent });
  let slim = null;
  try {
    const raw = loadMimFile(join(baseDir, `${mimID}.mim`));
    const mim = raw.mim_id ? raw : { ...raw, mim_id: mimID };  // vendored .mim files carry no mim_id field
    slim = generateSlimFromMim(mim, { category: PromptCategory.ENTRY, subCategory: PromptSubCategory.AN }, promptData, { rng });
  } catch { /* unreadable mim -> fall through to fallback below */ }
  if (!slim && mimID !== 'CC_Fallback') {
    const raw = loadMimFile(join(MIM_DIRS.FALLBACK, 'CC_Fallback.mim'));
    mimID = 'CC_Fallback';
    slim = generateSlimFromMim({ ...raw, mim_id: mimID }, { category: PromptCategory.ENTRY, subCategory: PromptSubCategory.AN }, promptData, { rng });
  }

  return {
    type: SkillResponseType.SKILL_ACTION,
    msgID: newMsgId(),
    ts: now(),
    data: {
      skill: { id: 'chitchat-skill', session: { id: sessionId, nodeID: 1, data: { _chitchat: { mim: mimID } }, trace: [] } },
      action: buildJcpFromSlim(slim),
      analytics: { 'chitchat-skill': [{ event: 'Skill Entry', properties: { initial_intent: intent || 'chitchat', mim_id: mimID } }] },
      final: true,
      fireAndForget: false,
    },
  };
}

/**
 * Reference ProcessQueryNode.resolveSemiSpecificMim: pick the semi-specific
 * category that contains one of the NLU entity values, sample among matches,
 * and return `${stem}_${category}`. Returns undefined when unresolvable.
 */
export function resolveSemiSpecificMim(stem, entities, lib = getLibrary(), rng = Math.random) {
  const entityValues = Object.keys(entities).map((k) => entities[k]);
  const categories = lib.semiSpecificStems[stem];
  const possible = [];
  if (categories) {
    for (const value of entityValues) {
      possible.push(...categories.filter((c) => (lib.semiSpecificCategories[c] || []).indexOf(value) !== -1));
    }
  }
  if (!possible.length) return undefined;
  const pick = possible[Math.floor(rng() * possible.length)];
  return [stem, pick].join('_');
}
