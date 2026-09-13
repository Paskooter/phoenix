'use strict';

// Execute source Chitchat launch + an explicitly supplied LISTEN_UPDATE using
// the pinned Pegasus GraphSkill under Node 8.  The update is synthetic: source
// Chitchat itself emits final announcements and never asks the host for it.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const reference = path.resolve(process.argv[2]);
const spec = JSON.parse(fs.readFileSync(path.resolve(process.argv[3]), 'utf8'));
const outPath = path.resolve(process.argv[4]);
const { Chitchat } = require(path.join(reference, 'packages/chitchat-skill/lib/Chitchat.js'));
const { GraphManager } = require(path.join(reference, 'packages/baseskill/lib/graph/GraphManager.js'));
const log = { debug() {}, info() {}, warn() {}, error() {}, createChild() { return this; } };
const clone = value => value === undefined ? value : JSON.parse(JSON.stringify(value));
let sourceTables;

function randomFor(seed) {
  let state = seed >>> 0;
  let calls = 0;
  const rng = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    calls += 1;
    return state / 0x100000000;
  };
  return { rng, calls: () => calls, state: () => state };
}

function body(row, type, session) {
  return {
    type,
    msgID: `${row.id}:${type}`,
    ts: 1,
    data: {
      general: { accountID: 's07-followup-account', robotID: 's07-followup-robot', lang: 'en-US' },
      runtime: {
        dialog: { referent: null },
        perception: { speaker: null },
        loop: { loopId: 's07-followup-loop', owner: null, users: [], jibo: { id: 's07-jibo', birthdate: 1495216025271, color: 'WHITE' } },
        location: { iso: spec.runtimeISO },
        character: { emotion: { name: 'NEUTRAL', valence: 0.45, confidence: 0.2 } },
      },
      skill: Object.assign({ id: 'chitchat-skill' }, session ? { session: clone(session) } : {}),
      result: type === 'LISTEN_LAUNCH'
        ? { nlu: { intent: row.intent, entities: clone(row.entities) }, asr: { text: '' }, memo: clone(row.memo) }
        : { nlu: { intent: 'synthetic-follow-up', entities: {} }, asr: { text: 'synthetic follow-up' } },
    },
  };
}

function scrub(value, location = '') {
  if (Array.isArray(value)) return value.map((item, index) => scrub(item, `${location}[${index}]`));
  if (!value || typeof value !== 'object') return value;
  const output = {};
  Object.keys(value).sort().forEach((key) => {
    const current = location ? `${location}.${key}` : key;
    if (current === 'msgID' || current === 'ts') return;
    if (key === 'id' && (current === 'data.skill.session.id' || current === 'config.jcp.id' || current === 'config.jcp.config.play.id' || current.endsWith('.config.jcp.id') || current.endsWith('.config.play.id'))) output[key] = '<generated-id>';
    else output[key] = scrub(value[key], current);
  });
  return output;
}

function actionDetails(action) {
  if (!action) return { present: false, jcp: null, slims: [], effectKeys: [] };
  const slims = [];
  const effectKeys = [];
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'SLIM') {
      const config = node.config || {};
      const play = config.play || {};
      slims.push({
        mim: play.meta && play.meta.mim_id,
        prompt: play.meta && play.meta.prompt_id,
        esml: play.esml,
        mimType: play.meta && play.meta.mim_type,
        play: config.play !== undefined,
        listen: config.listen !== undefined,
        display: config.display !== undefined,
      });
      effectKeys.push(...Object.keys(config).filter((key) => config[key] !== undefined).sort());
    }
    (node.children || []).forEach(walk);
  }
  const jcp = action.config && action.config.jcp;
  walk(jcp);
  return { present: true, jcp: scrub(jcp, 'data.action.config.jcp'), slims, effectKeys: effectKeys.sort() };
}

function normalize(response, turn) {
  const data = response && response.data;
  const session = data && data.skill && data.skill.session;
  const action = data && data.action;
  return {
    turn,
    responseType: response && response.type,
    final: data && data.final,
    fireAndForget: data && data.fireAndForget,
    session: scrub(session, 'data.skill.session'),
    trace: session && session.trace ? clone(session.trace) : null,
    transitions: session && session.trace ? session.trace.map((entry) => entry.transition) : null,
    action: scrub(action),
    actionDetails: actionDetails(action),
    mim: actionDetails(action).slims.map((slim) => ({ mim: slim.mim, prompt: slim.prompt, esml: slim.esml, mimType: slim.mimType })),
    jcp: actionDetails(action).jcp,
    analytics: data && data.analytics || {},
    effects: actionDetails(action).slims.map((slim) => ({ listen: slim.listen, display: slim.display, play: slim.play })),
  };
}

async function runCase(row) {
  const random = randomFor(row.seed);
  const previousRandom = Math.random;
  Math.random = random.rng;
  GraphManager._resetInstance();
  const skill = new Chitchat();
  skill.scriptedResponseMiMSet = sourceTables.scriptedResponseMiMSet;
  skill.emotionResponseMiMSet = sourceTables.emotionResponseMiMSet;
  skill.fallbackResponseMiMSet = sourceTables.fallbackResponseMiMSet;
  skill.semiSpecificStemMapping = sourceTables.semiSpecificStemMapping;
  skill.semiSpecificCategoryMapping = sourceTables.semiSpecificCategoryMapping;
  try {
    let launch;
    try {
      launch = await skill.handle({ body: body(row, 'LISTEN_LAUNCH'), log });
    } catch (error) {
      return { id: row.id, class: row.class, launch: null, launchError: { name: error.name, message: error.message }, update: null, updateError: null, randomCalls: random.calls(), randomState: random.state() };
    }
    const session = launch.data && launch.data.skill && launch.data.skill.session;
    let update;
    try {
      update = await skill.handle({ body: body(row, 'LISTEN_UPDATE', session), log });
    } catch (error) {
      return { id: row.id, class: row.class, launch: normalize(launch, 'launch'), launchError: null, update: null, updateError: { name: error.name, message: error.message }, randomCalls: random.calls(), randomState: random.state() };
    }
    return { id: row.id, class: row.class, launch: normalize(launch, 'launch'), launchError: null, update: normalize(update, 'update'), updateError: null, randomCalls: random.calls(), randomState: random.state() };
  } finally {
    Math.random = previousRandom;
  }
}

(async () => {
  GraphManager._resetInstance();
  const initialized = new Chitchat();
  await initialized.init();
  sourceTables = {
    scriptedResponseMiMSet: initialized.scriptedResponseMiMSet,
    emotionResponseMiMSet: initialized.emotionResponseMiMSet,
    fallbackResponseMiMSet: initialized.fallbackResponseMiMSet,
    semiSpecificStemMapping: initialized.semiSpecificStemMapping,
    semiSpecificCategoryMapping: initialized.semiSpecificCategoryMapping,
  };
  const rows = [];
  for (const row of spec.cases) rows.push(await runCase(row));
  const result = {
    schemaVersion: 1,
    mode: 'source',
    sourceRevision: spec.referenceRevision,
    runtime: process.version,
    image: 'node@sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c',
    sourceTables: { scripted: sourceTables.scriptedResponseMiMSet.size, emotion: sourceTables.emotionResponseMiMSet.size, fallback: sourceTables.fallbackResponseMiMSet.size, categories: Object.keys(sourceTables.semiSpecificCategoryMapping).length },
    runnerSha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
    rows,
  };
  fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ mode: result.mode, rows: rows.length, errors: rows.filter((row) => row.launchError || row.updateError).length, sourceTables: result.sourceTables }));
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
