// chitchat-skill — Phoenix port of packages/chitchat-skill in its REAL graph form
// (Chitchat.ts): IntentSplit → ProcessQueryNode → Do-MIM (ANFactory, final) → Complete,
// over the full vendored content library (4.4k MIM files under resources/mims/chitchat).
//
// ProcessQueryNode mirrors the reference:
//   1. The gateway matched a manifest intent entry and passed its memo ({mim, type})
//      in result.memo — the memo names the MIM to play.
//   2. SemiSpecificResponse memos are stems (`X_SS`) resolved against the NLU entity
//      values via the semi-specific category CSVs.
//   3. The MIM id is validated against the scripted/emotion sets per memo.type;
//      anything unresolvable falls back to core-responses/CC_Fallback.
//   4. data.local.path + data.local.promptData feed the ANFactory's Slimmer render.

import { join } from 'node:path';
import { createGraphSkill } from './graph/graphSkill.js';
import { Graph } from './graph/graph.js';
import { NoOpNode, DefaultNode, DefaultTransition } from './graph/nodes.js';
import { ANFactory, ANFactoryTransition } from './graph/mims/factories.js';
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

const IntentSplitTransition = Object.freeze({ Reactive: 'Reactive' });

/** Chitchat requires a memo — it is only ever launched from manifest matches. */
class IntentSplitNode extends NoOpNode {
  constructor(name) { super(name, Object.values(IntentSplitTransition)); }

  async exit(data) {
    if (!data.result || !data.result.memo) throw new Error('Chitchat launched without required memo!');
    return { transition: IntentSplitTransition.Reactive, result: data.result };
  }
}

const ProcessQueryTransition = Object.freeze({
  ScriptedResponse: 'ScriptedResponse',
  EmotionQuery: 'EmotionQuery',
  SpecificEmotionQuery: 'SpecificEmotionQuery',
  EmotionCommand: 'EmotionCommand',
  SemiSpecificResponse: 'SemiSpecificResponse',
  ErrorResponse: 'ErrorResponse',
});

class ProcessQueryNode extends NoOpNode {
  constructor(name, facade, rng) {
    super(name, Object.values(ProcessQueryTransition));
    this.facade = facade;
    this.rng = rng;
  }

  async exit(data) {
    const result = data.result || {};
    const memo = result.memo || {};
    const entities = (result.nlu && result.nlu.entities) || {};
    const intent = (result.nlu && result.nlu.intent) || '';
    const lib = getLibrary();
    const rng = this.rng;

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
      (type === IntentType.ScriptedResponse && (inScripted || inEmotion)) || // "Be Happy" commands are labelled Scripted but live in emotion
      (type === IntentType.SemiSpecificResponse && inScripted);

    let transition = ProcessQueryTransition[type] || ProcessQueryTransition.ScriptedResponse;
    if (!validIntent) {
      baseDir = MIM_DIRS.FALLBACK;
      mimID = 'CC_Fallback';
      transition = ProcessQueryTransition.ErrorResponse;
    }

    // The Do-MIM ANFactory renders data.local.path against data.local.promptData.
    // (loadMims fills mim_id from the filename; the Slimmer nests this under `skill.` too.)
    const dice = new Dice(6, rng); const coin = new Coin(rng);
    data.local.path = join(baseDir, `${mimID}.mim`);
    data.local.promptData = { dice, coin, entities, intent };

    this.facade.track(data, 'Skill Entry', { initial_intent: intent || 'chitchat', mim_id: mimID });

    return { transition, result: data.result };
  }
}

const SkillTransition = Object.freeze({ Done: 'Done' });

/** Build a chitchat handler; rng is injectable for deterministic tests. */
export function createChitchatSkill({ rng = Math.random } = {}) {
  return createGraphSkill({
    name: 'chitchat-skill',
    build: (gm, facade) => {
      const g = new Graph(gm, 'Chitchat Skill', Object.values(SkillTransition));

      const intentSplitNode = new IntentSplitNode('Intent Split');
      const processQueryNode = new ProcessQueryNode('Process Query', facade, rng);
      const completeNode = new DefaultNode('Complete');

      const doMIM = new ANFactory('Do MIM', {
        mimDataProvider: (data) => data.local.path,
        promptDataProvider: (data) => data.local.promptData,
        final: true,
        rng,
      }).createGraph(gm);

      g.addNode(intentSplitNode, [[IntentSplitTransition.Reactive, processQueryNode]]);
      g.addNode(processQueryNode, [
        [ProcessQueryTransition.ScriptedResponse, doMIM.initial],
        [ProcessQueryTransition.EmotionQuery, doMIM.initial],
        [ProcessQueryTransition.SpecificEmotionQuery, doMIM.initial],
        [ProcessQueryTransition.EmotionCommand, doMIM.initial],
        [ProcessQueryTransition.SemiSpecificResponse, doMIM.initial],
        [ProcessQueryTransition.ErrorResponse, doMIM.initial],
      ]);
      g.addSubGraph(doMIM, [[ANFactoryTransition.Success, completeNode]]);
      g.addNode(completeNode, [[DefaultTransition.Done, SkillTransition.Done]]);

      g.finalize();
      return g;
    },
  });
}

export const chitchatSkill = createChitchatSkill();

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
