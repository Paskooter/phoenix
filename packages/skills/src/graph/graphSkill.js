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

// GraphSkill's first source access is `body.data.general`. Node 8 reports a
// null/undefined intermediate as "Cannot read property ... of ...", while
// current Node reports "Cannot read properties ...". Localize only this
// precondition access; errors thrown by graph nodes and handlers stay native.
function sourceRequestData(body) {
  const data = body.data;
  if (data === null) throw new TypeError("Cannot read property 'general' of null");
  if (data === undefined) throw new TypeError("Cannot read property 'general' of undefined");
  return data;
}

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

  return async function handle(request, context = {}) {
    const body = request;
    const log = context.log || makeLog();
    log.debug('GraphSkill handling request: ', body);
    // Keep the source GraphSkill ordering: its concrete handler receives the
    // parsed request first, then validates the shared general context before
    // applying the skill fallback/name mutation. This intentionally leaves
    // null/undefined field failures to the actual property access rather than
    // introducing a second request schema policy at the graph layer.
    const requestData = sourceRequestData(body);
    if (!requestData.general || !requestData.general.accountID) {
      throw new Error('Skill request without general.accountID arrived');
    }
    if (!requestData.general.robotID) {
      throw new Error('Skill request without general.robotID arrived');
    }
    if (!requestData.skill) requestData.skill = { id: name };
    if (!requestData.skill.id) requestData.skill.id = name;
    if (requestData.skill.id !== name) throw new Error(`Incoming skill name doesn't match. This: '${name}', incoming: '${requestData.skill.id}'`);
    if (!requestData.result) log.warn("Didn't have action results when we expected them");

    const data = Object.assign({}, requestData, {
      analytics: {},
      behaviors: { parallel: [], sequence: [] },
      local: {},
      log,
    });

    let nodeResponse;
    if (body.type === SkillRequestType.LISTEN_LAUNCH || body.type === SkillRequestType.PROACTIVE_LAUNCH) {
      // GraphSkill records the framework-level entry event before entering the
      // graph.  Skill-specific nodes append their own events afterwards.
      facade.track(data, 'Skill Entry', {
        initial_intent: 'n/a',
        domain: '',
        was_hey_jibo_launch: body.type === SkillRequestType.LISTEN_LAUNCH,
        user_initiated: body.type === SkillRequestType.LISTEN_LAUNCH,
        last_skill: 'n/a',
      });
      nodeResponse = await gm.start(initial, data);
    } else if (body.type === SkillRequestType.LISTEN_UPDATE) {
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
