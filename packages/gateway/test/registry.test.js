import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import run from '../../../scripts/parity-reference/gateway-registry-probe.cjs';
import { normalizeHttp } from '../../../scripts/parity-reference/gateway-registry-normalize.mjs';
import { loadRegistry } from '../src/registry.js';
import { loadConfig } from '../src/config.js';
import { SkillConfigManager } from '../src/skillClient.js';
import { createGateway } from '../src/index.js';

test('registry, config and real HTTP boundary match pinned original Node 8 execution', async () => {
  const expected = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/registry-original.json.gz', import.meta.url))));
  const actual = await run({
    name: 'unit-test',
    manager: configs => new SkillConfigManager(configs),
    registry: (rootPath, indexFile) => loadRegistry({ rootPath, indexFile }),
    config: async env => {
      const { disableAuth, parserURL, historyURL, settingsURL, recordLaunchHistory, recordSpeechHistory } = await loadConfig(env);
      return { disableAuth, parserURL, historyURL, settingsURL, recordLaunchHistory, recordSpeechHistory };
    },
    server: async skills => {
      const gateway = await createGateway({ disableAuth: false, hubTokenSecret: '', parserURL: 'http://127.0.0.1:9', historyURL: 'http://127.0.0.1:9', skills });
      await gateway.service.listen(0);
      return { port: gateway.service.server.address().port, close: () => new Promise(resolve => gateway.service.server.close(resolve)) };
    },
  }, null);
  // JSON is the retained original observation format (undefined fields omitted).
  const serial = JSON.parse(JSON.stringify(actual));
  for (const group of ['validations', 'registries', 'config']) {
    const actualIDs = serial[group].map(row => row.id);
    const expectedIDs = expected[group].map(row => row.id);
    assert.deepEqual(actualIDs, expectedIDs, `${group}/ordered ids`);
    assert.equal(new Set(actualIDs).size, actualIDs.length, `${group}/unique ids`);
    assert.deepEqual(serial[group], expected[group], group);
  }
  assert.deepEqual(serial.originalIndex, expected.originalIndex, 'bundled registry is unchanged source data');
  assert.deepEqual(serial.http.map(normalizeHttp), expected.http.map(normalizeHttp));
});

test('shared skill host is an explicit deployment profile and supplied env is authoritative', async () => {
  const source = await loadConfig({});
  assert.equal(source.skills[0].id, 'answer');
  assert.equal(source.skills[0].URL, 'http://docker.for.mac.localhost:9002/answer_skill/v1/main');
  const shared = await loadConfig({ NET_skills: 'localhost:9014', NET_parser: 'parser:9999' });
  assert.equal(shared.skills[0].id, 'answer-skill');
  assert.equal(shared.skills[0].URL, 'http://localhost:9014/v1/answer-skill/main');
  assert.equal(shared.parserURL, 'http://parser:9999');
  assert.ok(shared.skills.find(skill => skill.id === 'report-skill').settings.view);
  const explicitSource = await loadConfig({ ETCO_hub_skillsConfig: 'skills-local.json', NET_skills: 'localhost:9014' });
  assert.equal(explicitSource.skills[0].id, 'answer');
  assert.equal(explicitSource.skills[0].URL, 'http://docker.for.mac.localhost:9002/answer_skill/v1/main');
  const explicitPhoenix = await loadConfig({ ETCO_hub_skillsConfig: 'skills-phoenix.json', NET_skills: 'localhost:9014' });
  assert.equal(explicitPhoenix.skills[0].id, 'answer-skill');
  assert.equal(explicitPhoenix.skills[0].URL, 'http://answer-skill:8080/v1/main');
});

test('startup rejects invalid configuration instead of silently dropping skills or substituting a fallback', async () => {
  const rootPath = await mkdtemp(join(tmpdir(), 'phoenix-startup-config-'));
  try {
    await mkdir(join(rootPath, 'resources/skills'), { recursive: true });
    await writeFile(join(rootPath, 'resources/skills/skills-local.json'), JSON.stringify({ skills: [{ configPath: 'missing.json' }] }));
    await assert.rejects(loadConfig({}, { rootPath }), { code: 'ENOENT' });
    await writeFile(join(rootPath, 'resources/skills/skills-local.json'), JSON.stringify({ skills: [{ configPath: 'manifest.json' }] }));
    await writeFile(join(rootPath, 'manifest.json'), JSON.stringify({ id: 'broken', intents: [] }));
    const config = await loadConfig({}, { rootPath });
    assert.equal(config.skills[0].URL, '');
    assert.equal(config.skills[0].onRobot, undefined);
    await assert.rejects(createGateway(config), /Need to either be 'onRobot: true' or have URL: broken/);
    await writeFile(join(rootPath, 'resources/skills/skills-local.json'), '{"skills":[]}');
    assert.deepEqual((await loadConfig({}, { rootPath })).skills, []);
  } finally { await rm(rootPath, { recursive: true, force: true }); }
});
