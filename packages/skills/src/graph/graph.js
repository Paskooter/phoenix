// Graph — port of baseskill/graph/Graph.ts + Types.ts (TransitionContainer).
// writeDotFile is a faithful port of Graph.ts:234-325 (GraphViz dump used by
// the original's skill-graph tooling); it is not on the robot wire path.
// A Graph owns a set of Nodes wired by name: addNode(node, [[transition, dest|exitName]]) maps
// every declared transition either to another Node or to one of the graph's named exit
// transitions; addSubGraph splices a finalized child graph in by connecting ITS exit transitions
// to parent nodes. finalize() validates: every dangling transition has an exit, every node is
// reachable, every exit transition is connected. The owning GraphManager is
// passed in so a host can select source-compatible shared allocation or an
// isolated deployment scope.

import fs from 'node:fs';

export class TransitionContainer {
  constructor(transition, destination = null, exitTransition = null) {
    this.transition = transition;
    this.destination = destination;
    this.exitTransition = exitTransition;
  }
}

import { Node } from './node.js';

export class Graph {
  /**
   * @param {import('./graphManager.js').GraphManager} gm node-ID registry for the owning skill
   * @param {string} name
   * @param {string[]} exitTransitionNames
   */
  constructor(gm, name, exitTransitionNames) {
    this.gm = gm;
    this.name = name;
    this.exitTransitions = new Map();
    // Graph.ts declares `public initial: Node` with no initializer, so the
    // field reads as `undefined` (not `null`) until the first node is added.
    this.initial = undefined;
    this.nodes = new Set();
    this.finalized = false;

    for (const n of exitTransitionNames) this.exitTransitions.set(n, []);
    if (this.exitTransitions.size !== exitTransitionNames.length) {
      throw new Error(`Graph '${name}' has duplicate exit transition names`);
    }
    if (!exitTransitionNames.length) {
      throw new Error(`Graph '${name}' needs to have at least one exit transition`);
    }
  }

  setInitialNode(node) {
    if (!this.nodes.has(node)) throw new Error(`Node '${node.name}' isn't a part of this graph`);
    this.initial = node;
  }

  /** Add a Node and wire ALL of its transitions to Nodes or exit-transition names. */
  addNode(node, transitionMapping) {
    if (this.finalized) throw new Error(`Can't add Node '${node.name}' to graph '${this.name}' after it's been finalized`);
    if (this.nodes.has(node)) throw new Error('Node already added to graph');

    this.gm.addNode(node);
    node.graphs.push(this);
    this.nodes.add(node);
    if (!this.initial) this.initial = node;

    const transMapSet = new Set(transitionMapping.map((t) => t[0]));
    if (transMapSet.size !== transitionMapping.length) {
      throw new Error(`Non-unique transitions found in transition mapping for node '${node.name}': ${Array.from(transMapSet)}`);
    }
    if (transMapSet.size !== node.transitionNames.length) {
      throw new Error(`Non-matching length of transition mapping for node '${node.name}'`);
    }
    for (const name of node.transitionNames) {
      if (!transMapSet.has(name)) throw new Error(`Missing transition '${name}' in transition mapping for node '${node.name}'`);
    }

    for (const [transition, dest] of transitionMapping) {
      if (typeof dest === 'string') node.transitions.set(transition, new TransitionContainer(transition, null, dest));
      else if (dest instanceof Node) node.transitions.set(transition, new TransitionContainer(transition, dest, null));
      else throw new Error(`Must provide a valid destination for node '${this.name}' and transition '${transition}'`);
    }
  }

  /** Splice in a finalized child graph, connecting its exit transitions to parent Nodes. */
  addSubGraph(subGraph, transitionMapping) {
    if (this.finalized) throw new Error(`Can't add subgraph '${subGraph.name}' to graph '${this.name}' after it's been finalized`);
    if (!subGraph.isFinalized()) throw new Error(`Can't add subgraph non-finalized '${subGraph.name}' to graph '${this.name}'`);

    for (const node of subGraph.nodes) {
      if (!this.gm.hasNode(node)) throw new Error(`Subgraph node '${node.name}' from graph '${subGraph.name}' not registered with same graph manager`);
      if (this.nodes.has(node)) throw new Error(`Subgraph node '${node.name}' from graph '${subGraph.name}' is already in this graph`);
      this.nodes.add(node);
      node.graphs.push(this);
    }

    const transMapSet = new Set(transitionMapping.map((t) => t[0]));
    if (transMapSet.size !== transitionMapping.length) {
      throw new Error(`Non-unique transitions found in transition mapping for subgraph '${subGraph.name}': ${Array.from(transMapSet)}`);
    }
    if (transMapSet.size !== subGraph.exitTransitions.size) {
      throw new Error(`Non-matching length of transition mapping for subgraph '${subGraph.name}'`);
    }
    for (const name of subGraph.exitTransitions.keys()) {
      if (!transMapSet.has(name)) throw new Error(`Missing transition '${name}' in transition mapping for subgraph '${subGraph.name}'`);
    }

    for (const [transition, nextNode] of transitionMapping) {
      for (const container of subGraph.exitTransitions.get(transition)) {
        if (container.destination) {
          throw new Error(`Can't override already assigned transition, subgraph: '${subGraph.name}' exit transition: '${transition}' dest state: '${container.destination.name}'`);
        }
        container.destination = nextNode;
      }
    }

    if (!this.initial) this.initial = subGraph.initial;
    return subGraph;
  }

  isFinalized() { return this.finalized; }

  /** Validate connectivity and collect dangling transitions into the graph's exits. */
  finalize() {
    if (this.finalized) return;

    for (const node of this.nodes) {
      for (const transCont of node.transitions.values()) {
        if (!transCont.destination) {
          if (!transCont.exitTransition) throw new Error(`Has to have either a destination node or exit transition: '${transCont.transition}'`);
          const containers = this.exitTransitions.get(transCont.exitTransition);
          if (!containers) throw new Error(`Graph '${this.name}' doesn't have exit transition '${transCont.exitTransition}'`);
          containers.push(transCont);
        } else if (!this.nodes.has(transCont.destination)) {
          // Graph.ts:200-201 interpolates the Node value itself, which stringifies
          // as '[object Object]' — reproduce the source text verbatim.
          throw new Error(`Graph '${this.name}': Node '${node.name}' has `
            + `transition to Node '${transCont.destination}' which isn't in graph`);
        }
      }
    }

    const reachable = new Set([this.initial]);
    this.initial.forEachDescendent((d) => { reachable.add(d); });
    for (const node of this.nodes) {
      if (!reachable.has(node)) throw new Error(`Graph '${this.name}': Node '${node.name}' is not reachable from any other state.`);
    }

    for (const [name, containers] of this.exitTransitions) {
      if (!containers.length) throw new Error(`Graph '${this.name}' has not connected exit transition '${name}'`);
    }

    this.finalized = true;
  }

  /**
   * Writes GraphViz dot file to disk at filepath (Graph.ts:234-325).
   * @param {string} filePath
   * @returns {boolean|undefined} `true` if writing was successful
   */
  writeDotFile(filePath) {
    if (!this.finalized) {
      throw new Error(`Can't render dot file of a non-finalized graph '${this.name}'`);
    }

    const initBgColor = '#4dc3ff';
    const regBgColor = '#99ddff';
    const outBgColor = '#0088cc';
    const graphBgColors = ['#f2f2f2', '#d9d9d9', '#bfbfbf', '#a6a6a6'];
    const getGraphColor = (ind) => graphBgColors[Math.min(ind, graphBgColors.length - 1)];
    const cleanName = (name) => String(name).replace(/"/ig, '\\"');

    const lines = ['digraph graphname {'];

    // Add an OUT state
    const DONE_NAME = 'Done';
    lines.push(`"${DONE_NAME}" [style=filled,fillcolor="${outBgColor}",color="black"];`);

    // Discover the graph hierarchical structure
    class GraphContainer {
      constructor(graph, level) { this.children = new Set(); this.graph = graph; this.level = level; }
    }
    const graphs = new Map();
    const getOrCreate = (graph, level) => {
      let cont = graphs.get(graph);
      if (!cont) {
        cont = new GraphContainer(graph, level);
        graphs.set(graph, cont);
      }
      return cont;
    };

    // Build the graph tree
    let topGraph = null;
    this.nodes.forEach((node) => {
      for (let i = 0; i < node.graphs.length; i++) {
        const current = node.graphs[node.graphs.length - 1 - i];
        const currentContainer = getOrCreate(current, i);
        if (i === 0 && !topGraph) topGraph = currentContainer;
        const next = node.graphs[node.graphs.length - 2 - i];
        if (next) {
          const nextContainer = getOrCreate(next, i + 1);
          currentContainer.children.add(nextContainer);
        }
      }
    });

    let clusterCount = 0;
    const createSubGraph = (graphContainer) => {
      lines.push(`subgraph cluster_${clusterCount++} {`);
      lines.push(' style = filled');
      lines.push(` fillcolor = "${getGraphColor(graphContainer.level)}"`);
      lines.push(' color = "black"');
      lines.push(` label = "${graphContainer.graph.name}"`);
      // Draw all nodes for graph
      graphContainer.graph.nodes.forEach((node) => {
        const name = cleanName(node.name);
        const bgColor = (node === this.initial) ? initBgColor : regBgColor;
        lines.push(`  "${name}" [style=filled,fillcolor="${bgColor}",color="black"];`);
      });
      // Recurse into child graphs
      graphContainer.children.forEach((child) => createSubGraph(child));
      lines.push('}');
    };

    // Start recursive graph rendering
    createSubGraph(topGraph);

    // All transitions
    this.nodes.forEach((node) => {
      node.transitions.forEach((transContainer) => {
        const sourceNodeName = cleanName(node.name);
        const targetName = cleanName(this.nodes.has(transContainer.destination) ? transContainer.destination.name : DONE_NAME);
        const transitionName = cleanName(transContainer.transition);
        lines.push(`"${sourceNodeName}" -> "${targetName}" [label="${transitionName}"]`);
      });
    });

    lines.push('}');
    const str = lines.join('\n');
    if (filePath) {
      try {
        fs.writeFileSync(filePath, str, { encoding: 'utf8' });
        return true;
      } catch (error) {
        console.error(error);
        return false;
      }
    }
    return undefined;
  }
}
