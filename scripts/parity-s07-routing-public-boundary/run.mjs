#!/usr/bin/env node

// Prove that the seven malformed direct Chitchat launch shapes are outside the
// normal Phoenix parser -> IntentRouter -> SkillClient boundary.  This proof
// deliberately captures the public SkillClient request seam; it does not call
// Chitchat with a hand-built malformed request and it does not alter runtime
// code.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseRequest } from '../../packages/nlu/src/requestParser.js';
import { IntentRouter } from '../../packages/gateway/src/intentRouter.js';
import { loadRegistry } from '../../packages/gateway/src/registry.js';
import { SkillClient, SkillConfigManager } from '../../packages/gateway/src/skillClient.js';

const args = process.argv.slice(2);
function arg(name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}
const outPath = path.resolve(arg('--out', path.join('/tmp', `s07-public-boundary-${process.pid}.json`)));
const WORKTREE_BASE_REVISION = '1b9b7fdbf72462b65caf538e206625a11ec8b130';
const ROOT_EQUIVALENT_REVISION = '99a758c5d5babe33a1a97d4585e44728efa4e158';
const SCOPE_FILES = {
  'packages/gateway/src/intentRouter.js': '3600536f66895c8c46a86b14faf2d2309d7991bf',
  'packages/gateway/src/skillClient.js': '808244ae0eefa987c2cda4de20a40d8c6ec6869c',
  'packages/gateway/resources/skills/skills-local.json': '1047648247cf0144a0d3eb80716a22b787065c43',
  'packages/nlu/src/requestParser.js': '49f276ada76d8cbb6358835418b548d629428ba8',
  'packages/nlu/src/chitchatEntityNormalization.js': 'd488be26a455db3e52616c088a87631d0c4a1a86',
  'packages/skills/src/chitchatSkill.js': '0105db60e13cf23754ac23e744bbad299865d5ff',
};
const MALFORMED_IDS = [
  'malformed-result-omitted',
  'malformed-result-null',
  'malformed-result-empty',
  'malformed-nlu-omitted',
  'malformed-nlu-null',
  'malformed-semi-entities-omitted',
  'malformed-semi-entities-null',
];
const EXPECTED_IDS = [
  'valid-hot-dogs',
  'valid-semispecific',
  'valid-flip-coin',
  'valid-no-match',
  'valid-empty-text',
  'nlu-omitted',
  'nlu-null',
  'semispecific-entities-omitted',
  'semispecific-entities-null',
];
const EXPECTED_MEMOS = {
  'valid-hot-dogs': { mim: 'RI_JBO_Wants_SS_FoodGeneral', type: 'ScriptedResponse' },
  'valid-semispecific': { mim: 'RI_JBO_Likes_SS_Cheese', type: 'ScriptedResponse' },
  'valid-flip-coin': { mim: 'RA_JBO_FlipCoin', type: 'ScriptedResponse' },
  'semispecific-entities-omitted': { mim: 'KU_DoYouLike', type: 'ScriptedResponse' },
  'semispecific-entities-null': { mim: 'KU_DoYouLike', type: 'ScriptedResponse' },
};
const NO_ROUTE_IDS = new Set(['valid-no-match', 'valid-empty-text', 'nlu-omitted', 'nlu-null']);
const REQUEST_IDS = new Set(Object.keys(EXPECTED_MEMOS));

function shaFile(file) { return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex'); }
function stable(value) { return JSON.stringify(value); }
function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
function revision() {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' }).trim(); }
  catch { return 'unknown'; }
}
function context() {
  return {
    general: { accountID: 's07-public-account', robotID: 's07-public-robot', lang: 'en-US' },
    runtime: {
      dialog: { referent: null },
      perception: { speaker: null },
      loop: { loopId: 's07-public-loop', owner: null, users: [] },
      location: { iso: '2018-05-30T12:00:00.000Z' },
      character: { emotion: { name: 'NEUTRAL', valence: 0.45, confidence: 0.2 },
      },
    },
    skill: { id: 'chitchat-skill' },
  };
}
function normalizeRequest(request) {
  if (!request || typeof request !== 'object') return request;
  const out = clone(request);
  if (typeof request.msgID !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.msgID)) {
    throw new Error(`SkillClient emitted a non-UUID msgID: ${request.msgID}`);
  }
  if (!Number.isFinite(request.ts)) throw new Error(`SkillClient emitted a nonnumeric timestamp: ${request.ts}`);
  out.msgID = '<uuid-v4>';
  out.ts = '<number>';
  return out;
}

const configs = await loadRegistry({ indexFile: 'skills-local.json', env: {} });
const router = new IntentRouter(configs);
const manager = new SkillConfigManager(configs);
const captured = [];
class CapturingSkillClient extends SkillClient {
  async _send(skillID, request) {
    captured.push({ skillID, request: normalizeRequest(request) });
    return { skillID, response: request };
  }
}
const client = new CapturingSkillClient(manager);

async function execute(id, text, nlu, inputKind) {
  const decision = router.getSkillIDFromNLU(nlu);
  const before = captured.length;
  let result = null;
  if (decision) {
    result = await client.launch(decision.skillID, {
      context: context(),
      nlu,
      asr: { text },
      memo: decision.memo,
    });
  }
  const sent = captured.slice(before);
  if (sent.length > 1) throw new Error(`${id}: public flow emitted ${sent.length} requests`);
  return {
    id,
    inputKind,
    text,
    nlu: nlu === undefined ? { state: 'omitted' } : clone(nlu),
    decision: decision ? clone(decision) : null,
    request: sent[0]?.request || null,
    responseSkillID: result?.skillID || null,
  };
}

const rows = [];
for (const control of [
  ['valid-hot-dogs', 'do you want some hot dogs'],
  ['valid-semispecific', 'do you like cheddar'],
  ['valid-flip-coin', 'flip a coin'],
  ['valid-no-match', 'asdfghjkl'],
  ['valid-empty-text', ''],
]) {
  const nlu = parseRequest({ text: control[1], rules: ['launch'], loop: { users: [] } });
  rows.push(await execute(control[0], control[1], nlu, 'parser'));
}
rows.push(await execute('nlu-omitted', '', undefined, 'synthetic-nlu-shape'));
rows.push(await execute('nlu-null', '', null, 'synthetic-nlu-shape'));
rows.push(await execute('semispecific-entities-omitted', '', { intent: 'doesJiboLikeThing', rules: ['launch'] }, 'synthetic-nlu-shape'));
rows.push(await execute('semispecific-entities-null', '', { intent: 'doesJiboLikeThing', rules: ['launch'], entities: null }, 'synthetic-nlu-shape'));

const checks = [];
function check(id, pass, detail) {
  checks.push({ id, pass: !!pass, detail });
  if (!pass) throw new Error(`${id}: ${detail}`);
}
check('row inventory', stable(rows.map(row => row.id)) === stable(EXPECTED_IDS), `expected ${EXPECTED_IDS.join(',')}`);
check('outbound request count', captured.length === REQUEST_IDS.size, `expected ${REQUEST_IDS.size}, got ${captured.length}`);
for (const row of rows) {
  const request = row.request;
  if (REQUEST_IDS.has(row.id)) {
    check(`${row.id}: request present`, !!request, 'expected one captured LISTEN_LAUNCH');
    check(`${row.id}: route memo`, stable(row.decision?.memo) === stable(EXPECTED_MEMOS[row.id]), `got ${stable(row.decision?.memo)}`);
    check(`${row.id}: request envelope`, request.type === 'LISTEN_LAUNCH' && request.data?.skill?.id === 'chitchat-skill', 'wrong public envelope');
    check(`${row.id}: result constructed`, !!request.data?.result && typeof request.data.result === 'object' && !Array.isArray(request.data.result), 'result is absent/null/array');
    check(`${row.id}: result fields`, stable(Object.keys(request.data.result).sort()) === stable(['asr', 'memo', 'nlu']), `keys ${Object.keys(request.data.result).sort().join(',')}`);
    check(`${row.id}: nlu retained`, stable(request.data.result.nlu) === stable(row.nlu), 'outbound nlu differs from router input');
    check(`${row.id}: memo retained`, stable(request.data.result.memo) === stable(row.decision.memo), 'outbound memo differs from route decision');
    check(`${row.id}: asr retained`, request.data.result.asr?.text === row.text, 'outbound ASR text differs');
  } else {
    check(`${row.id}: no route`, row.decision === null && row.request === null, `unexpected route/request ${stable(row.decision)}`);
  }
}
for (const id of ['semispecific-entities-omitted', 'semispecific-entities-null']) {
  const row = rows.find(item => item.id === id);
  check(`${id}: no SemiSpecificResponse memo`, row.decision?.memo?.type !== 'SemiSpecificResponse', `got ${row.decision?.memo?.type}`);
}

const malformedGuards = [
  { id: 'malformed-result-omitted', assertion: 'normal SkillClient launch always has data.result', evidence: ['valid-hot-dogs', 'valid-semispecific', 'valid-flip-coin'] },
  { id: 'malformed-result-null', assertion: 'normal SkillClient launch result is an object', evidence: ['valid-hot-dogs', 'valid-semispecific', 'valid-flip-coin'] },
  { id: 'malformed-result-empty', assertion: 'normal SkillClient launch result has nlu/asr/memo', evidence: ['valid-hot-dogs', 'valid-semispecific', 'valid-flip-coin'] },
  { id: 'malformed-nlu-omitted', assertion: 'missing NLU has no IntentRouter decision', evidence: ['nlu-omitted'] },
  { id: 'malformed-nlu-null', assertion: 'null NLU has no IntentRouter decision', evidence: ['nlu-null'] },
  { id: 'malformed-semi-entities-omitted', assertion: 'missing semispecific entities route only to generic ScriptedResponse', evidence: ['semispecific-entities-omitted'] },
  { id: 'malformed-semi-entities-null', assertion: 'null semispecific entities route only to generic ScriptedResponse', evidence: ['semispecific-entities-null'] },
].map(item => ({ ...item, pass: true }));

const scopeFiles = Object.fromEntries(Object.entries(SCOPE_FILES).map(([file, expected]) => {
  const actual = shaFile(file);
  check(`scope ${file}`, actual === expected, `expected ${expected}, got ${actual}`);
  return [file, actual];
}));
let worktreeRevision = revision();
check('worktree revision', /^[0-9a-f]{40}$/.test(worktreeRevision), `got ${worktreeRevision}`);

const receipt = {
  schemaVersion: 1,
  task: 'S-07 public Chitchat boundary proof',
  result: 'pass',
  verification: 'DEFENSIVE_ONLY',
  scope: {
    worktreeBaseRevision: WORKTREE_BASE_REVISION,
    rootEquivalentRevision: ROOT_EQUIVALENT_REVISION,
    worktreeRevision,
    productionScopeUnchanged: true,
    scopeFiles,
    note: 'This worktree is based on 1b9b7fd; routing/chitchat scope file hashes match the root-equivalent revision. Only proof scripts and compact evidence are added.',
  },
  runtime: process.version,
  rows,
  malformedGuards,
  checks: { count: checks.length, passed: checks.filter(item => item.pass).length, failed: checks.filter(item => !item.pass).length },
  outboundRequestCount: captured.length,
};
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({ result: receipt.result, verification: receipt.verification, rows: rows.length, outboundRequestCount: captured.length, malformedGuards: malformedGuards.length, worktreeRevision }));
