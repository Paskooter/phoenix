import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  CompiledGraphStore,
  discoverCompiledGraphs,
  ruleHandle,
  splitFstDirectories,
} from '../src/compiledFstAcquisition.js';

function stringBytes(value) {
  return Buffer.from(value, 'utf8');
}

function writeString(chunks, value) {
  const bytes = stringBytes(value);
  const length = Buffer.alloc(4);
  length.writeInt32LE(bytes.length);
  chunks.push(length, bytes);
}

function writeSymbolTable(chunks, entries) {
  const magic = Buffer.alloc(4);
  magic.writeInt32LE(0x7eb2fb74);
  chunks.push(magic);
  writeString(chunks, '');
  const available = Buffer.alloc(8);
  available.writeBigInt64LE(1_000_000_000n);
  chunks.push(available);
  const size = Buffer.alloc(8);
  size.writeBigInt64LE(BigInt(entries.length));
  chunks.push(size);
  for (const [label, symbol] of entries) {
    writeString(chunks, symbol);
    const key = Buffer.alloc(8);
    key.writeBigInt64LE(BigInt(label));
    chunks.push(key);
  }
}

function makeVectorFst({ states, start = 0, inputSymbols = [], outputSymbols = [] }) {
  const chunks = [];
  const headerMagic = Buffer.alloc(4);
  headerMagic.writeInt32LE(0x7eb2fdd6);
  chunks.push(headerMagic);
  writeString(chunks, 'vector');
  writeString(chunks, 'standard');
  const version = Buffer.alloc(4); version.writeInt32LE(2); chunks.push(version);
  const flags = Buffer.alloc(4); flags.writeInt32LE(3); chunks.push(flags);
  const properties = Buffer.alloc(8); properties.writeBigUInt64LE(0n); chunks.push(properties);
  const startState = Buffer.alloc(8); startState.writeBigInt64LE(BigInt(start)); chunks.push(startState);
  const count = Buffer.alloc(8); count.writeBigInt64LE(BigInt(states.length)); chunks.push(count);
  const ignoredArcCount = Buffer.alloc(8); ignoredArcCount.writeBigInt64LE(0n); chunks.push(ignoredArcCount);
  writeSymbolTable(chunks, inputSymbols);
  writeSymbolTable(chunks, outputSymbols);
  for (const state of states) {
    const final = Buffer.alloc(4); final.writeFloatLE(state.final === false ? Infinity : (state.final ?? Infinity)); chunks.push(final);
    const arcCount = Buffer.alloc(8); arcCount.writeBigInt64LE(BigInt(state.arcs.length)); chunks.push(arcCount);
    for (const arc of state.arcs) {
      const bytes = Buffer.alloc(16);
      bytes.writeInt32LE(arc.ilabel, 0);
      bytes.writeInt32LE(arc.olabel, 4);
      bytes.writeFloatLE(arc.weight ?? 0, 8);
      bytes.writeInt32LE(arc.nextstate, 12);
      chunks.push(bytes);
    }
  }
  return Buffer.concat(chunks);
}

function intentFst(intent) {
  return makeVectorFst({
    inputSymbols: [[0, 'ε'], [107, 'a'], [42, ' ']],
    outputSymbols: [[0, 'ε'], [2000, `N:{} {% intent='${intent}' %}`]],
    states: [
      { arcs: [{ ilabel: 0, olabel: 0, weight: 0, nextstate: 1 }] },
      { arcs: [{ ilabel: 107, olabel: 2000, weight: 0, nextstate: 2 }] },
      { arcs: [{ ilabel: 42, olabel: 0, weight: 0, nextstate: 3 }] },
      { final: 0, arcs: [] },
    ],
  });
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-nlu-acq-'));
  try { return fn(dir); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

test('rule handles match RobustParserClient.getRuleHandle', () => {
  assert.equal(ruleHandle('clock/timer_set_value'), 'handle:clock/timer_set_value');
  assert.equal(ruleHandle('launch'), 'handle:launch');
  assert.throws(() => ruleHandle(''), /non-empty rule name/);
});

test('fstDirectories are colon-separated like a PATH list', () => {
  assert.deepEqual(splitFstDirectories('a:b:c'), ['a', 'b', 'c']);
  assert.deepEqual(splitFstDirectories(' a : : b '), ['a', 'b']);
  assert.deepEqual(splitFstDirectories(['x', ' y ', '']), ['x', 'y']);
  assert.deepEqual(splitFstDirectories(''), []);
});

test('RulesRegistry glob of a missing directory yields no graphs', () => {
  withTempDir(dir => {
    assert.deepEqual(discoverCompiledGraphs([join(dir, 'missing')]), []);
  });
});

test('discovers nested .fst files and reconstructs lowered names', () => {
  withTempDir(dir => {
    mkdirSync(join(dir, 'skill'), { recursive: true });
    writeFileSync(join(dir, 'launch.fst'), intentFst('root'));
    writeFileSync(join(dir, 'skill', 'extra.fst'), intentFst('extra'));
    writeFileSync(join(dir, 'skill', 'ignore.txt'), 'not an fst');
    const graphs = discoverCompiledGraphs([dir]);
    assert.deepEqual(graphs.map(graph => graph.name).sort(), ['launch', 'skill/extra']);
    assert.equal(graphs.find(graph => graph.name === 'skill/extra').fstPath, join(dir, 'skill/extra') + '.fst');
  });
});

test('a later fstDirectory overwrites the same lowered name', () => {
  withTempDir(dir => {
    const first = join(dir, 'first');
    const second = join(dir, 'second');
    mkdirSync(first);
    mkdirSync(second);
    writeFileSync(join(first, 'extra.fst'), intentFst('first'));
    writeFileSync(join(second, 'extra.fst'), intentFst('second'));
    const graphs = discoverCompiledGraphs([first, second]);
    assert.equal(graphs.length, 1);
    assert.equal(graphs[0].directory, second);
    assert.equal(graphs[0].name, 'extra');
  });
});

test('COMPILE BINARYFST_PATH then PARSE_FROM_URI executes the loaded graph', () => {
  withTempDir(dir => {
    const path = join(dir, 'skill.fst');
    writeFileSync(path, intentFst('extraIntent'));
    const store = new CompiledGraphStore();
    const uri = ruleHandle('skill/extra');
    store.compileBinaryFstPath(path, uri);
    const parsed = store.parseFromUri('a', uri);
    assert.equal(parsed.accepted, true);
    assert.match(parsed.results[0].outputSymbols.join('\n'), /intent='extraIntent'/);
  });
});

test('COMPILE of a missing or malformed FST fails and does not register a handle', () => {
  withTempDir(dir => {
    const store = new CompiledGraphStore();
    const uri = ruleHandle('broken');
    assert.throws(() => store.compileBinaryFstPath(join(dir, 'missing.fst'), uri), /Could not open binary_fst_path/);
    assert.equal(store.hasHandle(uri), false);
    const path = join(dir, 'broken.fst');
    writeFileSync(path, 'not an openfst');
    assert.throws(() => store.compileBinaryFstPath(path, uri), /Malformed compiled NLU FST/);
    assert.equal(store.hasHandle(uri), false);
  });
});

test('RESET_MEMORY drops rule handles and PARSE_FROM_URI then fails', () => {
  withTempDir(dir => {
    const path = join(dir, 'extra.fst');
    writeFileSync(path, intentFst('extraIntent'));
    const store = new CompiledGraphStore();
    const uri = ruleHandle('extra');
    store.compileBinaryFstPath(path, uri);
    store.resetMemory();
    assert.equal(store.hasHandle(uri), false);
    assert.throws(() => store.parseFromUri('a', uri), /handle, but it does not exist/);
  });
});

test('REMOVE_FROM_MEM drops one handle and leaves others', () => {
  withTempDir(dir => {
    const first = join(dir, 'one.fst');
    const second = join(dir, 'two.fst');
    writeFileSync(first, intentFst('one'));
    writeFileSync(second, intentFst('two'));
    const store = new CompiledGraphStore();
    store.compileBinaryFstPath(first, ruleHandle('one'));
    store.compileBinaryFstPath(second, ruleHandle('two'));
    assert.equal(store.removeFromMemory(ruleHandle('one')), true);
    assert.equal(store.hasHandle(ruleHandle('one')), false);
    assert.equal(store.hasHandle(ruleHandle('two')), true);
    assert.match(store.parseFromUri('a', ruleHandle('two')).results[0].outputSymbols.join('\n'), /intent='two'/);
  });
});

test('in-memory COMPILE bytes are used after the on-disk graph is replaced', () => {
  withTempDir(dir => {
    const path = join(dir, 'extra.fst');
    writeFileSync(path, intentFst('original'));
    const store = new CompiledGraphStore();
    const uri = ruleHandle('extra');
    store.compileBinaryFstPath(path, uri);
    writeFileSync(path, intentFst('replaced'));
    assert.match(store.parseFromUri('a', uri).results[0].outputSymbols.join('\n'), /intent='original'/);
  });
});
