// C-03: an invalid configuration must be REJECTED exactly as the pinned reference
// rejects it - a bad index, a missing/malformed manifest or an invalid skill config
// must never be silently dropped or replaced by a fallback.
//
// Expectations are the retained original Node 8.9.4 observations in
// fixtures/registry-original.json.gz, whose compressed and gunzipped sha256 are
// asserted by registry.test.js. The rows mirrored here come from the shared case
// generator scripts/parity-reference/gateway-registry-cases.cjs, so this file is a
// focused, readable form of the same reference contract - not a second oracle.
//
// Source pins (Pegasus 5c0a7390539663ba749d360de348a428c088505c):
//   packages/hub/src/config/ConfigFileValidator.ts   index + skill-service config rejection
//   packages/hub/src/config/SkillUtils.ts            manifest read + URL composition
//   packages/hub/src/config/SkillConfigValidator.ts  per-skill config rejection
//   packages/utils/src/config/EnvVars.ts             readEnvVars required-variable rejection
//   packages/hub/src/cli/start.ts + utils/common/run-service.js  executable boundary
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { loadRegistry } from '../src/registry.js';
import { loadConfig } from '../src/config.js';
import { createGateway } from '../src/index.js';
import { SkillConfigManager } from '../src/skillClient.js';
import { readEnvVars } from '@phoenix/common';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// The same manifest the reference case generator uses as its baseline.
function basicManifest() {
  return {
    id: 'alpha',
    intents: [{ name: 'hello', memo: { greeting: true } }],
    settings: { view: { type: 'group', index: 0, childViews: [{ type: 'toggle', index: 1, valueDefinition: { target: 'lasso', key: 'enabled' } }] } },
    basePath: '/api/custom/',
    vendor: { keep: [1, false] },
    URL: 'overwritten',
  };
}

function writeCase(root, row) {
  mkdirSync(join(root, 'resources/skills'), { recursive: true });
  writeFileSync(join(root, 'resources/skills/cases.json'), row.rawIndex !== undefined ? row.rawIndex : JSON.stringify(row.index));
  for (const file of Object.keys(row.files || {})) {
    const value = row.files[file];
    writeFileSync(join(root, file), value && value.raw !== undefined ? value.raw : JSON.stringify(value));
  }
}

/** Load one invalid registry and return the reference-shaped rejection. */
async function rejection(root, row) {
  writeCase(root, row);
  try {
    const skills = await loadRegistry({ rootPath: root, indexFile: 'cases.json', env: {} });
    return { accepted: true, skills };
  } catch (error) {
    // JSON is the retained reference observation format, so undefined fields are omitted.
    const observed = { name: error.name, message: error.message.split(root).join('<fixture>') };
    if (error.code !== undefined) observed.code = error.code;
    return { accepted: false, error: observed };
  }
}

test('an invalid or malformed registry index is rejected with the reference error', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phoenix-c03-index-'));
  try {
    const rows = [
      // ConfigFileValidator.validateSkillsConfig (ConfigFileValidator.ts:31-40)
      [{ skills: {} }, { name: 'Error', message: "Hub service config missing required list parameter 'skills'" }],
      [{}, { name: 'Error', message: "Hub service config missing required list parameter 'skills'" }],
      [null, { name: 'TypeError', message: "Cannot read property 'skills' of null" }],
      // ConfigFileValidator.validateSkillServiceConfig (ConfigFileValidator.ts:22-28)
      [{ skills: [null] }, { name: 'TypeError', message: "Cannot read property 'baseURL' of null" }],
      [{ skills: [{}] }, { name: 'Error', message: "Skill service config missing required parameter 'configPath'" }],
      [{ skills: [{ configPath: 1 }] }, { name: 'Error', message: "Skill service config missing required parameter 'configPath'" }],
    ];
    for (const [index, expected] of rows) {
      const result = await rejection(root, { index, files: {} });
      assert.equal(result.accepted, false, `accepted ${JSON.stringify(index)}`);
      assert.equal(result.skills, undefined);
      assert.deepEqual(result.error, expected, JSON.stringify(index));
    }
    // The reference surfaces a JSON parse failure with its own legacy wording.
    const broken = await rejection(root, { rawIndex: '{"skills":', files: {} });
    assert.deepEqual(broken.error, { name: 'Error', message: "Error when parsing '<fixture>/resources/skills/cases.json': Unexpected end of JSON input" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an invalid or malformed skill manifest is rejected, never skipped', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phoenix-c03-manifest-'));
  try {
    const rows = [
      [{ configPath: 'missing.json' }, undefined, { name: 'Error', message: "ENOENT: no such file or directory, open '<fixture>/missing.json'", code: 'ENOENT' }],
      [{ configPath: 'manifest.json' }, { raw: '{"a":}' }, { name: 'Error', message: "Error when parsing '<fixture>/manifest.json': Unexpected token } in JSON at position 5" }],
      [{}, null, { name: 'TypeError', message: "Cannot set property 'URL' of null" }],
      [{}, 5, { name: 'TypeError', message: "Cannot create property 'URL' on number '5'" }],
      [{ baseURL: 4 }, basicManifest(), { name: 'TypeError', message: 'pathElement.startsWith is not a function' }],
      [{ baseURL: 'http://skill/' }, Object.assign(basicManifest(), { basePath: null }), { name: 'TypeError', message: "Cannot read property 'startsWith' of null" }],
    ];
    for (const [entry, manifest, expected] of rows) {
      const index = { skills: [Object.assign({ configPath: 'manifest.json' }, entry)] };
      const files = entry.configPath === 'missing.json' ? {} : { 'manifest.json': manifest };
      const result = await rejection(root, { index, files });
      assert.equal(result.accepted, false, `accepted ${JSON.stringify(entry)}`);
      assert.deepEqual(result.error, expected, JSON.stringify(entry));
    }
    // A missing manifest anywhere fails the whole load: the reference does not
    // return the manifests that did resolve.
    const mixed = await rejection(root, {
      index: { skills: [{ configPath: 'missing.json' }, { configPath: 'manifest.json', baseURL: 'http://skill' }] },
      files: { 'manifest.json': basicManifest() },
    });
    assert.deepEqual(mixed.error, { name: 'Error', message: "ENOENT: no such file or directory, open '<fixture>/missing.json'", code: 'ENOENT' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('startup rejects an invalid skill configuration instead of serving a partial registry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phoenix-c03-skill-'));
  try {
    // SkillConfigValidator.validateSkillConfig (SkillConfigValidator.ts:10-20)
    mkdirSync(join(root, 'resources/skills'), { recursive: true });
    // loadConfig resolves the source default index name unless ETCO_hub_skillsConfig is set.
    writeFileSync(join(root, 'resources/skills/skills-local.json'), JSON.stringify({ skills: [{ configPath: 'manifest.json' }] }));
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({ id: 'broken', intents: [] }));
    const config = await loadConfig({}, { rootPath: root });
    await assert.rejects(createGateway(config), /Need to either be 'onRobot: true' or have URL: broken/);

    // ManifestSettingViewValidator through the real startup path. The loader always
    // replaces URL from the index entry, so the manifest needs a baseURL to get past
    // the URL check that the reference runs first (SkillConfigValidator.ts:16-20).
    writeFileSync(join(root, 'resources/skills/skills-local.json'), JSON.stringify({ skills: [{ configPath: 'manifest.json', baseURL: 'http://skill' }] }));
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({ id: 'broken', intents: [], settings: { view: { type: '  ', index: 0 } } }));
    const withView = await loadConfig({}, { rootPath: root });
    await assert.rejects(createGateway(withView), /Error validating manifest settings, Error: "type" must be non-empty string/);

    // The in-process validator throws the same reference text in the same order.
    assert.throws(() => new SkillConfigManager([{ id: 'broken', intents: [] }]), /URL missing: broken/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the gateway executable refuses to start under an invalid reference registry', async () => {
  // The reference hub resolves its registry inside cli/start.ts -> HubConfigProvider
  // .getConfig(); a rejection reaches run-service.handleError, which logs and exits 1
  // after five seconds (utils/common/run-service.js:16-30) without ever listening.
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-c03-boundary-'));
  const emptyEnvFile = join(dir, 'empty.env');
  writeFileSync(emptyEnvFile, '');
  const port = await new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => { const { port: p } = probe.address(); probe.close(() => resolve(p)); });
  });
  const child = spawn(process.execPath, ['packages/gateway/src/index.js'], {
    cwd: REPO_ROOT,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      PHOENIX_ENV_FILE: emptyEnvFile,
      NET_parser: '127.0.0.1:9',
      NET_history: '127.0.0.1:9',
      NET_settings: '127.0.0.1:9',
      ETCO_hub_disableAuth: 'true',
      ETCO_server_port: String(port),
      ETCO_hub_skillsConfig: 'does-not-exist.json',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    let listened = false;
    for (let i = 0; i < 20 && !listened; i += 1) {
      await delay(100);
      try { listened = (await fetch(`http://127.0.0.1:${port}/healthcheck`)).ok; } catch { /* not up */ }
    }
    const exitCode = await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve('still running'); }, 12000);
      child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
    });
    assert.equal(listened, false, `gateway served traffic despite an invalid registry: ${stdout}`);
    assert.equal(exitCode, 1);
    assert.equal(stdout.includes('Starting hub with config'), false, 'the source logs the setup record only after a successful config load');
    assert.match(stderr, /ENOENT/);
    assert.match(stderr, /does-not-exist\.json/);
  } finally { child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
});

test('required reference environment variables are rejected by name', () => {
  // packages/utils/src/config/EnvVars.ts:14-16 - a null default is required.
  assert.throws(() => readEnvVars({ NET_lasso: null }, {}), {
    name: 'Error',
    message: "Required env variable 'NET_lasso' does not exist",
  });
  assert.throws(() => readEnvVars({ NET_lasso: null }, { NET_lasso: '' }), { message: "Required env variable 'NET_lasso' does not exist" });
  // HubConfigProvider declares no required variable, so an empty environment loads.
  assert.deepEqual(readEnvVars({ ETCO_hub_disableAuth: 'false' }, {}), { ETCO_hub_disableAuth: 'false' });
});
