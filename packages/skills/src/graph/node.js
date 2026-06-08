// Node — base of the GraphSkill FSM (port of baseskill/graph/nodes/Node.ts).
// A node has a stable id (assigned by GraphManager), named transitions to other nodes, and
// enter()/exit() hooks. enter() returns {action?, redirect?, final?}; exit() returns
// {transition?, redirect?, result?}.

export class Node {
  constructor(name, transitionNames = []) {
    this.id = null;
    this.name = name;
    this.transitionNames = transitionNames;
    this.transitions = new Map(); // transition -> { destination: Node|null }
  }

  /** Wire a transition to a destination node (null = terminal transition). */
  addTransition(name, destination = null) {
    this.transitions.set(name, { destination });
    return this;
  }

  /** @param {object} data session data — override. */
  async enter() { return {}; }
  async exit() { return {}; }
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
