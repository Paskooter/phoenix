// C-03: the unmodified reference registries, the reference environment names and the
// source CLI/startup contract, exercised against the real gateway process.
//
// Source pins (Pegasus 5c0a7390539663ba749d360de348a428c088505c):
//   packages/hub/src/config/HubConfigProvider.ts        env names, defaults, 'http://' prefix
//   packages/hub/src/skill/SkillUtils.ts                URL = baseURL/basePath/v1/main
//   packages/hub/src/skill-list/SkillListGetHttpRequestsHandler.ts  /skills routes + settings filter
//   packages/hub/src/cli/start.ts                       port expression + "Starting hub with config: "
//   packages/utils/src/config/EnvVars.ts                readEnvVars precedence/required
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, hubSetupConfig, HUB_ENV_DEFAULTS } from '../src/config.js';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS_DIR = join(PKG_ROOT, 'resources', 'skills');

// The three index files the pinned hub ships in resources/skills.
const REFERENCE_REGISTRIES = {
  'skills-local.json': { count: 21, first: { id: 'answer', URL: 'http://docker.for.mac.localhost:9002/answer_skill/v1/main' } },
  'skills-pegasus1.json': { count: 20, first: { id: 'answer', URL: 'http://gqa.jibo.aws/answer_skill/v1/main' } },
  'skills-pegasus2.json': { count: 21, first: { id: 'answer', URL: 'http://gqa.jibo.aws/answer_skill/v1/main' } },
};

function freePort() {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

test('every unmodified reference registry loads with source URL composition', async () => {
  for (const [indexFile, expected] of Object.entries(REFERENCE_REGISTRIES)) {
    const config = await loadConfig({ ETCO_hub_skillsConfig: indexFile });
    assert.equal(config.skills.length, expected.count, indexFile);
    assert.deepEqual(
      { id: config.skills[0].id, URL: config.skills[0].URL },
      expected.first,
      indexFile,
    );
    for (const skill of config.skills) {
      if (skill.URL) assert.match(skill.URL, /^http:\/\/.+\/v1\/main$/, skill.id);
      else assert.equal(skill.onRobot, true, `${skill.id} has no URL and is not onRobot`);
    }
  }
});

test('hub config reads the reference NET_/ETCO_ names with source precedence', () => {
  // HubConfigProvider.ts:24-33 - the exact default surface, incl. the unused speechConfig.
  assert.deepEqual(HUB_ENV_DEFAULTS, {
    ETCO_hub_disableAuth: 'false',
    ETCO_hub_skillsConfig: 'skills-local.json',
    ETCO_hub_speechConfig: 'google-speech.json',
    NET_parser: 'docker.for.mac.localhost:9005',
    NET_history: 'docker.for.mac.localhost:9006',
    ETCO_hub_recordSpeechHistory: 'false',
    ETCO_hub_recordLaunchHistory: 'true',
    NET_settings: 'settings.jibo.aws',
  });
});

test('hub config defaults, precedence and required-variable behaviour', async () => {
  // An unmodified reference environment: only NET_*/ETCO_* names, no Phoenix aliases.
  const source = await loadConfig({});
  assert.equal(source.disableAuth, false);
  assert.equal(source.parserURL, 'http://docker.for.mac.localhost:9005');
  assert.equal(source.historyURL, 'http://docker.for.mac.localhost:9006');
  assert.equal(source.settingsURL, 'http://settings.jibo.aws');
  assert.equal(source.recordSpeechHistory, false);
  assert.equal(source.recordLaunchHistory, true);

  // Reference names win; the ETCO_*Url aliases are Phoenix deployment extensions
  // consulted only when the source name is absent.
  const reference = await loadConfig({ NET_parser: 'parser:9090', NET_history: 'history:9091', NET_settings: 'settings:9092' });
  assert.equal(reference.parserURL, 'http://parser:9090');
  assert.equal(reference.historyURL, 'http://history:9091');
  assert.equal(reference.settingsURL, 'http://settings:9092');
  const alias = await loadConfig({ ETCO_hub_parserUrl: 'https://proxy.example' });
  assert.equal(alias.parserURL, 'https://proxy.example');
  const aliasLosesToSource = await loadConfig({ NET_parser: 'parser:9090', ETCO_hub_parserUrl: 'https://proxy.example' });
  assert.equal(aliasLosesToSource.parserURL, 'http://parser:9090');

  // Source flags are compared to the exact string 'true' (HubConfigProvider.ts:39-48).
  const flags = await loadConfig({ ETCO_hub_disableAuth: 'TRUE', ETCO_hub_recordSpeechHistory: 'TRUE', ETCO_hub_recordLaunchHistory: 'TRUE' });
  assert.equal(flags.disableAuth, false);
  assert.equal(flags.recordSpeechHistory, false);
  assert.equal(flags.recordLaunchHistory, false);
  // An empty source value falls back to the source default (readEnvVars `||`).
  const empty = await loadConfig({ NET_settings: '', ETCO_hub_recordLaunchHistory: '' });
  assert.equal(empty.settingsURL, 'http://settings.jibo.aws');
  assert.equal(empty.recordLaunchHistory, true);
});

test('startup setup log redacts each skill exactly like the source cli', async () => {
  const config = await loadConfig({});
  const report = config.skills.find((skill) => skill.id === 'report-skill');
  assert.ok(report.settings, 'fixture registry no longer carries settings metadata');
  assert.ok(report.proactives, 'fixture registry no longer carries proactives');

  const logged = hubSetupConfig(config);
  // HubConfig shape: interfaces.ts:14-21.
  assert.deepEqual(Object.keys(logged), ['disableAuth', 'parser', 'history', 'hubSettings', 'skills', 'settings']);
  assert.deepEqual(logged.parser, { baseURL: config.parserURL });
  assert.deepEqual(logged.hubSettings, { recordSpeechHistory: false, recordLaunchHistory: true });
  assert.equal(logged.skills.length, config.skills.length);
  for (const skill of logged.skills) {
    assert.equal('intents' in skill, false, skill.id);
    assert.equal('settings' in skill, false, skill.id);
    assert.equal('proactives' in skill, false, skill.id);
    assert.equal(typeof skill.URL, 'string', skill.id);
  }
  // The original config object is not mutated by the redaction.
  assert.ok(config.skills.find((s) => s.id === 'report-skill').settings);
});

test('gateway runs under the reference environment: source CLI port, registry and setup log', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-c03-env-'));
  const emptyEnvFile = join(dir, 'empty.env');
  writeFileSync(emptyEnvFile, '');
  const port = await freePort();

  // ONLY reference names: NET_parser/history/settings, ETCO_hub_disableAuth and
  // ETCO_server_port. No NET_skills, no ETCO_hub_*Url, no PORT, no PHOENIX_*.
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    PHOENIX_ENV_FILE: emptyEnvFile,
    NET_parser: '127.0.0.1:9',
    NET_history: '127.0.0.1:9',
    NET_settings: '127.0.0.1:9',
    ETCO_hub_disableAuth: 'true',
    ETCO_server_port: String(port),
  };
  const child = spawn(process.execPath, ['packages/gateway/src/index.js'], {
    cwd: join(PKG_ROOT, '..', '..'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(() => child.kill('SIGKILL'));

  let ready = false;
  for (let i = 0; i < 60 && !ready; i += 1) {
    await delay(100);
    try { ready = (await fetch(`http://127.0.0.1:${port}/healthcheck`)).ok; } catch { /* not up yet */ }
  }
  assert.ok(ready, `gateway did not listen on ETCO_server_port ${port}; stdout=${stdout} stderr=${stderr}`);

  const get = async (path) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: response.status, body: await response.text() };
  };

  const all = await get('/v1/skills/robot-1');
  assert.equal(all.status, 200);
  const allBody = JSON.parse(all.body);
  assert.equal(allBody.skills.length, REFERENCE_REGISTRIES['skills-local.json'].count);
  assert.deepEqual(
    { id: allBody.skills[0].id, URL: allBody.skills[0].URL },
    REFERENCE_REGISTRIES['skills-local.json'].first,
  );

  const bare = await get('/skills/robot-1');
  assert.equal(bare.status, 200);
  assert.deepEqual(JSON.parse(bare.body), allBody);

  // The source settings route filters on truthy manifest settings metadata
  // (SkillListGetHttpRequestsHandler.ts:22,38-42). In skills-local.json exactly
  // one manifest (report_skill_manifest.json) declares `settings`.
  const filtered = await get('/v1/skills/settings/robot-1');
  assert.equal(filtered.status, 200);
  assert.deepEqual(JSON.parse(filtered.body).skills.map((s) => s.id), ['report-skill']);
  assert.deepEqual(JSON.parse((await get('/skills/settings/robot-1')).body), JSON.parse(filtered.body));

  assert.equal((await get('/no-such-route')).status, 404);

  // The source startup record, projected onto HubConfig.
  const setupLine = stdout.split('\n').map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .find((line) => line && line.msg === 'Starting hub with config: ');
  assert.ok(setupLine, `no setup log line in stdout: ${stdout}`);
  assert.deepEqual(setupLine.parser, { baseURL: 'http://127.0.0.1:9' });
  assert.deepEqual(setupLine.settings, { baseURL: 'http://127.0.0.1:9' });
  assert.equal(setupLine.disableAuth, true);
  assert.deepEqual(setupLine.hubSettings, { recordSpeechHistory: false, recordLaunchHistory: true });
  assert.equal(setupLine.skills.length, REFERENCE_REGISTRIES['skills-local.json'].count);
  assert.equal(setupLine.skills.some((skill) => 'intents' in skill || 'settings' in skill || 'proactives' in skill), false);
});

test('gateway executable honours the source argv port and help, not only PORT', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-c03-cli-'));
  const emptyEnvFile = join(dir, 'empty.env');
  writeFileSync(emptyEnvFile, '');
  const port = await freePort();
  const root = join(PKG_ROOT, '..', '..');
  const child = spawn(process.execPath, ['packages/gateway/src/index.js', '--port', String(port)], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      PHOENIX_ENV_FILE: emptyEnvFile,
      NET_parser: '127.0.0.1:9',
      NET_history: '127.0.0.1:9',
      NET_settings: '127.0.0.1:9',
      ETCO_hub_disableAuth: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { out += chunk; });
  try {
    let ready = false;
    for (let i = 0; i < 60 && !ready; i += 1) {
      await delay(100);
      try { ready = (await fetch(`http://127.0.0.1:${port}/healthcheck`)).ok; } catch { /* not up yet */ }
    }
    assert.ok(ready, `gateway ignored --port ${port}: ${out}`);
  } finally {
    child.kill('SIGKILL');
  }

  // Hub help omits the `[options]` suffix the other services print (cli/start.ts:11-15).
  const help = spawn(process.execPath, ['packages/gateway/src/index.js', '--help'], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, PHOENIX_ENV_FILE: emptyEnvFile, ETCO_hub_disableAuth: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let helpOut = '';
  help.stdout.on('data', (chunk) => { helpOut += chunk; });
  const status = await new Promise((resolve) => help.on('exit', resolve));
  assert.equal(status, 0);
  assert.equal(helpOut.trim(), 'Usage: index.js\n  Options:\n  --port, -p: [default: 8080] Port of service');
});
