import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createChitchatSkill } from '../../packages/skills/src/chitchatSkill.js';
import { GraphManager } from '../../packages/skills/src/graph/graphManager.js';
import { skillRoute } from '../../packages/skills/src/skillService.js';

const specPath = path.resolve(process.argv[2]);
const out = path.resolve(process.argv[3]);
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
process.env.TZ = 'UTC';

const clone = value => value === undefined ? value : JSON.parse(JSON.stringify(value));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const log = { debug() {}, info() {}, warn() {}, error() {}, createChild() { return this; } };

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

async function runCase(item) {
  const random = randomFor(item.seed);
  const graphManager = new GraphManager();
  const skill = createChitchatSkill({ graphManager, rng: random.rng });
  try {
    const response = await skill(makeBody(item), { log });
    return { id: item.id, class: item.class, ok: true, value: normalize(response), randomCalls: random.calls(), randomState: random.state() };
  } catch (error) {
    // Exercise the same public error envelope as the HTTP skill service with
    // a fresh graph instance after retaining the direct error name/message.
    const wireSkill = createChitchatSkill({ graphManager: new GraphManager(), rng: randomFor(item.seed).rng });
    const wrapped = skillRoute('chitchat-skill', wireSkill);
    const wireResponse = await wrapped({ body: makeBody(item), trace: {}, log, req: { headers: {} } });
    return { id: item.id, class: item.class, ok: false, error: { name: error.name, message: error.message },
      wire: normalizeWireError(wireResponse), randomCalls: random.calls(), randomState: random.state() };
  }
}

const rows = [];
for (const item of spec.cases) rows.push(await runCase(item));
let candidateRevision = 'unknown';
try { candidateRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' }).trim(); } catch {}
const result = {
  schemaVersion: 1,
  mode: 'candidate',
  candidateRevision,
  runtime: process.version,
  runnerSha256: sha(fs.readFileSync(new URL('./run-candidate.mjs', import.meta.url))),
  rows,
};
fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ mode: result.mode, rows: rows.length, ok: rows.filter(row => row.ok).length, failed: rows.filter(row => !row.ok).length }));
