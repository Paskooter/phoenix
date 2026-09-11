// Node library — ports of baseskill/graph/nodes/{NoOpNode,DefaultNode,TrueFalseNode,JCPNode,
// SetLooperIDNode}.ts. These are the building blocks skills and the MIM factories assemble
// graphs from.

import { newJcpId } from '../jcpId.js';
import { Node } from './node.js';
import { sequenceProtocol, parallelProtocol } from './mims/protocol.js';

/** Generate a JCP Action wrapping a single behavior (graph/Utils.generateJCPAction). */
export function generateJCPAction(behavior) {
  return { type: 'JCP', config: { version: '2.0', jcp: behavior } };
}

// SEQUENCE / PARALLEL protocol builders (jibo-command-requester structural.*) live in
// graph/mims/protocol.js next to the REST of the requester port; re-exported for existing callers.
export { sequenceProtocol, parallelProtocol };

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

// SetLooperIDNode's first source access after the nlu default is
// `data.result.nlu.entities.loopMemberReferent`. Node 8 reported a
// null/undefined intermediate as "Cannot read property ... of ...", while
// current Node reports "Cannot read properties ...". The original emitted the
// Node 8 wording on the cloud wire (the error envelope carries the message), so
// localize only this precondition access; errors thrown by skill logic stay
// native.
function sourceLoopMemberReferent(nlu) {
  const entities = nlu.entities;
  if (entities === null) throw new TypeError("Cannot read property 'loopMemberReferent' of null");
  if (entities === undefined) throw new TypeError("Cannot read property 'loopMemberReferent' of undefined");
  return entities.loopMemberReferent;
}

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
    const looper = sourceLoopMemberReferent(data.result.nlu);

    switch (intent) {
      case 'cancel':
        return { transition: SetLooperIDTransition.Cancel };
      case 'loopmember':
        if (looper) {
          this.skill.overrideSpeaker(data, looper);
          // requester.perception.SetPresentPerson.generateProtocol(id, 'USER_OVERRIDE', 100)
          this.skill.addSequenceBehavior(data, {
            id: newJcpId(),
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
