import { readFileSync } from 'node:fs';

// The pinned parser consumes OpenFST vector/standard files.  This module keeps
// that file format and traversal separate from the AST matcher: a compiled
// graph is an immutable source artifact, so equal-cost paths can retain the
// arc order produced by the native compiler and OpenFST optimizer.

const FST_MAGIC = 0x7eb2fdd6;
const SYMBOL_TABLE_MAGIC = 0x7eb2fb74;
const EPSILON = 0;
const NON_BLANK = 1;
const CHARACTER_START = 10;
const CHARACTER_END = 299;
const SPACE = 32;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

function fail(message) {
  throw new Error(`Invalid OpenFST vector file: ${message}`);
}

function readString(view, cursor, label) {
  const length = view.readInt32LE(cursor.offset);
  cursor.offset += 4;
  if (length < 0 || cursor.offset + length > view.length) fail(`${label} length is out of range`);
  const value = view.subarray(cursor.offset, cursor.offset + length);
  cursor.offset += length;
  return value;
}

function readInt64(view, cursor, label) {
  const value = view.readBigInt64LE(cursor.offset);
  cursor.offset += 8;
  if (value < 0n || value > BigInt(MAX_SAFE_INTEGER)) fail(`${label} is not a safe non-negative integer`);
  return Number(value);
}

function readSymbolTable(view, cursor, direction) {
  if (cursor.offset + 4 > view.length || view.readInt32LE(cursor.offset) !== SYMBOL_TABLE_MAGIC) {
    fail(`missing ${direction} symbol table`);
  }
  cursor.offset += 4;
  const name = readString(view, cursor, `${direction} symbol-table name`).toString('utf8');
  const availableKey = readInt64(view, cursor, `${direction} available key`);
  const size = readInt64(view, cursor, `${direction} symbol-table size`);
  if (size > 10_000_000) fail(`${direction} symbol-table size is unreasonable`);
  const byLabel = new Map();
  const byBytes = new Map();
  for (let i = 0; i < size; i += 1) {
    const symbol = readString(view, cursor, `${direction} symbol`);
    const key = view.readBigInt64LE(cursor.offset);
    cursor.offset += 8;
    if (key < 0n || key > BigInt(MAX_SAFE_INTEGER)) fail(`${direction} symbol key is unsafe`);
    const label = Number(key);
    const bytes = Buffer.from(symbol);
    byLabel.set(label, bytes);
    byBytes.set(bytes.toString('hex'), label);
  }
  return { name, availableKey, byLabel, byBytes };
}

function readHeader(view, cursor) {
  if (view.length < 66 || view.readInt32LE(cursor.offset) !== FST_MAGIC) fail('bad magic');
  cursor.offset += 4;
  const fstType = readString(view, cursor, 'FST type').toString('ascii');
  const arcType = readString(view, cursor, 'arc type').toString('ascii');
  const version = view.readInt32LE(cursor.offset); cursor.offset += 4;
  const flags = view.readInt32LE(cursor.offset); cursor.offset += 4;
  const properties = view.readBigUInt64LE(cursor.offset); cursor.offset += 8;
  const start = view.readBigInt64LE(cursor.offset); cursor.offset += 8;
  const numStates = view.readBigInt64LE(cursor.offset); cursor.offset += 8;
  const numArcs = view.readBigInt64LE(cursor.offset); cursor.offset += 8;
  for (const [label, value] of [['start', start], ['numStates', numStates], ['numArcs', numArcs]]) {
    if (value < -1n || value > BigInt(MAX_SAFE_INTEGER)) fail(`${label} is unsafe`);
  }
  if (fstType !== 'vector' || arcType !== 'standard') {
    fail(`only vector/standard is supported (found ${fstType}/${arcType})`);
  }
  return {
    fstType,
    arcType,
    version,
    flags,
    properties,
    start: Number(start),
    numStates: Number(numStates),
    // VectorFst writes zero here and stores each state's arc count inline.
    numArcs: Number(numArcs),
  };
}

/**
 * A bounded reader for OpenFST's vector/standard binary representation.
 *
 * The source artifact is read once and state offsets are indexed without
 * materializing all arcs. This keeps the 42 MB launch graph usable while
 * preserving every state's original arc order.
 */
export class VectorStandardFst {
  constructor(bytes, { source = '<buffer>' } = {}) {
    this.source = source;
    this.bytes = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const cursor = { offset: 0 };
    this.header = readHeader(this.bytes, cursor);
    if ((this.header.flags & 0x3) !== 0x3) fail('both input and output symbol tables are required');
    this.inputSymbols = readSymbolTable(this.bytes, cursor, 'input');
    this.outputSymbols = readSymbolTable(this.bytes, cursor, 'output');
    this.dataOffset = cursor.offset;
    this.stateOffsets = new Uint32Array(this.header.numStates);
    this._indexStates();
  }

  static fromFile(path) {
    return new VectorStandardFst(readFileSync(path), { source: path });
  }

  _indexStates() {
    let offset = this.dataOffset;
    for (let state = 0; state < this.header.numStates; state += 1) {
      this.stateOffsets[state] = offset;
      if (offset + 12 > this.bytes.length) fail(`state ${state} is truncated`);
      offset += 4; // TropicalWeight final value.
      const arcCount = this.bytes.readBigInt64LE(offset);
      offset += 8;
      if (arcCount < 0n || arcCount > BigInt(MAX_SAFE_INTEGER)) fail(`state ${state} arc count is unsafe`);
      const next = offset + Number(arcCount) * 16;
      if (next > this.bytes.length) fail(`state ${state} arcs are truncated`);
      offset = next;
    }
    if (offset > this.bytes.length) fail('state data exceeds file');
    this.dataEnd = offset;
  }

  stateCount() {
    return this.header.numStates;
  }

  state(stateId) {
    if (!Number.isInteger(stateId) || stateId < 0 || stateId >= this.header.numStates) {
      fail(`state ${stateId} is out of range`);
    }
    let offset = this.stateOffsets[stateId];
    const finalWeight = this.bytes.readFloatLE(offset); offset += 4;
    const arcCountBig = this.bytes.readBigInt64LE(offset); offset += 8;
    const arcCount = Number(arcCountBig);
    const arcs = new Array(arcCount);
    for (let i = 0; i < arcCount; i += 1) {
      const ilabel = this.bytes.readInt32LE(offset); offset += 4;
      const olabel = this.bytes.readInt32LE(offset); offset += 4;
      const weight = this.bytes.readFloatLE(offset); offset += 4;
      const nextstate = this.bytes.readInt32LE(offset); offset += 4;
      if (nextstate < 0 || nextstate >= this.header.numStates) fail(`arc next state ${nextstate} is out of range`);
      arcs[i] = { ilabel, olabel, weight, nextstate };
    }
    return { finalWeight, arcs };
  }

  isFinal(stateId) {
    return Number.isFinite(this.bytes.readFloatLE(this.stateOffsets[stateId]));
  }

  inputLabelForByte(byte) {
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) throw new RangeError('input byte must be 0..255');
    return CHARACTER_START + byte;
  }

  inputSymbol(label) {
    if (label === EPSILON) return 'ε';
    if (label === NON_BLANK) return 'σ';
    if (label >= CHARACTER_START && label <= CHARACTER_END) return String.fromCharCode(label - CHARACTER_START);
    const symbol = this.inputSymbols.byLabel.get(label);
    return symbol ? Buffer.from(symbol).toString('utf8') : undefined;
  }

  outputSymbol(label) {
    if (label === EPSILON) return 'ε';
    if (label === NON_BLANK) return 'σ';
    if (label === 2) return 'εsub';
    if (label === 3) return '<s>';
    if (label === 4) return '<\\/s>';
    if (label === 5) return '<wp>';
    if (label === 6) return 'H:';
    if (label >= CHARACTER_START && label <= CHARACTER_END) return `C:${label - CHARACTER_START}`;
    const symbol = this.outputSymbols.byLabel.get(label);
    return symbol ? Buffer.from(symbol).toString('utf8') : undefined;
  }
}

function finiteFinal(fst, state) {
  return fst.isFinal(state);
}

function compareStates(a, b) {
  return a - b;
}

function sortedEntries(map) {
  return [...map.entries()].sort((a, b) => compareStates(a[0], b[0]));
}

// result_fst::cmp converts each final heuristic to int before comparing it.
// JavaScript's Math.trunc has the same toward-zero conversion for the finite
// weights emitted by OpenFST. sortNativeResults below reproduces the pinned
// std::sort partition behavior for equivalent integer buckets.
function nativeHeuristicBucket(value) {
  return Math.trunc(value);
}

function validateMaxStatesAfterSpace(value) {
  if (value !== Infinity && (!Number.isInteger(value) || value < 1)) {
    throw new RangeError('maxStatesAfterSpace must be a positive integer or Infinity');
  }
}

// parser::prune_states retains every node at or below the max-state
// threshold, so ties at the boundary may leave more than the configured
// number of nodes. The pinned helper's mixed int/double heap selects the same
// integer bucket as the maxStatesAfterSpace-th smallest finite heuristic; the
// source function then returns that threshold as int (toward-zero conversion).
// Selecting the order statistic directly avoids porting libstdc++ heap layout
// while preserving the source observable threshold and tie retention. The
// parser keeps node order in std::map; rebuilding a Map in its original
// iteration order preserves that order for later ties.
export function pruneNativeStates(active, maxStatesAfterSpace) {
  if (active.size <= maxStatesAfterSpace || maxStatesAfterSpace === Infinity) return active;
  const byHeuristic = [...active.entries()].sort((a, b) => a[1].heuristic - b[1].heuristic);
  const threshold = Math.trunc(byHeuristic[maxStatesAfterSpace - 1][1].heuristic);
  const kept = new Map();
  for (const [key, node] of active) {
    if (node.heuristic <= threshold) kept.set(key, node);
  }
  return kept;
}

function nativeResultLess(left, right) {
  return nativeHeuristicBucket(left.heuristic) < nativeHeuristicBucket(right.heuristic);
}

function swap(values, left, right) {
  const value = values[left];
  values[left] = values[right];
  values[right] = value;
}

// The native result_fst uses std::sort with an integer-bucket comparator. For
// equivalent buckets that comparator is not stable: the pinned libstdc++
// introsort moves the median pivot and partitions before its final insertion
// pass. Reproduce that bounded algorithm so a large equivalent bucket keeps
// the native first-result choice (for example, 20 equal finals select the
// source's middle branch rather than the first map entry).
function moveMedianToFirst(values, result, a, b, c, less) {
  if (less(values[a], values[b])) {
    if (less(values[b], values[c])) swap(values, result, b);
    else if (less(values[a], values[c])) swap(values, result, c);
    else swap(values, result, a);
  } else if (less(values[a], values[c])) {
    swap(values, result, a);
  } else if (less(values[b], values[c])) {
    swap(values, result, c);
  } else {
    swap(values, result, b);
  }
}

function unguardedPartition(values, first, last, pivot, less) {
  while (true) {
    while (less(values[first], values[pivot])) first += 1;
    last -= 1;
    while (less(values[pivot], values[last])) last -= 1;
    if (first >= last) return first;
    swap(values, first, last);
    first += 1;
  }
}

function unguardedLinearInsert(values, last, less) {
  const value = values[last];
  let position = last;
  while (less(value, values[position - 1])) {
    values[position] = values[position - 1];
    position -= 1;
  }
  values[position] = value;
}

function insertionSort(values, first, last, less) {
  for (let index = first + 1; index < last; index += 1) {
    if (less(values[index], values[first])) {
      const value = values[index];
      for (let position = index; position > first; position -= 1) {
        values[position] = values[position - 1];
      }
      values[first] = value;
    } else {
      unguardedLinearInsert(values, index, less);
    }
  }
}

function finalInsertionSort(values, less) {
  if (values.length > 16) {
    insertionSort(values, 0, 16, less);
    for (let index = 16; index < values.length; index += 1) {
      unguardedLinearInsert(values, index, less);
    }
  } else {
    insertionSort(values, 0, values.length, less);
  }
}

function adjustHeap(values, first, hole, length, value, less) {
  const top = hole;
  let child = hole;
  while (child < Math.floor((length - 1) / 2)) {
    child = 2 * (child + 1);
    if (less(values[first + child], values[first + child - 1])) child -= 1;
    values[first + hole] = values[first + child];
    hole = child;
  }
  if (length % 2 === 0 && child === (length - 2) / 2) {
    child = 2 * (child + 1);
    values[first + hole] = values[first + child - 1];
    hole = child - 1;
  }
  let parent = Math.floor((hole - 1) / 2);
  while (hole > top && less(values[first + parent], value)) {
    values[first + hole] = values[first + parent];
    hole = parent;
    parent = Math.floor((hole - 1) / 2);
  }
  values[first + hole] = value;
}

function heapSort(values, first, last, less) {
  const length = last - first;
  for (let parent = Math.floor((length - 2) / 2); parent >= 0; parent -= 1) {
    adjustHeap(values, first, parent, length, values[first + parent], less);
  }
  for (let end = last - 1; end > first; end -= 1) {
    const value = values[end];
    values[end] = values[first];
    adjustHeap(values, first, 0, end - first, value, less);
  }
}

function introsortLoop(values, first, last, depthLimit, less) {
  while (last - first > 16) {
    if (depthLimit === 0) {
      // Native partial_sort(first, last, last) builds and sorts a heap.
      // This can run on valid adversarial input, and its ordering of ties
      // differs from a stable JavaScript sort even with the same comparator.
      heapSort(values, first, last, less);
      return;
    }
    depthLimit -= 1;
    const middle = first + Math.floor((last - first) / 2);
    moveMedianToFirst(values, first, first + 1, middle, last - 1, less);
    const cut = unguardedPartition(values, first + 1, last, first, less);
    introsortLoop(values, cut, last, depthLimit, less);
    last = cut;
  }
}

export function sortNativeResults(results) {
  const ordered = [...results];
  if (ordered.length > 1) {
    const depthLimit = 2 * Math.floor(Math.log2(ordered.length));
    introsortLoop(ordered, 0, ordered.length, depthLimit, nativeResultLess);
    finalInsertionSort(ordered, nativeResultLess);
  }
  return ordered;
}

function copyNode(node, arc, outputLabel, inputSymbol) {
  return {
    heuristic: node.heuristic + arc.weight,
    transitions: node.transitions + 1,
    state: arc.nextstate,
    inputSymbols: node.inputSymbols.concat(inputSymbol),
    outputSymbols: node.outputSymbols.concat(outputLabel),
  };
}

/**
 * Executes a single compiled graph using parser.cpp's active/inactive epsilon
 * closure and strict lower-cost replacement rule. It intentionally returns
 * graph-level paths; AST entity interpretation and dynamic factory links are
 * separate concerns.
 */
export class CompiledFstExecutor {
  constructor(fst, { maxEpsilonDepth = 10_000, maxStatesAfterSpace = 50 } = {}) {
    this.fst = fst;
    this.maxEpsilonDepth = maxEpsilonDepth;
    validateMaxStatesAfterSpace(maxStatesAfterSpace);
    this.maxStatesAfterSpace = maxStatesAfterSpace;
  }

  _matches(stateId, inputLabel) {
    const arcs = this.fst.state(stateId).arcs;
    const exact = [];
    const wildcard = [];
    for (const arc of arcs) {
      if (arc.ilabel === inputLabel) exact.push({ arc, wildcard: false });
      else if (arc.ilabel === NON_BLANK && inputLabel !== EPSILON && inputLabel !== this.fst.inputLabelForByte(SPACE)) {
        wildcard.push({ arc, wildcard: true });
      }
    }
    // connected_fst::match_arc emits exact arcs, then non-blank wildcard arcs.
    return exact.concat(wildcard);
  }

  _onlyEpsilonTransitions(stateId) {
    if (finiteFinal(this.fst, stateId)) return false;
    const arcs = this.fst.state(stateId).arcs;
    return arcs.length === 0 || arcs.every(arc => arc.ilabel === EPSILON);
  }

  _mergePath(target, state, candidate) {
    const existing = target.get(state);
    // parser.cpp replaces only on a strictly lower heuristic. Keeping the
    // first equal candidate is the crucial compiled-graph tie behavior.
    if (!existing || candidate.heuristic < existing.heuristic) target.set(state, candidate);
  }

  _parseEpsilons(active) {
    const inactive = new Map();
    let current = active;
    let depth = 0;
    while (current.size > 0) {
      const next = new Map();
      for (const [state, node] of sortedEntries(current)) {
        for (const match of this._matches(state, EPSILON)) {
          const output = this.fst.outputSymbol(match.wildcard ? EPSILON : match.arc.olabel);
          if (output === undefined) throw new Error(`Unknown output label ${match.arc.olabel}`);
          this._mergePath(next, match.arc.nextstate, copyNode(node, match.arc, output, 'ε'));
        }
        if (!this._onlyEpsilonTransitions(state)) {
          const prior = inactive.get(state);
          if (!prior || node.heuristic < prior.heuristic) inactive.set(state, node);
        }
      }
      current = next;
      depth += 1;
      if (depth > this.maxEpsilonDepth) throw new Error('epsilon closure exceeded the parser depth bound');
    }
    for (const [state, node] of inactive) this._mergePath(current, state, node);
    return current;
  }

  _parseInput(active, byte) {
    const inputLabel = this.fst.inputLabelForByte(byte);
    const inputSymbol = String.fromCharCode(byte);
    const next = new Map();
    for (const [state, node] of sortedEntries(active)) {
      for (const match of this._matches(state, inputLabel)) {
        const label = match.wildcard ? inputLabel : match.arc.olabel;
        const output = this.fst.outputSymbol(label);
        if (output === undefined) throw new Error(`Unknown output label ${label}`);
        this._mergePath(next, match.arc.nextstate, copyNode(node, match.arc, output, inputSymbol));
      }
    }
    return next;
  }

  _inputBytes(text) {
    // parser.cpp tokenizes with std::stringstream in the default C locale,
    // then feeds each raw UTF-8 byte to the FST. In particular, NBSP and
    // other non-ASCII Unicode whitespace are ordinary bytes to the parser;
    // JavaScript's Unicode \S tokenization would incorrectly remove them.
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
    if (inToken) bytes.push(SPACE);
    return bytes;
  }

  parse(text) {
    let active = new Map();
    const start = this.fst.header.start;
    if (start < 0) return { input: String(text), accepted: false, results: [] };
    active.set(start, {
      heuristic: 0,
      transitions: 0,
      state: start,
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
    const inputLength = bytes.length;
    const results = sortedEntries(active)
      .filter(([state]) => finiteFinal(this.fst, state))
      .map(([state, node]) => ({
        state,
        heuristic: node.heuristic,
        // result.cpp writes the score with C++'s default six-significant
        // digit formatting before JSON serialization.
        score: Number((inputLength - node.heuristic).toPrecision(6)),
        transitions: node.transitions,
        inputSymbols: node.inputSymbols,
        outputSymbols: node.outputSymbols,
      }))
    return {
      input: String(text), accepted: results.length > 0, results: sortNativeResults(results),
    };
  }
}

export function loadCompiledFst(path, options) {
  return new CompiledFstExecutor(VectorStandardFst.fromFile(path), options);
}

export const compiledFstConstants = Object.freeze({
  FST_MAGIC,
  SYMBOL_TABLE_MAGIC,
  EPSILON,
  NON_BLANK,
  CHARACTER_START,
  CHARACTER_END,
  SPACE,
});
