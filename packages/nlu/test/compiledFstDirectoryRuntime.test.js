import assert from 'node:assert/strict';
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

const DIRECTORY_ERROR = /PHOENIX_NLU_COMPILED_FST_DIRECTORIES.*(?:unsupported|unprovenanced|parity)/i;

async function withConfig(values, fn) {
  try {
    for (const key of keys) {
      if (values[key] === undefined) delete process.env[key];
      else process.env[key] = values[key];
    }
    const runtime = await import(`../src/compiledFstRuntime.js?directory-closed=${instance++}`);
    const index = await import(`../src/index.js?directory-closed=${instance++}`);
    return await fn({ runtime, index });
  } finally {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}

// DIVERGENCES.md N-hardening-fst-directories: the original production parser
// globbed fstDirectories; Phoenix accepts only provenance-pinned graph profiles.
test('the default parser profile is AST when compiled artifacts are not selected', async () => {
  await withConfig({}, ({ runtime }) => {
    assert.equal(runtime.getCompiledFstRuntime(), null);
    assert.equal(runtime.defaultParserProfile(), 'ast');
  });
});

test('unprovenanced directory discovery is not a selectable compiled profile', async () => {
  await withConfig({
    PHOENIX_NLU_RUNTIME: 'compiled-fst',
    PHOENIX_NLU_COMPILED_FST_DIRECTORIES: '/unused/unprovenanced-rules',
  }, ({ runtime }) => {
    assert.throws(runtime.getCompiledFstRuntime, DIRECTORY_ERROR);
    assert.throws(runtime.defaultParserProfile, DIRECTORY_ERROR);
  });
});

test('directory discovery cannot be mixed into an approved profile', async () => {
  await withConfig({
    PHOENIX_NLU_RUNTIME: 'compiled-fst',
    PHOENIX_NLU_COMPILED_FST_DIRECTORIES: '/unused/unprovenanced-rules',
    PHOENIX_NLU_COMPILED_FST: '/unused/launch.fst',
    PHOENIX_NLU_COMPILED_FST_SHA256: '0'.repeat(64),
  }, ({ runtime }) => {
    assert.throws(runtime.getCompiledFstRuntime, /cannot combine directory discovery/);
  });
  await withConfig({
    PHOENIX_NLU_RUNTIME: 'compiled-fst',
    PHOENIX_NLU_COMPILED_FST_DIRECTORIES: '/unused/unprovenanced-rules',
    PHOENIX_NLU_COMPILED_SNAPSHOT_MANIFEST: '/unused/profile.json',
  }, ({ runtime }) => {
    assert.throws(runtime.getCompiledFstRuntime, /cannot combine a JSON snapshot manifest/);
  });
});

test('directory discovery prevents the HTTP listener from starting', async () => {
  await withConfig({
    PHOENIX_NLU_RUNTIME: 'compiled-fst',
    PHOENIX_NLU_COMPILED_FST_DIRECTORIES: '/unused/unprovenanced-rules',
  }, ({ index }) => {
    assert.throws(() => index.start(0), DIRECTORY_ERROR);
  });
});
