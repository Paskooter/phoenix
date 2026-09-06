import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { CompiledFstExecutor, VectorStandardFst } from '../src/compiledFst.js';

const launchPath = process.env.N08_LAUNCH_FST
  || '/home/shell/work/phoenix/.parity/reference/5c0a7390539663ba749d360de348a428c088505c/packages/parser/robust-parser/rules_fst/launch.fst';

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

function fixtureExecutor() {
  // Two equal-cost `a` paths share the same consumed input. The first arc is
  // deliberately the expected winner, matching parser.cpp's strict `<` tie
  // replacement. The epsilon prefix also exercises inactive-node closure.
  const bytes = makeVectorFst({
    inputSymbols: [[0, 'ε'], [107, 'a'], [42, ' ']],
    outputSymbols: [[0, 'ε'], [2000, "N:{} {% intent='first' %}"], [2001, "N:{} {% intent='second' %}"]],
    states: [
      { arcs: [{ ilabel: 0, olabel: 0, weight: 0, nextstate: 1 }] },
      { arcs: [
        { ilabel: 107, olabel: 2000, weight: 0, nextstate: 2 },
        { ilabel: 107, olabel: 2001, weight: 0, nextstate: 3 },
      ] },
      { arcs: [{ ilabel: 42, olabel: 0, weight: 0, nextstate: 4 }] },
      { arcs: [{ ilabel: 42, olabel: 0, weight: 0, nextstate: 5 }] },
      { final: 0, arcs: [] },
      { final: 0, arcs: [] },
    ],
  });
  return new CompiledFstExecutor(new VectorStandardFst(bytes));
}

test('reads vector/standard symbol tables and preserves first equal-cost arc', () => {
  const result = fixtureExecutor().parse('a');
  assert.equal(result.accepted, true);
  assert.equal(result.results[0].heuristic, 0);
  assert.equal(result.results[0].score, 2); // `a `, matching result_fst's byte length.
  assert.deepEqual(result.results[0].outputSymbols, ['ε', "N:{} {% intent='first' %}", 'ε']);
});

test('strictly lower heuristic replaces an earlier path to the same state', () => {
  const bytes = makeVectorFst({
    inputSymbols: [[0, 'ε'], [107, 'a'], [42, ' ']],
    outputSymbols: [[0, 'ε'], [2000, "N:{} {% intent='expensive' %}"], [2001, "N:{} {% intent='cheap' %}"]],
    states: [
      { arcs: [
        { ilabel: 107, olabel: 2000, weight: 2, nextstate: 1 },
        { ilabel: 107, olabel: 2001, weight: 1, nextstate: 1 },
      ] },
      { arcs: [{ ilabel: 42, olabel: 0, weight: 0, nextstate: 2 }] },
      { final: 0, arcs: [] },
    ],
  });
  const result = new CompiledFstExecutor(new VectorStandardFst(bytes)).parse('a').results[0];
  assert.equal(result.heuristic, 1);
  assert.equal(result.outputSymbols[0], "N:{} {% intent='cheap' %}");
});

test('wildcard arcs consume non-space bytes and emit the concrete C label', () => {
  const bytes = makeVectorFst({
    inputSymbols: [[0, 'ε'], [1, 'σ'], [42, ' ']],
    outputSymbols: [[0, 'ε'], [1, 'σ']],
    states: [
      { arcs: [{ ilabel: 1, olabel: 1, weight: 0, nextstate: 1 }] },
      { arcs: [{ ilabel: 42, olabel: 0, weight: 0, nextstate: 2 }] },
      { final: 0, arcs: [] },
    ],
  });
  const result = new CompiledFstExecutor(new VectorStandardFst(bytes)).parse('z').results[0];
  assert.deepEqual(result.outputSymbols, ['C:122', 'ε']);
});

test('executes archived launch FST tags and native byte scores', { skip: !existsSync(launchPath) }, () => {
  const executor = new CompiledFstExecutor(VectorStandardFst.fromFile(launchPath));
  const cases = [
    ['can you spell', 0, 'requestSpellWord'],
    ['how do you spell crepuscular', 12, 'requestSpellWord'],
    ['what should i get for christmas', 4, 'whatGiftShouldUserReceive'],
    ['what should i get for my birthday', 4, 'whatGiftShouldUserReceive'],
  ];
  for (const [text, heuristic, intent] of cases) {
    const result = executor.parse(text);
    assert.equal(result.accepted, true, text);
    assert.equal(result.results[0].heuristic, heuristic, text);
    assert.ok(result.results[0].outputSymbols.some(symbol => symbol.includes(`intent='${intent}'`)), text);
  }
});

test('archived launch path can be loaded without copying the 42 MB source artifact', { skip: !existsSync(launchPath) }, () => {
  const fst = VectorStandardFst.fromFile(launchPath);
  assert.equal(fst.header.fstType, 'vector');
  assert.equal(fst.header.arcType, 'standard');
  assert.equal(fst.header.numStates, 811778);
  assert.ok(fst.dataEnd > fst.dataOffset);
});
