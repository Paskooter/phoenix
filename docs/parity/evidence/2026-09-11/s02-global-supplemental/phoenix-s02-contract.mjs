/*
 * S-02 Phoenix contract driver.
 *
 * Runs the SAME probe names as `source-s02-contract.cjs` (which executes the
 * pinned original under Node 8.9.4) against the real Phoenix graph skill layer,
 * so `compare.py` can diff the two receipts cell-by-cell.
 *
 * API-shape mapping (deployment scope, recorded in the review README):
 *   original GraphManager.instance singleton  ->  an explicit GraphManager per probe
 *   original new Graph(name, exits)           ->  new Graph(gm, name, exits)
 *   original GraphSkill subclass              ->  createGraphSkill({name, build, graphManager})
 *   original BaseSkill express wrapper        ->  skillRoute(skillId, handler)
 *
 *   node phoenix-s02-contract.mjs <outPath>
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../../../..');

const {
  Graph, GraphManager, Node, createGraphSkill, nodes,
} = await import(path.join(ROOT, 'packages/skills/src/index.js'));
const { skillRoute } = await import(path.join(ROOT, 'packages/skills/src/skillService.js'));

const { SetLooperIDNode } = nodes;

const OUT = process.argv[2] || path.join(HERE, 'phoenix-s02-contract.json');

const results = {};

function describe(err) {
  return {
    message: err && err.message !== undefined ? err.message : String(err),
    ctor: err && err.constructor ? err.constructor.name : typeof err,
  };
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

/* Phoenix has no process-wide singleton; each probe gets a fresh manager. */
let manager = new GraphManager();
function reset() { manager = new GraphManager(); }

/* A concrete node whose enter/exit are supplied by the probe. */
class PNode extends Node {
  constructor(name, transitions, enter, exit) {
    super(name, transitions);
    this._enter = enter;
    this._exit = exit;
  }
  async enter(data) { return this._enter ? this._enter(data) : {}; }
  async exit(data) { return this._exit ? this._exit(data) : {}; }
}

const okNode = (name, tns, enter, exit) => new PNode(name, tns, enter, exit);

/* The probe logger only has to satisfy the skill boundary's calls. */
const noop = () => {};
function makeLog() {
  const log = { info: noop, warn: noop, error: noop, debug: noop };
  log.createChild = () => log;
  return log;
}

/* ------------------------------ skill shapes --------------------------- */

const jcp = (id, text) => ({
  type: 'JCP',
  config: { version: '2.0', jcp: { id, type: 'SPEAK', text } },
});

function actionOf(res) {
  return res && res.data && res.data.action ? safe(res.data.action) : null;
}

function buildGraph(gm, mode, skill) {
  const g = new Graph(gm, 's02-' + mode, ['Done']);

  if (mode === 'entry') {
    const n = okNode('Entry', ['Done'],
      async (data) => {
        skill.track(data, 'Probe Event', { marker: 'entry' });
        return { action: jcp('entry-action', 'entry'), final: false };
      },
      async () => ({ transition: 'Done' }));
    g.addNode(n, [['Done', 'Done']]);
    g.finalize();
    return g;
  }

  if (mode === 'tracker') {
    const n = okNode('Tracker', ['Done'],
      async (data) => {
        skill.track(data, 'First Event');
        skill.track(data, 'Second Event', { i: 2 });
        return { action: jcp('tracker-action', 'tracker'), final: false };
      },
      async () => ({ transition: 'Done' }));
    g.addNode(n, [['Done', 'Done']]);
    g.finalize();
    return g;
  }

  if (mode === 'multiTurn') {
    const ask = okNode('Ask', ['Answered'],
      async (data) => {
        skill.track(data, 'Probe Event', { marker: 'turn1' });
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

  if (mode === 'echo') {
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

  if (mode === 'sequence') {
    const n = okNode('Sequencer', ['Done'],
      async (data) => {
        skill.addSequenceBehavior(data, { id: 'seq-1', type: 'SET_PRESENT_PERSON', looperId: 'bob', source: 'USER_OVERRIDE', confidence: 100 });
        skill.addSequenceBehavior(data, { id: 'seq-2', type: 'IMPACT_EMOTION', emotion: 'HAPPY' });
        return { action: jcp('seq-main', 'seq-main'), final: false };
      },
      async () => ({ transition: 'Done' }));
    g.addNode(n, [['Done', 'Done']]);
    g.finalize();
    return g;
  }

  if (mode === 'parallel') {
    const n = okNode('Paralleler', ['Done'],
      async (data) => {
        skill.addParallelBehavior(data, { id: 'par-1', type: 'IMPACT_EMOTION', emotion: 'CALM' });
        return { action: jcp('par-main', 'par-main'), final: false };
      },
      async () => ({ transition: 'Done' }));
    g.addNode(n, [['Done', 'Done']]);
    g.finalize();
    return g;
  }

  if (mode === 'both') {
    const n = okNode('Both', ['Done'],
      async (data) => {
        skill.addParallelBehavior(data, { id: 'par-1', type: 'IMPACT_EMOTION', emotion: 'CALM' });
        skill.addParallelBehavior(data, { id: 'par-2', type: 'IMPACT_EMOTION', emotion: 'HAPPY' });
        skill.addSequenceBehavior(data, { id: 'seq-1', type: 'SET_PRESENT_PERSON', looperId: 'bob', source: 'USER_OVERRIDE', confidence: 100 });
        return { action: jcp('both-main', 'both-main'), final: false };
      },
      async () => ({ transition: 'Done' }));
    g.addNode(n, [['Done', 'Done']]);
    g.finalize();
    return g;
  }

  if (mode === 'nonJcp') {
    const n = okNode('NonJcp', ['Done'],
      async (data) => {
        skill.addSequenceBehavior(data, { id: 'seq-1', type: 'IMPACT_EMOTION', emotion: 'HAPPY' });
        return { action: { type: 'NOT_JCP', payload: { id: 'raw-action' } }, final: false };
      },
      async () => ({ transition: 'Done' }));
    g.addNode(n, [['Done', 'Done']]);
    g.finalize();
    return g;
  }

  if (mode === 'noBehaviors') {
    const n = okNode('Plain', ['Done'],
      async () => ({ action: jcp('plain-action', 'plain'), final: false }),
      async () => ({ transition: 'Done' }));
    g.addNode(n, [['Done', 'Done']]);
    g.finalize();
    return g;
  }

  if (mode === 'speakerSet') {
    const n = okNode('Speaker', ['Done'],
      async (data) => {
        skill.overrideSpeaker(data, 'looper-9');
        return { action: jcp('speaker-action', 'speaker'), final: false };
      },
      async () => ({ transition: 'Done' }));
    g.addNode(n, [['Done', 'Done']]);
    g.finalize();
    return g;
  }

  if (mode === 'speakerClear') {
    const n = okNode('SpeakerClear', ['Done'],
      async (data) => {
        skill.overrideSpeaker(data, null);
        return { action: jcp('clear-action', 'clear'), final: false };
      },
      async () => ({ transition: 'Done' }));
    g.addNode(n, [['Done', 'Done']]);
    g.finalize();
    return g;
  }

  if (mode === 'speakerNoRuntime') {
    const n = okNode('SpeakerNoRuntime', ['Done'],
      async (data) => {
        skill.overrideSpeaker(data, 'looper-9');
        return { action: jcp('noruntime-action', 'noruntime'), final: false };
      },
      async () => ({ transition: 'Done' }));
    g.addNode(n, [['Done', 'Done']]);
    g.finalize();
    return g;
  }

  if (mode === 'looper') {
    const hold = okNode('Hold', ['Next'],
      async () => ({ action: jcp('hold-action', 'hold'), final: false }),
      async (data) => ({ transition: 'Next', result: data.result }));
    const looper = new SetLooperIDNode('Looper', skill);
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

  const term = okNode('Terminal', ['Done'], async () => null, async () => ({ transition: 'Done' }));
  g.addNode(term, [['Done', 'Done']]);
  g.finalize();
  return g;
}

function makeSkill(mode) {
  reset();
  return createGraphSkill({
    name: 'probe-skill',
    graphManager: manager,
    build: (gm, facade) => buildGraph(gm, mode, facade),
  });
}

async function invokeDirect(skill, body) {
  return skill(body, { log: makeLog(), trace: {} });
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
    const skill = makeSkill('entry');
    const res = await invokeDirect(skill, launchBody());
    return { type: res.type, analytics: res.data.analytics };
  });

  await probe('s02.analytics.proactiveLaunchEntryEvent', async () => {
    const skill = makeSkill('entry');
    const res = await invokeDirect(skill, launchBody({ type: 'PROACTIVE_LAUNCH' }));
    return { type: res.type, analytics: res.data.analytics };
  });

  await probe('s02.analytics.trackDefaultsAndOrder', async () => {
    const skill = makeSkill('tracker');
    const res = await invokeDirect(skill, launchBody());
    return { events: res.data.analytics['probe-skill'] };
  });

  await probe('s02.analytics.notPersistedAcrossTurns', async () => {
    const skill = makeSkill('multiTurn');
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
    const skill = makeSkill('entry');
    const first = await invokeDirect(skill, launchBody());
    const session = JSON.parse(JSON.stringify(first.data.skill.session));
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
    const skill = makeSkill('sequence');
    const res = await invokeDirect(skill, launchBody());
    return { action: actionOf(res) };
  });

  await probe('s02.supplemental.parallelOnly', async () => {
    const skill = makeSkill('parallel');
    const res = await invokeDirect(skill, launchBody());
    return { action: actionOf(res) };
  });

  await probe('s02.supplemental.parallelWrapsSequence', async () => {
    const skill = makeSkill('both');
    const res = await invokeDirect(skill, launchBody());
    return { action: actionOf(res) };
  });

  await probe('s02.supplemental.nonJcpActionNotWrapped', async () => {
    const skill = makeSkill('nonJcp');
    const res = await invokeDirect(skill, launchBody());
    return { action: actionOf(res) };
  });

  await probe('s02.supplemental.noBehaviorsActionUnchanged', async () => {
    const skill = makeSkill('noBehaviors');
    const res = await invokeDirect(skill, launchBody());
    return { action: actionOf(res) };
  });

  await probe('s02.supplemental.generatedIdsAreTransactionShaped', async () => {
    const skill = makeSkill('both');
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

async function driveLooper(intent, entities) {
  const skill = makeSkill('looper');
  const launch = await invokeDirect(skill, launchBody({ runtime: { dialog: {}, perception: { speaker: 'original' } } }));
  const session = JSON.parse(JSON.stringify(launch.data.skill.session));
  const body = updateBody(session, intents(intent, entities));
  body.data.runtime.perception.speaker = 'original';
  const update = await invokeDirect(skill, body);
  return { launch, update, body };
}

async function speakerProbes() {
  await probe('s02.speaker.overrideSetsPerceptionSpeaker', async () => {
    const skill = makeSkill('speakerSet');
    const body = launchBody({ runtime: { dialog: {}, perception: { speaker: 'original' } } });
    const res = await invokeDirect(skill, body);
    return { speakerAfter: body.data.runtime.perception.speaker, action: actionOf(res) };
  });

  await probe('s02.speaker.overrideWithNullClearsSpeaker', async () => {
    const skill = makeSkill('speakerClear');
    const body = launchBody({ runtime: { dialog: {}, perception: { speaker: 'original' } } });
    const res = await invokeDirect(skill, body);
    return { speakerAfter: body.data.runtime.perception.speaker, action: actionOf(res) };
  });

  await probe('s02.speaker.overrideWithoutRuntimeContextIsNoop', async () => {
    const skill = makeSkill('speakerNoRuntime');
    const body = launchBody({ runtime: undefined });
    const res = await invokeDirect(skill, body);
    return { type: res.type, final: res.data.final, action: actionOf(res) };
  });

  await probe('s02.looper.cancel', async () => {
    const { update, body } = await driveLooper('cancel');
    return { action: actionOf(update), speakerAfter: body.data.runtime.perception.speaker, trace: update.data.skill.session.trace };
  });

  await probe('s02.looper.loopmemberWithReferent', async () => {
    const { update, body } = await driveLooper('loopmember', { loopMemberReferent: 'bob' });
    return { action: actionOf(update), speakerAfter: body.data.runtime.perception.speaker, trace: update.data.skill.session.trace };
  });

  await probe('s02.looper.loopmemberWithoutReferentFallsThrough', async () => {
    const { update, body } = await driveLooper('loopmember', {});
    return { action: actionOf(update), speakerAfter: body.data.runtime.perception.speaker, trace: update.data.skill.session.trace };
  });

  await probe('s02.looper.loopmemberWithEmptyStringReferent', async () => {
    const { update, body } = await driveLooper('loopmember', { loopMemberReferent: '' });
    return { action: actionOf(update), speakerAfter: body.data.runtime.perception.speaker, trace: update.data.skill.session.trace };
  });

  await probe('s02.looper.notInLoop', async () => {
    const { update, body } = await driveLooper('notInLoop');
    return { action: actionOf(update), speakerAfter: body.data.runtime.perception.speaker, trace: update.data.skill.session.trace };
  });

  await probe('s02.looper.unknownIntent', async () => {
    const { update, body } = await driveLooper('bananas');
    return { action: actionOf(update), speakerAfter: body.data.runtime.perception.speaker, trace: update.data.skill.session.trace };
  });

  await probe('s02.looper.nullResult', async () => {
    const skill = makeSkill('looper');
    const launch = await invokeDirect(skill, launchBody({ runtime: { dialog: {}, perception: {} } }));
    const session = JSON.parse(JSON.stringify(launch.data.skill.session));
    const body = updateBody(session, null);
    const update = await invokeDirect(skill, body);
    return { action: actionOf(update), speakerAfter: body.data.runtime.perception.speaker, trace: update.data.skill.session.trace };
  });

  await probe('s02.looper.nluWithoutEntitiesThrows', async () => {
    const skill = makeSkill('looper');
    const launch = await invokeDirect(skill, launchBody({ runtime: { dialog: {}, perception: {} } }));
    const session = JSON.parse(JSON.stringify(launch.data.skill.session));
    await invokeDirect(skill, updateBody(session, { nlu: { intent: 'loopmember' } }));
  });
}

/* --------------------- global intents across updates ------------------- */

async function globalProbes() {
  await probe('s02.global.cancelOnUpdate', async () => {
    const skill = makeSkill('echo');
    const launch = await invokeDirect(skill, launchBody({ result: intents('launchIntent') }));
    const session = JSON.parse(JSON.stringify(launch.data.skill.session));
    const update = await invokeDirect(skill, updateBody(session, intents('cancel')));
    return { launchText: launch.data.action.config.jcp.text, updateText: update.data.action.config.jcp.text, final: update.data.final };
  });

  await probe('s02.global.repeatOnUpdate', async () => {
    const skill = makeSkill('echo');
    const launch = await invokeDirect(skill, launchBody({ result: intents('launchIntent') }));
    const session = JSON.parse(JSON.stringify(launch.data.skill.session));
    const update = await invokeDirect(skill, updateBody(session, intents('repeat')));
    return { launchText: launch.data.action.config.jcp.text, updateText: update.data.action.config.jcp.text, final: update.data.final };
  });

  await probe('s02.global.thanksOnUpdate', async () => {
    const skill = makeSkill('echo');
    const launch = await invokeDirect(skill, launchBody({ result: intents('launchIntent') }));
    const session = JSON.parse(JSON.stringify(launch.data.skill.session));
    const update = await invokeDirect(skill, updateBody(session, intents('thanks')));
    return { launchText: launch.data.action.config.jcp.text, updateText: update.data.action.config.jcp.text, final: update.data.final };
  });

  await probe('s02.global.globalIntentDoesNotEmitEntryEvent', async () => {
    const skill = makeSkill('entry');
    const launch = await invokeDirect(skill, launchBody());
    const session = JSON.parse(JSON.stringify(launch.data.skill.session));
    const update = await invokeDirect(skill, updateBody(session, intents('thanks')));
    return {
      updateAnalytics: update.data.analytics,
      entryEvents: update.data.analytics['probe-skill'] || [],
    };
  });

  await probe('s02.global.thanksAfterTerminal', async () => {
    const skill = makeSkill('echo');
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
    const skill = makeSkill('entry');
    await invokeDirect(skill, { type: 'LISTEN_LAUNCH', msgID: 'm', ts: 1, data: { skill: { id: 'probe-skill' } } });
  });

  await probe('s02.failure.missingAccountID', async () => {
    const skill = makeSkill('entry');
    await invokeDirect(skill, { type: 'LISTEN_LAUNCH', msgID: 'm', ts: 1, data: { general: { robotID: 'r' }, skill: { id: 'probe-skill' } } });
  });

  await probe('s02.failure.missingRobotID', async () => {
    const skill = makeSkill('entry');
    await invokeDirect(skill, { type: 'LISTEN_LAUNCH', msgID: 'm', ts: 1, data: { general: { accountID: 'a' }, skill: { id: 'probe-skill' } } });
  });

  await probe('s02.failure.skillMismatch', async () => {
    const skill = makeSkill('entry');
    await invokeDirect(skill, { type: 'LISTEN_LAUNCH', msgID: 'm', ts: 1, data: { general: general(), skill: { id: 'other-skill' } } });
  });

  await probe('s02.failure.unknownRequestType', async () => {
    const skill = makeSkill('entry');
    await invokeDirect(skill, { type: 'NOT_A_REQUEST', msgID: 'm', ts: 1, data: { general: general(), skill: { id: 'probe-skill' } } });
  });

  await probe('s02.failure.missingResultStillResponds', async () => {
    const skill = makeSkill('entry');
    const body = launchBody();
    delete body.data.result;
    const res = await invokeDirect(skill, body);
    return { type: res.type, final: res.data.final, text: res.data.action.config.jcp.text };
  });

  await probe('s02.failure.missingSessionOnUpdate', async () => {
    const skill = makeSkill('entry');
    await invokeDirect(skill, updateBody(undefined, intents('yes')));
  });

  await probe('s02.failure.dataNull', async () => {
    const skill = makeSkill('entry');
    await invokeDirect(skill, { type: 'LISTEN_LAUNCH', msgID: 'm', ts: 1, data: null });
  });

  await probe('s02.failure.dataUndefined', async () => {
    const skill = makeSkill('entry');
    await invokeDirect(skill, { type: 'LISTEN_LAUNCH', msgID: 'm', ts: 1 });
  });
}

/* --------------------------- wire-level (live) ------------------------- */

async function wireProbes() {
  await probe('s02.wire.launchEnvelopeThroughRoute', async () => {
    const skill = makeSkill('entry');
    const res = await skillRoute('probe-skill', skill)({ body: launchBody(), trace: {}, log: makeLog() });
    return { type: res.type, final: res.data.final, analytics: res.data.analytics };
  });

  await probe('s02.wire.terminalEnvelopeThroughRoute', async () => {
    const skill = makeSkill('entry');
    const first = await skillRoute('probe-skill', skill)({ body: launchBody(), trace: {}, log: makeLog() });
    const session = JSON.parse(JSON.stringify(first.data.skill.session));
    const res = await skillRoute('probe-skill', skill)({ body: updateBody(session, intents('thanks')), trace: {}, log: makeLog() });
    return { type: res.type, final: res.data.final, action: res.data.action };
  });

  await probe('s02.wire.errorEnvelopeThroughRoute', async () => {
    const skill = makeSkill('entry');
    const res = await skillRoute('probe-skill', skill)({
      body: { type: 'LISTEN_LAUNCH', msgID: 'm', ts: 1, data: { general: general(), skill: { id: 'other-skill' } } },
      trace: {}, log: makeLog(),
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
