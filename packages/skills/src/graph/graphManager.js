// GraphManager — port of baseskill/graph/GraphManager.ts. A manager owns the
// node-ID space used by a graph host; source-compatible co-hosted skills share
// one manager, while independently deployed/custom skills may create a local
// manager. Node IDs are sequential within that host and are the wire format of
// session.nodeID.

import { newMsgId } from '@phoenix/contracts';

export class GraphManager {
  constructor() {
    this.nodeIDCounter = 0;
    this.idToNode = new Map();
    this.nodeToID = new Map();
  }

  /** Register a node, assigning the next sequential id. */
  addNode(node) {
    if (this.nodeToID.has(node)) throw new Error(`Node '${node.name}' has already been added`);
    if (node.id !== null) throw new Error(`Node '${node.name}' is already in a graph`);
    node.id = this.nodeIDCounter++;
    this.nodeToID.set(node, node.id);
    this.idToNode.set(node.id, node);
    return node;
  }

  getNode(id) { return this.idToNode.get(id); }
  hasNode(node) { return this.nodeToID.has(node); }

  /** Start a fresh session at the initial node (of a Node or a Graph) and enter it. */
  async start(initial, data) {
    if (data.skill.session) throw new Error('Skill session should not exist here');
    const node = (initial && initial.initial) ? initial.initial : initial; // Graph or Node
    data.skill.session = { id: newMsgId(), nodeID: node.id, data: {}, trace: [] };
    return this.enterNode(data);
  }

  async enterNode(data) {
    if (!data.skill.session) throw new Error('Skill session is required');
    const node = this.getNode(data.skill.session.nodeID);
    if (!node) throw new Error(`Node id '${data.skill.session.nodeID}' isn't a part of this graph`);
    const r = await node.enter(data);
    data.skill.session.trace.push({ nodeID: node.id, transition: null });
    if (r && (r.action || r.redirect)) return r; // emit to robot (final may be false → multi-turn)
    return this.exitNode(data); // no action → fall through to exit
  }

  async exitNode(data) {
    if (!data.skill.session) throw new Error('Skill session is required');
    const node = this.getNode(data.skill.session.nodeID);
    if (!node) throw new Error(`Node id '${data.skill.session.nodeID}' isn't a part of this graph`);
    const r = await node.exit(data);
    if (r && r.transition) return this._executeTransition(node, r, data);
    return r;
  }

  async _executeTransition(node, result, data) {
    data.result = result.result || null;
    if (!node.transitions.has(result.transition)) throw new Error(`State '${node.name}' returned unregistered transition '${result.transition}'`);
    const trace = data.skill.session.trace;
    if (!trace.length) throw new Error('Trace should exist');
    const traceElement = trace[trace.length - 1];
    if (traceElement.transition !== null) throw new Error("Trace transition shouldn't exist");
    if (traceElement.nodeID !== node.id) throw new Error('Unexpected trace node ID');
    traceElement.transition = result.transition;
    const next = node.transitions.get(result.transition);
    if (!next.destination) return null; // terminal transition
    data.skill.session.nodeID = next.destination.id;
    return this.enterNode(data);
  }
}

// The original Pegasus host keeps one GraphManager for every co-hosted cloud
// skill process. Built-in skills that share a Phoenix process opt into this
// instance explicitly; createGraphSkill callers keep the isolated manager
// default so direct skill tests and separately deployed skills do not inherit
// another process's graph IDs.
export const sharedGraphManager = new GraphManager();
