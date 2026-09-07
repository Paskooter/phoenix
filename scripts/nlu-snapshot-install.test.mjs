import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
  COMPILED_FST_PROFILE,
  FST_PROFILE_SCHEMA,
  FST_PROFILE_VERSION,
} from '../packages/nlu/src/compiledFstProfile.js';
import {
  FST_SNAPSHOT_SCHEMA,
  FST_SNAPSHOT_VERSION,
} from '../packages/nlu/src/compiledFstSnapshot.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INSTALLER = join(REPO_ROOT, 'scripts/install-nlu-snapshot.mjs');
const INVENTORY_PATH = join(REPO_ROOT, 'packages/nlu/resources/rule-inventory.json');
const TEST_BUNDLE = process.env.PHOENIX_NLU_TEST_BUNDLE;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function approvedSkeleton() {
  const inventoryBytes = readFileSync(INVENTORY_PATH);
  const inventory = JSON.parse(inventoryBytes.toString('utf8'));
  return {
    schema: FST_PROFILE_SCHEMA,
    version: FST_PROFILE_VERSION,
    kind: 'compiled-fst-profile',
    format: { schema: FST_SNAPSHOT_SCHEMA, version: FST_SNAPSHOT_VERSION, storage: 'gzip' },
    profile: {
      runtime: COMPILED_FST_PROFILE.runtime,
      approvedLaunchSha256: COMPILED_FST_PROFILE.approvedLaunchSha256,
      approvedInventorySha256: COMPILED_FST_PROFILE.approvedInventorySha256,
      sourceRevision: COMPILED_FST_PROFILE.sourceRevision,
      referenceRevision: COMPILED_FST_PROFILE.referenceRevision,
      sourceRuntime: COMPILED_FST_PROFILE.sourceRuntime,
      nativeParserSha256: COMPILED_FST_PROFILE.nativeParserSha256,
      factoryManifestSha256: COMPILED_FST_PROFILE.factoryManifestSha256,
      ruleManifestSha256: '0'.repeat(64),
      decodedHashAnchorSha256: COMPILED_FST_PROFILE.decodedHashAnchorSha256,
    },
    inventory: {
      referenceRevision: inventory.referenceRevision,
      sha256: sha256(inventoryBytes),
      publicRuleCount: Object.keys(inventory.publicRules).length,
      factoryCount: Object.keys(COMPILED_FST_PROFILE.factoryFiles)
        .filter(name => name.endsWith('.fst')).length,
    },
    ruleManifestSha256: '0'.repeat(64),
    factoryManifestSha256: COMPILED_FST_PROFILE.factoryManifestSha256,
    graphs: {},
    factories: {},
    factoryFiles: {},
  };
}

function runInstaller(input, output) {
  return spawnSync(process.execPath, [INSTALLER, '--input', input, '--output', output], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120000,
  });
}

test('installer rejects an incomplete profile before creating a destination', () => {
  const root = mkdtempSync(join(tmpdir(), 'phoenix-nlu-install-incomplete-'));
  try {
    const input = join(root, 'input');
    const output = join(root, 'output');
    mkdirSync(input);
    writeFileSync(join(input, 'profile.json'), JSON.stringify(approvedSkeleton()) + '\n');
    const result = runInstaller(input, output);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /approved complete set/);
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('installer rejects an artifact path that escapes the bundle', () => {
  const root = mkdtempSync(join(tmpdir(), 'phoenix-nlu-install-path-'));
  try {
    const input = join(root, 'input');
    const output = join(root, 'output');
    mkdirSync(input);
    const manifest = approvedSkeleton();
    const inventory = JSON.parse(readFileSync(INVENTORY_PATH, 'utf8'));
    manifest.graphs = Object.fromEntries(Object.keys(inventory.publicRules).map(name => [name, {
      path: '../outside.json.gz', snapshotSha256: '0'.repeat(64), snapshotBytes: 0,
      sourcePath: 'rules_fst/placeholder.fst', sourceSha256: '0'.repeat(64), sourceBytes: 0,
    }]));
    manifest.factories = Object.fromEntries(Object.keys(COMPILED_FST_PROFILE.factoryFiles)
      .filter(name => name.endsWith('.fst')).map(name => [name.slice(0, -4), {
        kind: 'fst', path: `factories/${name}.json.gz`, snapshotSha256: '0'.repeat(64), snapshotBytes: 0,
        sourcePath: `build/data/en-us/factory_rules/${name}`, sourceSha256: '0'.repeat(64), sourceBytes: 0,
      }]));
    manifest.factoryFiles = Object.fromEntries(Object.keys(COMPILED_FST_PROFILE.factoryFiles)
      .map(name => [name, {}]));
    writeFileSync(join(input, 'profile.json'), JSON.stringify(manifest) + '\n');
    const result = runInstaller(input, output);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /unsafe segment/);
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('installer rejects missing and corrupt artifacts from an otherwise approved bundle', {
  skip: !TEST_BUNDLE,
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'phoenix-nlu-install-invalid-'));
  const input = join(root, 'input');
  const output = join(root, 'output');
  cpSync(resolve(TEST_BUNDLE), input, { recursive: true });
  try {
    const manifest = JSON.parse(readFileSync(join(input, 'profile.json'), 'utf8'));
    const graph = manifest.graphs[Object.keys(manifest.graphs)[0]];
    const graphPath = join(input, graph.path);
    const original = readFileSync(resolve(TEST_BUNDLE, graph.path));

    rmSync(graphPath);
    let result = runInstaller(input, output);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /artifact is unavailable/);
    assert.equal(existsSync(output), false);

    writeFileSync(graphPath, original);
    const corrupt = Buffer.from(original);
    corrupt[corrupt.length - 1] ^= 1;
    writeFileSync(graphPath, corrupt);
    result = runInstaller(input, output);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /stored hash|cannot be decoded|decoded hash/);
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function freePort() {
  const server = net.createServer();
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const port = server.address().port;
  await new Promise((resolvePromise, reject) => server.close(error => error ? reject(error) : resolvePromise()));
  return port;
}

async function stopProcess(child) {
  if (child.exitCode === null) child.kill('SIGTERM');
  await new Promise(resolvePromise => {
    if (child.exitCode !== null) {
      resolvePromise();
      return;
    }
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
      resolvePromise();
    }, 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

async function waitForHealth(child, port, stderr) {
  const deadline = Date.now() + 120000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`NLU process exited ${child.exitCode}: ${stderr.join('').slice(-2000)}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthcheck`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) return;
      lastError = new Error(`health status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  throw new Error(`timed out waiting for NLU health: ${lastError?.message || 'unknown error'}`);
}

test('approved bundle installs, starts the real NLU service, and serves a parse', {
  skip: !TEST_BUNDLE,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'phoenix-nlu-install-live-'));
  const output = join(root, 'installed');
  let child;
  try {
    const installStarted = process.hrtime.bigint();
    const result = runInstaller(resolve(TEST_BUNDLE), output);
    const installMs = Number(process.hrtime.bigint() - installStarted) / 1e6;
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.verified, true);
    assert.equal(receipt.graphCount, 98);
    assert.equal(receipt.factoryCount, 15);
    assert.equal(receipt.factoryFileCount, 16);
    assert.equal(receipt.runtime, 'compiled-fst');
    assert.equal(receipt.runtimeMetadata.snapshotManifest, join(output, 'profile.json'));

    const port = await freePort();
    const env = { ...process.env, PORT: String(port), PHOENIX_NLU_RUNTIME: 'compiled-fst',
      PHOENIX_NLU_COMPILED_SNAPSHOT_MANIFEST: join(output, 'profile.json') };
    for (const key of Object.keys(env)) {
      if (key.startsWith('PHOENIX_NLU_') && key !== 'PHOENIX_NLU_RUNTIME'
        && key !== 'PHOENIX_NLU_COMPILED_SNAPSHOT_MANIFEST') delete env[key];
    }
    child = spawn(process.execPath, ['packages/nlu/src/index.js'], {
      cwd: REPO_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stderr = [];
    child.stderr.on('data', chunk => stderr.push(String(chunk)));
    const startupStarted = process.hrtime.bigint();
    await waitForHealth(child, port, stderr);
    const startupMs = Number(process.hrtime.bigint() - startupStarted) / 1e6;
    const response = await fetch(`http://127.0.0.1:${port}/v1/parse`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'NLU', data: { text: 'who is jane jetson', rules: ['launch'] } }),
      signal: AbortSignal.timeout(30000),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.intent, 'whoIsPerson');
    assert.equal(body.data.entities.GivenName, 'jane');
    console.log(JSON.stringify({ installMs: Math.round(installMs * 1000) / 1000,
      startupMs: Math.round(startupMs * 1000) / 1000, parseStatus: response.status }));
  } finally {
    if (child) await stopProcess(child);
    rmSync(root, { recursive: true, force: true });
  }
});
