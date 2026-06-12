// GraphSkill — port of baseskill/GraphSkill.handle. Turns an FSM graph into a skill handler:
// LISTEN_LAUNCH/PROACTIVE_LAUNCH -> GraphManager.start; LISTEN_UPDATE -> GraphManager.exitNode;
// a node's EnterResponse {action, final} becomes a SKILL_ACTION (final:false keeps the skill open
// for the next turn — multi-turn); no action/redirect -> terminal SKILL_ACTION (final, fireAndForget).
// Supplemental behaviors queued during the turn (addSequenceBehavior/addParallelBehavior) are
// wrapped around JCP actions exactly like injectSupplementalBehaviors in the reference.

import { newMsgId, now, SkillRequestType, SkillResponseType } from '@phoenix/contracts';
import { GraphManager } from './graphManager.js';
import { sequenceProtocol, parallelProtocol } from './nodes.js';

const noop = () => {};
const makeLog = () => {
  const log = { info: noop, warn: noop, error: noop, debug: noop };
  log.createChild = () => log;
  return log;
};

function isJCP(action) { return action && action.type === 'JCP'; }

function injectSupplementalBehaviors(data, action) {
  let behavior = action.config.jcp;
  if (data.behaviors.sequence.length) behavior = sequenceProtocol([...data.behaviors.sequence, behavior]);
  if (data.behaviors.parallel.length) behavior = parallelProtocol([...data.behaviors.parallel, behavior]);
  action.config.jcp = behavior;
  return action;
}

/**
 * The GraphSkill facade nodes/factories call back into (BaseSkill/GraphSkill convenience methods).
 */
export class SkillFacade {
  constructor(name) { this.name = name; }

  /** Track a skill analytics event onto the response's analytics payload. */
  track(data, event, properties = {}) {
    if (!data.analytics) data.analytics = {};
    if (!data.analytics[this.name]) data.analytics[this.name] = [];
    data.analytics[this.name].push({ event, properties });
  }

  /** Override the perceived speaker for the rest of the transaction. */
  overrideSpeaker(data, id) {
    if (data.runtime && data.runtime.perception) data.runtime.perception.speaker = id;
  }

  addSequenceBehavior(data, behavior) { this._addBehavior(data, behavior, 'sequence'); }
  addParallelBehavior(data, behavior) { this._addBehavior(data, behavior, 'parallel'); }

  _addBehavior(data, behavior, kind) {
    if (!data.behaviors) data.behaviors = { parallel: [], sequence: [] };
    if (!data.behaviors.parallel) data.behaviors.parallel = [];
    if (!data.behaviors.sequence) data.behaviors.sequence = [];
    data.behaviors[kind].push(behavior);
  }
}

/**
 * @param {{ name:string, build:(gm:GraphManager, skill:SkillFacade)=>object }} def
 *   build(gm, skill) registers nodes/sub-graphs and returns the initial node OR a finalized Graph.
 * @returns {(request:object)=>Promise<object>} a skill handler for createSkillsService
 */
export function createGraphSkill({ name, build }) {
  const gm = new GraphManager();
  const facade = new SkillFacade(name);
  const initial = build(gm, facade);

  return async function handle(request) {
    const body = request;
    const data = Object.assign({}, body.data, {
      analytics: {},
      behaviors: { parallel: [], sequence: [] },
      local: {},
      log: makeLog(),
    });
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
        data: {
          skill: data.skill,
          action: isJCP(nodeResponse.action) ? injectSupplementalBehaviors(data, nodeResponse.action) : nodeResponse.action,
          analytics: data.analytics,
          final: nodeResponse.final || false,
          fireAndForget: false,
        },
      };
    }
    // No action/redirect -> last node reached, transaction finished.
    return {
      type: SkillResponseType.SKILL_ACTION, msgID: newMsgId(), ts: now(),
      data: { skill: data.skill, action: null, analytics: data.analytics, final: true, fireAndForget: true },
    };
  };
}
