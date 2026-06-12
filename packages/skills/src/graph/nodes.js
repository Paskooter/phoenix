// Node library — ports of baseskill/graph/nodes/{NoOpNode,DefaultNode,TrueFalseNode,JCPNode,
// SetLooperIDNode}.ts. These are the building blocks skills and the MIM factories assemble
// graphs from.

import { newMsgId } from '@phoenix/contracts';
import { Node } from './node.js';

/** Generate a JCP Action wrapping a single behavior (graph/Utils.generateJCPAction). */
export function generateJCPAction(behavior) {
  return { type: 'JCP', config: { version: '2.0', jcp: behavior } };
}

/** SEQUENCE / PARALLEL protocol builders (jibo-command-requester structural.*). */
export const sequenceProtocol = (children) => ({ id: newMsgId(), type: 'SEQUENCE', children });
export const parallelProtocol = (children) => ({ id: newMsgId(), type: 'PARALLEL', children });

/** A node that takes no action in the world — only routes via exit(). */
export class NoOpNode extends Node {
  async enter() { return null; }
}

export const DefaultTransition = Object.freeze({ Done: 'Done' });

/** NoOpNode with only a 'Done' transition. */
export class DefaultNode extends NoOpNode {
  constructor(name) { super(name, [DefaultTransition.Done]); }
  async exit() { return { transition: DefaultTransition.Done }; }
}

export const TrueFalseTransition = Object.freeze({ True: 'True', False: 'False' });

/** Routes True/False on an async predicate over the skill data. */
export class TrueFalseNode extends NoOpNode {
  constructor(name, logic) {
    super(name, [TrueFalseTransition.True, TrueFalseTransition.False]);
    this.logic = logic;
  }
  async exit(data) {
    return { transition: (await this.logic(data)) ? TrueFalseTransition.True : TrueFalseTransition.False, result: data.result };
  }
}

/** Marker base for nodes whose enter() yields a JCP action. */
export class JCPNode extends Node {}

export const SetLooperIDTransition = Object.freeze({ Cancel: 'Cancel', Success: 'Success', NotInLoop: 'NotInLoop' });

/**
 * Reads the wrongID-flow NLU result: 'cancel' → Cancel; 'loopmember' with a loopMemberReferent
 * → override the perceived speaker (+ a supplemental SetPresentPerson behavior) → Success;
 * anything else clears the override → NotInLoop. (SetLooperIDNode.ts)
 */
export class SetLooperIDNode extends NoOpNode {
  constructor(name, skill) {
    super(name, [SetLooperIDTransition.Cancel, SetLooperIDTransition.Success, SetLooperIDTransition.NotInLoop]);
    this.skill = skill;
  }

  async exit(data) {
    if (!data.result) data.result = {};
    if (!data.result.nlu) data.result.nlu = { entities: { loopMemberReferent: null } };

    const intent = data.result.nlu.intent;
    const looper = data.result.nlu.entities.loopMemberReferent;

    switch (intent) {
      case 'cancel':
        return { transition: SetLooperIDTransition.Cancel };
      case 'loopmember':
        if (looper) {
          this.skill.overrideSpeaker(data, looper);
          // requester.perception.SetPresentPerson.generateProtocol(id, 'USER_OVERRIDE', 100)
          this.skill.addSequenceBehavior(data, {
            id: newMsgId(),
            type: 'SET_PRESENT_PERSON',
            looperId: looper,
            source: 'USER_OVERRIDE',
            confidence: 100,
          });
          return { transition: SetLooperIDTransition.Success };
        }
        // fallthrough on incomplete looper info, like the reference
      case 'notInLoop':
      default:
        this.skill.overrideSpeaker(data, null);
        return { transition: SetLooperIDTransition.NotInLoop };
    }
  }
}
