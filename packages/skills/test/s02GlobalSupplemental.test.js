// S-02 — global results, speaker overrides and supplemental behaviors.
//
// Asserts the S-02 surfaces of the graph skill layer against the pinned original
// (jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c):
//   * GraphSkill.ts:143-154  track() -> data.analytics[skillName] entries
//   * GraphSkill.ts:73-80    SKILL_ENTRY analytics on launch/proactive launch
//   * GraphSkill.ts:161-172  overrideSpeaker() -> data.runtime.perception.speaker
//   * GraphSkill.ts:179-214  addParallelBehavior/addSequenceBehavior buffering
//   * GraphSkill.ts:227-239  injectSupplementalBehaviors ordering
//   * graph/nodes/SetLooperIDNode.ts:24-64  cancel/loopmember/notInLoop dispatch
//   * interfaces/src/skill/behaviors.ts:5-29 SupportedBehaviors / SupplementalBehaviors
//   * jibo-command-requester structural/Sequence|Parallel/SetPresentPerson generateProtocol
//
// Both layers are covered:
//   1. direct handler invocation (the framework boundary);
//   2. the same behaviour over a LIVE skills HTTP entrypoint.
//
// The two receipts this file encodes are diffed cell-by-cell by
// docs/parity/evidence/2026-09-11/s02-global-supplemental/compare.py (39 probes).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Graph, GraphManager, Node, createGraphSkill, createSkillsService, nodes,
} from '../src/index.js';

const { SetLooperIDNode } = nodes;

/* ------------------------------------------------------------------ helpers */

class ProbeNode extends Node {
  constructor(name, transitions, enter, exit) {
    super(name, transitions);
    this._enter = enter;
    this._exit = exit;
  }
  async enter(data) { return this._enter ? this._enter(data) : {}; }
  async exit(data) { return this._exit ? this._exit(data) : {}; }
}

const node = (name, tns, enter, exit) => new ProbeNode(name, tns, enter, exit);

const GENERAL = { accountID: 'fixture-account', robotID: 'fixture-robot', lang: 'en-US' };
const RUNTIME = { dialog: {}, perception: {} };
const SKILL_ID = 's02-skill';

const jcp = (id, text) => ({ type: 'JCP', config: { version: '2.0', jcp: { id, type: 'SPEAK', text } } });
const nlu = (intent, entities) => ({ nlu: { intent, entities: entities || {} }, asr: { text: String(intent), confidence: 1 } });

function makeSkill(build) {
  return createGraphSkill({ name: SKILL_ID, graphManager: new GraphManager(), build });
}

function launchBody(extra = {}) {
  return {
    type: extra.type || 'LISTEN_LAUNCH', msgID: 'm1', ts: 1,
    data: {
      general: GENERAL,
      runtime: extra.runtime === undefined ? RUNTIME : extra.runtime,
      skill: { id: SKILL_ID },
      result: extra.result === undefined ? nlu('fixture') : extra.result,
    },
  };
}

function updateBody(session, result = nlu('yes')) {
  const data = { general: GENERAL, runtime: { dialog: {}, perception: {} }, skill: { id: SKILL_ID }, result };
  if (session !== undefined) data.skill.session = session;
  return { type: 'LISTEN_UPDATE', msgID: 'm2', ts: 2, data };
}

const call = (skill, body) => skill(body, { log: console, trace: {} });
const roundTrip = (value) => JSON.parse(JSON.stringify(value));
const entries = (response) => response.data.analytics[SKILL_ID] || [];
const eventsOf = (response) => entries(response).map((e) => e.event);

/* A graph whose answering UPDATE reaches SetLooperIDNode: the launch node holds
 * the turn, and the update's NLU intent is what the looper dispatches on (the
 * same shape as OptInFactory: MIM holds the turn, looper runs inside it). */
function looperSkill() {
  return makeSkill((gm, skill) => {
    const g = new Graph(gm, 's02-looper', ['Done']);
    const hold = node('Hold', ['Next'],
      async () => ({ action: jcp('hold-action', 'hold'), final: false }),
      async (data) => ({ transition: 'Next', result: data.result }));
    const looper = new SetLooperIDNode('Looper', skill);
    const cancel = node('Cancel', ['Done'], async () => ({ action: jcp('cancel-action', 'cancel'), final: false }), async () => ({ transition: 'Done' }));
    const success = node('Success', ['Done'], async () => ({ action: jcp('success-action', 'success'), final: false }), async () => ({ transition: 'Done' }));
    const notInLoop = node('NotInLoop', ['Done'], async () => ({ action: jcp('notinloop-action', 'notInLoop'), final: false }), async () => ({ transition: 'Done' }));
    g.addNode(hold, [['Next', looper]]);
    g.addNode(looper, [['Cancel', cancel], ['Success', success], ['NotInLoop', notInLoop]]);
    g.addNode(cancel, [['Done', 'Done']]);
    g.addNode(success, [['Done', 'Done']]);
    g.addNode(notInLoop, [['Done', 'Done']]);
    g.finalize();
    return g;
  });
}

/* Drives the looper graph with the given answering intent. */
async function driveLooper(intent, entities) {
  const skill = looperSkill();
  const launch = await call(skill, launchBody({ runtime: { dialog: {}, perception: { speaker: 'original' } } }));
  const session = roundTrip(launch.data.skill.session);
  const body = updateBody(session, nlu(intent, entities));
  body.data.runtime.perception.speaker = 'original';
  const update = await call(skill, body);
  return { update, body };
}

/* ============================== analytics ============================== */

test('S-02 analytics: launch emits the source Skill Entry event and never persists analytics', async () => {
  const skill = makeSkill((gm, facade) => {
    const g = new Graph(gm, 's02-entry', ['Done']);
    g.addNode(node('Entry', ['Done'],
      async (data) => {
        facade.track(data, 'Probe Event', { marker: 'entry' });
        return { action: jcp('entry-action', 'entry'), final: false };
      },
      async () => ({ transition: 'Done' })), [['Done', 'Done']]);
    g.finalize();
    return g;
  });

  const launched = await call(skill, launchBody());
  assert.deepEqual(entries(launched)[0], {
    event: 'Skill Entry',
    properties: {
      initial_intent: 'n/a', domain: '', was_hey_jibo_launch: true, user_initiated: true, last_skill: 'n/a',
    },
  }, 'GraphSkill.ts:73-80 emits SKILL_ENTRY before the graph is entered');
  assert.deepEqual(entries(launched)[1], { event: 'Probe Event', properties: { marker: 'entry' } });

  // GraphSkill.ts:61-66 builds `analytics: {}` per request: turn 2 starts empty.
  const updated = await call(skill, updateBody(roundTrip(launched.data.skill.session), nlu('thanks')));
  assert.deepEqual(eventsOf(updated), [], 'a LISTEN_UPDATE never re-emits the entry event');
  assert.deepEqual(updated.data.skill.session.data, {}, 'analytics are not written into the session blob');
});

test('S-02 analytics: proactive launch flips both launch flags and track() defaults properties', async () => {
  const skill = makeSkill((gm, facade) => {
    const g = new Graph(gm, 's02-proactive', ['Done']);
    g.addNode(node('Entry', ['Done'],
      async (data) => {
        facade.track(data, 'No Props');
        return { action: jcp('proactive-action', 'proactive'), final: false };
      },
      async () => ({ transition: 'Done' })), [['Done', 'Done']]);
    g.finalize();
    return g;
  });

  const res = await call(skill, launchBody({ type: 'PROACTIVE_LAUNCH' }));
  assert.deepEqual(entries(res)[0].properties, {
    initial_intent: 'n/a', domain: '', was_hey_jibo_launch: false, user_initiated: false, last_skill: 'n/a',
  }, 'GraphSkill.ts:70-80 keys both flags off LISTEN_LAUNCH');
  assert.deepEqual(entries(res)[1], { event: 'No Props', properties: {} }, 'GraphSkill.ts:143 defaults properties to {}');
});

/* ============================ speaker override ========================= */

test('S-02 speaker: overrideSpeaker mutates runtime.perception and SetLooperIDNode pairs it with SET_PRESENT_PERSON', async () => {
  const set = await driveLooper('loopmember', { loopMemberReferent: 'bob' });
  assert.equal(set.body.data.runtime.perception.speaker, 'bob',
    'GraphSkill.ts:168 assigns the id onto the request runtime it was handed');
  const behavior = set.update.data.action.config.jcp;
  assert.equal(behavior.type, 'SEQUENCE', 'the supplemental behavior rides the answering JCP');
  assert.deepEqual(behavior.children.map((c) => c.type), ['SET_PRESENT_PERSON', 'SPEAK']);
  assert.deepEqual(
    { looperId: behavior.children[0].looperId, source: behavior.children[0].source, confidence: behavior.children[0].confidence },
    { looperId: 'bob', source: 'USER_OVERRIDE', confidence: 100 },
    'SetLooperIDNode.ts:45-49 generateProtocol(looperId, "USER_OVERRIDE", 100)',
  );
  assert.equal(set.update.data.skill.session.trace[1].transition, 'Success');

  const clear = await driveLooper('notInLoop');
  assert.equal(clear.body.data.runtime.perception.speaker, null,
    'SetLooperIDNode.ts:55-58 clears the override on the NotInLoop path');
  assert.equal(clear.update.data.action.config.jcp.id, 'notinloop-action', 'nothing is wrapped when nothing was queued');
});

test('S-02 speaker: cancel leaves the perceived speaker untouched, and an override without a runtime context is a no-op', async () => {
  const cancelled = await driveLooper('cancel');
  assert.equal(cancelled.body.data.runtime.perception.speaker, 'original',
    'SetLooperIDNode.ts:39-40 takes Cancel before any overrideSpeaker call');
  assert.equal(cancelled.update.data.action.config.jcp.id, 'cancel-action');
  assert.equal(cancelled.update.data.skill.session.trace[1].transition, 'Cancel');

  const noRuntime = await makeSkill((gm, facade) => {
    const g = new Graph(gm, 's02-no-runtime', ['Done']);
    g.addNode(node('Speaker', ['Done'],
      async (data) => {
        facade.overrideSpeaker(data, 'looper-9');
        return { action: jcp('noruntime-action', 'noruntime'), final: false };
      },
      async () => ({ transition: 'Done' })), [['Done', 'Done']]);
    g.finalize();
    return g;
  });
  const res = await call(noRuntime, launchBody({ runtime: undefined }));
  assert.equal(res.type, 'SKILL_ACTION', 'GraphSkill.ts:162-171 is a guarded no-op without runtime.perception');
  assert.equal(res.data.action.config.jcp.text, 'noruntime');
});

/* ======================= supplemental behaviours ======================= */

test('S-02 supplemental: sequence buffers in push order and parallel wraps the sequence', async () => {
  const skill = makeSkill((gm, facade) => {
    const g = new Graph(gm, 's02-both', ['Done']);
    g.addNode(node('Both', ['Done'],
      async (data) => {
        facade.addParallelBehavior(data, { id: 'par-1', type: 'IMPACT_EMOTION', emotion: 'CALM' });
        facade.addParallelBehavior(data, { id: 'par-2', type: 'IMPACT_EMOTION', emotion: 'HAPPY' });
        facade.addSequenceBehavior(data, { id: 'seq-1', type: 'IMPACT_EMOTION', emotion: 'HAPPY' });
        facade.addSequenceBehavior(data, { id: 'seq-2', type: 'SET_PRESENT_PERSON', looperId: 'bob', source: 'USER_OVERRIDE', confidence: 100 });
        return { action: jcp('both-main', 'both-main'), final: false };
      },
      async () => ({ transition: 'Done' })), [['Done', 'Done']]);
    g.finalize();
    return g;
  });

  const res = await call(skill, launchBody());
  const behavior = res.data.action.config.jcp;
  assert.equal(behavior.type, 'PARALLEL', 'GraphSkill.ts:227-239 wraps PARALLEL outermost');
  assert.equal(behavior.succeedOnFirst, false, 'Parallel.generateProtocol default');
  assert.equal(/^[0-9a-f]{32}$/.test(behavior.id), true, 'generated transaction id is 32 lowercase hex');
  assert.deepEqual(behavior.children.map((c) => c.type), ['IMPACT_EMOTION', 'IMPACT_EMOTION', 'SEQUENCE']);
  assert.deepEqual(behavior.children.slice(0, 2).map((c) => c.id), ['par-1', 'par-2'], 'parallel list keeps push order');
  assert.equal(behavior.children[2].type, 'SEQUENCE', 'the main action is wrapped by the sequence, not the other way round');
  assert.deepEqual(behavior.children[2].children.map((c) => c.id), ['seq-1', 'seq-2', 'both-main'],
    'sequence = supplemental sequence behaviours followed by the main behaviour');
  assert.equal(/^[0-9a-f]{32}$/.test(behavior.children[2].id), true);
});

test('S-02 supplemental: a non-JCP action is never wrapped', async () => {
  const skill = makeSkill((gm, facade) => {
    const g = new Graph(gm, 's02-non-jcp', ['Done']);
    g.addNode(node('NonJcp', ['Done'],
      async (data) => {
        facade.addSequenceBehavior(data, { id: 'seq-1', type: 'IMPACT_EMOTION', emotion: 'HAPPY' });
        return { action: { type: 'NOT_JCP', payload: { id: 'raw-action' } }, final: false };
      },
      async () => ({ transition: 'Done' })), [['Done', 'Done']]);
    g.finalize();
    return g;
  });

  const res = await call(skill, launchBody());
  assert.deepEqual(res.data.action, { type: 'NOT_JCP', payload: { id: 'raw-action' } },
    'GraphSkill.ts:107 only injects into a JCPAction');
});

/* ======================= global intents on updates ===================== */

test('S-02 global: cancel/repeat/thanks reach the graph untouched and add no entry analytics', async () => {
  for (const intent of ['cancel', 'repeat', 'thanks']) {
    const skill = makeSkill((gm) => {
      const g = new Graph(gm, 's02-echo', ['Done']);
      const ask = node('Ask', ['Answered'],
        async () => ({ action: jcp('echo-ask', 'launch'), final: false }),
        async (data) => ({ transition: 'Answered', result: data.result }));
      const echo = node('Echo', ['Done'],
        async (data) => ({ action: jcp('echo-action', `intent:${data.result.nlu.intent}`), final: true }),
        async () => ({ transition: 'Done' }));
      g.addNode(ask, [['Answered', echo]]);
      g.addNode(echo, [['Done', 'Done']]);
      g.finalize();
      return g;
    });

    const launch = await call(skill, launchBody());
    const update = await call(skill, updateBody(roundTrip(launch.data.skill.session), nlu(intent)));
    assert.equal(update.data.action.config.jcp.text, `intent:${intent}`,
      'the framework applies no global-intent policy of its own; the node sees the raw NLU result');
    assert.equal(update.data.final, true);
    assert.deepEqual(eventsOf(update), [], 'only LISTEN_LAUNCH/PROACTIVE_LAUNCH tracks SKILL_ENTRY');
  }
});

test('S-02 global: a global intent after the floor is closed is answered silently', async () => {
  const skill = makeSkill((gm) => {
    const g = new Graph(gm, 's02-terminal', ['Done']);
    const ask = node('Ask', ['Answered'],
      async () => ({ action: jcp('ask-action', 'ask'), final: false }),
      async (data) => ({ transition: 'Answered', result: data.result }));
    const finish = node('Finish', ['Done'],
      async () => ({ action: jcp('finish-action', 'finish'), final: true }),
      async () => ({ transition: 'Done' }));
    g.addNode(ask, [['Answered', finish]]);
    g.addNode(finish, [['Done', 'Done']]);
    g.finalize();
    return g;
  });

  const launch = await call(skill, launchBody());
  const u1 = await call(skill, updateBody(roundTrip(launch.data.skill.session), nlu('yes')));
  const u2 = await call(skill, updateBody(roundTrip(u1.data.skill.session), nlu('thanks')));
  assert.deepEqual({ type: u2.type, final: u2.data.final, fireAndForget: u2.data.fireAndForget, action: u2.data.action },
    { type: 'SKILL_ACTION', final: true, fireAndForget: true, action: null },
    'GraphSkill.ts:116-134 terminal response');
  assert.deepEqual(u2.data.skill.session.trace, [
    { nodeID: 0, transition: 'Answered' },
    { nodeID: 1, transition: 'Done' },
  ]);
});

/* ============================= failure paths =========================== */

test('S-02 failure: SetLooperIDNode reproduces the source Node 8 property-access error for incomplete entities', async () => {
  // SetLooperIDNode.ts:31-36 defaults only a missing `nlu`; an `nlu` without
  // `entities` throws inside the original's own property read, and that message
  // is what the cloud error envelope carried (Node 8 wording).
  const undefinedEntities = looperSkill();
  const launchA = await call(undefinedEntities, launchBody());
  await assert.rejects(
    () => call(undefinedEntities, updateBody(roundTrip(launchA.data.skill.session), { nlu: { intent: 'loopmember' } })),
    (err) => err instanceof TypeError && err.message === "Cannot read property 'loopMemberReferent' of undefined",
  );

  const nullEntities = looperSkill();
  const launchB = await call(nullEntities, launchBody());
  await assert.rejects(
    () => call(nullEntities, updateBody(roundTrip(launchB.data.skill.session), { nlu: { intent: 'loopmember', entities: null } })),
    (err) => err instanceof TypeError && err.message === "Cannot read property 'loopMemberReferent' of null",
  );
});

test('S-02 failure: the source request preconditions still own the S-02 entry point', async () => {
  const skill = makeSkill((gm) => {
    const g = new Graph(gm, 's02-entry', ['Done']);
    g.addNode(node('Entry', ['Done'], async () => ({ action: jcp('entry-action', 'entry'), final: false }), async () => ({ transition: 'Done' })), [['Done', 'Done']]);
    g.finalize();
    return g;
  });

  const cases = [
    [{ type: 'LISTEN_LAUNCH', msgID: 'm', ts: 1 }, "Cannot read property 'general' of undefined"],
    [{ type: 'LISTEN_LAUNCH', msgID: 'm', ts: 1, data: null }, "Cannot read property 'general' of null"],
    [{ type: 'LISTEN_LAUNCH', msgID: 'm', ts: 1, data: { skill: { id: SKILL_ID } } }, 'Skill request without general.accountID arrived'],
    [{ type: 'LISTEN_LAUNCH', msgID: 'm', ts: 1, data: { general: { robotID: 'r' }, skill: { id: SKILL_ID } } }, 'Skill request without general.accountID arrived'],
    [{ type: 'LISTEN_LAUNCH', msgID: 'm', ts: 1, data: { general: { accountID: 'a' }, skill: { id: SKILL_ID } } }, 'Skill request without general.robotID arrived'],
    [{ type: 'LISTEN_LAUNCH', msgID: 'm', ts: 1, data: { general: GENERAL, skill: { id: 'other-skill' } } }, "Incoming skill name doesn't match. This: 's02-skill', incoming: 'other-skill'"],
    [{ type: 'NOT_A_REQUEST', msgID: 'm', ts: 1, data: { general: GENERAL, skill: { id: SKILL_ID } } }, "Unknown request type 'NOT_A_REQUEST'"],
  ];
  for (const [body, message] of cases) {
    await assert.rejects(() => call(skill, body), (err) => err.message === message, message);
  }

  await assert.rejects(
    () => call(skill, updateBody(undefined, nlu('yes'))),
    (err) => err.message === 'Skill session is required',
  );

  // A missing per-turn result only warns; the node still runs.
  const noResult = launchBody();
  delete noResult.data.result;
  const res = await call(skill, noResult);
  assert.equal(res.data.action.config.jcp.text, 'entry');
});

/* ====================== live HTTP entrypoint layer ===================== */

async function withS02Service(handler, run) {
  const server = await createSkillsService({
    name: 's02-host',
    skills: [{ id: SKILL_ID, handler }],
    defaultId: SKILL_ID,
  }).listen(0);
  const port = server.address().port;
  const post = async (body) => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/${SKILL_ID}/main`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    await run(post);
  } finally {
    await new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
}

test('S-02 live entrypoint: entry analytics, supplemental wrapping and global cancel over HTTP', async () => {
  const analyticsSkill = makeSkill((gm, facade) => {
    const g = new Graph(gm, 's02-live-analytics', ['Done']);
    g.addNode(node('Entry', ['Done'],
      async (data) => {
        facade.addSequenceBehavior(data, { id: 'seq-1', type: 'IMPACT_EMOTION', emotion: 'HAPPY' });
        return { action: jcp('entry-action', 'entry'), final: false };
      },
      async () => ({ transition: 'Done' })), [['Done', 'Done']]);
    g.finalize();
    return g;
  });

  await withS02Service(analyticsSkill, async (post) => {
    const launched = await post(launchBody());
    assert.equal(launched.status, 200);
    assert.equal(launched.body.data.analytics[SKILL_ID][0].event, 'Skill Entry');
    const behavior = launched.body.data.action.config.jcp;
    assert.equal(behavior.type, 'SEQUENCE');
    assert.deepEqual(behavior.children.map((c) => c.type), ['IMPACT_EMOTION', 'SPEAK']);
  });

  const looper = looperSkill();
  await withS02Service(looper, async (post) => {
    const launched = await post(launchBody());
    const answered = await post(updateBody(launched.body.data.skill.session, nlu('loopmember', { loopMemberReferent: 'bob' })));
    const behavior = answered.body.data.action.config.jcp;
    assert.equal(behavior.type, 'SEQUENCE');
    assert.equal(behavior.children[0].type, 'SET_PRESENT_PERSON');
    assert.equal(behavior.children[0].looperId, 'bob');
  });

  // The cancel leg needs its own session: answering the looper moves the
  // session past it, exactly like the source OptIn graph.
  const cancelling = looperSkill();
  await withS02Service(cancelling, async (post) => {
    const launched = await post(launchBody());
    const cancelled = await post(updateBody(launched.body.data.skill.session, nlu('cancel')));
    assert.equal(cancelled.body.data.action.config.jcp.id, 'cancel-action');
    assert.deepEqual(cancelled.body.data.skill.session.trace.map((t) => t.transition), ['Next', 'Cancel', null]);
  });

  // The localized failure message is what the robot's error envelope receives.
  const failing = looperSkill();
  await withS02Service(failing, async (post) => {
    const launched = await post(launchBody());
    const broken = await post(updateBody(launched.body.data.skill.session, { nlu: { intent: 'loopmember' } }));
    assert.equal(broken.status, 200);
    assert.equal(broken.body.type, 'ERROR');
    assert.equal(broken.body.data.message, "Cannot read property 'loopMemberReferent' of undefined");
    assert.deepEqual(broken.body.data.skill, { id: SKILL_ID });
  });
});
