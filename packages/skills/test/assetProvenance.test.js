// S-06 — MIM / view / config asset provenance.
//
// Two layers:
//  1. Provenance: every family the pinned Pegasus source ships (chitchat + report
//     + baseskill + template MIMs, the semi-specific category CSVs, report view
//     configs, prompt-text/prefs configs) is hashed and compared to a fixture
//     re-derived from the pinned checkout (scripts/parity-assets/generate.mjs).
//     The fixture also records the field-by-field source equivalence counts.
//  2. Runtime reachability: rather than checking that files exist, this file
//     starts the real skills HTTP host and sends requests, then asserts the
//     served ESML / display payload came out of the on-disk asset.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SkillRequestType } from '@phoenix/contracts';
import { loadMimFile } from '../src/graph/mims/promptData.js';
import { start } from '../src/index.js';
import { reportSkill } from '../src/reportSkill.js';
import { clearReportEnvCache } from '../src/report/env.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(TEST_DIR, '..');
const REPO = resolve(TEST_DIR, '..', '..', '..');
const RES = join(PKG, 'resources');
const MIM_ROOT = join(RES, 'mims');

const fixture = JSON.parse(readFileSync(join(TEST_DIR, 'fixtures', 'asset-provenance.json'), 'utf8'));

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

/** Rebuild the fixture's canonical digest for a family from the live tree. */
function digestFamily(phxRel) {
  const abs = join(REPO, phxRel);
  const isFile = statSync(abs).isFile();
  const base = isFile ? dirname(abs) : abs;
  const files = isFile ? [phxRel.split('/').pop()] : walk(abs).map((p) => relative(abs, p));
  const rows = files.map((rel) => `${rel} ${sha256File(join(base, rel))}\n`).sort();
  return {
    count: files.length,
    aggregateSha256: createHash('sha256').update(rows.join('')).digest('hex'),
    files: Object.fromEntries(files.map((rel) => [rel, sha256File(join(base, rel))])),
  };
}

test('S-06: every MIM / CSV / view / config family matches the pinned-source digest', () => {
  assert.equal(fixture.schemaVersion, 1);
  const families = Object.entries(fixture.families);
  assert.ok(families.length >= 9, `expected the full family set, got ${families.length}`);
  let files = 0;
  for (const [id, expected] of families) {
    const actual = digestFamily(expected.phoenix);
    assert.equal(actual.count, expected.count, `${id}: file count`);
    assert.equal(actual.aggregateSha256, expected.aggregateSha256, `${id}: aggregate digest`);
    if (expected.files) {
      assert.deepEqual(actual.files, expected.files, `${id}: per-file hashes`);
      files += expected.count;
    }
    if (expected.samples) {
      for (const [rel, sha] of Object.entries(expected.samples)) {
        assert.equal(actual.files[rel], sha, `${id}: sample ${rel}`);
      }
    }
  }
  // The large chitchat family is aggregate-only in the fixture; its 66 category
  // CSVs are also covered by the digest above.
  assert.ok(files >= 100, `per-file families should cover the small trees (${files})`);
});

test('S-06: source equivalence recorded field by field (added / missing / differing)', () => {
  const eq = fixture.sourceEquivalence;
  // Byte-identical re-homes.
  for (const id of ['mims/chitchat', 'mims/report', 'mims/base', 'mims/template', 'views']) {
    assert.equal(eq[id].identical, true, `${id} must be byte-identical to source`);
    assert.equal(eq[id].differing.length, 0, `${id} hashes`);
    assert.equal(eq[id].onlySource.length, 0, `${id} only-source`);
    assert.equal(eq[id].onlyPhoenix.length, 0, `${id} only-phoenix`);
  }
  // GQA MIMs: the 10 recovered srv-gqa-ws MIMs match; GQA_banned_word.mim is
  // Phoenix-authored (the recovered source references the id but ships no file).
  assert.deepEqual(eq['mims/gqa'].onlyPhoenix, ['GQA_banned_word.mim']);
  assert.deepEqual(eq['mims/gqa'].differing, []);
  assert.equal(eq['mims/gqa'].phoenixCount, 11);
});

test('S-06: every vendored MIM parses and carries a source-shaped prompt inventory', () => {
  const files = walk(MIM_ROOT).filter((p) => p.endsWith('.mim'));
  assert.ok(files.length >= 4520, `expected the full MIM tree, got ${files.length}`);
  let prompts = 0;
  for (const abs of files) {
    const rel = relative(REPO, abs);
    const mim = loadMimFile(abs); // the production loader, not a raw readFile
    assert.ok(mim && typeof mim === 'object' && !Array.isArray(mim), `${rel}: object`);
    assert.ok(Array.isArray(mim.prompts) && mim.prompts.length > 0, `${rel}: prompts`);
    // GQA MIM files are slim_from_mim inputs; the source's builder supplies the
    // mim_type on the response. Every other vendored family declares one.
    if (!rel.includes('/mims/gqa/')) {
      assert.ok(typeof mim.mim_type === 'string' && mim.mim_type.length > 0, `${rel}: mim_type`);
    } else if (mim.mim_type !== undefined) {
      assert.equal(typeof mim.mim_type, 'string', `${rel}: mim_type`);
    }
    const ids = new Set();
    for (const p of mim.prompts) {
      assert.equal(typeof p.prompt, 'string', `${rel}: prompt text`);
      assert.equal(typeof p.media, 'string', `${rel}: media`);
      assert.equal(typeof p.prompt_id, 'string', `${rel}: prompt_id`);
      ids.add(p.prompt_id);
      prompts += 1;
    }
    assert.ok(ids.size > 0, `${rel}: at least one prompt_id`);
  }
  assert.ok(prompts >= 12700, `prompt inventory size (${prompts})`);
});

test('S-06: semi-specific MIM ids resolve against the category CSVs exactly as source does', () => {
  const scripted = readdirSync(join(MIM_ROOT, 'chitchat', 'scripted-responses'));
  const ss = scripted.filter((f) => f.endsWith('.mim') && f.includes('_SS_')).map((f) => f.slice(0, -4));
  const categories = new Set(ss.map((id) => id.split('_').pop()));
  const csvDir = join(MIM_ROOT, 'chitchat', 'semi_specific_categories');
  const csvs = new Set(readdirSync(csvDir).filter((f) => f.endsWith('.csv')).map((f) => f.slice(0, -4)));
  assert.equal(ss.length, 151, 'semi-specific MIM count');
  assert.equal(csvs.size, 66, 'category CSV count');
  const unresolved = [...categories].filter((c) => !csvs.has(c)).sort();
  // PetDied / ScaryCreature carry no category CSV in the pinned source either —
  // reproduced here rather than silently dropped (see the evidence review).
  assert.deepEqual(unresolved, ['PetDied', 'ScaryCreature']);
  for (const f of readdirSync(csvDir)) {
    const lines = readFileSync(join(csvDir, f), 'utf8').split(/\r?\n/).filter((l) => l.trim());
    assert.equal(lines[0].split(',')[0].trim(), 'Value', `${f}: header`);
    assert.ok(lines.length > 1, `${f}: rows`);
  }
});

// ---------------------------------------------------------------------------
// Runtime reachability — request the assets through the real HTTP surface.
// ---------------------------------------------------------------------------

function listen(server) {
  return new Promise((r) => server.listen(0, () => r(server.address().port)));
}

function post(port, path, body) {
  return new Promise((leave, reject) => {
    const raw = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port, path, method: 'POST',
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

const launch = (skillId, result) => ({
  type: SkillRequestType.LISTEN_LAUNCH, msgID: 's06', ts: 1,
  data: {
    general: { accountID: 'a', robotID: 'r', lang: 'en-US' },
    runtime: { dialog: {}, perception: { speaker: 'u1' }, loop: { loopId: 'l', users: [{ id: 'u1', name: 'Alice Smith', accountId: 'acct-1', birthdate: '1990-01-01' }] }, location: { lat: 42.36, lng: -71.06, iso: '2026-06-12T10:00:00-04:00' } },
    skill: { id: skillId },
    result,
  },
});

const slims = (response) => {
  const out = [];
  const visit = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'SLIM') out.push(n);
    // A SEQUENCE node carries its children inline; a SLIM carries a config.
    const children = n.children || (n.config && n.config.jcp && n.config.jcp.children) || [];
    for (const child of children) visit(child);
  };
  visit(response.data.action.config.jcp);
  return out;
};

/**
 * True when `served` is the rendered form of the `raw` ESML template: every
 * literal segment of the raw prompt (the text between `${...}` placeholders)
 * appears in order. Placeholder payloads are runtime data, not asset content.
 */
function rendersTemplate(raw, served) {
  const parts = raw.split(/\$\{[^}]*\}/).map((s) => s.trim()).filter(Boolean);
  let pos = 0;
  for (const part of parts) {
    const i = served.indexOf(part, pos);
    if (i < 0) return false;
    pos = i + part.length;
  }
  return true;
}

test('S-06 runtime: the skills host loads and serves chitchat + report MIM assets', async () => {
  const server = await start(0);
  const port = server.address().port;
  try {
    // Chitchat: the memo names the MIM; the served ESML must be one of that
    // file's prompts (loaded through the production loader here).
    const chitchat = await post(port, '/v1/chitchat-skill/main', launch('chitchat-skill', {
      memo: { mim: 'RI_JBO_LikesIceCream', type: 'ScriptedResponse' },
      nlu: { intent: 'RI_JBO_LikesIceCream', entities: {}, rules: [] }, asr: { text: '' },
    }));
    assert.equal(chitchat.status, 200);
    const chitchatSlim = slims(chitchat.body)[0];
    assert.ok(chitchatSlim, 'chitchat produced a SLIM');
    assert.equal(chitchatSlim.config.play.meta.mim_id, 'RI_JBO_LikesIceCream');
    const chitchatMim = loadMimFile(join(MIM_ROOT, 'chitchat', 'scripted-responses', 'RI_JBO_LikesIceCream.mim'));
    const chitchatTexts = new Set(chitchatMim.prompts.map((p) => p.prompt));
    assert.ok(chitchatTexts.has(chitchatSlim.config.play.esml), 'served chitchat ESML came from the MIM file');
    assert.ok(chitchatMim.prompts.some((p) => p.prompt_id === chitchatSlim.config.play.meta.prompt_id));
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('S-06 runtime: the report skill loads and serves vendored MIM and view configs', async () => {
  const YESTERDAY = { daily: { data: [{ temperatureHigh: 60, temperatureLow: 45, summary: 'Cloudy all day.', icon: 'cloudy' }] } };
  const TODAY = {
    currently: { temperature: 71, summary: 'Light rain', icon: 'rain' },
    daily: { data: [{ temperatureHigh: 75, temperatureLow: 58, summary: 'Rain.', icon: 'rain' }] },
  };
  const relay = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    const u = new URL(req.url, 'http://x');
    res.end(JSON.stringify({ relayData: u.pathname === '/v1/dark_sky' && u.searchParams.has('secondsSinceEpoch') ? YESTERDAY : TODAY }));
  });
  const relayPort = await listen(relay);
  process.env.NET_data = `localhost:${relayPort}`;
  clearReportEnvCache();
  try {
    const r = await reportSkill(launch('report-skill', {
      nlu: { intent: 'requestWeatherPR', entities: {}, rules: [] }, asr: { text: '' }, memo: 'Reactive',
    }), { req: { jibo: { toHeader: () => ({ 'x-jibo-transid': 's06' }) } } });

    // MIM: every served mim_id resolves to a real file and the ESML is one of
    // its prompts.
    const mims = slims(r);
    assert.ok(mims.length > 0, 'report produced MIM SLIMs');
    for (const slim of mims) {
      const id = slim.config.play.meta.mim_id;
      const file = join(MIM_ROOT, 'report', 'en-us', `${id}.mim`);
      const mim = loadMimFile(file);
      const candidates = mim.prompts.filter((p) => p.prompt_id === slim.config.play.meta.prompt_id);
      assert.ok(candidates.length > 0, `served ${id} prompt_id ${slim.config.play.meta.prompt_id} exists in ${id}.mim`);
      assert.ok(candidates.some((p) => rendersTemplate(p.prompt, slim.config.play.esml)), `served ${id} ESML is the rendered form of an on-disk prompt`);
    }

    // View config: the served display carries the weatherHiLo template's static
    // fields (ids + positions) from resources/views/weatherHiLo.json.
    const serialized = JSON.stringify(r);
    const view = JSON.parse(readFileSync(join(RES, 'views', 'weatherHiLo.json'), 'utf8'));
    assert.ok(serialized.includes(view.viewConfig.id), 'served display carries the view config id');
    for (const cfg of view.componentConfigs) {
      assert.ok(serialized.includes(`"id":"${cfg.id}"`), `served display component ${cfg.id}`);
      assert.ok(serialized.includes(`"x":${cfg.position.x}`), `served display component ${cfg.id} x-position`);
    }
    assert.ok(serialized.includes('assets/personal-report-skill/weather/bg/tempNormal_v01.crn'), 'temp band asset path served');
  } finally {
    await new Promise((r) => relay.close(r));
    delete process.env.NET_data;
    clearReportEnvCache();
  }
});
