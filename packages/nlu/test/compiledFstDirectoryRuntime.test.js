import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const keys = [
  'PHOENIX_NLU_RUNTIME',
  'PHOENIX_NLU_COMPILED_FST',
  'PHOENIX_NLU_COMPILED_FACTORY_DIR',
  'PHOENIX_NLU_COMPILED_RULES_DIR',
  'PHOENIX_NLU_COMPILED_FST_SHA256',
  'PHOENIX_NLU_COMPILED_SNAPSHOT_MANIFEST',
  'PHOENIX_NLU_COMPILED_FST_DIRECTORIES',
  'PHOENIX_NLU_COMPILED_HOME',
];
const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
let instance = 0;

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

async function withConfig(values, fn) {
  try {
    for (const key of keys) {
      if (values[key] === undefined) delete process.env[key];
      else process.env[key] = values[key];
    }
    const runtime = await import(`../src/compiledFstRuntime.js?dir=${instance}`);
    const parser = await import(`../src/requestParser.js?dir=${instance}`);
    return await fn({ ...runtime, ...parser, instance: instance++ });
  } finally {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}

test('the default parser profile is AST when compiled artifacts are not selected', async () => {
  await withConfig({}, ({ getCompiledFstRuntime, defaultParserProfile }) => {
    assert.equal(getCompiledFstRuntime(), null);
    assert.equal(defaultParserProfile(), 'ast');
  });
});

test('directory discovery cannot mix with snapshot or closed binary pins', async () => {
  await withConfig({
    PHOENIX_NLU_RUNTIME: 'compiled-fst',
    PHOENIX_NLU_COMPILED_SNAPSHOT_MANIFEST: '/unused/profile.json',
    PHOENIX_NLU_COMPILED_FST_DIRECTORIES: '/unused/rules',
  }, ({ getCompiledFstRuntime }) => {
    assert.throws(getCompiledFstRuntime, /cannot combine a JSON snapshot manifest/);
  });
  await withConfig({
    PHOENIX_NLU_RUNTIME: 'compiled-fst',
    PHOENIX_NLU_COMPILED_FST_DIRECTORIES: '/unused/rules',
    PHOENIX_NLU_COMPILED_FST: '/unused/launch.fst',
    PHOENIX_NLU_COMPILED_FST_SHA256: '0'.repeat(64),
  }, ({ getCompiledFstRuntime }) => {
    assert.throws(getCompiledFstRuntime, /cannot combine directory discovery/);
  });
});

test('directory compiled runtime loads graphs outside the 98-rule inventory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-nlu-dir-'));
  try {
    mkdirSync(join(dir, 'skill'), { recursive: true });
    writeFileSync(join(dir, 'skill', 'extra.fst'), intentFst('extraIntent'));
    await withConfig({
      PHOENIX_NLU_RUNTIME: 'compiled-fst',
      PHOENIX_NLU_COMPILED_FST_DIRECTORIES: dir,
    }, ({ getCompiledFstRuntime, compiledFstRuntimeConfig, defaultParserProfile, matchCompiledRule, parseRequest }) => {
      const runtime = getCompiledFstRuntime();
      assert.equal(defaultParserProfile(), 'compiled-fst-directories');
      assert.equal(runtime.acquisition, 'fst-directories');
      assert.equal(runtime.hasRule('skill/extra'), true);
      assert.equal(runtime.hasRule('launch'), false);
      assert.deepEqual(compiledFstRuntimeConfig().ruleNames, ['skill/extra']);
      const compiled = matchCompiledRule('skill/extra', 'a', runtime);
      assert.equal(compiled.intent, 'extraIntent');
      assert.deepEqual(parseRequest({ text: 'a', rules: ['skill/extra'] }), {
        rules: ['skill/extra'],
        intent: 'extraIntent',
        entities: {},
      });
      assert.deepEqual(parseRequest({ text: 'a', rules: ['audit/nonexistent'] }), {
        rules: [], intent: null, entities: null,
      });
      assert.deepEqual(parseRequest({ text: 'a', rules: ['audit/nonexistent', 'skill/extra'] }), {
        rules: ['skill/extra'],
        intent: 'extraIntent',
        entities: {},
      });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a malformed discovered FST fails compiled startup with no AST fallback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-nlu-bad-'));
  try {
    writeFileSync(join(dir, 'broken.fst'), 'not an openfst');
    await withConfig({
      PHOENIX_NLU_RUNTIME: 'compiled-fst',
      PHOENIX_NLU_COMPILED_FST_DIRECTORIES: dir,
    }, async ({ getCompiledFstRuntime }) => {
      assert.throws(getCompiledFstRuntime, /Malformed compiled NLU FST/);
      const { start } = await import(`../src/index.js?dir-bad=${instance++}`);
      assert.throws(() => start(0), /Malformed compiled NLU FST/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('directory compiled listener serves an extra graph on POST /v1/parse', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-nlu-http-'));
  try {
    mkdirSync(join(dir, 'skill'), { recursive: true });
    writeFileSync(join(dir, 'skill', 'extra.fst'), intentFst('extraIntent'));
    await withConfig({
      PHOENIX_NLU_RUNTIME: 'compiled-fst',
      PHOENIX_NLU_COMPILED_FST_DIRECTORIES: dir,
    }, async () => {
      const { start } = await import(`../src/index.js?dir-http=${instance++}`);
      const server = await start(0);
      try {
        const base = `http://127.0.0.1:${server.address().port}`;
        const response = await fetch(`${base}/v1/parse`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'NLU', data: { text: 'a', rules: ['skill/extra'] } }),
        });
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.data.intent, 'extraIntent');
        assert.deepEqual(body.data.rules, ['skill/extra']);
        const unknown = await fetch(`${base}/v1/parse`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'NLU', data: { text: 'a', rules: ['missing/graph'] } }),
        });
        assert.equal(unknown.status, 200);
        assert.deepEqual((await unknown.json()).data, { rules: [], intent: null, entities: null });
      } finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
