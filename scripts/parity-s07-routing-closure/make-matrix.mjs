#!/usr/bin/env node

// Generate the compact, bounded S-07 routing plan.  The runners intentionally
// receive small batch plans: constructing the complete Chitchat graph and
// rendering every source MIM in one process previously exhausted the worker.
// This file is the durable plan generator; generated plans and runtime rows
// belong in /tmp and are never checked in.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
function arg(name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

const sourceRoot = path.resolve(arg('--source-root', '/home/shell/work/phoenix/.parity/reference/5c0a7390539663ba749d360de348a428c088505c'));
const outDir = path.resolve(arg('--out-dir', path.join('/tmp', `s07-routing-${process.pid}`)));
const batchSize = Number(arg('--batch-size', '256'));
const referenceRevision = arg('--source-revision', '5c0a7390539663ba749d360de348a428c088505c');
const candidateRevision = arg('--candidate-revision', '1b9b7fdbf72462b65caf538e206625a11ec8b130');
const candidateRuntime = arg('--candidate-runtime', 'v22.22.0');
if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 512) throw new Error('--batch-size must be an integer between 1 and 512');

const chitchat = path.join(sourceRoot, 'packages/chitchat-skill');
const scriptedDir = path.join(chitchat, 'mims/scripted-responses');
const emotionDir = path.join(chitchat, 'mims/emotion-responses');
const fallbackDir = path.join(chitchat, 'mims/core-responses');
const categoryDir = path.join(chitchat, 'res/semi_specific_categories');
const boundarySpec = path.resolve(new URL('../parity-s07-boundaries/matrix-spec.json', import.meta.url).pathname);
const sourceRunnerPath = path.resolve(new URL('../parity-s07-boundaries/run-source.cjs', import.meta.url).pathname);
const candidateRunnerPath = path.resolve(new URL('../parity-s07-boundaries/run-candidate.mjs', import.meta.url).pathname);

function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function shaFile(file) { return sha(fs.readFileSync(file)); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function names(dir, suffix) {
  return fs.readdirSync(dir).filter(name => name.endsWith(suffix)).map(name => name.slice(0, -suffix.length)).sort();
}
function firstCsvField(line) {
  let value = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { value += '"'; i += 1; }
      else quoted = !quoted;
    } else if (ch === ',' && !quoted) break;
    else value += ch;
  }
  return value.trim();
}
function categoryValues(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(1).map(firstCsvField).filter(Boolean);
}
function hashList(value) { return sha(JSON.stringify(value)); }
function seedFor(id) {
  let value = 2166136261;
  for (const ch of id) { value ^= ch.charCodeAt(0); value = Math.imul(value, 16777619); }
  return value >>> 0;
}
function clone(value) { return value === undefined ? value : JSON.parse(JSON.stringify(value)); }

const scripted = names(scriptedDir, '.mim');
const emotion = names(emotionDir, '.mim');
const fallback = names(fallbackDir, '.mim');
const categories = Object.fromEntries(names(categoryDir, '.csv').map(category => [category, categoryValues(path.join(categoryDir, `${category}.csv`))]));
const mimObservedIdsCache = new Map();
function observedMimIds(mim) {
  if (mimObservedIdsCache.has(mim)) return mimObservedIdsCache.get(mim);
  const dir = scripted.includes(mim) ? scriptedDir : emotion.includes(mim) ? emotionDir : fallbackDir;
  const file = path.join(dir, `${mim}.mim`);
  const observed = new Set([mim]);
  if (fs.existsSync(file)) {
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (config.mim_id) observed.add(config.mim_id);
    for (const prompt of config.prompts || []) {
      if (prompt.prompt_category === 'Entry-Core' && prompt.mim_id) observed.add(prompt.mim_id);
    }
  }
  const result = [...observed].sort();
  mimObservedIdsCache.set(mim, result);
  return result;
}
const stems = {};
for (const mim of scripted.filter(id => id.includes('_SS_'))) {
  const parts = mim.split('_');
  const category = parts.pop();
  const stem = parts.join('_');
  (stems[stem] ||= []).push(category);
}
for (const stem of Object.keys(stems)) stems[stem].sort();
const allCategories = Object.keys(categories).sort();
const usedCategories = [...new Set(Object.values(stems).flat())].sort();
const unreachableCategories = allCategories.filter(category => !usedCategories.includes(category));

// Prefer an unambiguous value for each stem/category so the row checks the
// named category.  If a category's values all collide (Kiwi is the known
// source example), retain the first source value and record all valid outputs.
function matchingCategories(stem, value) {
  return (stems[stem] || []).filter(category => (categories[category] || []).includes(value));
}
function valueFor(stem, category) {
  const values = categories[category] || [];
  const unique = values.find(value => matchingCategories(stem, value).length === 1);
  return unique || values[0] || `__s07_missing_${category}__`;
}

const cases = [];
const ids = new Set();
function add(row) {
  if (ids.has(row.id)) throw new Error(`duplicate case id: ${row.id}`);
  ids.add(row.id);
  const preserveSeed = row._preserveSeed === true;
  const copy = { ...row };
  delete copy._preserveSeed;
  if (!preserveSeed && !Object.prototype.hasOwnProperty.call(copy, 'seed')) copy.seed = seedFor(row.id);
  cases.push(copy);
}

// The complete routing inventory is intentionally MIM based.  The pinned
// manifest/parser corpus already owns utterance coverage; this lane proves
// that every vendored source MIM can cross the skill boundary with its source
// memo family.  Route-only comparison keeps this inventory bounded in output
// size while still checking transition, selected MIM and failure envelope.
fs.mkdirSync(outDir, { recursive: true });
for (const mim of scripted) {
  add({
    id: `direct-scripted:${mim}`,
    class: 'direct-scripted-mim',
    comparison: 'routing',
    expectedTransition: 'ScriptedResponse',
    expectedMimIds: observedMimIds(mim),
    result: 'valid-nlu',
    memo: { type: 'ScriptedResponse', mim },
  });
}
for (const mim of emotion) {
  for (const type of ['ScriptedResponse', 'EmotionQuery', 'SpecificEmotionQuery', 'EmotionCommand']) {
    add({
      id: `direct-emotion:${type}:${mim}`,
      class: 'direct-emotion-mim',
      comparison: 'routing',
      expectedTransition: type === 'ScriptedResponse' ? 'EmotionCommand' : type,
      expectedMimIds: observedMimIds(mim),
      result: 'valid-nlu',
      memo: { type, mim },
    });
  }
}
add({
  id: 'direct-fallback:CC_Fallback',
  class: 'fallback-mim',
  comparison: 'routing',
  expectedTransition: 'ErrorResponse',
  expectedMimIds: observedMimIds('CC_Fallback'),
  result: 'valid-nlu',
  memo: { type: 'ScriptedResponse', mim: 'CC_Fallback' },
});

// Preserve the previously audited fun-and-games, fallback, wrong-family and
// seven malformed controls.  This gives the closure one inventory rather than
// silently dropping an existing boundary when the semispecific lane expands.
for (const row of readJson(boundarySpec).cases) add({ ...clone(row), _preserveSeed: true });

// Every accepted memo type, plus the source's ScriptedResponse -> emotion
// reclassification and an unknown memo type.  The existing boundary controls
// cover several of these, but explicit IDs make inventory review unambiguous.
add({ id: 'memo-type:ScriptedResponse', class: 'memo-type', comparison: 'routing', expectedTransition: 'ScriptedResponse', expectedMimIds: observedMimIds('RA_JBO_FlipCoin'), result: 'valid-nlu', memo: { type: 'ScriptedResponse', mim: 'RA_JBO_FlipCoin' } });
// The source memo names the category family (RI_JBO_Likes_SS), while the
// selected file is the category-keyed MIM (RI_JBO_Likes_SS_Cheese).  Keep the
// entity value from the pinned CSV, but derive observed prompt IDs from the
// actual pinned file rather than manufacturing a value-suffixed filename.
add({ id: 'memo-type:SemiSpecificResponse', class: 'memo-type', comparison: 'routing', expectedTransition: 'SemiSpecificResponse', expectedMimIds: observedMimIds('RI_JBO_Likes_SS_Cheese'), result: 'valid-nlu', intent: 'doesJiboLikeThing', entities: { Cheese: valueFor('RI_JBO_Likes_SS', 'Cheese') }, memo: { type: 'SemiSpecificResponse', mim: 'RI_JBO_Likes_SS' } });
add({ id: 'memo-type:EmotionQuery', class: 'memo-type', comparison: 'routing', expectedTransition: 'EmotionQuery', expectedMimIds: observedMimIds('OI_JBO_IsHappy'), result: 'valid-nlu', memo: { type: 'EmotionQuery', mim: 'OI_JBO_IsHappy' } });
add({ id: 'memo-type:SpecificEmotionQuery', class: 'memo-type', comparison: 'routing', expectedTransition: 'SpecificEmotionQuery', expectedMimIds: observedMimIds('OI_JBO_IsHappy'), result: 'valid-nlu', memo: { type: 'SpecificEmotionQuery', mim: 'OI_JBO_IsHappy' } });
add({ id: 'memo-type:EmotionCommand', class: 'memo-type', comparison: 'routing', expectedTransition: 'EmotionCommand', expectedMimIds: observedMimIds('OI_JBO_IsHappy'), result: 'valid-nlu', memo: { type: 'EmotionCommand', mim: 'OI_JBO_IsHappy' } });
add({ id: 'memo-type:ScriptedResponse-emotion-reclassified', class: 'memo-type', comparison: 'routing', expectedTransition: 'EmotionCommand', expectedMimIds: observedMimIds('OI_JBO_IsHappy'), result: 'valid-nlu', memo: { type: 'ScriptedResponse', mim: 'OI_JBO_IsHappy' } });
add({ id: 'memo-type:UnknownType', class: 'wrong-family', comparison: 'routing', expectedTransition: 'ErrorResponse', result: 'valid-nlu', memo: { type: 'UnknownType', mim: 'RA_JBO_FlipCoin' } });

// Every source semispecific MIM is represented once.  These 151 rows are
// partitioned below, so each source/candidate process handles at most the
// configured bounded batch rather than retaining a monolithic graph capture.
for (const stem of Object.keys(stems).sort()) {
  for (const category of stems[stem]) {
    const value = valueFor(stem, category);
    const allowedCategories = matchingCategories(stem, value);
    const resolvable = allowedCategories.length > 0;
    add({
      id: `semi:${stem}:${category}`,
      class: resolvable ? 'semispecific' : 'semispecific-unresolvable-category',
      comparison: 'routing',
      expectedTransition: resolvable ? 'SemiSpecificResponse' : 'ErrorResponse',
      result: 'valid-nlu',
      intent: 'doesJiboLikeThing',
      entities: { [category]: value },
      memo: { type: 'SemiSpecificResponse', mim: stem },
      semispecific: { stem, category, value, allowedCategories },
      expectedMimIds: [...new Set(allowedCategories.flatMap(resolvedCategory => observedMimIds(`${stem}_${resolvedCategory}`)))].sort(),
    });
  }
}

// Category CSVs with no source MIM are still retained in the inventory.  A
// sentinel row for each makes the absence observable and proves that an
// accidental category-to-stem fallback cannot be hidden by a missing row.
for (const category of unreachableCategories) {
  add({
    id: `semi-unreachable:${category}`,
    class: 'semispecific-unreachable-category',
    comparison: 'routing',
    expectedTransition: 'ErrorResponse',
    result: 'valid-nlu',
    intent: 'doesJiboLikeThing',
    entities: { [category]: `__s07_unreachable_${category}__` },
    memo: { type: 'SemiSpecificResponse', mim: 'RI_JBO_Likes_SS' },
    semispecific: { stem: 'RI_JBO_Likes_SS', category, value: `__s07_unreachable_${category}__`, allowedCategories: [] },
    expectedMimIds: observedMimIds('CC_Fallback'),
  });
}

// The three source/native entity collision rows are also sent through the
// skill boundary using the normalized source entities.  run-normalization.mjs
// independently exercises the parser boundary and records the raw text.
const collisionCases = [
  ['collision:hot-dogs', 'doesJiboWantThing', { FoodGeneral: 'SomeFoodGeneral' }, 'RI_JBO_Wants_SS_FoodGeneral'],
  ['collision:depressed', 'isJiboDescriptor', { Emotion: 'Sad' }, 'RI_JBO_IsSad'],
  ['collision:good-or-evil', 'isJiboDescriptor', { JiboDescriptor: 'GoodOrEvil' }, 'RI_JBO_IsGoodOrEvil'],
];
for (const [id, intent, entities, mim] of collisionCases) {
  const emotionMim = emotion.includes(mim);
  add({ id, class: 'normalization-collision', comparison: 'routing', expectedTransition: emotionMim ? 'EmotionCommand' : 'ScriptedResponse', expectedMimIds: observedMimIds(mim), result: 'valid-nlu', intent, entities, memo: { type: 'ScriptedResponse', mim } });
}

const batches = [];
for (let start = 0; start < cases.length; start += batchSize) {
  const batchCases = cases.slice(start, start + batchSize);
  const name = `batch-${String(batches.length).padStart(3, '0')}.json`;
  batches.push({ name, index: batches.length, start, count: batchCases.length, ids: batchCases.map(row => row.id) });
  fs.writeFileSync(path.join(outDir, name), `${JSON.stringify({ schemaVersion: 1, task: 'S-07', referenceRevision, runtimeISO: '2018-05-30T12:00:00.000Z', cases: batchCases }, null, 2)}\n`);
}

const sourceInventory = {
  scripted: { count: scripted.length, sortedSha256: hashList(scripted) },
  emotion: { count: emotion.length, sortedSha256: hashList(emotion) },
  fallback: { count: fallback.length, sortedSha256: hashList(fallback) },
  semispecificMims: { count: Object.values(stems).flat().length, sortedSha256: hashList(Object.entries(stems).flatMap(([stem, cats]) => cats.map(category => `${stem}_${category}`)).sort()) },
  stems: { count: Object.keys(stems).length, sortedSha256: hashList(Object.fromEntries(Object.entries(stems).sort())) },
  categories: { count: allCategories.length, sortedSha256: hashList(allCategories) },
  categoryValues: { sortedSha256: hashList(Object.fromEntries(allCategories.map(category => [category, categories[category]]))) },
};
const plan = {
  schemaVersion: 1,
  task: 'S-07 routing closure',
  referenceRevision,
  sourceRoot,
  candidateRevision,
  candidateRuntime,
  sourceRunnerSha256: shaFile(sourceRunnerPath),
  candidateRunnerSha256: shaFile(candidateRunnerPath),
  batchSize,
  batches,
  rows: cases.length,
  classCounts: Object.fromEntries([...new Set(cases.map(row => row.class))].sort().map(kind => [kind, cases.filter(row => row.class === kind).length])),
  sourceInventory,
  semispecific: { stems: Object.keys(stems).sort(), usedCategories, unreachableCategories, mims: Object.entries(stems).flatMap(([stem, cats]) => cats.map(category => ({ stem, category, value: valueFor(stem, category), allowedCategories: matchingCategories(stem, valueFor(stem, category)) }))).sort((a, b) => `${a.stem}:${a.category}`.localeCompare(`${b.stem}:${b.category}`)) },
  malformedPrecedenceIds: readJson(boundarySpec).cases.filter(row => row.expectedDifference === 'source-malformed-precedence').map(row => row.id),
  collisionIds: collisionCases.map(row => row[0]),
  mimRouteInventorySha256: hashList(cases.filter(row => row.expectedMimIds).map(row => ({ id: row.id, expectedMimIds: row.expectedMimIds })).sort((a, b) => a.id.localeCompare(b.id))),
  boundarySpecSha256: shaFile(boundarySpec),
};
fs.writeFileSync(path.join(outDir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
fs.writeFileSync(path.join(outDir, 'normalization.json'), `${JSON.stringify({
  schemaVersion: 1,
  sourceRevision: referenceRevision,
  sourceCapture: {
    path: '/home/shell/work/phoenix/.parity/reviews/full-original-parser.json',
    sha256: 'ef747cbdce0cd495a4561807fa035f6763252b5f88d55cffd780b14fa39f755d',
    sourceRevision: '5c0a7390539663ba749d360de348a428c088505c',
    runtime: 'v8.9.4',
  },
  rows: [
    { id: 'collision:hot-dogs', captureId: 'chitchat:1757:0:base', text: 'do you want some hot dogs', intent: 'doesJiboWantThing', sourceEntities: { FoodGeneral: 'SomeFoodGeneral', union_original_fst_name: 'handle:chitchat/launch' }, sourceMim: 'RI_JBO_Wants_SS_FoodGeneral' },
    { id: 'collision:depressed', captureId: 'chitchat:2091:0:base', text: 'are you depressed', intent: 'isJiboDescriptor', sourceEntities: { Emotion: 'Sad', union_original_fst_name: 'handle:chitchat/launch' }, sourceMim: 'RI_JBO_IsSad' },
    { id: 'collision:good-or-evil', captureId: 'chitchat:2244:0:base', text: 'are you bad or are you good', intent: 'isJiboDescriptor', sourceEntities: { JiboDescriptor: 'GoodOrEvil', union_original_fst_name: 'handle:chitchat/launch' }, sourceMim: 'RI_JBO_IsGoodOrEvil' },
  ],
}, null, 2)}\n`);
console.log(JSON.stringify({ outDir, rows: cases.length, batches: batches.length, batchSize, classCounts: plan.classCounts, sourceInventory, semispecific: { stems: plan.semispecific.stems.length, mims: plan.semispecific.mims.length, usedCategories: usedCategories.length, unreachableCategories: unreachableCategories.length } }, null, 2));
