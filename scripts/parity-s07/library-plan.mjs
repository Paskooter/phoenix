#!/usr/bin/env node

// Build the deterministic S-07 library/context plan from the pinned Pegasus tree.
// The plan is intentionally generated from the source tree, rather than from the
// Phoenix mirror, so missing/extra MIMs and category omissions fail closed.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
}

const sourceRoot = path.resolve(arg('--source-root', '/home/shell/work/phoenix/.parity/reference/5c0a7390539663ba749d360de348a428c088505c'));
const outPath = path.resolve(arg('--out', path.join(process.cwd(), 's07-library-plan.json')));
const sourceRevision = arg('--source-revision', '5c0a7390539663ba749d360de348a428c088505c');
const chitchat = path.join(sourceRoot, 'packages/chitchat-skill');
const mimRoot = path.join(chitchat, 'mims');
const categoryRoot = path.join(chitchat, 'res/semi_specific_categories');
const manifestPath = path.join(chitchat, 'resources/test-manifest.json');

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function listMims(dir) {
  return fs.readdirSync(dir).filter((name) => name.endsWith('.mim')).sort().map((name) => name.slice(0, -4));
}
function readMim(dir, id) { return readJson(path.join(dir, `${id}.mim`)); }
function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function treeDigest(dir) {
  const files = [];
  function walk(current) {
    for (const name of fs.readdirSync(current).sort()) {
      const file = path.join(current, name);
      const stat = fs.statSync(file);
      if (stat.isDirectory()) walk(file);
      else files.push([path.relative(dir, file).replaceAll(path.sep, '/'), sha256(file)]);
    }
  }
  walk(dir);
  return { files: files.length, sha256: crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex') };
}

// The source CSVs are ordinary two-column CSVs, but this parser honors quoted
// commas so the inventory itself does not inherit Phoenix's line.split shortcut.
function firstCsvColumn(line) {
  let value = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') { value += '"'; i += 1; }
      else quoted = !quoted;
    } else if (c === ',' && !quoted) break;
    else value += c;
  }
  return value.trim();
}
function readCategory(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(1)
    .map(firstCsvColumn).filter(Boolean);
}

const scriptedDir = path.join(mimRoot, 'scripted-responses');
const emotionDir = path.join(mimRoot, 'emotion-responses');
const fallbackDir = path.join(mimRoot, 'core-responses');
const scripted = listMims(scriptedDir);
const emotion = listMims(emotionDir);
const fallback = listMims(fallbackDir);
const sourceMims = [...new Set([...scripted, ...emotion, ...fallback])].sort();
const manifest = readJson(manifestPath).tests;
const manifestMimSet = new Set(manifest.map((row) => row.memo && row.memo.mim).filter(Boolean));
const manifestRows = manifest.map((row, index) => ({
  rowId: `manifest:${index}`,
  command: row.command,
  intent: row.intent,
  memo: row.memo,
  entities: row.entities || [],
  conditionalTests: row.conditionalTests || [],
}));
const duplicateCommands = Object.entries(manifestRows.reduce((out, row) => {
  const key = JSON.stringify(row.command);
  (out[key] ||= []).push(row.rowId);
  return out;
}, {})).filter(([, rows]) => rows.length > 1).map(([command, rows]) => ({ command: JSON.parse(command), rows }));

const categoryFiles = fs.readdirSync(categoryRoot).filter((name) => name.endsWith('.csv')).sort();
const categories = Object.fromEntries(categoryFiles.map((name) => [name.slice(0, -4), readCategory(path.join(categoryRoot, name))]));
const semispecific = scripted.filter((id) => id.includes('_SS_')).sort();
const stemMapping = {};
for (const id of semispecific) {
  const parts = id.split('_');
  const stem = parts.slice(0, -1).join('_');
  const category = parts.at(-1);
  (stemMapping[stem] ||= []).push(category);
}
for (const stem of Object.keys(stemMapping)) stemMapping[stem].sort();
const usedCategories = [...new Set(Object.values(stemMapping).flat())].sort();
const unreachableCategories = categoryFiles.map((name) => name.slice(0, -4)).filter((name) => !usedCategories.includes(name));

const emotions = ['JOYFUL', 'PLEASED', 'DETERMINED', 'CONFIDENT', 'NEUTRAL', 'INSECURE', 'HOPEFUL', 'SAD', 'FRUSTRATED'];
const dates = [
  '2018-01-01', '2018-01-02', '2018-02-01', '2018-03-01', '2018-04-01', '2018-04-10',
  '2018-09-01', '2018-10-01', '2018-10-03', '2018-10-05', '2018-10-10', '2018-10-15',
  '2018-10-16', '2018-10-20', '2018-10-26', '2018-10-27', '2018-10-28', '2018-10-30',
  '2018-10-31', '2018-11-01', '2018-11-02', '2018-11-05', '2018-11-15', '2018-11-17',
  '2018-11-18', '2018-11-20', '2018-11-23', '2018-11-24', '2018-11-25', '2018-11-26',
  '2018-11-28', '2018-12-01', '2018-12-02', '2018-12-10', '2018-12-12', '2018-12-15',
  '2018-12-19', '2018-12-20', '2018-12-21', '2018-12-24', '2018-12-25', '2018-12-26', '2018-12-31',
];

function mimNeeds(mim) {
  const text = JSON.stringify(mim);
  return {
    emotion: /jibo\.emotion|emotion\.valence/.test(text),
    identity: /(?:^|[^a-z])(?:speaker|referent|loop(?:\.|Member)|loop\.owner)/.test(text),
    birthday: /isBirthday|birthday|age\./.test(text),
    color: /jibo\.color/.test(text),
    region: /location\.home\.isInRegion/.test(text),
    city: /location\.city/.test(text),
    date: /(?:dt\.|location\.iso)/.test(text),
  };
}

function profilesFor(mim) {
  const needs = mimNeeds(mim);
  const profiles = new Set(['baseline']);
  if (needs.identity) {
    ['no-speaker', 'referent', 'speaker-referent', 'no-owner', 'owner-speaker', 'loop-one', 'loop-two',
      'referent-female-child', 'referent-male-adult'].forEach((p) => profiles.add(p));
  }
  if (needs.birthday) {
    ['birthday-jibo', 'birthday-speaker', 'birthday-referent', 'nonbirthday-referent'].forEach((p) => profiles.add(p));
  }
  if (needs.emotion) {
    emotions.forEach((emotion) => profiles.add(`emotion-${emotion}`));
    ['emotion-positive', 'emotion-zero', 'emotion-negative', 'emotion-missing'].forEach((p) => profiles.add(p));
  }
  if (needs.color) ['color-WHITE', 'color-BLACK'].forEach((p) => profiles.add(p));
  if (needs.region) ['region-US', 'region-CA'].forEach((p) => profiles.add(p));
  if (needs.city) ['city-boston', 'city-new-york'].forEach((p) => profiles.add(p));
  if (needs.date) dates.forEach((date) => profiles.add(`date-${date}`));
  return [...profiles];
}

function hashSeed(text) {
  let h = 2166136261;
  for (const c of text) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

const cases = [];
const seen = new Set();
function addCase(row) {
  if (seen.has(row.id)) throw new Error(`duplicate case id: ${row.id}`);
  seen.add(row.id);
  cases.push({ ...row, rngSeed: hashSeed(row.id) });
}

function addMimCases({ idPrefix, mim, memoType, family, extraEntities = {} }) {
  const dir = emotion.includes(mim) ? emotionDir : scripted.includes(mim) ? scriptedDir : fallbackDir;
  const config = readMim(dir, mim);
  for (const profile of profilesFor(config)) {
    addCase({ id: `${idPrefix}:${mim}:${memoType}:${profile}`, family, mim, memoType, profile, entities: extraEntities });
  }
}

// Every valid source MIM absent from the manifest, with every context dimension
// used by its own conditions/templates. Semispecifics are added below with the
// concrete CSV values that actually drive their resolver.
for (const mim of sourceMims) {
  if (mim === 'CC_Fallback') continue;
  if (mim.includes('_SS_')) continue;
  if (emotion.includes(mim)) continue;
  if (!manifestMimSet.has(mim)) addMimCases({ idPrefix: 'missing', mim, memoType: 'ScriptedResponse', family: 'missing-scripted' });
}

for (const mim of emotion) {
  for (const memoType of ['EmotionQuery', 'SpecificEmotionQuery', 'EmotionCommand', 'ScriptedResponse']) {
    addMimCases({ idPrefix: 'emotion', mim, memoType, family: 'emotion' });
  }
}

const ambiguousByStem = {};
for (const [stem, cats] of Object.entries(stemMapping)) {
  const valuesToCats = {};
  for (const category of cats) for (const value of categories[category] || []) (valuesToCats[value] ||= []).push(category);
  ambiguousByStem[stem] = Object.entries(valuesToCats).filter(([, matches]) => matches.length > 1).map(([value, matches]) => ({ value, matches: matches.sort() }));
}

const ambiguousCaseSeen = new Set();
for (const mim of semispecific) {
  const parts = mim.split('_');
  const stem = parts.slice(0, -1).join('_');
  const category = parts.at(-1);
  const values = categories[category] || [];
  const mimConfig = readMim(scriptedDir, mim);
  for (const value of values) {
    for (const profile of profilesFor(mimConfig)) {
      const matches = (ambiguousByStem[stem] || []).find((item) => item.value === value);
      addCase({ id: `semi:${mim}:${category}:${value}:${profile}`, family: 'semispecific', mim: stem, memoType: 'SemiSpecificResponse', profile, entities: { [category]: value }, expectedCategory: category, expectedCategories: matches ? matches.matches : [category] });
    }
  }
  for (const { value, matches } of (ambiguousByStem[stem] || [])) {
    const ambiguousKey = `${stem}:${value}`;
    if (ambiguousCaseSeen.has(ambiguousKey)) continue;
    ambiguousCaseSeen.add(ambiguousKey);
    const orders = [matches, [...matches].reverse()];
    for (let order = 0; order < orders.length; order += 1) {
      const entities = {};
      for (const key of orders[order]) entities[key] = value;
      for (const profile of profilesFor(mimConfig)) {
        addCase({ id: `semi-ambiguous:${stem}:${value}:order${order}:${profile}`, family: 'semispecific-ambiguous', mim: stem, memoType: 'SemiSpecificResponse', profile, entities, expectedCategories: matches });
      }
    }
  }
}

// Explicit fallback and invalid-family controls keep the matrix fail-closed at
// the routing boundary even though CC_Fallback is not an absent library MIM.
for (const profile of ['baseline', 'no-speaker', 'referent']) {
  addCase({ id: `control:fallback:${profile}`, family: 'fallback-control', mim: 'NoSuchMim', memoType: 'ScriptedResponse', profile, entities: {} });
  addCase({ id: `control:wrong-family:${profile}`, family: 'fallback-control', mim: scripted.find((id) => !id.includes('_SS_')), memoType: 'EmotionQuery', profile, entities: {} });
}

const allMimFiles = [
  ...scripted.map((id) => path.join(scriptedDir, `${id}.mim`)),
  ...emotion.map((id) => path.join(emotionDir, `${id}.mim`)),
  ...fallback.map((id) => path.join(fallbackDir, `${id}.mim`)),
];
const inventory = {
  sourceRevision,
  sourceManifest: { rows: manifestRows.length, distinctMims: manifestMimSet.size, duplicateCommands },
  sourceMims: { scripted: scripted.length, emotion: emotion.length, fallback: fallback.length, total: sourceMims.length, ids: { scripted, emotion, fallback } },
  missingFromManifest: sourceMims.filter((id) => !manifestMimSet.has(id)),
  semispecific: { mims: semispecific.length, stems: Object.keys(stemMapping).length, stemMapping, categories: categoryFiles.map((name) => name.slice(0, -4)), usedCategories, unreachableCategories, valueCounts: Object.fromEntries(Object.entries(categories).map(([name, values]) => [name, values.length])) },
  emotionStates: emotions,
  dates,
  sourceTrees: {
    scripted: treeDigest(scriptedDir),
    emotion: treeDigest(emotionDir),
    fallback: treeDigest(fallbackDir),
    categories: treeDigest(categoryRoot),
    manifest: { bytes: fs.statSync(manifestPath).size, sha256: sha256(manifestPath) },
  },
};

const plan = {
  schemaVersion: 1,
  task: 'S-07',
  sourceRevision,
  inventory,
  manifestRows,
  cases,
};
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(plan, null, 2)}\n`);
console.log(JSON.stringify({ outPath, cases: cases.length, missing: inventory.missingFromManifest.length, emotion: emotion.length, semispecific: semispecific.length, unreachableCategories }, null, 2));
