import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CompiledFstExecutor, VectorStandardFst, compiledFstConstants, sortNativeResults } from '../src/compiledFst.js';
import { ConnectedFstExecutor } from '../src/connectedFst.js';

const { CHARACTER_START, SPACE } = compiledFstConstants;

test('adversarial final-state ties retain the recorded C++ heap-fallback order', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/compiled-fst-sort-source.json', import.meta.url)));
  const controlSource = readFileSync(new URL('../../../scripts/parity-reference/nlu-sort-control.cpp', import.meta.url));
  assert.equal(createHash('sha256').update(controlSource).digest('hex'), fixture.controlSourceSha256);
  for (const row of fixture.cases) {
    const nodes = Array.from({ length: row.size }, (_, id) => {
      const weight = Math.min(id, row.size - id);
      return { id, heuristic: row.bucketed ? Math.floor(weight / 5) + (id % 3) / 5 : weight };
    });
    const order = sortNativeResults(nodes).map(node => node.id);
    assert.equal(createHash('sha256').update(JSON.stringify(order)).digest('hex'), row.expectedOrderSha256, row.name);
  }
});

function writeString(chunks, value) {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(4);
  length.writeInt32LE(bytes.length);
  chunks.push(length, bytes);
}

function writeSymbols(chunks, entries) {
  const magic = Buffer.alloc(4);
  magic.writeInt32LE(0x7eb2fb74);
  chunks.push(magic);
  writeString(chunks, '');
  const available = Buffer.alloc(8);
  available.writeBigInt64LE(1_000_000_000n);
  chunks.push(available);
  const count = Buffer.alloc(8);
  count.writeBigInt64LE(BigInt(entries.length));
  chunks.push(count);
  for (const [label, symbol] of entries) {
    writeString(chunks, symbol);
    const key = Buffer.alloc(8);
    key.writeBigInt64LE(BigInt(label));
    chunks.push(key);
  }
}

function vectorFst(states, outputSymbols = []) {
  const chunks = [];
  const magic = Buffer.alloc(4);
  magic.writeInt32LE(0x7eb2fdd6);
  chunks.push(magic);
  writeString(chunks, 'vector');
  writeString(chunks, 'standard');
  const version = Buffer.alloc(4);
  version.writeInt32LE(2);
  chunks.push(version);
  const flags = Buffer.alloc(4);
  flags.writeInt32LE(3);
  chunks.push(flags);
  const properties = Buffer.alloc(8);
  properties.writeBigUInt64LE(0n);
  chunks.push(properties);
  const start = Buffer.alloc(8);
  start.writeBigInt64LE(0n);
  chunks.push(start);
  const stateCount = Buffer.alloc(8);
  stateCount.writeBigInt64LE(BigInt(states.length));
  chunks.push(stateCount);
  const ignoredArcs = Buffer.alloc(8);
  ignoredArcs.writeBigInt64LE(0n);
  chunks.push(ignoredArcs);
  writeSymbols(chunks, [[0, 'ε'], [1, 'σ']]);
  writeSymbols(chunks, [[0, 'ε'], ...outputSymbols]);
  for (const state of states) {
    const final = Buffer.alloc(4);
    final.writeFloatLE(state.final === undefined ? Infinity : state.final);
    chunks.push(final);
    const arcCount = Buffer.alloc(8);
    arcCount.writeBigInt64LE(BigInt(state.arcs.length));
    chunks.push(arcCount);
    for (const arc of state.arcs) {
      const encoded = Buffer.alloc(16);
      encoded.writeInt32LE(arc.ilabel, 0);
      encoded.writeInt32LE(arc.olabel ?? 0, 4);
      encoded.writeFloatLE(arc.weight ?? 0, 8);
      encoded.writeInt32LE(arc.nextstate, 12);
      chunks.push(encoded);
    }
  }
  return Buffer.concat(chunks);
}

function weightedFinals() {
  return new VectorStandardFst(vectorFst([
    { arcs: [
      { ilabel: CHARACTER_START + 97, olabel: 2000, weight: 1.8, nextstate: 1 },
      { ilabel: CHARACTER_START + 97, olabel: 2001, weight: 1.2, nextstate: 2 },
    ] },
    { arcs: [{ ilabel: CHARACTER_START + SPACE, nextstate: 3 }] },
    { arcs: [{ ilabel: CHARACTER_START + SPACE, nextstate: 4 }] },
    { final: 0, arcs: [] },
    { final: 0, arcs: [] },
  ], [[2000, 'N:{} first'], [2001, 'N:{} second']]));
}

function manyBranches(count = 51) {
  const states = [{ arcs: [] }];
  const finalStart = 1 + count;
  states[0].arcs = Array.from({ length: count }, (_, index) => ({
    ilabel: CHARACTER_START + 97,
    weight: index,
    nextstate: 1 + index,
  }));
  for (let index = 0; index < count; index += 1) {
    states.push({ arcs: [{ ilabel: CHARACTER_START + SPACE, nextstate: finalStart + index }] });
  }
  for (let index = 0; index < count; index += 1) states.push({ final: 0, arcs: [] });
  return new VectorStandardFst(vectorFst(states));
}

function equalFinals(count = 20) {
  const finalStart = 1 + count;
  const states = [{ arcs: [] }];
  const outputSymbols = [];
  states[0].arcs = Array.from({ length: count }, (_, index) => {
    outputSymbols.push([3000 + index, `N:{} branch${index}`]);
    return {
      ilabel: CHARACTER_START + 97,
      olabel: 3000 + index,
      weight: 1.2,
      nextstate: 1 + index,
    };
  });
  for (let index = 0; index < count; index += 1) {
    states.push({ arcs: [{ ilabel: CHARACTER_START + SPACE, nextstate: finalStart + index }] });
  }
  for (let index = 0; index < count; index += 1) states.push({ final: 0, arcs: [] });
  return new VectorStandardFst(vectorFst(states, outputSymbols));
}

test('direct executor uses native ASCII-byte whitespace and preserves UTF-8 whitespace bytes', () => {
  const executor = new CompiledFstExecutor(weightedFinals());
  assert.deepEqual(executor._inputBytes('a\u00a0b'), [97, 194, 160, 98, 32]);
  assert.deepEqual(executor._inputBytes('a\tb\n'), [97, 32, 98, 32]);
});

test('direct and connected final ordering truncates heuristic weights like native result_fst', () => {
  const direct = new CompiledFstExecutor(weightedFinals()).parse('a');
  assert.equal(direct.results.length, 2);
  assert.equal(direct.results[0].state, 3);
  assert.equal(direct.results[0].heuristic, 1.7999999523162842);

  const connected = new ConnectedFstExecutor(weightedFinals(), { strictFactories: false }).parse('a');
  assert.equal(connected.results.length, 2);
  assert.equal(connected.results[0].state, 3);
  assert.equal(connected.results[0].heuristic, 1.7999999523162842);
});

test('large equivalent buckets follow native std::sort first-result order', () => {
  // Native result_fst uses std::sort rather than a stable sort. At 20
  // equivalent finals, the pinned libstdc++ partition puts branch 10 first.
  const fst = equalFinals();
  assert.equal(new CompiledFstExecutor(fst).parse('a').results[0].state, 31);
  assert.equal(new ConnectedFstExecutor(fst, { strictFactories: false }).parse('a').results[0].state, 31);
});

test('direct and connected executors prune to the native 50-state default after spaces', () => {
  const fst = manyBranches();
  assert.equal(new CompiledFstExecutor(fst).parse('a').results.length, 50);
  assert.equal(new CompiledFstExecutor(fst, { maxStatesAfterSpace: 1 }).parse('a').results.length, 1);
  assert.equal(new CompiledFstExecutor(fst, { maxStatesAfterSpace: Infinity }).parse('a').results.length, 51);

  assert.equal(new ConnectedFstExecutor(fst, { strictFactories: false }).parse('a').results.length, 50);
  assert.equal(new ConnectedFstExecutor(fst, { strictFactories: false, maxStatesAfterSpace: 1 }).parse('a').results.length, 1);
  assert.equal(new ConnectedFstExecutor(fst, { strictFactories: false, maxStatesAfterSpace: Infinity }).parse('a').results.length, 51);
});

test('preloaded factory FSTs disable disk fallback while preserving callsite graph identity', () => {
  const top = new VectorStandardFst(vectorFst([{ final: 0, arcs: [] }]));
  const child = new VectorStandardFst(vectorFst([{ final: 0, arcs: [] }]));
  const executor = new ConnectedFstExecutor(top, {
    factoryDir: '/this/path/must-not-be-read',
    factoryPaths: { same: '/this/path/must-not-be-read/same.fst' },
    factoryFsts: new Map([['same', child]]),
  });

  const first = executor._loadFactory('same', 0, 7);
  const second = executor._loadFactory('same', 0, 8);
  assert.notEqual(first, second);
  assert.equal(executor.graphs[first].fst, child);
  assert.equal(executor.graphs[second].fst, child);
  assert.notEqual(executor.graphs[first].returns, executor.graphs[second].returns);

  assert.throws(() => executor._loadFactory('missing', 0, 9), /Factory FST is unavailable: missing/);
  assert.equal(new ConnectedFstExecutor(top, {
    factoryDir: '/this/path/must-not-be-be-read',
    factoryFsts: new Map(),
    strictFactories: false,
  })._loadFactory('missing', 0, 9), undefined);
  assert.throws(() => new ConnectedFstExecutor(top, { factoryFsts: {} }), /factoryFsts must be a Map/);
});
