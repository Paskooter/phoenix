'use strict';

// Execute the original Pegasus chitchat graph under the pinned Node 8 image.
// The reference Chitchat.init() walks 4,424 MIMs and 66 CSV files with the
// historical async file walker.  The graph itself only needs the resulting
// sets/maps, so this runner builds those tables synchronously from the same
// source directories.  This keeps one source process usable for the whole
// boundary matrix while preserving the source graph and MIM runtime.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ref = path.resolve(process.argv[2]);
const specPath = path.resolve(process.argv[3]);
const out = path.resolve(process.argv[4]);
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
process.env.TZ = 'UTC';

const { Chitchat } = require(path.join(ref, 'packages/chitchat-skill/lib/Chitchat.js'));
const { GraphManager } = require(path.join(ref, 'packages/baseskill/lib/graph/GraphManager.js'));

const clone = value => value === undefined ? value : JSON.parse(JSON.stringify(value));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const log = { debug() {}, info() {}, warn() {}, error() {}, createChild() { return this; } };

function fileNames(dir, ext) {
  return fs.readdirSync(dir).filter(name => name.slice(-ext.length) === ext);
}

function csvFirstField(line) {
  let value = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { value += '"'; i += 1; }
      else quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      break;
    } else {
      value += ch;
    }
  }
  return value.trim();
}

function stemsFromNames(mimNames) {
  const out = {};
  mimNames.forEach(fileName => {
    const mimID = fileName.slice(-4) === '.mim' ? fileName.slice(0, -4) : fileName;
    if (!/_SS_/.test(mimID)) return;
    const parts = mimID.split('_');
    const stem = parts.slice(0, -1).join('_');
    const category = parts[parts.length - 1];
    if (stem && category) (out[stem] || (out[stem] = [])).push(category);
  });
  return out;
}

async function sourceTables(reference) {
  const root = path.join(reference, 'packages/chitchat-skill');
  const scriptedDir = path.join(root, 'mims/scripted-responses');
  const emotionDir = path.join(root, 'mims/emotion-responses');
  const fallbackDir = path.join(root, 'mims/core-responses');
  const scriptedNames = fileNames(scriptedDir, '.mim').map(name => name.slice(0, -4));
  const emotionNames = fileNames(emotionDir, '.mim').map(name => name.slice(0, -4));
  const fallbackNames = fileNames(fallbackDir, '.mim').map(name => name.slice(0, -4));
  const stems = stemsFromNames(scriptedNames);
  const categories = {};
  const categoryDir = path.join(root, 'res/semi_specific_categories');
  fileNames(categoryDir, '.csv').forEach(name => {
    const category = name.slice(0, -4);
    const lines = fs.readFileSync(path.join(categoryDir, name), 'utf8').split(/\r?\n/);
    categories[category] = [];
    for (let i = 1; i < lines.length; i += 1) {
      if (lines[i].trim()) categories[category].push(csvFirstField(lines[i]));
    }
  });
  const { FileUtils } = require(path.join(reference, 'node_modules/jibo-cai-utils/lib/jibo-cai-utils.js'));
  const inventoryDirs = [
    ['scripted', scriptedDir, 'mim'],
    ['emotion', emotionDir, 'mim'],
    ['fallback', fallbackDir, 'mim'],
    ['categories', categoryDir, 'csv'],
  ];
  const sourceInventory = {};
  for (const entry of inventoryDirs) {
    const paths = await FileUtils.findAllFilesWithExt(entry[1], entry[2]);
    sourceInventory[entry[0]] = paths.map(filePath => path.basename(filePath));
  }
  const sourceCategoryValues = {};
  const csvParse = require(path.join(reference, 'node_modules/csv-parse'));
  const sourceCategoryPaths = await FileUtils.findAllFilesWithExt(categoryDir, 'csv');
  for (const filePath of sourceCategoryPaths) {
    const records = await new Promise((resolve, reject) => {
      csvParse(fs.readFileSync(filePath, 'utf8'), { delimiter: ',', columns: true }, (error, rows) => error ? reject(error) : resolve(rows));
    });
    sourceCategoryValues[path.basename(filePath, '.csv')] = records.map(row => row.Value);
  }
  const names = {
    scripted: fileNames(scriptedDir, '.mim'),
    emotion: fileNames(emotionDir, '.mim'),
    fallback: fileNames(fallbackDir, '.mim'),
    categories: fileNames(categoryDir, '.csv'),
  };
  const hashOrder = value => sha(JSON.stringify(value));
  const manualHashes = {
    scripted: hashOrder(names.scripted), emotion: hashOrder(names.emotion), fallback: hashOrder(names.fallback),
    categories: hashOrder(names.categories), stems: hashOrder(stems), categoryValues: hashOrder(categories),
  };
  const sourceHashes = {
    scripted: hashOrder(sourceInventory.scripted), emotion: hashOrder(sourceInventory.emotion), fallback: hashOrder(sourceInventory.fallback),
    categories: hashOrder(sourceInventory.categories), stems: hashOrder(stemsFromNames(sourceInventory.scripted)), categoryValues: hashOrder(sourceCategoryValues),
  };
  // Chitchat.init() consumes these FileUtils results, whose asynchronous
  // completion order can differ from readdirSync order.  Inject the actual
  // source-ordered inventory and parser output used by that implementation.
  const effectiveScriptedNames = sourceInventory.scripted.map(name => name.slice(0, -4));
  const effectiveEmotionNames = sourceInventory.emotion.map(name => name.slice(0, -4));
  const effectiveFallbackNames = sourceInventory.fallback.map(name => name.slice(0, -4));
  const effectiveStems = stemsFromNames(sourceInventory.scripted);
  const injectedHashes = {
    scripted: hashOrder(sourceInventory.scripted), emotion: hashOrder(sourceInventory.emotion), fallback: hashOrder(sourceInventory.fallback),
    categories: hashOrder(sourceInventory.categories), stems: hashOrder(effectiveStems), categoryValues: hashOrder(sourceCategoryValues),
  };
  return {
    scripted: new Set(effectiveScriptedNames),
    emotion: new Set(effectiveEmotionNames),
    fallback: new Set(effectiveFallbackNames),
    stems: effectiveStems,
    categories: sourceCategoryValues,
    counts: { scripted: effectiveScriptedNames.length, emotion: effectiveEmotionNames.length, fallback: effectiveFallbackNames.length, categories: Object.keys(sourceCategoryValues).length },
    inventory: { readdirHashes: manualHashes, sourceHashes, injectedHashes, equivalent: JSON.stringify(sourceHashes) === JSON.stringify(injectedHashes) },
  };
}

function installTables(skill, tables) {
  skill.scriptedResponseMiMSet = tables.scripted;
  skill.emotionResponseMiMSet = tables.emotion;
  skill.fallbackResponseMiMSet = tables.fallback;
  skill.semiSpecificStemMapping = tables.stems;
  skill.semiSpecificCategoryMapping = tables.categories;
}

function makeBody(item) {
  const data = {
    general: { accountID: 'acct-1', robotID: 'robot-1', lang: 'en-US' },
    runtime: {
      dialog: { referent: null },
      perception: { speaker: null },
      loop: { loopId: 'loop-1', owner: null, users: [] },
      location: { iso: spec.runtimeISO },
      character: { emotion: { name: 'NEUTRAL', valence: 0.45, confidence: 0.2 } },
    },
    skill: { id: 'chitchat-skill' },
  };
  if (item.result === 'omitted') return { type: 'LISTEN_LAUNCH', msgID: item.id, ts: 1, data };
  if (item.result === 'null') data.result = null;
  else if (item.result === 'empty') data.result = {};
  else if (item.result === 'nlu-omitted') data.result = { asr: { text: '' } };
  else if (item.result === 'nlu-null') data.result = { nlu: null, asr: { text: '' } };
  else if (item.result === 'nlu-empty') data.result = { nlu: {}, asr: { text: '' } };
  else if (item.result === 'entities-omitted') data.result = { nlu: { intent: item.intent || 'doesJiboLikeThing' }, asr: { text: '' } };
  else if (item.result === 'entities-null') data.result = { nlu: { intent: item.intent || 'doesJiboLikeThing', entities: null }, asr: { text: '' } };
  else data.result = { nlu: { intent: item.intent || 'doesJiboLikeThing', entities: clone(item.entities || {}), rules: [] }, asr: { text: '' } };
  if (data.result && typeof data.result === 'object') {
    if (item.memo !== 'omitted' && Object.prototype.hasOwnProperty.call(item, 'memo')) data.result.memo = clone(item.memo);
  }
  return { type: 'LISTEN_LAUNCH', msgID: item.id, ts: 1, data };
}

function randomFor(seed) {
  let state = (seed === undefined ? 0x50454741 : seed) >>> 0;
  let calls = 0;
  const rng = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    calls += 1;
    return state / 0x100000000;
  };
  return { rng, calls: () => calls, state: () => state >>> 0 };
}

function promptLeaves(action) {
  const out = [];
  function visit(node) {
    if (!node) return;
    if (node.type === 'SLIM') {
      const cfg = node.config || {};
      const play = cfg.play || {};
      const meta = play.meta || {};
      out.push({
        type: node.type,
        mim_id: meta.mim_id || null,
        prompt_id: meta.prompt_id || null,
        prompt_sub_category: meta.prompt_sub_category || null,
        mim_type: meta.mim_type || null,
        esml: play.esml === undefined ? null : play.esml,
        autoRuleConfig: play.autoRuleConfig === undefined ? null : play.autoRuleConfig,
      });
      return;
    }
    if (Array.isArray(node.children)) node.children.forEach(visit);
  }
  visit(action && action.config && action.config.jcp);
  return out;
}

function normalize(response) {
  const data = response && response.data;
  const session = data && data.skill && data.skill.session;
  return {
    type: response && response.type,
    final: data && data.final,
    fireAndForget: data && data.fireAndForget,
    prompts: promptLeaves(data && data.action),
    analytics: data && data.analytics || {},
    trace: session && session.trace ? session.trace.map(entry => entry.transition) : null,
    sessionData: session && session.data ? clone(session.data) : null,
  };
}

function normalizeWireError(response) {
  return { type: response && response.type, message: response && response.data && response.data.message,
    skill: response && response.data && response.data.skill && response.data.skill.id };
}

async function runCase(item, tables) {
  const random = randomFor(item.seed);
  Math.random = random.rng;
  GraphManager._resetInstance();
  const skill = new Chitchat();
  installTables(skill, tables);
  try {
    const response = await skill.handle({ body: makeBody(item), log });
    return { id: item.id, class: item.class, ok: true, value: normalize(response), randomCalls: random.calls(), randomState: random.state() };
  } catch (error) {
    return { id: item.id, class: item.class, ok: false, error: { name: error.name, message: error.message },
      wire: normalizeWireError(skill.buildErrorResponse(error)), randomCalls: random.calls(), randomState: random.state() };
  }
}

async function main() {
  const tables = await sourceTables(ref);
  const rows = [];
  for (let i = 0; i < spec.cases.length; i += 1) rows.push(await runCase(spec.cases[i], tables));
  const result = {
    schemaVersion: 1,
    mode: 'source',
    referenceRevision: spec.referenceRevision,
    runtime: process.version,
    image: 'node@sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c',
    sourceTables: { counts: tables.counts, inventory: tables.inventory },
    runnerSha256: sha(fs.readFileSync(__filename)),
    rows,
  };
  fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ mode: result.mode, rows: rows.length, ok: rows.filter(row => row.ok).length, failed: rows.filter(row => !row.ok).length, sourceTables: result.sourceTables }));
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
