import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
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
  'PHOENIX_NLU_COMPILED_FST_DIRECTORIES',
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

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hardlinkTree(source, target) {
  mkdirSync(target, { recursive: true });
  for (const name of readdirSync(source)) {
    const sourcePath = join(source, name);
    const targetPath = join(target, name);
    if (lstatSync(sourcePath).isDirectory()) hardlinkTree(sourcePath, targetPath);
    else linkSync(sourcePath, targetPath);
  }
}

test('trusted decoded hash anchor rejects a self-consistent graph/profile mutation', { skip: !configured }, () => {
  const sourceRoot = join(manifest, '..');
  const overlayRoot = mkdtempSync(join(tmpdir(), 'phoenix-fst-anchor-control-'));
  const overlayProfile = join(overlayRoot, 'profile');
  hardlinkTree(sourceRoot, overlayProfile);
  const targetEntry = 'circuit-saver/play_again';
  const overlayManifest = join(overlayProfile, 'profile.json');
  const sourceManifest = JSON.parse(readFileSync(manifest, 'utf8'));
  const entry = sourceManifest.graphs[targetEntry];
  const target = join(overlayProfile, entry.path);
  try {
    unlinkSync(target);
    unlinkSync(overlayManifest);
    const compression = entry.compression || 'json';
    const stored = readFileSync(join(sourceRoot, entry.path));
    const decoded = compression === 'gzip' ? gunzipSync(stored) : stored;
    const document = JSON.parse(decoded.toString('utf8'));
    document.header.numArcs += 1;
    document.artifact.sourceBytes += 1;
    const mutatedDecoded = Buffer.from(JSON.stringify(document) + '\n');
    const mutatedStored = compression === 'gzip'
      ? gzipSync(mutatedDecoded, { level: 9, mtime: 0 }) : mutatedDecoded;
    writeFileSync(target, mutatedStored);
    entry.sourceBytes += 1;
    entry.snapshotSha256 = sha256(mutatedDecoded);
    entry.snapshotBytes = mutatedDecoded.length;
    if (compression === 'gzip') {
      entry.storedSha256 = sha256(mutatedStored);
      entry.storedBytes = mutatedStored.length;
    }
    writeFileSync(overlayManifest, JSON.stringify(sourceManifest) + '\n');
    const runtimeUrl = new URL('../src/compiledFstRuntime.js', import.meta.url).href;
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('PHOENIX_NLU_')) delete env[key];
    env.PHOENIX_NLU_RUNTIME = 'compiled-fst';
    env.PHOENIX_NLU_COMPILED_SNAPSHOT_MANIFEST = overlayManifest;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { getCompiledFstRuntime } from ${JSON.stringify(runtimeUrl)}; getCompiledFstRuntime();`],
    { cwd: process.cwd(), env, encoding: 'utf8', timeout: 120000 });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /trusted hash anchor mismatch/);
  } finally {
    rmSync(overlayRoot, { recursive: true, force: true });
  }
});
