import assert from 'node:assert/strict';
import { test } from 'node:test';

const manifest = process.env.PHOENIX_NLU_COMPILED_SNAPSHOT_MANIFEST;
const configured = process.env.PHOENIX_NLU_RUNTIME === 'compiled-fst' && Boolean(manifest);
const original = Object.fromEntries([
  'PHOENIX_NLU_RUNTIME',
  'PHOENIX_NLU_COMPILED_SNAPSHOT_MANIFEST',
  'PHOENIX_NLU_COMPILED_FST',
  'PHOENIX_NLU_COMPILED_FACTORY_DIR',
  'PHOENIX_NLU_COMPILED_RULES_DIR',
  'PHOENIX_NLU_COMPILED_FST_SHA256',
].map(name => [name, process.env[name]]));
let serial = 0;

async function withSnapshot(values, fn) {
  const names = Object.keys(original);
  try {
    for (const name of names) {
      if (values[name] === undefined) delete process.env[name];
      else process.env[name] = values[name];
    }
    return await fn(await import(`../src/compiledFstRuntime.js?snapshot-test=${serial++}`));
  } finally {
    for (const name of names) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  }
}

test('snapshot mode rejects mixing JSON and binary artifact settings', async () => {
  await withSnapshot({
    PHOENIX_NLU_RUNTIME: 'compiled-fst',
    PHOENIX_NLU_COMPILED_SNAPSHOT_MANIFEST: '/unused/profile.json',
    PHOENIX_NLU_COMPILED_FST: '/unused/launch.fst',
  }, ({ getCompiledFstRuntime }) => {
    assert.throws(getCompiledFstRuntime, /cannot combine a JSON snapshot manifest/);
  });
});

test('portable profile executes verified graph and all decoded factory FSTs', { skip: !configured }, async () => {
  await withSnapshot({
    PHOENIX_NLU_RUNTIME: 'compiled-fst',
    PHOENIX_NLU_COMPILED_SNAPSHOT_MANIFEST: manifest,
  }, ({ getCompiledFstRuntime, compiledFstRuntimeConfig, matchCompiledRule }) => {
    const runtime = getCompiledFstRuntime();
    const metadata = compiledFstRuntimeConfig();
    assert.equal(metadata.snapshotManifest, manifest);
    assert.equal(metadata.fstPath, undefined);
    assert.equal(metadata.factoryDir, undefined);
    assert.equal(runtime.executor.factoryFsts.size, 15);
    assert.equal(runtime.ruleCount, 98);
    assert.deepEqual(matchCompiledRule('launch', 'cancel the timer', runtime), {
      rule: 'launch',
      entities: {
        domain: 'timer', hours: 'null', minutes: 'null', seconds: 'null',
        skill: '@be/clock', union_original_fst_name: 'handle:clock/launch',
      },
      intent: 'stop', priority: 'HIGH', score: 13, nativeHeuristic: 4,
    });
    assert.equal(matchCompiledRule('launch', 'what have you been doing', runtime).intent, 'whatDidJiboAction');
    assert.equal(matchCompiledRule('launch', 'where should i shop for christmas', runtime).intent, 'whereShouldUserHolidayShop');
  });
});
