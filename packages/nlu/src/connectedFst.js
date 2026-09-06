import { existsSync } from 'node:fs';
import { VectorStandardFst, compiledFstConstants, pruneNativeStates, sortNativeResults } from './compiledFst.js';

// This is the small part of connected_fst that is observable while parsing a
// sentence.  A factory arc is an epsilon call into another FST.  The native
// implementation loads that FST once, adds an epsilon return arc to each
// final state, and keeps the graph/state pair as the parser key.  Keeping the
// return arcs on the loaded graph gives the same sharing behavior without
// flattening the graph or changing its arc order.

const {
  EPSILON,
  NON_BLANK,
  CHARACTER_START,
  SPACE,
} = compiledFstConstants;

function validateMaxStatesAfterSpace(value) {
  if (value !== Infinity && (!Number.isInteger(value) || value < 1)) {
    throw new RangeError('maxStatesAfterSpace must be a positive integer or Infinity');
  }
}

function graphStateKey(graph, state) {
  return `${graph}:${state}`;
}

function sortedEntries(map) {
  return [...map.entries()].sort((a, b) => {
    const [ag, as] = a[0].split(':').map(Number);
    const [bg, bs] = b[0].split(':').map(Number);
    return ag - bg || as - bs;
  });
}

function copyNode(node, transition) {
  return {
    heuristic: node.heuristic + transition.weight,
    transitions: node.transitions + 1,
    graph: transition.graph,
    state: transition.state,
    inputSymbols: node.inputSymbols.concat(transition.inputSymbol),
    outputSymbols: node.outputSymbols.concat(transition.outputSymbol),
  };
}

export class ConnectedFstExecutor {
  constructor(topFst, {
    source = topFst.source,
    factoryDir,
    factoryPaths = {},
    factoryFsts,
    maxEpsilonDepth = 10_000,
    maxStatesAfterSpace = 50,
    strictFactories = true,
  } = {}) {
    this.source = source;
    this.factoryDir = factoryDir;
    this.factoryPaths = { ...factoryPaths };
    if (factoryFsts !== undefined && !(factoryFsts instanceof Map)) {
      throw new TypeError('factoryFsts must be a Map keyed by factory basename');
    }
    // When supplied, this is the complete verified factory snapshot for the
    // runtime request. An empty map is meaningful: it disables filesystem
    // fallback and makes missing factories visible through strictFactories.
    this.factoryFsts = factoryFsts === undefined ? undefined : new Map(factoryFsts);
    this.maxEpsilonDepth = maxEpsilonDepth;
    validateMaxStatesAfterSpace(maxStatesAfterSpace);
    this.maxStatesAfterSpace = maxStatesAfterSpace;
    this.strictFactories = strictFactories;
    this.graphs = [{ fst: topFst, returns: [], name: 'top' }];
    // connected_fst keeps a dynamic child per parent call site.  The native
    // cache key is the parent graph/state and factory output symbol, rather
    // than the factory filename alone; sharing by filename would attach a
    // child's return arcs to unrelated rule contexts.
    this.graphByCallsite = new Map();
  }

  static fromFile(path, options = {}) {
    return new ConnectedFstExecutor(VectorStandardFst.fromFile(path), {
      ...options,
      source: path,
    });
  }

  _factoryName(outputSymbol) {
    if (!outputSymbol.startsWith('G:factory:')) return undefined;
    return outputSymbol.slice('G:factory:'.length);
  }

  _factoryPath(name) {
    if (this.factoryPaths[name]) return this.factoryPaths[name];
    if (this.factoryDir) return `${this.factoryDir}/${name}.fst`;
    return undefined;
  }

  _loadFactory(name, parentGraph, parentState) {
    const callsite = `${parentGraph}:${parentState}:${name}`;
    const existing = this.graphByCallsite.get(callsite);
    if (existing !== undefined) return existing;

    let fst;
    if (this.factoryFsts !== undefined) {
      fst = this.factoryFsts.get(name);
      if (!fst) {
        if (this.strictFactories) throw new Error(`Factory FST is unavailable: ${name}`);
        return undefined;
      }
    } else {
      const path = this._factoryPath(name);
      if (!path || !existsSync(path)) {
        if (this.strictFactories) {
          throw new Error(`Factory FST is unavailable: ${name}`);
        }
        return undefined;
      }
      fst = VectorStandardFst.fromFile(path);
    }
    const graph = this.graphs.length;
    this.graphs.push({ fst, returns: [], name, callsite });
    this.graphByCallsite.set(callsite, graph);
    return graph;
  }

  _matches(graph, state, inputLabel) {
    const fst = this.graphs[graph].fst;
    const exact = [];
    const wildcard = [];
    for (const arc of fst.state(state).arcs) {
      if (arc.ilabel === inputLabel) exact.push({ arc, wildcard: false });
      else if (
        arc.ilabel === NON_BLANK
        && inputLabel !== EPSILON
        && inputLabel !== fst.inputLabelForByte(SPACE)
      ) {
        wildcard.push({ arc, wildcard: true });
      }
    }
    // connected_fst emits exact arcs first, followed by non-blank arcs.
    return exact.concat(wildcard);
  }

  _onlyEpsilonTransitions(graph, state) {
    // connected_fst::is_final_node only returns true for the top graph. A
    // child final state has implicit epsilon return arcs and is therefore
    // still part of epsilon closure.
    if (graph === 0 && this.graphs[graph].fst.isFinal(state)) return false;
    const arcs = this.graphs[graph].fst.state(state).arcs;
    return arcs.length === 0 || arcs.every(arc => arc.ilabel === EPSILON);
  }

  _mergePath(target, graph, state, candidate) {
    const key = graphStateKey(graph, state);
    const existing = target.get(key);
    // parser.cpp replaces only on a strictly lower heuristic. Equal-cost
    // paths retain the first candidate produced by the ordered graph arcs.
    if (!existing || candidate.heuristic < existing.heuristic) target.set(key, candidate);
  }

  _epsilonTransitions(graph, state, node) {
    const graphInfo = this.graphs[graph];
    const fst = graphInfo.fst;
    const transitions = [];

    // A connected child graph's final state gets an epsilon return arc for
    // each factory call site that has opened it.
    if (graph !== 0 && fst.isFinal(state)) {
      for (const target of graphInfo.returns) {
        transitions.push({
          graph: target.graph,
          state: target.state,
          weight: 0,
          inputSymbol: 'ε',
          outputSymbol: 'ε',
        });
      }
    }

    for (const match of this._matches(graph, state, EPSILON)) {
      const arc = match.arc;
      const output = fst.outputSymbol(match.wildcard ? EPSILON : arc.olabel);
      if (output === undefined) throw new Error(`Unknown output label ${arc.olabel}`);

      const factory = this._factoryName(output);
      if (factory !== undefined) {
        const child = this._loadFactory(factory, graph, state);
        if (child === undefined) {
          // In diagnostic mode, preserve the unresolved marker. The native
          // parser would report a missing factory; this mode is useful for
          // reading an otherwise complete graph without hiding that boundary.
          transitions.push({
            graph,
            state: arc.nextstate,
            weight: arc.weight,
            inputSymbol: 'ε',
            outputSymbol: output,
          });
          continue;
        }
        const returnTarget = { graph, state: arc.nextstate };
        const childReturns = this.graphs[child].returns;
        if (!childReturns.some(t => t.graph === returnTarget.graph && t.state === returnTarget.state)) {
          childReturns.push(returnTarget);
        }
        // connected_fst::get_arc_to_fst returns an epsilon/epsilon arc into
        // the child, so the factory marker itself is absent from result tags.
        transitions.push({
          graph: child,
          state: this.graphs[child].fst.header.start,
          weight: arc.weight,
          inputSymbol: 'ε',
          outputSymbol: 'ε',
        });
      } else {
        transitions.push({
          graph,
          state: arc.nextstate,
          weight: arc.weight,
          inputSymbol: 'ε',
          outputSymbol: output,
        });
      }
    }
    return transitions;
  }

  _parseEpsilons(active) {
    const inactive = new Map();
    let current = active;
    let depth = 0;
    while (current.size > 0) {
      const next = new Map();
      for (const [key, node] of sortedEntries(current)) {
        const graph = node.graph;
        const state = node.state;
        for (const transition of this._epsilonTransitions(graph, state, node)) {
          this._mergePath(next, transition.graph, transition.state, copyNode(node, transition));
        }
        if (!this._onlyEpsilonTransitions(graph, state)) {
          const old = inactive.get(key);
          if (!old || node.heuristic < old.heuristic) inactive.set(key, node);
        }
      }
      current = next;
      depth += 1;
      if (depth > this.maxEpsilonDepth) throw new Error('epsilon closure exceeded the parser depth bound');
    }
    for (const [key, node] of inactive) {
      const [graph, state] = key.split(':').map(Number);
      this._mergePath(current, graph, state, node);
    }
    return current;
  }

  _parseInput(active, byte) {
    const inputLabel = CHARACTER_START + byte;
    const inputSymbol = String.fromCharCode(byte);
    const next = new Map();
    for (const [, node] of sortedEntries(active)) {
      for (const match of this._matches(node.graph, node.state, inputLabel)) {
        const fst = this.graphs[node.graph].fst;
        const label = match.wildcard ? inputLabel : match.arc.olabel;
        const output = fst.outputSymbol(label);
        if (output === undefined) throw new Error(`Unknown output label ${label}`);
        this._mergePath(next, node.graph, match.arc.nextstate, copyNode(node, {
          graph: node.graph,
          state: match.arc.nextstate,
          weight: match.arc.weight,
          inputSymbol,
          outputSymbol: output,
        }));
      }
    }
    return next;
  }

  _inputBytes(text) {
    // parser.cpp feeds the raw UTF-8 bytes through std::stringstream >>
    // token.  Its default C locale separates only the ASCII whitespace bytes;
    // using JavaScript's Unicode \S would incorrectly split NBSP and other
    // non-ASCII bytes before the native byte matcher sees them.
    const input = Buffer.from(String(text), 'utf8');
    const bytes = [];
    let inToken = false;
    for (const byte of input) {
      const whitespace = byte === 9 || byte === 10 || byte === 11 || byte === 12 || byte === 13 || byte === SPACE;
      if (whitespace) {
        if (inToken) {
          bytes.push(SPACE);
          inToken = false;
        }
      } else {
        bytes.push(byte);
        inToken = true;
      }
    }
    // parser.cpp appends SPACE_WS_STRING after every extracted token,
    // including the final token when the input has no trailing whitespace.
    if (inToken) bytes.push(SPACE);
    return bytes;
  }

  _resetDynamicGraphs() {
    // A parser instance owns one connected graph per parse request. The
    // native service may cache the immutable FST bytes, but dynamic return
    // arcs belong to that request's connected graph and must not leak a
    // previous call site's continuation into the next result.
    this.graphs = [{ fst: this.graphs[0].fst, returns: [], name: 'top' }];
    this.graphByCallsite = new Map();
  }

  parse(text) {
    this._resetDynamicGraphs();
    const start = this.graphs[0].fst.header.start;
    if (start < 0) return { input: String(text), accepted: false, results: [] };
    let active = new Map();
    active.set(graphStateKey(0, start), {
      graph: 0,
      state: start,
      heuristic: 0,
      transitions: 0,
      inputSymbols: [],
      outputSymbols: [],
    });
    const bytes = this._inputBytes(text);
    for (const byte of bytes) {
      active = this._parseEpsilons(active);
      active = this._parseInput(active, byte);
      if (byte === SPACE) active = pruneNativeStates(active, this.maxStatesAfterSpace);
      if (active.size === 0) break;
    }
    active = this._parseEpsilons(active);
    const results = sortedEntries(active)
      .filter(([, node]) => node.graph === 0 && this.graphs[0].fst.isFinal(node.state))
      .map(([, node]) => ({
        state: node.state,
        graph: node.graph,
        heuristic: node.heuristic,
        // result.cpp streams this double with the C++ default precision (six
        // significant digits) into the JSON response. Preserve that wire
        // representation instead of exposing JavaScript's full binary-float
        // expansion.
        score: Number((bytes.length - node.heuristic).toPrecision(6)),
        transitions: node.transitions,
        inputSymbols: node.inputSymbols,
        outputSymbols: node.outputSymbols,
      }))
    return {
      input: String(text), accepted: results.length > 0, results: sortNativeResults(results),
    };
  }
}

export function loadConnectedFst(path, options = {}) {
  return ConnectedFstExecutor.fromFile(path, options);
}
