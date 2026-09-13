#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createChitchatSkill } from '../../packages/skills/src/chitchatSkill.js';
import { GraphManager } from '../../packages/skills/src/graph/graphManager.js';

const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const outPath = process.argv[3];
const clone = (value) => value === undefined ? value : JSON.parse(JSON.stringify(value));
const log = { debug() {}, info() {}, warn() {}, error() {}, createChild() { return this; } };

function randomFor(seed) {
  let state = seed >>> 0;
  let calls = 0;
  const rng = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; calls += 1; return state / 0x100000000; };
  return { rng, calls: () => calls, state: () => state };
}

function body(row, type, session) {
  return {
    type, msgID: `${row.id}:${type}`, ts: 1,
    data: {
      general: { accountID: 's07-followup-account', robotID: 's07-followup-robot', lang: 'en-US' },
      runtime: { dialog: { referent: null }, perception: { speaker: null }, loop: { loopId: 's07-followup-loop', owner: null, users: [], jibo: { id: 's07-jibo', birthdate: 1495216025271, color: 'WHITE' } }, location: { iso: spec.runtimeISO }, character: { emotion: { name: 'NEUTRAL', valence: 0.45, confidence: 0.2 } } },
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
  const slims = []; const effectKeys = [];
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'SLIM') {
      const config = node.config || {}; const play = config.play || {};
      slims.push({ mim: play.meta && play.meta.mim_id, prompt: play.meta && play.meta.prompt_id, esml: play.esml, mimType: play.meta && play.meta.mim_type, play: config.play !== undefined, listen: config.listen !== undefined, display: config.display !== undefined });
      effectKeys.push(...Object.keys(config).filter((key) => config[key] !== undefined).sort());
    }
    (node.children || []).forEach(walk);
  }
  const jcp = action.config && action.config.jcp;
  walk(jcp);
  return { present: true, jcp: scrub(jcp, 'data.action.config.jcp'), slims, effectKeys: effectKeys.sort() };
}

function normalize(response, turn) {
  const data = response && response.data; const session = data && data.skill && data.skill.session; const action = data && data.action; const details = actionDetails(action);
  return { turn, responseType: response && response.type, final: data && data.final, fireAndForget: data && data.fireAndForget, session: scrub(session, 'data.skill.session'), trace: session && session.trace ? clone(session.trace) : null, transitions: session && session.trace ? session.trace.map((entry) => entry.transition) : null, action: scrub(action), actionDetails: details, mim: details.slims.map((slim) => ({ mim: slim.mim, prompt: slim.prompt, esml: slim.esml, mimType: slim.mimType })), jcp: details.jcp, analytics: data && data.analytics || {}, effects: details.slims.map((slim) => ({ listen: slim.listen, display: slim.display, play: slim.play })) };
}

async function runCase(row) {
  const random = randomFor(row.seed); const graphManager = new GraphManager(); const skill = createChitchatSkill({ graphManager, rng: random.rng });
  let launch;
    try {
      launch = await skill(body(row, 'LISTEN_LAUNCH'), { log });
    } catch (error) {
      return { id: row.id, class: row.class, launch: null, launchError: { name: error.name, message: error.message }, update: null, updateError: null, randomCalls: random.calls(), randomState: random.state() };
    }
    const session = launch.data && launch.data.skill && launch.data.skill.session;
    let update;
    try {
      update = await skill(body(row, 'LISTEN_UPDATE', session), { log });
    } catch (error) {
      return { id: row.id, class: row.class, launch: normalize(launch, 'launch'), launchError: null, update: null, updateError: { name: error.name, message: error.message }, randomCalls: random.calls(), randomState: random.state() };
    }
  return { id: row.id, class: row.class, launch: normalize(launch, 'launch'), launchError: null, update: normalize(update, 'update'), updateError: null, randomCalls: random.calls(), randomState: random.state() };
}

const rows = [];
for (const row of spec.cases) rows.push(await runCase(row));
let candidateRevision = 'unknown';
try { candidateRevision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch {}
const result = { schemaVersion: 1, mode: 'candidate', candidateRevision, runtime: process.version, runnerSha256: crypto.createHash('sha256').update(fs.readFileSync(new URL('./run-candidate.mjs', import.meta.url))).digest('hex'), rows };
fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ mode: result.mode, rows: rows.length, errors: rows.filter((row) => row.launchError || row.updateError).length }));
