// S-01 — GraphSkill sessions and graph execution.
//
// Two layers are covered:
//   1. the graph engine contract (Graph/GraphManager/Node) asserted against the
//      pinned original (jiboV2/pegasus@5c0a739 packages/baseskill/src/graph/*),
//      including every invalid-graph and invalid-session error string;
//   2. the same contract over a LIVE skills HTTP entrypoint, with real
//      multi-turn sessions, retries and corrupted/replayed session blobs.
//
// Source citations are file:line against
// 5c0a7390539663ba749d360de348a428c088505c.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  Graph, TransitionContainer, GraphManager, Node, FnNode,
  createGraphSkill, createSkillsService, start, colorSkill, SKILLS,
} from '../src/index.js';

/* ------------------------------------------------------------------ helpers */

class ProbeNode extends Node {
  constructor(name, transitions, enter, exit) {
    super(name, transitions);
    if (enter) this._enter = enter;
    if (exit) this._exit = exit;
  }
  async enter(data) { return this._enter ? this._enter(data) : {}; }
  async exit(data) { return this._exit ? this._exit(data) : {}; }
}

const node = (name, tns, enter, exit) => new ProbeNode(name, tns, enter, exit);
const silent = async () => null;
const routed = (transition, extra = () => ({})) => async (data) => ({ transition, result: data.result, ...extra() });

const GENERAL = { accountID: 'fixture-account', robotID: 'fixture-robot', lang: 'en-US' };
const RUNTIME = { dialog: {}, perception: {} };

function launchBody(skillId, extraData = {}) {
  return {
    type: 'LISTEN_LAUNCH', msgID: 'm1', ts: 1,
    data: {
      general: GENERAL, runtime: RUNTIME, skill: { id: skillId },
      result: { nlu: { intent: 'fixture', entities: {} } },
      ...extraData,
    },
  };
}

function updateBody(skillId, session, result) {
  const data = { general: GENERAL, runtime: RUNTIME, skill: { id: skillId }, result };
  if (session !== undefined) data.skill.session = session;
  return { type: 'LISTEN_UPDATE', msgID: 'm2', ts: 2, data };
}

const roundTrip = (value) => JSON.parse(JSON.stringify(value));

function errorOf(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected a synchronous throw');
}

async function rejectionOf(promiseFactory) {
  try {
    await promiseFactory();
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejected promise');
}

/* =============================== graph engine ============================ */

test('S-01 Graph construction and finalization reproduce every source error', () => {
  const cases = [
    // Graph.ts:39-45
    [[(gm) => new Graph(gm, 'G', ['Done', 'Done'])], "Graph 'G' has duplicate exit transition names"],
    [[(gm) => new Graph(gm, 'G', [])], "Graph 'G' needs to have at least one exit transition"],
    // Graph.ts:43-46 — exit-transition declarations
    [[(gm) => {
      const g = new Graph(gm, 'G', ['Alpha', 'Beta']);
      return { keys: Array.from(g.exitTransitions.keys()), initial: g.initial, finalized: g.isFinalized() };
    }], null],
    // Graph.ts:51-56
    [[(gm) => {
      const g = new Graph(gm, 'G', ['Done']);
      g.setInitialNode(node('Foreign', [], silent, async () => ({})));
    }], "Node 'Foreign' isn't a part of this graph"],
    // Graph.ts:61-67
    [[(gm) => {
      const g = new Graph(gm, 'G', ['Done']);
      const a = node('A', ['next'], silent, routed('next'));
      const b = node('B', [], silent, async () => ({}));
      g.addNode(a, [['next', b]]);
      g.addNode(a, [['next', b]]);
    }], 'Node already added to graph'],
    // Graph.ts:79-82
    [[(gm) => {
      const g = new Graph(gm, 'G', ['Done']);
      const a = node('A', ['x', 'y'], silent, async () => ({}));
      g.addNode(a, [['x', node('B', [], silent, async () => ({}))], ['x', node('C', [], silent, async () => ({}))]]);
    }], "Non-unique transitions found in transition mapping for node 'A': x"],
    // Graph.ts:83-85
    [[(gm) => {
      const g = new Graph(gm, 'G', ['Done']);
      g.addNode(node('A', ['x', 'y'], silent, async () => ({})), [['x', node('B', [], silent, async () => ({}))]]);
    }], "Non-matching length of transition mapping for node 'A'"],
    // Graph.ts:86-90
    [[(gm) => {
      const g = new Graph(gm, 'G', ['Done']);
      g.addNode(node('A', ['x', 'y'], silent, async () => ({})), [
        ['x', node('B', [], silent, async () => ({}))],
        ['z', node('C', [], silent, async () => ({}))],
      ]);
    }], "Missing transition 'y' in transition mapping for node 'A'"],
    // Graph.ts:93-101 — `dest instanceof Node`, so a duck-typed destination is invalid
    [[(gm) => {
      const g = new Graph(gm, 'G', ['Done']);
      g.addNode(node('A', ['x'], silent, async () => ({})), [
        ['x', { name: 'Fake', transitions: new Map(), graphs: [], id: null, enter: async () => ({}) }],
      ]);
    }], "Must provide a valid destination for node 'G' and transition 'x'"],
    // Graph.ts:62-64
    [[(gm) => {
      const g = new Graph(gm, 'G', ['Done']);
      const a = node('A', ['next'], silent, routed('next'));
      const b = node('B', ['done'], silent, routed('done'));
      g.addNode(a, [['next', b]]);
      g.addNode(b, [['done', 'Done']]);
      g.finalize();
      g.addNode(node('C', [], silent, async () => ({})), []);
    }], "Can't add Node 'C' to graph 'G' after it's been finalized"],
    // Graph.ts:189-191
    [[(gm) => {
      const g = new Graph(gm, 'G', ['Done']);
      g.addNode(node('A', ['x'], silent, routed('x')), [['x', 'NotAnExit']]);
      g.finalize();
    }], "Graph 'G' doesn't have exit transition 'NotAnExit'"],
    // Graph.ts:199-202 — the source interpolates the Node object itself
    [[(gm) => {
      const g = new Graph(gm, 'G', ['Done']);
      g.addNode(node('A', ['x'], silent, async () => ({})), [
        ['x', node('Foreign', [], silent, async () => ({}))],
      ]);
      g.finalize();
    }], "Graph 'G': Node 'A' has transition to Node '[object Object]' which isn't in graph"],
    // Graph.ts:212-217
    [[(gm) => {
      const g = new Graph(gm, 'G', ['Done']);
      g.addNode(node('A', ['x'], silent, routed('x')), [['x', 'Done']]);
      g.addNode(node('Island', [], silent, async () => ({})), []);
      g.finalize();
    }], "Graph 'G': Node 'Island' is not reachable from any other state."],
    // Graph.ts:220-224
    [[(gm) => {
      const g = new Graph(gm, 'G', ['Done', 'Unused']);
      g.addNode(node('A', ['x'], silent, routed('x')), [['x', 'Done']]);
      g.finalize();
    }], "Graph 'G' has not connected exit transition 'Unused'"],
    // Node.ts:46-50
    [[() => node('A', ['x', 'x'], silent, async () => ({}))], "Node 'A' has duplicate transition names"],
    // Node.ts:69-72
    [[() => node('A', [], silent, async () => ({})).forEachDescendent(() => {})],
      "Can't traverse descendents until we've been added to graph"],
  ];

  for (const [[fn], expected] of cases) {
    const gm = new GraphManager();
    if (expected === null) {
      const out = fn(gm);
      assert.deepEqual(out.keys, ['Alpha', 'Beta']);
      assert.equal(out.initial, undefined, 'Graph.ts leaves `initial` undefined until a node is added');
      assert.equal(out.finalized, false);
      continue;
    }
    assert.equal(errorOf(() => fn(gm)).message, expected);
  }
});

test('S-01 forEachDescendent walks breadth-first and reports early termination', () => {
  const gm = new GraphManager();
  const g = new Graph(gm, 'G', ['Done']);
  const a = node('A', ['x', 'y'], silent, async () => ({}));
  const b = node('B', ['z'], silent, async () => ({}));
  const c = node('C', [], silent, async () => ({}));
  const d = node('D', [], silent, async () => ({}));
  g.addNode(a, [['x', b], ['y', c]]);
  g.addNode(b, [['z', d]]);
  g.addNode(c, []);
  g.addNode(d, []);

  const seen = [];
  const early = a.forEachDescendent((n) => { seen.push(n.name); return n.name === 'C'; });
  assert.equal(early, true, 'handler truthiness terminates the walk');
  assert.deepEqual(seen, ['B', 'C']);

  const all = [];
  assert.equal(a.forEachDescendent((n) => { all.push(n.name); }), false);
  assert.deepEqual(all, ['B', 'C', 'D']);

  assert.deepEqual([a.id, b.id, c.id, d.id], [0, 1, 2, 3]);
  assert.equal(gm.nodeIDCounter, 4);
});

test('S-01 subgraph composition splices exits, inherits the initial node and rejects invalid splices', () => {
  const buildChild = (gm, name = 'Child', exitName = 'Out') => {
    const child = new Graph(gm, name, [exitName]);
    const a = node(`${name}A`, ['go'], silent, routed('go'));
    child.addNode(a, [['go', exitName]]);
    child.finalize();
    return { child, a };
  };

  // Happy path: Graph.ts:114-165
  {
    const gm = new GraphManager();
    const parent = new Graph(gm, 'Parent', ['Done']);
    const after = node('After', ['Done'], silent, routed('Done'));
    const { child, a } = buildChild(gm);
    parent.addSubGraph(child, [['Out', after]]);
    parent.addNode(after, [['Done', 'Done']]);
    parent.finalize();

    assert.deepEqual(Array.from(parent.nodes).map((n) => n.name), ['ChildA', 'After']);
    assert.equal(child.nodes.size, 1);
    assert.deepEqual(a.graphs.map((gr) => gr.name), ['Child', 'Parent']);
    assert.equal(child.exitTransitions.get('Out')[0].destination, after);
    assert.equal(parent.initial.name, 'ChildA', 'the parent inherits the subgraph initial');
  }

  const bad = [
    // Graph.ts:119-121
    [[(gm) => {
      const parent = new Graph(gm, 'Parent', ['Done']);
      const pn = node('PN', [], silent, async () => ({}));
      parent.addNode(pn, []);
      parent.addSubGraph(new Graph(gm, 'Child', ['Out']), [['Out', pn]]);
    }], "Can't add subgraph non-finalized 'Child' to graph 'Parent'"],
    // Graph.ts:136-143
    [[(gm) => {
      const parent = new Graph(gm, 'Parent', ['Done']);
      const p1 = node('P1', [], silent, async () => ({}));
      const p2 = node('P2', [], silent, async () => ({}));
      parent.addNode(p1, []);
      parent.addNode(p2, []);
      const { child } = buildChild(gm);
      parent.addSubGraph(child, [['Out', p1], ['Extra', p2]]);
    }], "Non-matching length of transition mapping for subgraph 'Child'"],
    // Graph.ts:144-148
    [[(gm) => {
      const parent = new Graph(gm, 'Parent', ['Done']);
      const p1 = node('P1', [], silent, async () => ({}));
      parent.addNode(p1, []);
      const { child } = buildChild(gm);
      parent.addSubGraph(child, [['Wrong', p1]]);
    }], "Missing transition 'Out' in transition mapping for subgraph 'Child'"],
    // Graph.ts:153-156
    [[(gm) => {
      const { child } = buildChild(gm);
      const p1 = node('P1', [], silent, async () => ({}));
      const p2 = node('P2', [], silent, async () => ({}));
      const parentA = new Graph(gm, 'ParentA', ['Done']);
      parentA.addSubGraph(child, [['Out', p1]]);
      const parentB = new Graph(gm, 'ParentB', ['Done']);
      parentB.addSubGraph(child, [['Out', p2]]);
    }], "Can't override already assigned transition, subgraph: 'Child' exit transition: 'Out' dest state: 'P1'"],
    // Graph.ts:125-127
    [[(gm) => {
      const childManager = new GraphManager();
      const { child } = buildChild(childManager);
      const parent = new Graph(gm, 'Parent', ['Done']);
      const p1 = node('P1', [], silent, async () => ({}));
      parent.addNode(p1, []);
      parent.addSubGraph(child, [['Out', p1]]);
    }], "Subgraph node 'ChildA' from graph 'Child' not registered with same graph manager"],
    // Graph.ts:128-130
    [[(gm) => {
      const { child } = buildChild(gm);
      const p1 = node('P1', ['Done'], silent, routed('Done'));
      const parent = new Graph(gm, 'Parent', ['Done']);
      parent.addSubGraph(child, [['Out', p1]]);
      parent.addNode(p1, [['Done', 'Done']]);
      parent.addSubGraph(child, [['Out', p1]]);
    }], "Subgraph node 'ChildA' from graph 'Child' is already in this graph"],
    // Graph.ts:115-117
    [[(gm) => {
      const parent = new Graph(gm, 'Parent', ['Done']);
      const p1 = node('P1', ['Done'], silent, routed('Done'));
      parent.addNode(p1, [['Done', 'Done']]);
      parent.finalize();
      const { child } = buildChild(gm);
      parent.addSubGraph(child, [['Out', p1]]);
    }], "Can't add subgraph 'Child' to graph 'Parent' after it's been finalized"],
  ];

  for (const [[fn], expected] of bad) {
    assert.equal(errorOf(() => fn(new GraphManager())).message, expected);
  }
});

test('S-01 GraphManager allocates node ids and guards session/transition preconditions', async () => {
  // Phoenix deliberately allows explicit managers (deployment scope); the
  // original's locked `GraphManager.instance` constructor is an accepted,
  // documented divergence recorded in the S-01 review.
  const gm = new GraphManager();
  const g = new Graph(gm, 'G', ['Done']);
  const a = node('A', ['Done'], silent, routed('Done'));
  g.addNode(a, [['Done', 'Done']]);
  g.finalize();

  assert.equal(a.id, 0);
  assert.equal(gm.getNode(0), a);
  assert.equal(gm.hasNode(a), true);
  assert.equal(gm.nodeIDCounter, 1);
  assert.equal(errorOf(() => gm.addNode(a)).message, "Node 'A' has already been added");

  const preset = node('Preset', [], silent, async () => ({}));
  preset.id = 7;
  assert.equal(errorOf(() => gm.addNode(preset)).message, "This node 'Preset' is already in a graph");

  assert.equal(
    (await rejectionOf(() => gm.start(g, { skill: { session: { id: 'old' } } }))).message,
    'Skill session should not exist here',
  );
  assert.equal((await rejectionOf(() => gm.enterNode({ skill: {} }))).message, 'Skill session is required');
  assert.equal((await rejectionOf(() => gm.exitNode({ skill: {} }))).message, 'Skill session is required');
  assert.equal(
    (await rejectionOf(() => gm.enterNode({ skill: { session: { nodeID: 999, trace: [] } } }))).message,
    "Node id '999' isn't a part of this graph",
  );
  assert.equal(
    (await rejectionOf(() => gm.exitNode({ skill: { session: { nodeID: 999, trace: [] } } }))).message,
    "Node id '999' isn't a part of this graph",
  );

  // Fresh session creation mirrors GraphManager.start: uuid id, initial node, empty data/trace
  const data = { skill: {} };
  assert.equal(await gm.start(g, data), null, 'a terminal initial node ends the transaction');
  assert.match(data.skill.session.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(data.skill.session.nodeID, 0);
  assert.deepEqual(data.skill.session.data, {});
  assert.deepEqual(data.skill.session.trace, [{ nodeID: 0, transition: 'Done' }]);
});

test('S-01 GraphManager transition guards detect unregistered, corrupt and replayed traces', async () => {
  const gm = new GraphManager();
  const n = node('N', ['Done'], silent, routed('Done'));
  gm.addNode(n);
  n.transitions.set('Done', new TransitionContainer('Done', null, null));

  const at = (trace) => ({ skill: { session: { nodeID: n.id, trace } } });

  assert.equal(
    (await rejectionOf(() => gm._executeTransition(n, { transition: 'Nope' }, at([])))).message,
    "State 'N' returned unregistered transition 'Nope'",
  );
  assert.equal((await rejectionOf(() => gm._executeTransition(n, { transition: 'Done' }, at([])))).message, 'Trace should exist');
  assert.equal(
    (await rejectionOf(() => gm._executeTransition(n, { transition: 'Done' }, at([{ nodeID: n.id, transition: 'Done' }])))).message,
    "Trace transition shouldn't exist",
  );
  assert.equal(
    (await rejectionOf(() => gm._executeTransition(n, { transition: 'Done' }, at([{ nodeID: n.id + 1, transition: null }])))).message,
    'Unexpected trace node ID',
  );

  const terminal = await gm._executeTransition(n, { transition: 'Done' }, at([{ nodeID: n.id, transition: null }]));
  assert.equal(terminal, null, 'a terminal transition ends the transaction');

  const data = at([{ nodeID: n.id, transition: null }]);
  await gm._executeTransition(n, { transition: 'Done', result: null }, data);
  assert.equal(data.result, null, 'result.result || null');
  data.result = 'sentinel';
  data.skill.session.trace = [{ nodeID: n.id, transition: null }];
  await gm._executeTransition(n, { transition: 'Done' }, data);
  assert.equal(data.result, null, 'a missing result becomes null, overwriting the previous turn');
});

test('S-01 Graph.writeDotFile reproduces the source GraphViz dump', () => {
  const gm = new GraphManager();
  const g = new Graph(gm, 'Dot', ['Done']);
  const a = node('Alpha', ['go'], silent, routed('go'));
  const b = node('Bravo', ['Done'], silent, routed('Done'));
  g.addNode(a, [['go', b]]);
  g.addNode(b, [['Done', 'Done']]);
  g.finalize();

  assert.throws(
    () => new Graph(new GraphManager(), 'G', ['Done']).writeDotFile('/tmp/never.gv'),
    /Can't render dot file of a non-finalized graph 'G'/,
  );

  const target = '/tmp/s01-dot.test.gv';
  assert.equal(g.writeDotFile(target), true);
  assert.equal(g.writeDotFile(''), undefined, 'a falsy path renders but writes nothing');
  assert.equal(
    readFileSync(target, 'utf8'),
    [
      'digraph graphname {',
      '"Done" [style=filled,fillcolor="#0088cc",color="black"];',
      'subgraph cluster_0 {',
      ' style = filled',
      ' fillcolor = "#f2f2f2"',
      ' color = "black"',
      ' label = "Dot"',
      '  "Alpha" [style=filled,fillcolor="#4dc3ff",color="black"];',
      '  "Bravo" [style=filled,fillcolor="#99ddff",color="black"];',
      '}',
      '"Alpha" -> "Bravo" [label="go"]',
      '"Bravo" -> "Done" [label="Done"]',
      '}',
    ].join('\n'),
  );
});

/* ============================ GraphSkill ================================= */

function makeProbeSkill(mode) {
  const gm = new GraphManager();
  return createGraphSkill({
    name: 'probe-skill',
    graphManager: gm,
    build: () => {
      const g = new Graph(gm, `probe-${mode}`, ['Done']);
      if (mode === 'threeTurn') {
        const ask = node('Ask', ['Answered'],
          async () => ({ action: { type: 'JCP', config: { jcp: { id: 'a' } } }, final: false }),
          routed('Answered'));
        const confirm = node('Confirm', ['Confirmed'],
          async () => ({ action: { type: 'JCP', config: { jcp: { id: 'b' } } }, final: false }),
          routed('Confirmed'));
        const finish = node('Finish', ['Done'],
          async () => ({ action: { type: 'JCP', config: { jcp: { id: 'c' } } }, final: true }),
          async () => ({}));
        g.addNode(ask, [['Answered', confirm]]);
        g.addNode(confirm, [['Confirmed', finish]]);
        g.addNode(finish, [['Done', 'Done']]);
      } else {
        const ask = node('Ask', ['Answered'],
          async () => ({ action: { type: 'JCP', config: { jcp: { id: 'a' } } }, final: false }),
          routed('Answered'));
        const finish = node('Finish', ['Done'],
          async () => ({ action: { type: 'JCP', config: { jcp: { id: 'c' } } }, final: true }),
          async () => ({}));
        g.addNode(ask, [['Answered', finish]]);
        g.addNode(finish, [['Done', 'Done']]);
      }
      g.finalize();
      return g;
    },
  });
}

test('S-01 GraphSkill continues a captured session through every follow-up action', async () => {
  const skill = makeProbeSkill('threeTurn');
  const launch = await skill(launchBody('probe-skill'));
  const s0 = roundTrip(launch.data.skill.session);
  assert.deepEqual(s0.trace, [{ nodeID: 0, transition: null }]);
  assert.equal(launch.data.final, false);
  assert.deepEqual(launch.data.analytics['probe-skill'], [{
    event: 'Skill Entry',
    properties: { initial_intent: 'n/a', domain: '', was_hey_jibo_launch: true, user_initiated: true, last_skill: 'n/a' },
  }]);

  const u1 = await skill(updateBody('probe-skill', roundTrip(s0), { asr: { text: 'yes' }, memo: 'first' }));
  const s1 = roundTrip(u1.data.skill.session);
  assert.equal(u1.data.final, false, 'multi-turn: the skill stays open');
  assert.deepEqual(s1.trace, [{ nodeID: 0, transition: 'Answered' }, { nodeID: 1, transition: null }]);

  const u2 = await skill(updateBody('probe-skill', roundTrip(s1), { asr: { text: 'confirm' }, memo: 'second' }));
  const s2 = roundTrip(u2.data.skill.session);
  assert.equal(u2.data.final, true);
  assert.deepEqual(s2.trace, [
    { nodeID: 0, transition: 'Answered' },
    { nodeID: 1, transition: 'Confirmed' },
    { nodeID: 2, transition: null },
  ]);
  assert.deepEqual(s2.data, {}, 'per-turn results are never persisted into the session blob');

  const u3 = await skill(updateBody('probe-skill', roundTrip(s2), { asr: { text: 'again' } }));
  assert.equal(u3.data.final, true, 'a post-terminal update is silently terminal');
  assert.equal(u3.data.fireAndForget, true);
  assert.equal(u3.data.action, null);
  assert.equal(u3.data.skill.session.nodeID, 2);
  assert.deepEqual(u3.data.skill.session.trace, s2.trace, 'the terminal node is not re-entered');
});

test('S-01 GraphSkill retries, corrupted and replayed sessions behave like the source', async () => {
  const skill = makeProbeSkill('multiTurn');
  const launch = await skill(launchBody('probe-skill'));
  const s0 = roundTrip(launch.data.skill.session);
  const retryBody = updateBody('probe-skill', roundTrip(s0), { asr: { text: 'blue' } });

  const first = await skill(retryBody);
  const retry = await skill(updateBody('probe-skill', roundTrip(s0), { asr: { text: 'blue' } }));
  assert.deepEqual(roundTrip(retry.data), roundTrip(first.data), 'a byte-identical retry replays deterministically');

  assert.equal(
    (await rejectionOf(() => skill(updateBody('probe-skill', { id: 'corrupt', nodeID: 4242, data: {}, trace: [] })))).message,
    "Node id '4242' isn't a part of this graph",
  );
  assert.equal(
    (await rejectionOf(() => skill(updateBody('probe-skill', { id: 'consumed', nodeID: 0, data: {}, trace: [{ nodeID: 0, transition: 'Answered' }] })))).message,
    "Trace transition shouldn't exist",
  );
  assert.equal(
    (await rejectionOf(() => skill(updateBody('probe-skill', { id: 'mismatch', nodeID: 0, data: {}, trace: [{ nodeID: 77, transition: null }] })))).message,
    'Unexpected trace node ID',
  );
  assert.equal(
    (await rejectionOf(() => skill(updateBody('probe-skill', undefined, {})))).message,
    'Skill session is required',
  );
  assert.equal(
    (await rejectionOf(() => skill(launchBody('probe-skill', { skill: { id: 'probe-skill', session: s0 } })))).message,
    'Skill session should not exist here',
  );
});

/* ======================= live HTTP entrypoint ============================ */

async function withServer(fn) {
  const server = await start(0, { skillId: 'color-skill' });
  const port = server.address().port;
  const post = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    return await fn(post);
  } finally {
    await new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
}

const colorLaunch = () => launchBody('color-skill', {
  result: { nlu: { intent: 'favoriteColorChat', rules: ['launch'], entities: {} } },
});

const colorUpdate = (session, text) => updateBody('color-skill', session, {
  asr: { text }, nlu: { intent: null, rules: [], entities: {} },
});

test('S-01 live color-skill entrypoint runs a real multi-turn session to its terminal state', async () => {
  await withServer(async (post) => {
    const launch = await post('/v1/main', colorLaunch());
    assert.equal(launch.status, 200);
    assert.equal(launch.body.data.final, false, 'asks the question, transaction stays open');
    assert.equal(launch.body.data.skill.session.nodeID, 0);
    assert.deepEqual(launch.body.data.skill.session.trace, [{ nodeID: 0, transition: null }]);
    assert.deepEqual(Object.keys(launch.body.timings), ['total']);
    const s0 = roundTrip(launch.body.data.skill.session);

    // A retry of the *same* pre-state request must replay identically.
    const retry = await post('/v1/main', colorUpdate(roundTrip(s0), 'blue'));
    const answered = await post('/v1/main', colorUpdate(roundTrip(s0), 'blue'));
    assert.equal(answered.status, 200);
    assert.equal(answered.body.data.final, true, 'replies and ends the transaction');
    // A retry of the same pre-state replays the same session and the same
    // spoken text; the rendered JCP carries freshly generated ids each turn.
    assert.equal(retry.body.data.final, answered.body.data.final);
    assert.deepEqual(
      roundTrip(answered.body.data.skill.session),
      roundTrip(retry.body.data.skill.session),
      'a retry of the same pre-state replays identically',
    );
    assert.equal(
      answered.body.data.action.config.jcp.children[0].config.play.esml,
      retry.body.data.action.config.jcp.children[0].config.play.esml,
    );
    const s1 = roundTrip(answered.body.data.skill.session);
    assert.equal(s1.nodeID, 1, 'parked on the terminal ReplyColor node');
    assert.equal(s1.data.color, 'blue', 'the answered color round-trips in session.data');
    assert.deepEqual(s1.trace, [{ nodeID: 0, transition: 'answered' }, { nodeID: 1, transition: null }]);

    const after = await post('/v1/main', colorUpdate(roundTrip(s1), 'green'));
    assert.equal(after.body.data.final, true);
    assert.equal(after.body.data.fireAndForget, true);
    assert.equal(after.body.data.action, null, 'a post-terminal update takes no action');
    assert.deepEqual(after.body.data.skill.session.trace, s1.trace);
  });
});

test('S-01 live entrypoint rejects corrupted, cross-skill and replayed-launch sessions', async () => {
  await withServer(async (post) => {
    await post('/v1/main', colorLaunch());
    const skill = { id: 'color-skill' };
    const cases = [
      [{ id: 'corrupt', nodeID: 4242, data: {}, trace: [] }, "Node id '4242' isn't a part of this graph"],
      [{ id: 'consumed', nodeID: 0, data: {}, trace: [{ nodeID: 0, transition: 'answered' }] }, "Trace transition shouldn't exist"],
      [{ id: 'mismatch', nodeID: 0, data: {}, trace: [{ nodeID: 77, transition: null }] }, 'Unexpected trace node ID'],
      [undefined, 'Skill session is required'],
    ];
    for (const [session, message] of cases) {
      const body = updateBody('color-skill', session, { asr: { text: 'blue' }, nlu: { intent: null, entities: {} } });
      if (session === undefined) delete body.data.skill.session;
      const response = await post('/v1/main', body);
      assert.equal(response.status, 200, 'the source error envelope is an ordinary 200 skill response');
      assert.equal(response.body.type, 'ERROR');
      assert.equal(response.body.data.message, message);
      assert.deepEqual(response.body.data.skill, skill);
    }

    const rel = await post('/v1/main', launchBody('color-skill', {
      skill: { id: 'color-skill', session: { id: 'stale', nodeID: 0, data: {}, trace: [] } },
    }));
    assert.equal(rel.body.data.message, 'Skill session should not exist here');
  });
});

test('S-01 a session minted by one cohosted skill is refused by another', async () => {
  const otherManager = new GraphManager();
  const other = createGraphSkill({
    name: 'other-skill',
    graphManager: otherManager,
    build: (gm) => gm.addNode(new FnNode('OtherOnly', {
      enter: async () => ({ action: { type: 'JCP', config: { jcp: { id: 'z' } } }, final: false }),
    })),
  });
  const server = await createSkillsService({
    name: 's01-cross-skill',
    skills: [{ id: 'color-skill', handler: colorSkill }, { id: 'other-skill', handler: other }],
    defaultId: 'color-skill',
  }).listen(0);
  const port = server.address().port;
  const post = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    const launch = await post('/v1/color-skill/main', colorLaunch());
    const s0 = roundTrip(launch.body.data.skill.session);
    const answered = await post('/v1/color-skill/main', colorUpdate(roundTrip(s0), 'blue'));
    const colorSession = roundTrip(answered.body.data.skill.session);
    assert.equal(colorSession.nodeID, 1);

    const misplaced = await post('/v1/other-skill/main', updateBody('other-skill', colorSession, {}));
    assert.equal(misplaced.status, 200);
    assert.equal(misplaced.body.type, 'ERROR');
    assert.equal(misplaced.body.data.message, "Node id '1' isn't a part of this graph");
  } finally {
    await new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});

/* ================= in-flight session cutover policy ====================== */

const REPORT_RUNTIME = {
  loop: { loopId: 'fixture-loop', users: [{ id: 'fixture-speaker', accountId: 'fixture-account', birthdate: '1990-01-01' }] },
  location: { lat: 42.36, lng: -71.06, iso: '2018-05-30T12:00:00+00:00' },
  perception: { speaker: 'fixture-speaker' },
  character: { emotion: { name: 'NEUTRAL', valence: 0, confidence: 0 } },
  dialog: {},
};

const reportLaunch = () => ({
  type: 'LISTEN_LAUNCH', msgID: 'report-launch', ts: 1,
  data: {
    general: GENERAL, runtime: REPORT_RUNTIME, skill: { id: 'report-skill' },
    result: {
      nlu: { intent: 'launchPersonalReport', entities: {}, rules: ['launch'] },
      asr: { text: 'personal report', confidence: 1 },
      memo: 'Reactive',
    },
  },
});

const reportUpdate = (session) => ({
  type: 'LISTEN_UPDATE', msgID: 'report-update', ts: 2,
  data: {
    general: GENERAL, runtime: REPORT_RUNTIME, skill: { id: 'report-skill', session },
    result: { asr: { text: 'yes' }, nlu: { intent: 'yes', rules: [], entities: {} } },
  },
});

async function posterFor(server) {
  const port = server.address().port;
  return async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
}

test('S-01 an in-flight session survives an identical-shape restart but is never validated across a shape change', async () => {
  const oldPrefs = process.env.ETCO_report_prefsFromConfig;
  process.env.ETCO_report_prefsFromConfig = 'true';
  const servers = [];
  try {
    // Shape A: the standalone per-skill process the compose/native launchers use.
    const standaloneA = await start(0, { skillId: 'report-skill' });
    servers.push(standaloneA);
    const postA = await posterFor(standaloneA);
    const launched = await postA('/v1/main', reportLaunch());
    assert.equal(launched.status, 200);
    const standaloneSession = roundTrip(launched.body.data.skill.session);
    assert.equal(typeof standaloneSession.nodeID, 'number');

    // Shape B: an identical standalone process (a same-shape restart).
    const standaloneB = await start(0, { skillId: 'report-skill' });
    servers.push(standaloneB);
    const postB = await posterFor(standaloneB);
    const resumed = await postB('/v1/main', reportUpdate(roundTrip(standaloneSession)));
    assert.notEqual(resumed.body.type, 'ERROR', 'a same-shape restart resumes the captured session');
    assert.equal(resumed.body.type, 'SKILL_ACTION');
    assert.equal(resumed.body.data.skill.session.id, standaloneSession.id, 'the opaque session id is preserved');
    assert.deepEqual(
      resumed.body.data.skill.session.data,
      standaloneSession.data,
      'the session data payload survives the restart unchanged',
    );

    // Shape C: the combined host, where the same skill is cohosted behind other skills.
    const combined = await createSkillsService({ name: 's01-combined', skills: SKILLS, defaultId: 'answer-skill' }).listen(0);
    servers.push(combined);
    const postC = await posterFor(combined);
    const combinedLaunch = await postC('/v1/report-skill/main', reportLaunch());
    const combinedSession = roundTrip(combinedLaunch.body.data.skill.session);
    assert.notEqual(
      combinedSession.nodeID,
      standaloneSession.nodeID,
      'the combined host allocates the same skill at a different node id',
    );

    // The session blob is opaque and carries only numeric node ids, so the
    // cloud cannot tell which allocation shape minted it: offering the
    // standalone-minted session to the combined host is NOT refused.
    const crossShape = await postC('/v1/report-skill/main', reportUpdate(roundTrip(standaloneSession)));
    assert.equal(crossShape.status, 200);
    assert.notEqual(
      crossShape.body.type,
      'ERROR',
      'a cross-shape session is silently reinterpreted in the target node-id space, '
        + 'so migration/reset must be enforced by the deployment, not by the skill',
    );
    assert.equal(crossShape.body.data.skill.session.nodeID, combinedSession.nodeID);
  } finally {
    if (oldPrefs === undefined) delete process.env.ETCO_report_prefsFromConfig;
    else process.env.ETCO_report_prefsFromConfig = oldPrefs;
    for (const server of servers) {
      await new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  }
});
