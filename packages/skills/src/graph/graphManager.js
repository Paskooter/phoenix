// GraphManager — port of baseskill/graph/GraphManager.ts, but PER GraphSkill INSTANCE rather
// than a process singleton (the reference runs one skill per process; Phoenix hosts many in one
// process, so each skill owns its own node-ID space). Node IDs are global+sequential within a
// skill and are the wire format of session.nodeID.

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

  /** Start a fresh session at the initial node and enter it. */
  async start(initial, data) {
    if (data.skill.session) throw new Error('Skill session should not exist here');
    data.skill.session = { id: newMsgId(), nodeID: initial.id, data: {}, trace: [] };
    return this.enterNode(data);
  }

  async enterNode(data) {
    const node = this.getNode(data.skill.session.nodeID);
    if (!node) throw new Error(`Node id '${data.skill.session.nodeID}' isn't part of this graph`);
    const r = await node.enter(data);
    data.skill.session.trace.push({ nodeID: node.id, transition: null });
    if (r && (r.action || r.redirect)) return r; // emit to robot (final may be false → multi-turn)
    return this.exitNode(data); // no action → fall through to exit
  }

  async exitNode(data) {
    const node = this.getNode(data.skill.session.nodeID);
    if (!node) throw new Error(`Node id '${data.skill.session.nodeID}' isn't part of this graph`);
    const r = await node.exit(data);
    if (r && r.transition) return this._executeTransition(node, r, data);
    return r;
  }

  async _executeTransition(node, result, data) {
    data.result = result.result || null;
    if (!node.transitions.has(result.transition)) throw new Error(`Node '${node.name}' returned unregistered transition '${result.transition}'`);
    const trace = data.skill.session.trace;
    if (trace.length) trace[trace.length - 1].transition = result.transition;
    const next = node.transitions.get(result.transition);
    if (!next.destination) return null; // terminal transition
    data.skill.session.nodeID = next.destination.id;
    return this.enterNode(data);
  }
}
