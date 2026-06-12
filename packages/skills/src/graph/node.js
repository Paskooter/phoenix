// Node — base of the GraphSkill FSM (port of baseskill/graph/nodes/Node.ts).
// A node has a stable id (assigned by GraphManager), named transitions to other nodes, and
// enter()/exit() hooks. enter() returns {action?, redirect?, final?}; exit() returns
// {transition?, redirect?, result?}. Transitions hold TransitionContainer-shaped entries
// ({transition, destination, exitTransition}) so Graph.finalize can collect graph exits.

export class Node {
  constructor(name, transitionNames = []) {
    this.id = null;
    this.name = name;
    this.transitionNames = transitionNames;
    this.graphs = [];
    this.transitions = new Map(); // transition -> TransitionContainer

    const transitionSet = new Set(transitionNames);
    if (transitionSet.size !== transitionNames.length) {
      throw new Error(`Node '${name}' has duplicate transition names`);
    }
  }

  /** Wire a transition to a destination node (null = terminal transition). */
  addTransition(name, destination = null) {
    this.transitions.set(name, { transition: name, destination, exitTransition: null });
    return this;
  }

  /** @param {object} data session data — override. */
  async enter() { return {}; }
  async exit() { return {}; }

  /**
   * BFS over all descendents; handler returning true terminates early (and returns true).
   */
  forEachDescendent(handler) {
    if (this.id === null) throw new Error(`Can't traverse descendents until we've been added to graph`);

    const visited = new Set();
    const toVisit = [];
    for (const tc of this.transitions.values()) if (tc.destination) toVisit.push(tc.destination);

    while (toVisit.length > 0) {
      const next = toVisit.shift();
      visited.add(next);
      const ret = handler(next);
      if (ret) return true;
      for (const tc of next.transitions.values()) {
        if (tc.destination && !visited.has(tc.destination)) toVisit.push(tc.destination);
      }
    }
    return false;
  }
}

/** Convenience node built from enter/exit functions. */
export class FnNode extends Node {
  constructor(name, { transitions = [], enter, exit } = {}) {
    super(name, transitions);
    if (enter) this._enter = enter;
    if (exit) this._exit = exit;
  }
  async enter(data) { return this._enter ? this._enter(data) : {}; }
  async exit(data) { return this._exit ? this._exit(data) : {}; }
}
