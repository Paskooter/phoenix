// S-06 — hub skill index + manifest provenance.
//
// 1. Provenance: every file under resources/skills is hashed and compared to a
//    fixture re-derived from the pinned 5c0a739 Pegasus reference
//    (scripts/parity-assets/generate.mjs). The fixture records which files are
//    byte-identical, which are re-homed/transformed, and which are
//    Phoenix-authored deployment adapters.
// 2. Runtime: loadConfig() resolves every index entry to a readable manifest
//    (a missing/broken entry throws at startup), and the gateway serves the
//    loaded manifest content over GET /v1/skills.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createGateway } from '../src/index.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(TEST_DIR, '..', '..', '..');
const SKILLS_DIR = resolve(TEST_DIR, '..', 'resources', 'skills');

const fixture = JSON.parse(readFileSync(join(TEST_DIR, 'fixtures', 'manifest-provenance.json'), 'utf8'));

const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
function walk(abs) {
  const out = [];
  for (const name of readdirSync(abs)) {
    const p = join(abs, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}
function familyDigest(phxRel) {
  const abs = join(REPO, phxRel);
  const files = walk(abs).map((p) => relative(abs, p));
  const rows = files.map((rel) => `${rel} ${sha256File(join(abs, rel))}\n`).sort();
  return {
    count: files.length,
    aggregateSha256: createHash('sha256').update(rows.join('')).digest('hex'),
    files: Object.fromEntries(files.map((rel) => [rel, sha256File(join(abs, rel))])),
  };
}

test('S-06: every hub skill index and manifest file matches the pinned-source digest', () => {
  const expected = fixture.phoenixFamilies.skillsDir;
  const actual = familyDigest(expected.phoenix);
  assert.equal(actual.count, expected.count, 'skills dir file count');
  assert.equal(actual.aggregateSha256, expected.aggregateSha256, 'skills dir aggregate digest');
  assert.deepEqual(actual.files, expected.files, 'per-file hashes');
  assert.equal(actual.count, 33, 'index + manifest inventory size');
});

test('S-06: index/manifest provenance classified per file (identical, transformed, authored)', () => {
  const idx = fixture.indexFiles;
  // Byte-identical to the pinned reference — no port rewrites, no dropped entries.
  const paths = {
    'skills-local.json': join(SKILLS_DIR, 'skills-local.json'),
    'skills-pegasus1.json': join(SKILLS_DIR, 'skills-pegasus1.json'),
    'skills-pegasus2.json': join(SKILLS_DIR, 'skills-pegasus2.json'),
    'stringNormalizationMap.json': resolve(TEST_DIR, '..', 'resources', 'stringNormalizationMap.json'),
  };
  for (const [name, path] of Object.entries(paths)) {
    assert.equal(idx[name].identical, true, `${name} must match the pinned source`);
    assert.equal(sha256File(path), idx[name].phoenixSha256, `${name} live hash`);
  }
  // The shared-host answer manifest is the one transformed source file: a
  // pretty-printed superset of the source manifest. Its added intents are
  // themselves source-backed by the pinned external answer manifest.
  assert.equal(idx['answer_skill_manifest.json'].identical, false);
  const answer = fixture.answerManifest;
  assert.equal(answer.id.source, answer.id.phoenix, 'answer-skill manifest id');
  assert.deepEqual(answer.missingIntents, [], 'no source intent dropped');
  assert.deepEqual(answer.memoConflicts, [], 'memos agree for shared names');
  assert.deepEqual(answer.addedIntents, [
    'isUnknownDescriptor', 'requestWeather', 'whenIsBirthday', 'whereIsPerson',
    'whereIsThing', 'whoIsPerson', 'whyIsUnknownDescriptor',
  ]);
  const external = new Set(fixture.externalAnswerManifest.intents);
  for (const name of answer.addedIntents) {
    assert.ok(external.has(name), `added intent ${name} is present in the pinned external answer manifest`);
  }
  // Re-homed manifest trees.
  assert.equal(fixture.sourceEquivalence['be-skills'].identical, true, 'be-skills byte-identical');
  assert.equal(fixture.sourceEquivalence['external-skills'].identical, true, 'external-skills byte-identical');
  assert.deepEqual(fixture.sourceEquivalence['pegasus-skills'].differing, [], 'pegasus-skills: no in-place edits');
  assert.deepEqual(fixture.sourceEquivalence['pegasus-skills'].onlyPhoenix, ['answer_skill_manifest.json', 'color_skill_manifest.json']);
});

test('S-06 runtime: the gateway resolves every index entry and serves the manifests', async () => {
  // loadRegistry reads index + each manifest at load time; a missing or invalid
  // entry throws instead of being silently dropped.
  const config = await loadConfig({});
  const ids = config.skills.map((s) => s.id);
  assert.equal(config.skills.length, 21, 'default skills-local entry count');
  assert.deepEqual(ids.slice(0, 4), ['answer', 'news', 'report-skill', 'chitchat-skill']);
  for (const skill of config.skills) {
    assert.ok(skill.id && typeof skill.id === 'string', 'every manifest entry has an id');
    assert.ok(skill.onRobot === true || typeof skill.URL === 'string', `${skill.id} is routable or on-robot`);
  }

  const gateway = await createGateway(config);
  await gateway.service.listen(0);
  const port = gateway.service.server.address().port;
  try {
    const served = await new Promise((leave, reject) => {
      http.get({ hostname: '127.0.0.1', port, path: '/v1/skills' }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => leave({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      }).on('error', reject);
    });
    assert.equal(served.status, 200);
    assert.deepEqual(served.body.skills.map((s) => s.id), ids, 'served skill list matches loaded registry');
    const answer = served.body.skills.find((s) => s.id === 'answer');
    assert.ok(answer.intents.length >= 23, 'served answer intents come from the manifest');
    const names = new Set(answer.intents.map((i) => i.name));
    // The default index routes 'answer' to the pinned external answer manifest;
    // every served intent name is source-backed.
    for (const name of fixture.externalAnswerManifest.intents) {
      assert.ok(names.has(name), `served answer manifest keeps source intent ${name}`);
    }
  } finally {
    await new Promise((r) => gateway.service.server.close(r));
  }
});

test('S-06 runtime: the shared-host profile serves the transformed answer-skill manifest', async () => {
  const shared = await loadConfig({ NET_skills: 'localhost:9014' });
  assert.equal(shared.skills[0].id, 'answer-skill');
  assert.equal(shared.skills[0].URL, 'http://localhost:9014/v1/answer-skill/main');
  const names = new Set(shared.skills[0].intents.map((i) => i.name));
  for (const name of fixture.answerManifest.sourceIntents) assert.ok(names.has(name), `shared answer-skill keeps ${name}`);
  for (const name of fixture.answerManifest.addedIntents) assert.ok(names.has(name), `shared answer-skill adds ${name}`);
});
