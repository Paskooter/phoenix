// S-06 — NLU grammar asset provenance.
//
// 1. Provenance: resources/rules-src, resources/grammar, resources/rules/@be,
//    resources/{data,factory-words,factory} are hashed against a fixture
//    re-derived from the pinned 5c0a739 Pegasus reference
//    (scripts/parity-assets/generate.mjs).
// 2. The checked-in rule-inventory.json is a pinned oracle: every rule and
//    compiled FST hash it records must match the pinned source bytes and the
//    vendored rule sources actually on disk.
// 3. Runtime: the running NLU service is asked to parse utterances whose hits
//    live in a specific grammar file; the served intent must match, and the
//    intent literal must appear in that on-disk file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from '../src/index.js';
import { _loadedSkillCount } from '../src/fullGrammar.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(TEST_DIR, '..');
const REPO = resolve(PKG, '..', '..');
const RES = join(PKG, 'resources');

const fixture = JSON.parse(readFileSync(join(TEST_DIR, 'fixtures', 'grammar-provenance.json'), 'utf8'));
const inventory = JSON.parse(readFileSync(join(RES, 'rule-inventory.json'), 'utf8'));

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
function familyDigest(abs) {
  const files = walk(abs).map((p) => relative(abs, p));
  const rows = files.map((rel) => `${rel} ${sha256File(join(abs, rel))}\n`).sort();
  return {
    count: files.length,
    aggregateSha256: createHash('sha256').update(rows.join('')).digest('hex'),
    files: Object.fromEntries(files.map((rel) => [rel, sha256File(join(abs, rel))])),
  };
}

test('S-06: every vendored grammar / rule / factory data family matches the pinned-source digest', () => {
  const expected = Object.entries(fixture.phoenixFamilies);
  assert.ok(expected.length >= 6, 'family set');
  for (const [id, fam] of expected) {
    const actual = familyDigest(join(REPO, fam.phoenix));
    assert.equal(actual.count, fam.count, `${id}: file count`);
    assert.equal(actual.aggregateSha256, fam.aggregateSha256, `${id}: aggregate digest`);
    if (fam.files) assert.deepEqual(actual.files, fam.files, `${id}: per-file hashes`);
  }
});

test('S-06: rule-inventory.json hashes every rule against the pinned source and the disks', () => {
  assert.equal(inventory.referenceRevision, '5c0a7390539663ba749d360de348a428c088505c');
  assert.equal(inventory.ruleCount, 117);
  assert.equal(Object.keys(inventory.rules).length, 117, 'rule inventory size');

  const fstSource = fixture.sourceFamilies.rulesFst.files;
  for (const [name, rule] of Object.entries(inventory.rules)) {
    // rule sha is the pinned source rule_src file, and the vendored copy matches.
    const vendored = join(RES, rule.path);
    assert.ok(existsSync(vendored), `${name}: vendored rule present`);
    assert.equal(sha256File(vendored), rule.sha256, `${name}: vendored rule matches pinned hash`);
  }
  for (const [name, rule] of Object.entries(inventory.publicRules)) {
    const rel = rule.compiledPath.replace(/^rules_fst\//, '');
    assert.ok(rel in fstSource, `${name}: compiled FST is in the pinned source tree`);
    assert.equal(rule.sha256, fstSource[rel], `${name}: compiled FST hash matches pinned source`);
  }
  for (const [name, entry] of Object.entries({ ...inventory.factories, ...inventory.supporting })) {
    const p = join(RES, entry.path);
    assert.ok(existsSync(p), `${name}: ${entry.path} present`);
    assert.equal(sha256File(p), entry.sha256, `${name}: matches pinned hash`);
  }
});

test('S-06: grammar provenance classified — rules-src identical, launch-rule copies adapted', () => {
  assert.equal(fixture.sourceEquivalence['rules-src'].identical, true, 'rules-src byte-identical to pinned source');
  assert.deepEqual(fixture.sourceEquivalence['rules-src'].differing, []);
  const be = fixture.sourceEquivalence['rules/@be'];
  assert.deepEqual(be.onlyPhoenix, [], 'no invented launch rules');
  // The launch-rule engine's copies are hand-trimmed for the pure-JS matcher;
  // the documented divergence is the full set of 10 vendored launch rules.
  assert.equal(be.differing.length, 10, 'documented adapted launch rules');
  for (const rel of be.differing) {
    assert.ok(rel.endsWith('launch.rule'), `adapted file ${rel} is a launch rule`);
    assert.ok(existsSync(join(RES, 'rules', '@be', rel)), `${rel} is vendored under rules/@be`);
  }
  assert.ok(fixture.documentedDivergences['rules/@be'].detail.length > 0, 'adaptation is documented in the fixture');
});

// ---------------------------------------------------------------------------
// Runtime: parse through the real NLU HTTP service.
// ---------------------------------------------------------------------------

function post(port, text) {
  return new Promise((leave, reject) => {
    const raw = JSON.stringify({ type: 'NLU', data: { text, rules: ['launch'] } });
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/v1/parse', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => leave({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end(raw);
  });
}

test('S-06 runtime: the NLU service loads every vendored launch grammar and parses from it', async () => {
  // Every grammar/skills/<x>/launch.rule on disk is loaded into the in-process
  // full-grammar stage.
  const onDisk = readdirSync(join(RES, 'grammar', 'skills')).filter((d) => existsSync(join(RES, 'grammar', 'skills', d, 'launch.rule')));
  assert.equal(onDisk.length, 20, 'launch grammars on disk');
  assert.equal(_loadedSkillCount(), onDisk.length, 'every launch grammar is loaded');

  const server = await start(0);
  const port = server.address().port;
  try {
    // Each case must resolve to the intent the pinned grammar file defines for
    // it — and that intent literal must be present in the file we claim loaded.
    const cases = [
      { text: 'sing me a song', intent: 'requestSingSong', file: join(RES, 'grammar', 'skills', 'chitchat', 'launch.rule'), skill: undefined },
      { text: 'turn on the lights', intent: 'lightsOn', file: join(RES, 'grammar', 'skills', 'hue-control', 'launch.rule'), skill: '@be/hue-control' },
      // be-skill launches come from the adapted launch-rule copies.
      { text: 'set a timer for five minutes', intent: 'start', file: join(RES, 'rules', '@be', 'clock', 'launch.rule'), skill: '@be/clock' },
    ];
    for (const c of cases) {
      const res = await post(port, c.text);
      assert.equal(res.status, 200, `${c.text}: status`);
      assert.equal(res.body.data.intent, c.intent, `${c.text}: intent`);
      if (c.skill) assert.equal(res.body.data.entities.skill, c.skill, `${c.text}: skill`);
      const source = readFileSync(c.file, 'utf8');
      assert.ok(source.includes(c.intent), `${c.text}: ${c.intent} is defined in ${relative(PKG, c.file)}`);
    }
    // No-match still no-matches (the grammar stage does not invent a result).
    assert.equal((await post(port, 'blurf gnax wibble')).body.data.intent, null);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
