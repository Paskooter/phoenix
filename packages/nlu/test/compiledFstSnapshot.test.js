import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CompiledFstExecutor, VectorStandardFst } from '../src/compiledFst.js';
import {
  FST_SNAPSHOT_SCHEMA,
  FST_SNAPSHOT_VERSION,
  parseFstSnapshot,
  serializeFstSnapshot,
  stringifyFstSnapshot,
} from '../src/compiledFstSnapshot.js';

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
  writeString(chunks, 'fixture');
  const available = Buffer.alloc(8); available.writeBigInt64LE(1_000_000_000n); chunks.push(available);
  const count = Buffer.alloc(8); count.writeBigInt64LE(BigInt(entries.length)); chunks.push(count);
  for (const [label, symbol] of entries) {
    writeString(chunks, symbol);
    const key = Buffer.alloc(8); key.writeBigInt64LE(BigInt(label)); chunks.push(key);
  }
}

function vectorFst(states, outputSymbols = []) {
  const chunks = [];
  const magic = Buffer.alloc(4); magic.writeInt32LE(0x7eb2fdd6); chunks.push(magic);
  writeString(chunks, 'vector'); writeString(chunks, 'standard');
  const version = Buffer.alloc(4); version.writeInt32LE(2); chunks.push(version);
  const flags = Buffer.alloc(4); flags.writeInt32LE(3); chunks.push(flags);
  const properties = Buffer.alloc(8); properties.writeBigUInt64LE(0x1_0000_0001n); chunks.push(properties);
  const start = Buffer.alloc(8); start.writeBigInt64LE(0n); chunks.push(start);
  const count = Buffer.alloc(8); count.writeBigInt64LE(BigInt(states.length)); chunks.push(count);
  const arcs = Buffer.alloc(8); arcs.writeBigInt64LE(0n); chunks.push(arcs);
  writeSymbols(chunks, [[0, 'ε'], [1, 'σ'], [107, 'a']]);
  writeSymbols(chunks, [[0, 'ε'], ...outputSymbols]);
  for (const state of states) {
    const final = Buffer.alloc(4); final.writeFloatLE(state.final ?? Infinity); chunks.push(final);
    const arcCount = Buffer.alloc(8); arcCount.writeBigInt64LE(BigInt(state.arcs.length)); chunks.push(arcCount);
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

test('JSON snapshots preserve decoded graph fields, symbols, and special numbers', () => {
  const original = new VectorStandardFst(vectorFst([
    { arcs: [
      { ilabel: 107, olabel: 2000, weight: -0, nextstate: 1 },
      { ilabel: 107, olabel: 2001, weight: NaN, nextstate: 2 },
    ] },
    { final: -Infinity, arcs: [] },
    { final: 0, arcs: [{ ilabel: 32, olabel: 2002, weight: Infinity, nextstate: 3 }] },
    { final: 0, arcs: [] },
  ], [[2000, 'N:{} first'], [2001, 'N:{} second'], [2002, 'é']])) ;
  const document = serializeFstSnapshot(original, {
    sourcePath: 'fixture.fst', sourceSha256: 'a'.repeat(64), sourceBytes: original.bytes.length,
  });
  assert.equal(document.schema, FST_SNAPSHOT_SCHEMA);
  assert.equal(document.version, FST_SNAPSHOT_VERSION);
  const restored = parseFstSnapshot(JSON.parse(stringifyFstSnapshot(document)));
  assert.deepEqual(restored.header, original.header);
  assert.deepEqual([...restored.inputSymbols.byLabel.entries()], [...original.inputSymbols.byLabel.entries()]);
  assert.deepEqual([...restored.outputSymbols.byLabel.entries()], [...original.outputSymbols.byLabel.entries()]);
  assert.equal(Object.is(restored.state(0).arcs[0].weight, -0), true);
  assert.equal(Number.isNaN(restored.state(0).arcs[1].weight), true);
  assert.equal(Object.is(restored.state(1).finalWeight, -Infinity), true);
  assert.equal(restored.state(1).finalWeight, -Infinity);
  assert.equal(restored.state(2).arcs[0].weight, Infinity);
  assert.equal(restored.isFinal(1), false);
  assert.equal(restored.isFinal(2), true);
});

test('JSON-loaded graph executes the same equal-cost path and output symbols', () => {
  const bytes = vectorFst([
    { arcs: [
      { ilabel: 107, olabel: 2000, nextstate: 1 },
      { ilabel: 107, olabel: 2001, nextstate: 2 },
    ] },
    { arcs: [{ ilabel: 32, nextstate: 3 }] },
    { arcs: [{ ilabel: 32, nextstate: 4 }] },
    { final: 0, arcs: [] },
    { final: 0, arcs: [] },
  ], [[2000, "N:{} {% intent='first' %}"], [2001, "N:{} {% intent='second' %}"]]);
  const original = new VectorStandardFst(bytes);
  const restored = parseFstSnapshot(serializeFstSnapshot(original));
  const originalResult = new CompiledFstExecutor(original).parse('a');
  const restoredResult = new CompiledFstExecutor(restored).parse('a');
  assert.deepEqual(restoredResult, originalResult);
});

test('snapshot artifact provenance stays relative', () => {
  const document = serializeFstSnapshot(new VectorStandardFst(vectorFst([{ final: 0, arcs: [] }])), {
    sourcePath: '/private/launch.fst', sourceSha256: 'a'.repeat(64), sourceBytes: 1,
  });
  assert.throws(() => parseFstSnapshot(document), /sourcePath must be a relative label/);
});
