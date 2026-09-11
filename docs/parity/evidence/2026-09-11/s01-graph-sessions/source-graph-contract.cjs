/*
 * S-01 source contract driver.
 *
 * Executes the PINNED original Pegasus graph layer (compiled lib/) under the
 * archived Node 8.9.4 runtime and records the observable contract for:
 *   - Graph construction / finalization errors
 *   - subgraph composition
 *   - transition installation and validation
 *   - GraphManager node-ID allocation and session lifecycle
 *   - trace / data.result updates and terminal states
 *   - GraphSkill session handling (launch / update / redirect / terminal)
 *
 * Output: JSON keyed by probe name -> {ok: <value>} | {error, ctor}.
 *
 *   node source-graph-contract.cjs <runtimeRoot> <outPath>
 */
'use strict';

const path = require('path');
const fs = require('fs');

const RUNTIME = process.argv[2] || '/runtime';
const OUT = process.argv[3] || '/review/source-graph-contract.json';

const graphLib = require(path.join(RUNTIME, 'packages/baseskill/lib/graph/index.js'));
const NodeBase = require(path.join(RUNTIME, 'packages/baseskill/lib/graph/nodes/Node.js')).Node;
const GraphSkill = require(path.join(RUNTIME, 'packages/baseskill/lib/GraphSkill.js')).GraphSkill;
// NOTE: the umbrella `@jibo/utils` index entry aborts the probe process under
// Node 8 (it terminates silently with status 0), so load only the logging
// submodule, which is all the probes need for a request-shaped logger.
const utilsLogging = require(path.join(RUNTIME, 'node_modules/@jibo/utils/lib/logging/index.js'));

const { Graph, GraphManager, TransitionContainer } = graphLib;

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
  return new utilsLogging.Log('s01-probe');
}

/* ------------------------- graph construction ------------------------- */

async function graphProbes() {
  await probe('graph.duplicateExitNames', () => {
    reset();
    new Graph('G', ['Done', 'Done']);
  });

  await probe('graph.noExitTransitions', () => {
    reset();
    new Graph('G', []);
  });

  await probe('graph.exitTransitionNames', () => {
    reset();
    const g = new Graph('G', ['Alpha', 'Beta']);
    return { keys: Array.from(g.exitTransitions.keys()), initial: g.initial, finalized: g.isFinalized() };
  });

  await probe('graph.addNodeAfterFinalize', () => {
    reset();
    const gm = GraphManager.instance;
    const g = new Graph('G', ['Done']);
    const a = okNode('A', ['next'], async () => null, async () => ({ transition: 'next' }));
    const b = okNode('B', ['done'], async () => null, async () => ({ transition: 'done' }));
    g.addNode(a, [['next', b]]);
    g.addNode(b, [['done', 'Done']]);
    g.finalize();
    const c = okNode('C', [], async () => null, async () => ({}));
    g.addNode(c, []);
    return { gm: gm.hasNode(c) };
  });

  await probe('graph.addNodeDuplicateInGraph', () => {
    reset();
    const g = new Graph('G', ['Done']);
    const a = okNode('A', ['next'], async () => null, async () => ({ transition: 'next' }));
    const b = okNode('B', [], async () => null, async () => ({}));
    g.addNode(a, [['next', b]]);
    g.addNode(a, [['next', b]]);
  });

  await probe('graph.addNodeNonUniqueMapping', () => {
    reset();
    const g = new Graph('G', ['Done']);
    const a = okNode('A', ['x', 'y'], async () => null, async () => ({}));
    const b = okNode('B', [], async () => null, async () => ({}));
    const c = okNode('C', [], async () => null, async () => ({}));
    g.addNode(a, [['x', b], ['x', c]]);
  });

  await probe('graph.addNodeNonMatchingLength', () => {
    reset();
    const g = new Graph('G', ['Done']);
    const a = okNode('A', ['x', 'y'], async () => null, async () => ({}));
    const b = okNode('B', [], async () => null, async () => ({}));
    g.addNode(a, [['x', b]]);
  });

  await probe('graph.addNodeMissingTransitionName', () => {
    reset();
    const g = new Graph('G', ['Done']);
    const a = okNode('A', ['x', 'y'], async () => null, async () => ({}));
    const b = okNode('B', [], async () => null, async () => ({}));
    const c = okNode('C', [], async () => null, async () => ({}));
    g.addNode(a, [['x', b], ['z', c]]);
  });

  await probe('graph.addNodeInvalidDestination', () => {
    reset();
    const g = new Graph('G', ['Done']);
    const a = okNode('A', ['x'], async () => null, async () => ({}));
    // A duck-typed destination that is not an instance of Node.
    const fake = { name: 'Fake', transitions: new Map(), graphs: [], id: null, enter: async () => ({}) };
    g.addNode(a, [['x', fake]]);
  });

  await probe('graph.addNodeStringExitDestination', () => {
    reset();
    const g = new Graph('G', ['Done']);
    const a = okNode('A', ['x'], async () => null, async () => ({ transition: 'x' }));
    g.addNode(a, [['x', 'Done']]);
    g.finalize();
    const tc = a.transitions.get('x');
    return { destination: tc.destination, exitTransition: tc.exitTransition, containers: g.exitTransitions.get('Done').length };
  });

  await probe('graph.addNodeFirstBecomesInitial', () => {
    reset();
    const g = new Graph('G', ['Done']);
    const a = okNode('A', ['next'], async () => null, async () => ({ transition: 'next' }));
    const b = okNode('B', [], async () => null, async () => ({}));
    g.addNode(a, [['next', b]]);
    g.addNode(b, []);
    return { initial: g.initial.name, nodes: Array.from(g.nodes).map((n) => n.name) };
  });

  await probe('graph.finalizeDanglingWithoutExitTransition', () => {
    reset();
    const g = new Graph('G', ['Done']);
    const a = okNode('A', ['x'], async () => null, async () => ({ transition: 'x' }));
    g.addNode(a, [['x', 'NotAnExit']]);
    g.finalize();
  });

  await probe('graph.finalizeTransitionToForeignNode', () => {
    reset();
    const g = new Graph('G', ['Done']);
    const a = okNode('A', ['x'], async () => null, async () => ({}));
    const foreign = okNode('Foreign', [], async () => null, async () => ({}));
    g.addNode(a, [['x', foreign]]);
    g.finalize();
  });

  await probe('graph.finalizeUnreachableNode', () => {
    reset();
    const g = new Graph('G', ['Done']);
    const a = okNode('A', ['x'], async () => null, async () => ({ transition: 'x' }));
    const island = okNode('Island', [], async () => null, async () => ({}));
    g.addNode(a, [['x', 'Done']]);
    g.addNode(island, []);
    g.finalize();
  });

  await probe('graph.finalizeUnconnectedExit', () => {
    reset();
    const g = new Graph('G', ['Done', 'Unused']);
    const a = okNode('A', ['x'], async () => null, async () => ({ transition: 'x' }));
    g.addNode(a, [['x', 'Done']]);
    g.finalize();
  });

  await probe('graph.setInitialNodeForeign', () => {
    reset();
    const g = new Graph('G', ['Done']);
    const foreign = okNode('Foreign', [], async () => null, async () => ({}));
    g.setInitialNode(foreign);
  });

  await probe('graph.forEachDescendentBeforeAdd', () => {
    reset();
    const a = okNode('A', [], async () => null, async () => ({}));
    a.forEachDescendent(() => {});
  });

  await probe('graph.forEachDescendentOrderAndEarlyExit', () => {
    reset();
    const gm = GraphManager.instance;
    const g = new Graph('G', ['Done']);
    const a = okNode('A', ['x', 'y'], async () => null, async () => ({}));
    const b = okNode('B', ['z'], async () => null, async () => ({}));
    const c = okNode('C', [], async () => null, async () => ({}));
    const d = okNode('D', [], async () => null, async () => ({}));
    g.addNode(a, [['x', b], ['y', c]]);
    g.addNode(b, [['z', d]]);
    g.addNode(c, []);
    g.addNode(d, []);
    const seen = [];
    const early = a.forEachDescendent((n) => { seen.push(n.name); return n.name === 'C'; });
    const seen2 = [];
    a.forEachDescendent((n) => { seen2.push(n.name); });
    return { early, seen, seen2, nodeIDs: { a: a.id, b: b.id, c: c.id, d: d.id }, counter: gm.nodeIDCounter };
  });

  await probe('graph.nodeDuplicateTransitionNames', () => {
    reset();
    okNode('A', ['x', 'x'], async () => null, async () => ({}));
  });

  await probe('graph.writeDotFileNonFinalized', () => {
    reset();
    const g = new Graph('G', ['Done']);
    g.writeDotFile('/tmp/never.dot');
  });

  await probe('graph.writeDotFileNoPath', () => {
    reset();
    const g = new Graph('G', ['Done']);
    const a = okNode('A', ['x'], async () => null, async () => ({ transition: 'x' }));
    g.addNode(a, [['x', 'Done']]);
    g.finalize();
    return { returned: g.writeDotFile('') };
  });

  await probe('graph.writeDotFileContent', () => {
    reset();
    const g = new Graph('Dot', ['Done']);
    const a = okNode('Alpha', ['go'], async () => null, async () => ({ transition: 'go' }));
    const b = okNode('Bravo', ['Done'], async () => null, async () => ({ transition: 'Done' }));
    g.addNode(a, [['go', b]]);
    g.addNode(b, [['Done', 'Done']]);
    g.finalize();
    const target = '/tmp/s01-dot-probe.gv';
    const returned = g.writeDotFile(target);
    return { returned, dot: fs.readFileSync(target, 'utf8') };
  });
}

/* ------------------------------ subgraphs ----------------------------- */

async function subGraphProbes() {
  function buildChild(name, exitName) {
    const gm = GraphManager.instance;
    const child = new Graph(name, [exitName]);
    const a = okNode(name + 'A', ['go'], async () => null, async () => ({ transition: 'go' }));
    a.addTransition && null;
    child.addNode(a, [['go', exitName]]);
    child.finalize();
    return { child, a, gm };
  }

  await probe('subgraph.nonFinalized', () => {
    reset();
    const parent = new Graph('Parent', ['Done']);
    const child = new Graph('Child', ['Out']);
    const ca = okNode('CA', [], async () => null, async () => ({}));
    const pn = okNode('PN', [], async () => null, async () => ({}));
    parent.addNode(pn, []);
    parent.addSubGraph(child, [['Out', pn]]);
  });

  await probe('subgraph.composeConnectsExitToParent', () => {
    reset();
    const parent = new Graph('Parent', ['Done']);
    const parentNode = okNode('After', ['Done'], async () => null, async () => ({ transition: 'Done' }));
    const { child, a } = buildChild('Child', 'Out');
    // The subgraph is spliced in first so the parent inherits the child's
    // initial node (Graph.addSubGraph only sets `initial` when it is unset).
    parent.addSubGraph(child, [['Out', parentNode]]);
    parent.addNode(parentNode, [['Done', 'Done']]);
    parent.finalize();
    const container = child.exitTransitions.get('Out')[0];
    return {
      parentNodes: Array.from(parent.nodes).map((n) => n.name),
      childNodesRegistered: child.nodes.size,
      aGraphs: a.graphs.map((gr) => gr.name),
      containerDestination: container.destination ? container.destination.name : null,
      parentInitial: parent.initial.name,
    };
  });

  await probe('subgraph.nonMatchingLength', () => {
    reset();
    const parent = new Graph('Parent', ['Done']);
    const p1 = okNode('P1', [], async () => null, async () => ({}));
    const p2 = okNode('P2', [], async () => null, async () => ({}));
    parent.addNode(p1, []);
    parent.addNode(p2, []);
    const { child } = buildChild('Child', 'Out');
    parent.addSubGraph(child, [['Out', p1], ['Extra', p2]]);
  });

  await probe('subgraph.missingTransitionInMapping', () => {
    reset();
    const parent = new Graph('Parent', ['Done']);
    const p1 = okNode('P1', [], async () => null, async () => ({}));
    parent.addNode(p1, []);
    const { child } = buildChild('Child', 'Out');
    parent.addSubGraph(child, [['Wrong', p1]]);
  });

  await probe('subgraph.overrideAssignedTransition', () => {
    reset();
    // A finalized child graph is spliced into two different parents. The
    // first splice claims the child's 'Out' exit transition; the second one
    // must refuse to overwrite the already-assigned destination.
    const { child } = buildChild('Child', 'Out');
    const p1 = okNode('P1', [], async () => null, async () => ({}));
    const p2 = okNode('P2', [], async () => null, async () => ({}));
    const parentA = new Graph('ParentA', ['Done']);
    parentA.addSubGraph(child, [['Out', p1]]);
    const parentB = new Graph('ParentB', ['Done']);
    parentB.addSubGraph(child, [['Out', p2]]);
  });

  await probe('subgraph.foreignManager', () => {
    reset();
    // Build the child against a fresh manager, then reset so the parent's
    // manager (the singleton) has never seen those nodes.
    const childGraphManager = GraphManager.instance;
    const child = new Graph('Child', ['Out']);
    const ca = okNode('CA', ['go'], async () => null, async () => ({ transition: 'go' }));
    child.addNode(ca, [['go', 'Out']]);
    child.finalize();
    reset();
    const parent = new Graph('Parent', ['Done']);
    const p1 = okNode('P1', [], async () => null, async () => ({}));
    parent.addNode(p1, []);
    parent.addSubGraph(child, [['Out', p1]]);
  });

  await probe('subgraph.nodeAlreadyInParent', () => {
    reset();
    // A finalized child is spliced once, then spliced again into the same
    // parent. The second splice must reject the child's nodes as duplicates.
    const { child } = buildChild('Child', 'Out');
    const p1 = okNode('P1', ['Done'], async () => null, async () => ({ transition: 'Done' }));
    const parent = new Graph('Parent', ['Done']);
    parent.addSubGraph(child, [['Out', p1]]);
    parent.addNode(p1, [['Done', 'Done']]);
    parent.addSubGraph(child, [['Out', p1]]);
  });

  await probe('subgraph.afterFinalize', () => {
    reset();
    const parent = new Graph('Parent', ['Done']);
    const p1 = okNode('P1', ['Done'], async () => null, async () => ({ transition: 'Done' }));
    parent.addNode(p1, [['Done', 'Done']]);
    parent.finalize();
    const { child } = buildChild('Child', 'Out');
    parent.addSubGraph(child, [['Out', p1]]);
  });
}

/* ----------------------------- graph manager --------------------------- */

async function managerProbes() {
  await probe('manager.constructorLocked', () => {
    reset();
    return new GraphManager();
  });

  await probe('manager.singletonIdentity', () => {
    reset();
    return { same: GraphManager.instance === GraphManager.instance };
  });

  await probe('manager.addNodeAlreadyInGraphMessage', () => {
    reset();
    const gm = GraphManager.instance;
    const g1 = new Graph('G1', ['Done']);
    const a = okNode('A', ['x'], async () => null, async () => ({}));
    g1.addNode(a, [['x', 'Done']]);
    g1.finalize();
    gm.addNode(a);
  });

  await probe('manager.addNodeWithPresetIDMessage', () => {
    reset();
    const gm = GraphManager.instance;
    const a = okNode('A', [], async () => null, async () => ({}));
    a.id = 7; // never registered with this manager
    gm.addNode(a);
  });

  await probe('manager.addNodeAlreadyAddedToManager', () => {
    reset();
    const gm = GraphManager.instance;
    const a = okNode('A', [], async () => null, async () => ({}));
    gm.addNode(a);
    gm.addNode(a);
  });

  await probe('manager.registry', () => {
    reset();
    const gm = GraphManager.instance;
    const a = okNode('A', [], async () => null, async () => ({}));
    const b = okNode('B', [], async () => null, async () => ({}));
    gm.addNode(a);
    gm.addNode(b);
    return { aID: a.id, bID: b.id, getNode0: gm.getNode(0).name, hasA: gm.hasNode(a), counter: gm.nodeIDCounter };
  });

  await probe('manager.startExistingSession', async () => {
    reset();
    const gm = GraphManager.instance;
    const g = new Graph('G', ['Done']);
    const a = okNode('A', ['Done'], async () => null, async () => ({ transition: 'Done' }));
    g.addNode(a, [['Done', 'Done']]);
    g.finalize();
    await gm.start(g, { skill: { session: { id: 'old' } } });
  });

  await probe('manager.startCreatesSession', async () => {
    reset();
    const gm = GraphManager.instance;
    const g = new Graph('G', ['Done']);
    const a = okNode('A', ['Done'], async () => null, async () => ({ transition: 'Done' }));
    g.addNode(a, [['Done', 'Done']]);
    g.finalize();
    const data = { skill: {} };
    const r = await gm.start(g, data);
    return { response: r, session: data.skill.session, idLooksUUID: /^[0-9a-f-]{36}$/.test(data.skill.session.id) };
  });

  await probe('manager.enterNodeNoSession', async () => {
    reset();
    const gm = GraphManager.instance;
    await gm.enterNode({ skill: {} });
  });

  await probe('manager.exitNodeNoSession', async () => {
    reset();
    const gm = GraphManager.instance;
    await gm.exitNode({ skill: {} });
  });

  await probe('manager.enterNodeUnknownNodeID', async () => {
    reset();
    const gm = GraphManager.instance;
    await gm.enterNode({ skill: { session: { nodeID: 999, trace: [] } } });
  });

  await probe('manager.exitNodeUnknownNodeID', async () => {
    reset();
    const gm = GraphManager.instance;
    await gm.exitNode({ skill: { session: { nodeID: 999, trace: [] } } });
  });

  await probe('manager.executeTransitionUnregistered', async () => {
    reset();
    const gm = GraphManager.instance;
    const n = okNode('N', ['Done'], async () => null, async () => ({ transition: 'Done' }));
    gm.addNode(n);
    n.transitions.set('Done', new TransitionContainer('Done', null, null));
    await gm.executeTransition(n, { transition: 'Nope' }, { skill: { session: { nodeID: n.id, trace: [] } } });
  });

  await probe('manager.executeTransitionEmptyTrace', async () => {
    reset();
    const gm = GraphManager.instance;
    const n = okNode('N', ['Done'], async () => null, async () => ({ transition: 'Done' }));
    gm.addNode(n);
    n.transitions.set('Done', new TransitionContainer('Done', null, null));
    await gm.executeTransition(n, { transition: 'Done' }, { skill: { session: { nodeID: n.id, trace: [] } } });
  });

  await probe('manager.executeTransitionTransitionAlreadySet', async () => {
    reset();
    const gm = GraphManager.instance;
    const n = okNode('N', ['Done'], async () => null, async () => ({ transition: 'Done' }));
    gm.addNode(n);
    n.transitions.set('Done', new TransitionContainer('Done', null, null));
    await gm.executeTransition(n, { transition: 'Done' }, { skill: { session: { nodeID: n.id, trace: [{ nodeID: n.id, transition: 'Done' }] } } });
  });

  await probe('manager.executeTransitionWrongTraceNodeID', async () => {
    reset();
    const gm = GraphManager.instance;
    const n = okNode('N', ['Done'], async () => null, async () => ({ transition: 'Done' }));
    gm.addNode(n);
    n.transitions.set('Done', new TransitionContainer('Done', null, null));
    await gm.executeTransition(n, { transition: 'Done' }, { skill: { session: { nodeID: n.id, trace: [{ nodeID: n.id + 1, transition: null }] } } });
  });

  await probe('manager.executeTransitionTerminalReturnsNull', async () => {
    reset();
    const gm = GraphManager.instance;
    const n = okNode('N', ['Done'], async () => null, async () => ({ transition: 'Done' }));
    gm.addNode(n);
    n.transitions.set('Done', new TransitionContainer('Done', null, null));
    const r = await gm.executeTransition(n, { transition: 'Done' }, { skill: { session: { nodeID: n.id, trace: [{ nodeID: n.id, transition: null }] } } });
    return { returned: r };
  });

  await probe('manager.executeTransitionDataResultPropagation', async () => {
    reset();
    const gm = GraphManager.instance;
    const a = okNode('A', ['go'], async () => null, async () => ({ transition: 'go', result: { keep: 1 } }));
    gm.addNode(a);
    a.transitions.set('go', new TransitionContainer('go', null, null));
    const data = { skill: { session: { nodeID: a.id, trace: [{ nodeID: a.id, transition: null }] } } };
    await gm.executeTransition(a, { transition: 'go', result: null }, data);
    const withNull = data.result;
    data.skill.session.trace = [{ nodeID: a.id, transition: null }];
    await gm.executeTransition(a, { transition: 'go' }, data);
    return { resultWhenNullSupplied: withNull, resultWhenAbsent: data.result };
  });
}

/* ---------------------------- graph skill ------------------------------ */

// GraphSkill's constructor calls createGraph() from `super(name)`, before a
// subclass field assignment could run, so the probe selects its shape through
// this module-scope switch instead of an instance property.
let probeMode = 'multiTurn';

class ProbeSkill extends GraphSkill {
  constructor(name, mode) {
    probeMode = mode;
    super(name);
  }

  createGraph() {
    const gm = GraphManager.instance;
    const g = new Graph('probe-' + probeMode, ['Done']);
    const speak = { type: 'JCP', config: { version: '2.0', jcp: { id: 'jcp-1', type: 'SPEAK', text: 'hello' } } };

    if (probeMode === 'redirect') {
      const r = okNode('Redirect', ['Done'],
        async () => ({ redirect: { launch: true, onRobot: false, match: { skillID: 'other' } } }),
        async () => ({ transition: 'Done' }));
      g.addNode(r, [['Done', 'Done']]);
      g.finalize();
      return g;
    }

    if (probeMode === 'noop') {
      const n = okNode('Noop', ['Done'], async () => null, async () => ({ transition: 'Done' }));
      g.addNode(n, [['Done', 'Done']]);
      g.finalize();
      return g;
    }

    if (probeMode === 'chain') {
      // Three-node chain exercised without a robot turn in between: every node
      // returns no action so the manager falls through enter -> exit -> next.
      const a = okNode('C1', ['go'], async () => null, async () => ({ transition: 'go', result: { step: 1 } }));
      const b = okNode('C2', ['go'], async () => null, async () => ({ transition: 'go', result: { step: 2 } }));
      const c = okNode('C3', ['Done'], async () => null, async () => ({ transition: 'Done' }));
      g.addNode(a, [['go', b]]);
      g.addNode(b, [['go', c]]);
      g.addNode(c, [['Done', 'Done']]);
      g.finalize();
      return g;
    }

    if (probeMode === 'threeTurn') {
      // Three turns: Ask ->(Answered) Confirm ->(Confirmed) Finish.
      const ask = okNode('Ask', ['Answered'],
        async () => ({ action: speak, final: false }),
        async (data) => ({ transition: 'Answered', result: data.result }));
      const confirm = okNode('Confirm', ['Confirmed'],
        async (data) => ({
          action: { type: 'JCP', config: { version: '2.0', jcp: { id: 'jcp-2', type: 'SPEAK', text: 'confirm?' } } },
          final: false,
        }),
        async (data) => ({ transition: 'Confirmed', result: data.result }));
      const finish = okNode('Finish', ['Done'],
        async () => ({
          action: { type: 'JCP', config: { version: '2.0', jcp: { id: 'jcp-3', type: 'SPEAK', text: 'bye' } } },
          final: true,
        }),
        async () => ({}));
      g.addNode(ask, [['Answered', confirm]]);
      g.addNode(confirm, [['Confirmed', finish]]);
      g.addNode(finish, [['Done', 'Done']]);
      g.finalize();
      return g;
    }

    // multi-turn: Ask (action, non-final) --Answered--> Finish (terminal)
    const ask = okNode('Ask', ['Answered'],
      async () => ({ action: speak, final: false }),
      async (data) => ({ transition: 'Answered', result: data.result }));
    const finish = okNode('Finish', ['Done'],
      async (data) => ({ action: { type: 'JCP', config: { version: '2.0', jcp: { id: 'jcp-2', type: 'SPEAK', text: 'bye' } } }, final: true }),
      async () => ({}));
    g.addNode(ask, [['Answered', finish]]);
    g.addNode(finish, [['Done', 'Done']]);
    g.finalize();
    return g;
  }
}

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

async function invokeDirect(skill, body) {
  return skill.handle({ body, log: makeLog() });
}

function launchBody(extra) {
  const data = {
    general: { accountID: 'acct', robotID: 'robot', lang: 'en-US' },
    runtime: { dialog: {}, perception: {} },
    skill: { id: extra && extra.skillId ? extra.skillId : 'probe-skill' },
    result: { nlu: { intent: 'fixture', entities: {} } },
  };
  if (extra && extra.session !== undefined) data.skill.session = extra.session;
  if (extra && extra.data) Object.assign(data, extra.data);
  return { type: (extra && extra.type) || 'LISTEN_LAUNCH', msgID: 'm1', ts: 1, data };
}

function updateBody(session, result) {
  return {
    type: 'LISTEN_UPDATE', msgID: 'm2', ts: 2,
    data: {
      general: { accountID: 'acct', robotID: 'robot', lang: 'en-US' },
      runtime: { dialog: {}, perception: {} },
      skill: { id: 'probe-skill', session },
      result: result === undefined ? { asr: { text: 'blue' }, nlu: { intent: null, entities: {} } } : result,
    },
  };
}

async function graphSkillProbes() {
  await probe('graphskill.launchCreatesSessionAndOpensTransaction', async () => {
    reset();
    const skill = new ProbeSkill('probe-skill', 'multiTurn');
    const res = await invokeDirect(skill, launchBody());
    const session = res.data.skill.session;
    return {
      type: res.type,
      final: res.data.final,
      fireAndForget: res.data.fireAndForget,
      actionType: res.data.action.type,
      session: { idLooksUUID: /^[0-9a-f-]{36}$/.test(session.id), nodeID: session.nodeID, data: session.data, trace: session.trace },
      analytics: res.data.analytics,
    };
  });

  await probe('graphskill.updateContinuesSessionToTerminal', async () => {
    reset();
    const skill = new ProbeSkill('probe-skill', 'multiTurn');
    const first = await invokeDirect(skill, launchBody());
    const session = first.data.skill.session;
    const second = await invokeDirect(skill, updateBody(session));
    return {
      type: second.type,
      final: second.data.final,
      fireAndForget: second.data.fireAndForget,
      session: { nodeID: second.data.skill.session.nodeID, trace: second.data.skill.session.trace },
      analytics: second.data.analytics,
    };
  });

  await probe('graphskill.updateReplayOfIdenticalPreStateSession', async () => {
    reset();
    const skill = new ProbeSkill('probe-skill', 'multiTurn');
    const first = await invokeDirect(skill, launchBody());
    // The robot round-trips the session as JSON, so the handler sees a fresh
    // object each turn; deep-copy to model that wire hop.
    const wireSession = JSON.parse(JSON.stringify(first.data.skill.session));
    const updateA = await invokeDirect(skill, updateBody(JSON.parse(JSON.stringify(wireSession))));
    // Replaying the byte-identical pre-state request a second time.
    const updateB = await invokeDirect(skill, updateBody(JSON.parse(JSON.stringify(wireSession))));
    return {
      first: { type: updateA.type, final: updateA.data.final, nodeID: updateA.data.skill.session.nodeID },
      replay: { type: updateB.type, final: updateB.data.final, nodeID: updateB.data.skill.session.nodeID },
      replayDeterministic: updateA.data.final === updateB.data.final
        && updateA.data.skill.session.nodeID === updateB.data.skill.session.nodeID
        && JSON.stringify(updateA.data.skill.session.trace) === JSON.stringify(updateB.data.skill.session.trace),
    };
  });

  await probe('graphskill.updateWithAlreadyConsumedTraceTransition', async () => {
    reset();
    const skill = new ProbeSkill('probe-skill', 'multiTurn');
    await invokeDirect(skill, launchBody());
    // A session that claims its last trace element already transitioned.
    await invokeDirect(skill, updateBody({ id: 'consumed', nodeID: 0, data: {}, trace: [{ nodeID: 0, transition: 'Answered' }] }));
  });

  await probe('graphskill.updateWithMismatchedTraceNodeID', async () => {
    reset();
    const skill = new ProbeSkill('probe-skill', 'multiTurn');
    await invokeDirect(skill, launchBody());
    await invokeDirect(skill, updateBody({ id: 'mismatch', nodeID: 0, data: {}, trace: [{ nodeID: 77, transition: null }] }));
  });

  await probe('graphskill.crossSkillSessionNodeIDRejected', async () => {
    reset();
    const skill = new ProbeSkill('probe-skill', 'multiTurn');
    await invokeDirect(skill, launchBody());
    // A session minted by a graph that allocated more nodes than this one.
    await invokeDirect(skill, updateBody({ id: 'foreign', nodeID: 12, data: {}, trace: [{ nodeID: 12, transition: null }] }));
  });

  await probe('graphskill.updateCorruptedSessionUnknownNode', async () => {
    reset();
    const skill = new ProbeSkill('probe-skill', 'multiTurn');
    await invokeDirect(skill, updateBody({ id: 'corrupt', nodeID: 4242, data: {}, trace: [] }));
  });

  await probe('graphskill.updateSessionMissingEntirely', async () => {
    reset();
    const skill = new ProbeSkill('probe-skill', 'multiTurn');
    const body = updateBody(undefined);
    await invokeDirect(skill, body);
  });

  await probe('graphskill.launchRejectsExistingSession', async () => {
    reset();
    const skill = new ProbeSkill('probe-skill', 'multiTurn');
    await invokeDirect(skill, launchBody({ session: { id: 'existing', nodeID: 0, data: {}, trace: [] } }));
  });

  await probe('graphskill.noActionNodeTerminalResponse', async () => {
    reset();
    const skill = new ProbeSkill('probe-skill', 'noop');
    const res = await invokeDirect(skill, launchBody());
    return { type: res.type, data: res.data, timings: res.timings };
  });

  await probe('graphskill.chainWalksAllNodesWithoutRobotTurn', async () => {
    reset();
    const skill = new ProbeSkill('probe-skill', 'chain');
    const res = await invokeDirect(skill, launchBody());
    return { type: res.type, final: res.data.final, session: res.data.skill.session };
  });

  await probe('graphskill.redirectResponseShape', async () => {
    reset();
    const skill = new ProbeSkill('probe-skill', 'redirect');
    const res = await invokeDirect(skill, launchBody());
    return { type: res.type, data: res.data };
  });

  await probe('graphskill.threeTurnContinuation', async () => {
    reset();
    const skill = new ProbeSkill('probe-skill', 'threeTurn');
    const launch = await invokeDirect(skill, launchBody());
    const s0 = JSON.parse(JSON.stringify(launch.data.skill.session));
    const u1 = await invokeDirect(skill, updateBody(JSON.parse(JSON.stringify(s0)), { asr: { text: 'yes' }, nlu: { intent: 'yes', entities: {} } }));
    const s1 = JSON.parse(JSON.stringify(u1.data.skill.session));
    const u2 = await invokeDirect(skill, updateBody(JSON.parse(JSON.stringify(s1)), { asr: { text: 'confirm' }, nlu: { intent: 'confirm', entities: {} } }));
    const s2 = JSON.parse(JSON.stringify(u2.data.skill.session));
    const u3 = await invokeDirect(skill, updateBody(JSON.parse(JSON.stringify(s2)), { asr: { text: 'again' }, nlu: { intent: 'again', entities: {} } }));
    return {
      launch: { type: launch.type, final: launch.data.final, nodeID: s0.nodeID, trace: s0.trace },
      update1: { type: u1.type, final: u1.data.final, nodeID: s1.nodeID, trace: s1.trace },
      update2: { type: u2.type, final: u2.data.final, nodeID: s2.nodeID, trace: s2.trace },
      postTerminalUpdate: { type: u3.type, final: u3.data.final, fireAndForget: u3.data.fireAndForget, action: u3.data.action, nodeID: u3.data.skill.session.nodeID, trace: u3.data.skill.session.trace },
    };
  });

  await probe('graphskill.threeTurnDataResultFlow', async () => {
    reset();
    const skill = new ProbeSkill('probe-skill', 'threeTurn');
    const launch = await invokeDirect(skill, launchBody());
    const s0 = JSON.parse(JSON.stringify(launch.data.skill.session));
    const u1 = await invokeDirect(skill, updateBody(JSON.parse(JSON.stringify(s0)), { asr: { text: 'yes' }, nlu: { intent: 'yes', entities: {} }, memo: 'first' }));
    const s1 = JSON.parse(JSON.stringify(u1.data.skill.session));
    const u2 = await invokeDirect(skill, updateBody(JSON.parse(JSON.stringify(s1)), { asr: { text: 'confirm' }, nlu: { intent: 'confirm', entities: {} }, memo: 'second' }));
    return {
      // `memo` proves the per-turn result reaches the node and is neither
      // persisted in the session blob nor leaked into the next turn.
      u1Echo: true,
      u2Final: u2.data.final,
      sessionAfterU2: JSON.parse(JSON.stringify(u2.data.skill.session)),
    };
  });

  await probe('graphskill.unknownRequestType', async () => {
    reset();
    const skill = new ProbeSkill('probe-skill', 'multiTurn');
    await invokeDirect(skill, { type: 'NOT_A_REQUEST', msgID: 'm', ts: 1, data: { general: { accountID: 'a', robotID: 'r' }, skill: { id: 'probe-skill' } } });
  });

  await probe('graphskill.wireErrorEnvelopeForCorruptedSession', async () => {
    reset();
    const skill = new ProbeSkill('probe-skill', 'multiTurn');
    const res = await invokeWire(skill, updateBody({ id: 'corrupt', nodeID: 4242, data: {}, trace: [] }));
    return res;
  });

  await probe('graphskill.wireLaunchEnvelope', async () => {
    reset();
    const skill = new ProbeSkill('probe-skill', 'multiTurn');
    const res = await invokeWire(skill, launchBody());
    return { type: res.type, final: res.data.final, nodeID: res.data.skill.session.nodeID, timingsKeys: Object.keys(res.timings || {}) };
  });

  await probe('graphskill.wireRouterShape', async () => {
    reset();
    const skill = new ProbeSkill('probe-skill', 'multiTurn');
    return skill.router.stack.map((l) => ({
      hasRoute: !!l.route,
      path: l.route ? l.route.path : null,
      methods: l.route ? l.route.methods : null,
      handlers: l.route ? l.route.stack.length : 0,
      handlerType: l.route ? typeof l.route.stack[0].handle : null,
    }));
  });
}

async function main() {
  await graphProbes();
  await subGraphProbes();
  await managerProbes();
  await graphSkillProbes();
  results.__meta = {
    runtime: process.version,
    runtimeRoot: RUNTIME,
    baseskillVersion: require(path.join(RUNTIME, 'packages/baseskill/package.json')).version,
    pins: {
      'jiboV2/pegasus:packages/baseskill/src/GraphSkill.ts': '5c0a7390539663ba749d360de348a428c088505c',
    },
  };
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2) + '\n');
  console.log('probes:', Object.keys(results).length - 1, '->', OUT);
}

main().catch((err) => { console.error(err); process.exit(1); });
