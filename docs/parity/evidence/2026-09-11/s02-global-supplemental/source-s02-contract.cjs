/*
 * S-02 source contract driver.
 *
 * Executes the PINNED original Pegasus framework (compiled lib/) under the
 * archived Node 8.9.4 runtime and records the observable contract for the
 * S-02 surfaces:
 *   - GraphSkill analytics (track / SKILL_ENTRY / per-turn lifetime)
 *   - speaker overrides (overrideSpeaker + SetLooperIDNode)
 *   - sequence/parallel supplemental behaviors (injectSupplementalBehaviors)
 *   - global cancel/repeat/thanks arriving on skill updates
 *   - framework failure handling
 *
 * Output: JSON keyed by probe name -> {ok: <value>} | {error, ctor}.
 *
 *   node source-s02-contract.cjs <runtimeRoot> <outPath>
 */
'use strict';

const path = require('path');
const fs = require('fs');

const RUNTIME = process.argv[2] || '/runtime';
const OUT = process.argv[3] || '/review/source-s02-contract.json';

const graphLib = require(path.join(RUNTIME, 'packages/baseskill/lib/graph/index.js'));
const NodeBase = require(path.join(RUNTIME, 'packages/baseskill/lib/graph/nodes/Node.js')).Node;
const GraphSkill = require(path.join(RUNTIME, 'packages/baseskill/lib/GraphSkill.js')).GraphSkill;
const SetLooperIDNode = require(path.join(RUNTIME, 'packages/baseskill/lib/graph/nodes/SetLooperIDNode.js')).SetLooperIDNode;
// NOTE: the umbrella `@jibo/utils` index entry aborts the probe process under
// Node 8 (it terminates silently with status 0); load only the logging
// submodule, which is all these probes need for a request-shaped logger.
const utilsLogging = require(path.join(RUNTIME, 'node_modules/@jibo/utils/lib/logging/index.js'));

const { Graph, GraphManager } = graphLib;

const results = {};

function describe(err) {
  const out = { message: err && err.message !== undefined ? err.message : String(err) };
  out.ctor = err && err.constructor ? err.constructor.name : typeof err;
  return out;
}

function safe(value) {
  if (value === undefined) return { __undefined: true };
  if (value === null) return null;
  if (typeof value === 'function') return { __function: value.name || '(anonymous)' };
  if (value instanceof Map) {
    const o = {};
    for (const [k, v] of value.entries()) o[String(k)] = safe(v);
    return { __map: o };
  }
  if (value instanceof Set) return { __set: Array.from(value.values()).map(safe) };
  if (Array.isArray(value)) return value.map(safe);
  if (typeof value === 'object') {
    const o = {};
    for (const k of Object.keys(value)) o[k] = safe(value[k]);
    return o;
  }
  return value;
}

async function probe(name, fn) {
  try {
    results[name] = { ok: safe(await fn()) };
  } catch (err) {
    results[name] = { error: describe(err) };
  }
}

function reset() { GraphManager._resetInstance(); }

/* A concrete node whose enter/exit are supplied by the probe. */
class PNode extends NodeBase {
  constructor(name, transitions, enter, exit) {
    super(name, transitions);
    this._enter = enter;
    this._exit = exit;
  }
  async enter(data) { return this._enter ? this._enter(data) : {}; }
  async exit(data) { return this._exit ? this._exit(data) : {}; }
}

const okNode = (name, tns, enter, exit) => new PNode(name, tns, enter, exit);

function makeLog() {
  return new utilsLogging.Log('s02-probe');
}

/* ------------------------------ skill shapes --------------------------- */

// GraphSkill's constructor calls createGraph() from `super(name)`, before a
// subclass field assignment could run, so the probe selects its shape through
// this module-scope switch instead of an instance property.
let probeMode = 'entry';

const jcp = (id, text) => ({
  type: 'JCP',
  config: { version: '2.0', jcp: { id, type: 'SPEAK', text } },
});

function actionOf(res) {
  return res && res.data && res.data.action ? safe(res.data.action) : null;
}

class ProbeSkill extends GraphSkill {
  constructor(name, mode) {
    probeMode = mode;
    super(name);
  }

  createGraph() {
    const gm = GraphManager.instance;
    const g = new Graph('s02-' + probeMode, ['Done']);
    const self = this;

    if (probeMode === 'entry') {
      // A node that tracks a skill event and emits a JCP action.
      const n = okNode('Entry', ['Done'],
        async (data) => {
          self.track(data, 'Probe Event', { marker: 'entry' });
          return { action: jcp('entry-action', 'entry'), final: false };
        },
        async () => ({ transition: 'Done' }));
      g.addNode(n, [['Done', 'Done']]);
      g.finalize();
      return g;
    }

    if (probeMode === 'tracker') {
      // Two tracked events plus the framework entry event ordering.
      const n = okNode('Tracker', ['Done'],
        async (data) => {
          self.track(data, 'First Event');
          self.track(data, 'Second Event', { i: 2 });
          return { action: jcp('tracker-action', 'tracker'), final: false };
        },
        async () => ({ transition: 'Done' }));
      g.addNode(n, [['Done', 'Done']]);
      g.finalize();
      return g;
    }

    if (probeMode === 'multiTurn') {
      const ask = okNode('Ask', ['Answered'],
        async (data) => {
          self.track(data, 'Probe Event', { marker: 'turn1' });
          return { action: jcp('ask-action', 'ask'), final: false };
        },
        async (data) => ({ transition: 'Answered', result: data.result }));
      const finish = okNode('Finish', ['Done'],
        async () => ({ action: jcp('finish-action', 'finish'), final: true }),
        async () => ({}));
      g.addNode(ask, [['Answered', finish]]);
      g.addNode(finish, [['Done', 'Done']]);
      g.finalize();
      return g;
    }

    if (probeMode === 'echo') {
      // Two nodes so an update continues the transaction; the second node
      // echoes the per-turn NLU intent back inside the action so a global
      // intent's pass-through can be observed on the wire.
      const ask = okNode('Ask', ['Answered'],
        async () => ({ action: jcp('echo-ask', 'launch'), final: false }),
        async (data) => ({ transition: 'Answered', result: data.result }));
      const echo = okNode('Echo', ['Done'],
        async (data) => {
          const intent = data.result && data.result.nlu ? data.result.nlu.intent : null;
          return { action: jcp('echo-action', 'intent:' + intent), final: true };
        },
        async (data) => ({ transition: 'Done', result: data.result }));
      g.addNode(ask, [['Answered', echo]]);
      g.addNode(echo, [['Done', 'Done']]);
      g.finalize();
      return g;
    }

    if (probeMode === 'sequence') {
      const n = okNode('Sequencer', ['Done'],
        async (data) => {
          self.addSequenceBehavior(data, { id: 'seq-1', type: 'SET_PRESENT_PERSON', looperId: 'bob', source: 'USER_OVERRIDE', confidence: 100 });
          self.addSequenceBehavior(data, { id: 'seq-2', type: 'IMPACT_EMOTION', emotion: 'HAPPY' });
          return { action: jcp('seq-main', 'seq-main'), final: false };
        },
        async () => ({ transition: 'Done' }));
      g.addNode(n, [['Done', 'Done']]);
      g.finalize();
      return g;
    }

    if (probeMode === 'parallel') {
      const n = okNode('Paralleler', ['Done'],
        async (data) => {
          self.addParallelBehavior(data, { id: 'par-1', type: 'IMPACT_EMOTION', emotion: 'CALM' });
          return { action: jcp('par-main', 'par-main'), final: false };
        },
        async () => ({ transition: 'Done' }));
      g.addNode(n, [['Done', 'Done']]);
      g.finalize();
      return g;
    }

    if (probeMode === 'both') {
      const n = okNode('Both', ['Done'],
        async (data) => {
          self.addParallelBehavior(data, { id: 'par-1', type: 'IMPACT_EMOTION', emotion: 'CALM' });
          self.addParallelBehavior(data, { id: 'par-2', type: 'IMPACT_EMOTION', emotion: 'HAPPY' });
          self.addSequenceBehavior(data, { id: 'seq-1', type: 'SET_PRESENT_PERSON', looperId: 'bob', source: 'USER_OVERRIDE', confidence: 100 });
          return { action: jcp('both-main', 'both-main'), final: false };
        },
        async () => ({ transition: 'Done' }));
      g.addNode(n, [['Done', 'Done']]);
      g.finalize();
      return g;
    }

    if (probeMode === 'nonJcp') {
      const n = okNode('NonJcp', ['Done'],
        async (data) => {
          self.addSequenceBehavior(data, { id: 'seq-1', type: 'IMPACT_EMOTION', emotion: 'HAPPY' });
          return { action: { type: 'NOT_JCP', payload: { id: 'raw-action' } }, final: false };
        },
        async () => ({ transition: 'Done' }));
      g.addNode(n, [['Done', 'Done']]);
      g.finalize();
      return g;
    }

    if (probeMode === 'noBehaviors') {
      const n = okNode('Plain', ['Done'],
        async () => ({ action: jcp('plain-action', 'plain'), final: false }),
        async () => ({ transition: 'Done' }));
      g.addNode(n, [['Done', 'Done']]);
      g.finalize();
      return g;
    }

    if (probeMode === 'speakerSet') {
      const n = okNode('Speaker', ['Done'],
        async (data) => {
          self.overrideSpeaker(data, 'looper-9');
          return { action: jcp('speaker-action', 'speaker'), final: false };
        },
        async () => ({ transition: 'Done' }));
      g.addNode(n, [['Done', 'Done']]);
      g.finalize();
      return g;
    }

    if (probeMode === 'speakerClear') {
      const n = okNode('SpeakerClear', ['Done'],
        async (data) => {
          self.overrideSpeaker(data, null);
          return { action: jcp('clear-action', 'clear'), final: false };
        },
        async () => ({ transition: 'Done' }));
      g.addNode(n, [['Done', 'Done']]);
      g.finalize();
      return g;
    }

    if (probeMode === 'speakerNoRuntime') {
      const n = okNode('SpeakerNoRuntime', ['Done'],
        async (data) => {
          self.overrideSpeaker(data, 'looper-9');
          return { action: jcp('noruntime-action', 'noruntime'), final: false };
        },
        async () => ({ transition: 'Done' }));
      g.addNode(n, [['Done', 'Done']]);
      g.finalize();
      return g;
    }

    if (probeMode === 'looper') {
      // The source SetLooperIDNode IS the unit under test. Hold holds the
      // launch turn; the following UPDATE is what reaches the looper (exactly
      // like the OptIn graph, where a MIM holds the turn and the looper is
      // entered and exited inside the answering turn). Each transition lands
      // on a node that emits a distinguishable JCP action.
      const hold = okNode('Hold', ['Next'],
        async () => ({ action: jcp('hold-action', 'hold'), final: false }),
        async (data) => ({ transition: 'Next', result: data.result }));
      const looper = new SetLooperIDNode('Looper', self);
      const cancel = okNode('Cancel', ['Done'], async () => ({ action: jcp('cancel-action', 'cancel'), final: false }), async () => ({ transition: 'Done' }));
      const success = okNode('Success', ['Done'], async () => ({ action: jcp('success-action', 'success'), final: false }), async () => ({ transition: 'Done' }));
      const notInLoop = okNode('NotInLoop', ['Done'], async () => ({ action: jcp('notinloop-action', 'notInLoop'), final: false }), async () => ({ transition: 'Done' }));
      g.addNode(hold, [['Next', looper]]);
      g.addNode(looper, [
        ['Cancel', cancel],
        ['Success', success],
        ['NotInLoop', notInLoop],
      ]);
      g.addNode(cancel, [['Done', 'Done']]);
      g.addNode(success, [['Done', 'Done']]);
      g.addNode(notInLoop, [['Done', 'Done']]);
      g.finalize();
      return g;
    }

    // default: a single no-action terminal node
    const term = okNode('Terminal', ['Done'], async () => null, async () => ({ transition: 'Done' }));
    g.addNode(term, [['Done', 'Done']]);
    g.finalize();
    return g;
  }
}

async function invokeDirect(skill, body) {
  return skill.handle({ body, log: makeLog() });
}

function general(overrides) {
  return Object.assign({ accountID: 'acct', robotID: 'robot', lang: 'en-US' }, overrides || {});
}

function launchBody(extra) {
  const opts = extra || {};
  const data = {
    general: general(opts.general),
    runtime: opts.runtime === undefined ? { dialog: {}, perception: {} } : opts.runtime,
    skill: { id: opts.skillId || 'probe-skill' },
    result: opts.result === undefined ? { nlu: { intent: 'fixture', entities: {} } } : opts.result,
  };
  if (opts.session !== undefined) data.skill.session = opts.session;
  return { type: opts.type || 'LISTEN_LAUNCH', msgID: 'm1', ts: 1, data };
}

function updateBody(session, result) {
  const data = {
    general: general(),
    runtime: { dialog: {}, perception: {} },
    skill: { id: 'probe-skill' },
    result: result === undefined ? { asr: { text: 'blue' }, nlu: { intent: null, entities: {} } } : result,
  };
  if (session !== undefined) data.skill.session = session;
  return { type: 'LISTEN_UPDATE', msgID: 'm2', ts: 2, data };
}

const intents = (intent, entities) => ({ nlu: { intent, entities: entities || {} }, asr: { text: String(intent), confidence: 1 } });

/* --------------------------- analytics probes -------------------------- */

async function analyticsProbes() {
  await probe('s02.analytics.launchEntryEvent', async () => {
    reset();
    const skill = new ProbeSkill('probe-skill', 'entry');
    const res = await invokeDirect(skill, launchBody());
    return { type: res.type, analytics: res.data.analytics };
  });

  await probe('s02.analytics.proactiveLaunchEntryEvent', async () => {
    reset();
    const skill = new ProbeSkill('probe-skill', 'entry');
    const res = await invokeDirect(skill, launchBody({ type: 'PROACTIVE_LAUNCH' }));
    return { type: res.type, analytics: res.data.analytics };
  });

  await probe('s02.analytics.trackDefaultsAndOrder', async () => {
    reset();
    const skill = new ProbeSkill('probe-skill', 'tracker');
    const res = await invokeDirect(skill, launchBody());
    return { events: res.data.analytics['probe-skill'] };
  });

  await probe('s02.analytics.notPersistedAcrossTurns', async () => {
    reset();
    const skill = new ProbeSkill('probe-skill', 'multiTurn');
    const first = await invokeDirect(skill, launchBody());
    const session = JSON.parse(JSON.stringify(first.data.skill.session));
    const second = await invokeDirect(skill, updateBody(session, intents('yes')));
    return {
      turn1: first.data.analytics['probe-skill'].map((e) => e.event),
      turn2: (second.data.analytics['probe-skill'] || []).map((e) => e.event),
      turn2HasEntryEvent: (second.data.analytics['probe-skill'] || []).some((e) => e.event === 'Skill Entry'),
      sessionData: second.data.skill.session.data,
    };
  });

  await probe('s02.analytics.terminalResponseCarriesAnalytics', async () => {
    reset();
    const skill = new ProbeSkill('probe-skill', 'entry');
    const first = await invokeDirect(skill, launchBody());
    const session = JSON.parse(JSON.stringify(first.data.skill.session));
    // The terminal default node tracks nothing; the response must still carry
    // the (empty) analytics object rather than omit it.
    const terminal = await invokeDirect(skill, updateBody(session, intents('thanks')));
    return {
      type: terminal.type, final: terminal.data.final, action: terminal.data.action,
      analyticsKeys: Object.keys(terminal.data.analytics),
    };
  });
}

/* ----------------------- supplemental behavior probes ------------------ */

async function supplementalProbes() {
  await probe('s02.supplemental.sequenceOnly', async () => {
    reset();
    const skill = new ProbeSkill('probe-skill', 'sequence');
    const res = await invokeDirect(skill, launchBody());
    return { action: actionOf(res) };
  });

  await probe('s02.supplemental.parallelOnly', async () => {
    reset();
    const skill = new ProbeSkill('probe-skill', 'parallel');
    const res = await invokeDirect(skill, launchBody());
    return { action: actionOf(res) };
  });

  await probe('s02.supplemental.parallelWrapsSequence', async () => {
    reset();
    const skill = new ProbeSkill('probe-skill', 'both');
    const res = await invokeDirect(skill, launchBody());
    return { action: actionOf(res) };
  });

  await probe('s02.supplemental.nonJcpActionNotWrapped', async () => {
    reset();
    const skill = new ProbeSkill('probe-skill', 'nonJcp');
    const res = await invokeDirect(skill, launchBody());
    return { action: actionOf(res) };
  });

  await probe('s02.supplemental.noBehaviorsActionUnchanged', async () => {
    reset();
    const skill = new ProbeSkill('probe-skill', 'noBehaviors');
    const res = await invokeDirect(skill, launchBody());
    return { action: actionOf(res) };
  });

  await probe('s02.supplemental.generatedIdsAreTransactionShaped', async () => {
    reset();
    const skill = new ProbeSkill('probe-skill', 'both');
    const res = await invokeDirect(skill, launchBody());
    const action = res.data.action;
    const ids = [];
    const walk = (b) => {
      if (!b || typeof b !== 'object') return;
      ids.push({ id: b.id, type: b.type, idIs32Hex: typeof b.id === 'string' && /^[0-9a-f]{32}$/.test(b.id) });
      (b.children || []).forEach(walk);
    };
    walk(action.config.jcp);
    return { ids };
  });
}

/* --------------------------- speaker / looper -------------------------- */

/* Drives the looper graph the way the original OptIn graph does: the launch
 * holds the turn, and the answering UPDATE carries the NLU intent that
 * SetLooperIDNode dispatches on. */
async function driveLooper(intent, entities) {
  const skill = new ProbeSkill('probe-skill', 'looper');
  const launchBodyObj = launchBody({ runtime: { dialog: {}, perception: { speaker: 'original' } } });
  const launch = await invokeDirect(skill, launchBodyObj);
  const session = JSON.parse(JSON.stringify(launch.data.skill.session));
  // The update body owns the runtime object the looper mutates, so keep the
  // reference to inspect the speaker override afterwards.
  const body = updateBody(session, intents(intent, entities));
  body.data.runtime.perception.speaker = 'original';
  const update = await invokeDirect(skill, body);
  return { launch, update, body };
}

async function speakerProbes() {
  await probe('s02.speaker.overrideSetsPerceptionSpeaker', async () => {
    reset();
    const skill = new ProbeSkill('probe-skill', 'speakerSet');
    const body = launchBody({ runtime: { dialog: {}, perception: { speaker: 'original' } } });
    const res = await invokeDirect(skill, body);
    return { speakerAfter: body.data.runtime.perception.speaker, action: actionOf(res) };
  });

  await probe('s02.speaker.overrideWithNullClearsSpeaker', async () => {
    reset();
    const skill = new ProbeSkill('probe-skill', 'speakerClear');
    const body = launchBody({ runtime: { dialog: {}, perception: { speaker: 'original' } } });
    const res = await invokeDirect(skill, body);
    return { speakerAfter: body.data.runtime.perception.speaker, action: actionOf(res) };
  });

  await probe('s02.speaker.overrideWithoutRuntimeContextIsNoop', async () => {
    reset();
    const skill = new ProbeSkill('probe-skill', 'speakerNoRuntime');
    const body = launchBody({ runtime: undefined });
    const res = await invokeDirect(skill, body);
    return { type: res.type, final: res.data.final, action: actionOf(res) };
  });

  await probe('s02.looper.cancel', async () => {
    reset();
    const { update, body } = await driveLooper('cancel');
    return { action: actionOf(update), speakerAfter: body.data.runtime.perception.speaker, trace: update.data.skill.session.trace };
  });

  await probe('s02.looper.loopmemberWithReferent', async () => {
    reset();
    const { update, body } = await driveLooper('loopmember', { loopMemberReferent: 'bob' });
    return { action: actionOf(update), speakerAfter: body.data.runtime.perception.speaker, trace: update.data.skill.session.trace };
  });

  await probe('s02.looper.loopmemberWithoutReferentFallsThrough', async () => {
    reset();
    const { update, body } = await driveLooper('loopmember', {});
    return { action: actionOf(update), speakerAfter: body.data.runtime.perception.speaker, trace: update.data.skill.session.trace };
  });

  await probe('s02.looper.loopmemberWithEmptyStringReferent', async () => {
    reset();
    const { update, body } = await driveLooper('loopmember', { loopMemberReferent: '' });
    return { action: actionOf(update), speakerAfter: body.data.runtime.perception.speaker, trace: update.data.skill.session.trace };
  });

  await probe('s02.looper.notInLoop', async () => {
    reset();
    const { update, body } = await driveLooper('notInLoop');
    return { action: actionOf(update), speakerAfter: body.data.runtime.perception.speaker, trace: update.data.skill.session.trace };
  });

  await probe('s02.looper.unknownIntent', async () => {
    reset();
    const { update, body } = await driveLooper('bananas');
    return { action: actionOf(update), speakerAfter: body.data.runtime.perception.speaker, trace: update.data.skill.session.trace };
  });

  await probe('s02.looper.nullResult', async () => {
    reset();
    const skill = new ProbeSkill('probe-skill', 'looper');
    const launch = await invokeDirect(skill, launchBody({ runtime: { dialog: {}, perception: {} } }));
    const session = JSON.parse(JSON.stringify(launch.data.skill.session));
    const body = updateBody(session, null);
    const update = await invokeDirect(skill, body);
    return { action: actionOf(update), speakerAfter: body.data.runtime.perception.speaker, trace: update.data.skill.session.trace };
  });

  await probe('s02.looper.nluWithoutEntitiesThrows', async () => {
    reset();
    const skill = new ProbeSkill('probe-skill', 'looper');
    const launch = await invokeDirect(skill, launchBody({ runtime: { dialog: {}, perception: {} } }));
    const session = JSON.parse(JSON.stringify(launch.data.skill.session));
    await invokeDirect(skill, updateBody(session, { nlu: { intent: 'loopmember' } }));
  });
}

/* --------------------- global intents across updates ------------------- */

async function globalProbes() {
  await probe('s02.global.cancelOnUpdate', async () => {
    reset();
    const skill = new ProbeSkill('probe-skill', 'echo');
    const launch = await invokeDirect(skill, launchBody({ result: intents('launchIntent') }));
    const session = JSON.parse(JSON.stringify(launch.data.skill.session));
    const update = await invokeDirect(skill, updateBody(session, intents('cancel')));
    return { launchText: launch.data.action.config.jcp.text, updateText: update.data.action.config.jcp.text, final: update.data.final };
  });

  await probe('s02.global.repeatOnUpdate', async () => {
    reset();
    const skill = new ProbeSkill('probe-skill', 'echo');
    const launch = await invokeDirect(skill, launchBody({ result: intents('launchIntent') }));
    const session = JSON.parse(JSON.stringify(launch.data.skill.session));
    const update = await invokeDirect(skill, updateBody(session, intents('repeat')));
    return { launchText: launch.data.action.config.jcp.text, updateText: update.data.action.config.jcp.text, final: update.data.final };
  });

  await probe('s02.global.thanksOnUpdate', async () => {
    reset();
    const skill = new ProbeSkill('probe-skill', 'echo');
    const launch = await invokeDirect(skill, launchBody({ result: intents('launchIntent') }));
    const session = JSON.parse(JSON.stringify(launch.data.skill.session));
    const update = await invokeDirect(skill, updateBody(session, intents('thanks')));
    return { launchText: launch.data.action.config.jcp.text, updateText: update.data.action.config.jcp.text, final: update.data.final };
  });

  await probe('s02.global.globalIntentDoesNotEmitEntryEvent', async () => {
    reset();
    const skill = new ProbeSkill('probe-skill', 'entry');
    const launch = await invokeDirect(skill, launchBody());
    const session = JSON.parse(JSON.stringify(launch.data.skill.session));
    const update = await invokeDirect(skill, updateBody(session, intents('thanks')));
    return {
      updateAnalytics: update.data.analytics,
      entryEvents: update.data.analytics['probe-skill'] || [],
    };
  });

  await probe('s02.global.thanksAfterTerminal', async () => {
    // The skill floor is already closed (the last node consumed a terminal
    // transition); a later global intent is answered silently.
    reset();
    const skill = new ProbeSkill('probe-skill', 'echo');
    const launch = await invokeDirect(skill, launchBody({ result: intents('launchIntent') }));
    const s0 = JSON.parse(JSON.stringify(launch.data.skill.session));
    const u1 = await invokeDirect(skill, updateBody(s0, intents('yes')));
    const s1 = JSON.parse(JSON.stringify(u1.data.skill.session));
    const u2 = await invokeDirect(skill, updateBody(s1, intents('thanks')));
    return {
      u1: { nodeID: u1.data.skill.session.nodeID, trace: u1.data.skill.session.trace },
      u2: { type: u2.type, final: u2.data.final, fireAndForget: u2.data.fireAndForget, action: u2.data.action, trace: u2.data.skill.session.trace },
    };
  });
}

/* ---------------------------- failure handling ------------------------- */

async function failureProbes() {
  await probe('s02.failure.missingGeneral', async () => {
    reset();
    const skill = new ProbeSkill('probe-skill', 'entry');
    await invokeDirect(skill, { type: 'LISTEN_LAUNCH', msgID: 'm', ts: 1, data: { skill: { id: 'probe-skill' } } });
  });

  await probe('s02.failure.missingAccountID', async () => {
    reset();
    const skill = new ProbeSkill('probe-skill', 'entry');
    await invokeDirect(skill, { type: 'LISTEN_LAUNCH', msgID: 'm', ts: 1, data: { general: { robotID: 'r' }, skill: { id: 'probe-skill' } } });
  });

  await probe('s02.failure.missingRobotID', async () => {
    reset();
    const skill = new ProbeSkill('probe-skill', 'entry');
    await invokeDirect(skill, { type: 'LISTEN_LAUNCH', msgID: 'm', ts: 1, data: { general: { accountID: 'a' }, skill: { id: 'probe-skill' } } });
  });

  await probe('s02.failure.skillMismatch', async () => {
    reset();
    const skill = new ProbeSkill('probe-skill', 'entry');
    await invokeDirect(skill, { type: 'LISTEN_LAUNCH', msgID: 'm', ts: 1, data: { general: general(), skill: { id: 'other-skill' } } });
  });

  await probe('s02.failure.unknownRequestType', async () => {
    reset();
    const skill = new ProbeSkill('probe-skill', 'entry');
    await invokeDirect(skill, { type: 'NOT_A_REQUEST', msgID: 'm', ts: 1, data: { general: general(), skill: { id: 'probe-skill' } } });
  });

  await probe('s02.failure.missingResultStillResponds', async () => {
    reset();
    const skill = new ProbeSkill('probe-skill', 'entry');
    const body = launchBody();
    delete body.data.result;
    const res = await invokeDirect(skill, body);
    return { type: res.type, final: res.data.final, text: res.data.action.config.jcp.text };
  });

  await probe('s02.failure.missingSessionOnUpdate', async () => {
    reset();
    const skill = new ProbeSkill('probe-skill', 'entry');
    await invokeDirect(skill, updateBody(undefined, intents('yes')));
  });

  await probe('s02.failure.dataNull', async () => {
    reset();
    const skill = new ProbeSkill('probe-skill', 'entry');
    await invokeDirect(skill, { type: 'LISTEN_LAUNCH', msgID: 'm', ts: 1, data: null });
  });

  await probe('s02.failure.dataUndefined', async () => {
    reset();
    const skill = new ProbeSkill('probe-skill', 'entry');
    await invokeDirect(skill, { type: 'LISTEN_LAUNCH', msgID: 'm', ts: 1 });
  });
}

/* --------------------------- wire-level (live) ------------------------- */

function postHandlerOf(skill) {
  const layer = skill.router.stack.find((l) => l.route && l.route.path === '/' && l.route.methods && l.route.methods.post);
  return layer.route.stack[0].handle;
}

async function invokeWire(skill, body) {
  const handle = postHandlerOf(skill);
  let out;
  let settled = false;
  const res = { status() { return res; }, json(v) { out = v; settled = true; return res; } };
  // The Express route wrapper registered by BaseHttpHandler does not return
  // its promise, so drain the microtask/immediate queue until it settles.
  await handle({ body, log: makeLog() }, res, (err) => { out = { __next: describe(err) }; settled = true; });
  for (let i = 0; i < 200 && !settled; i++) await new Promise((r) => setImmediate(r));
  return out;
}

async function wireProbes() {
  await probe('s02.wire.launchEnvelopeThroughRoute', async () => {
    reset();
    const skill = new ProbeSkill('probe-skill', 'entry');
    const res = await invokeWire(skill, launchBody());
    return { type: res.type, final: res.data.final, analytics: res.data.analytics };
  });

  await probe('s02.wire.terminalEnvelopeThroughRoute', async () => {
    reset();
    const skill = new ProbeSkill('probe-skill', 'entry');
    const first = await invokeWire(skill, launchBody());
    const session = JSON.parse(JSON.stringify(first.data.skill.session));
    const res = await invokeWire(skill, updateBody(session, intents('thanks')));
    return { type: res.type, final: res.data.final, action: res.data.action };
  });

  await probe('s02.wire.errorEnvelopeThroughRoute', async () => {
    reset();
    const skill = new ProbeSkill('probe-skill', 'entry');
    const res = await invokeWire(skill, {
      type: 'LISTEN_LAUNCH', msgID: 'm', ts: 1, data: { general: general(), skill: { id: 'other-skill' } },
    });
    return { type: res.type, message: res.data.message, skill: res.data.skill };
  });
}

async function main() {
  await analyticsProbes();
  await supplementalProbes();
  await speakerProbes();
  await globalProbes();
  await failureProbes();
  await wireProbes();
  results.__meta = {
    runtime: process.version,
    runtimeRoot: RUNTIME,
    baseskillVersion: require(path.join(RUNTIME, 'packages/baseskill/package.json')).version,
    pins: {
      'jiboV2/pegasus:packages/baseskill/src/GraphSkill.ts': '5c0a7390539663ba749d360de348a428c088505c',
      'jiboV2/pegasus:packages/baseskill/src/graph/nodes/SetLooperIDNode.ts': '5c0a7390539663ba749d360de348a428c088505c',
      'jiboV2/pegasus:packages/interfaces/src/skill/behaviors.ts': '5c0a7390539663ba749d360de348a428c088505c',
    },
  };
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2) + '\n');
  console.log('probes:', Object.keys(results).length - 1, '->', OUT);
}

main().catch((err) => { console.error(err); process.exit(1); });
