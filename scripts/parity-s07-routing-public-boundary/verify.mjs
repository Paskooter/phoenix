#!/usr/bin/env node

// Verify the compact public-boundary receipt without executing a hand-built
// Chitchat request.  Falsification runs this checker against fresh mutated
// copies, so paired receipt corruption cannot be hidden by a child result.

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const index = args.indexOf('--receipt');
const receiptPath = path.resolve(index === -1 ? args[0] : args[index + 1]);
const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
const stable = value => JSON.stringify(value);
const errors = [];
const expectedScopeFiles = {
  'packages/gateway/src/intentRouter.js': '3600536f66895c8c46a86b14faf2d2309d7991bf',
  'packages/gateway/src/skillClient.js': '808244ae0eefa987c2cda4de20a40d8c6ec6869c',
  'packages/gateway/resources/skills/skills-local.json': '1047648247cf0144a0d3eb80716a22b787065c43',
  'packages/nlu/src/requestParser.js': '49f276ada76d8cbb6358835418b548d629428ba8',
  'packages/nlu/src/chitchatEntityNormalization.js': 'd488be26a455db3e52616c088a87631d0c4a1a86',
  'packages/skills/src/chitchatSkill.js': '0105db60e13cf23754ac23e744bbad299865d5ff',
};
const expectedIds = [
  'valid-hot-dogs', 'valid-semispecific', 'valid-flip-coin', 'valid-no-match',
  'valid-empty-text', 'nlu-omitted', 'nlu-null',
  'semispecific-entities-omitted', 'semispecific-entities-null',
];
const expectedTexts = {
  'valid-hot-dogs': 'do you want some hot dogs',
  'valid-semispecific': 'do you like cheddar',
  'valid-flip-coin': 'flip a coin',
  'valid-no-match': 'asdfghjkl',
  'valid-empty-text': '',
  'nlu-omitted': '',
  'nlu-null': '',
  'semispecific-entities-omitted': '',
  'semispecific-entities-null': '',
};
const expectedNlu = {
  'valid-hot-dogs': { entities: { FoodGeneral: 'SomeFoodGeneral', union_original_fst_name: 'handle:chitchat/launch' }, intent: 'doesJiboWantThing', rules: ['launch'] },
  'valid-semispecific': { entities: { Cheese: 'SomeCheese', union_original_fst_name: 'handle:chitchat/launch' }, intent: 'doesJiboLikeThing', rules: ['launch'] },
  'valid-flip-coin': { entities: { union_original_fst_name: 'handle:chitchat/launch' }, intent: 'requestFlipCoin', rules: ['launch'] },
  'valid-no-match': { intent: null, entities: null, rules: [] },
  'valid-empty-text': { intent: null, entities: null, rules: [] },
};
const expectedMemos = {
  'valid-hot-dogs': { mim: 'RI_JBO_Wants_SS_FoodGeneral', type: 'ScriptedResponse' },
  'valid-semispecific': { mim: 'RI_JBO_Likes_SS_Cheese', type: 'ScriptedResponse' },
  'valid-flip-coin': { mim: 'RA_JBO_FlipCoin', type: 'ScriptedResponse' },
  'semispecific-entities-omitted': { mim: 'KU_DoYouLike', type: 'ScriptedResponse' },
  'semispecific-entities-null': { mim: 'KU_DoYouLike', type: 'ScriptedResponse' },
};
const requestIds = new Set(Object.keys(expectedMemos));
const noRouteIds = new Set(['valid-no-match', 'valid-empty-text', 'nlu-omitted', 'nlu-null']);
const malformedIds = [
  'malformed-result-omitted', 'malformed-result-null', 'malformed-result-empty',
  'malformed-nlu-omitted', 'malformed-nlu-null',
  'malformed-semi-entities-omitted', 'malformed-semi-entities-null',
];
const expectedGuards = new Map([
  ['malformed-result-omitted', ['normal SkillClient launch always has data.result', ['valid-hot-dogs', 'valid-semispecific', 'valid-flip-coin']]],
  ['malformed-result-null', ['normal SkillClient launch result is an object', ['valid-hot-dogs', 'valid-semispecific', 'valid-flip-coin']]],
  ['malformed-result-empty', ['normal SkillClient launch result has nlu/asr/memo', ['valid-hot-dogs', 'valid-semispecific', 'valid-flip-coin']]],
  ['malformed-nlu-omitted', ['missing NLU has no IntentRouter decision', ['nlu-omitted']]],
  ['malformed-nlu-null', ['null NLU has no IntentRouter decision', ['nlu-null']]],
  ['malformed-semi-entities-omitted', ['missing semispecific entities route only to generic ScriptedResponse', ['semispecific-entities-omitted']]],
  ['malformed-semi-entities-null', ['null semispecific entities route only to generic ScriptedResponse', ['semispecific-entities-null']]],
]);
const general = { accountID: 's07-public-account', robotID: 's07-public-robot', lang: 'en-US' };
const runtime = {
  dialog: { referent: null },
  perception: { speaker: null },
  loop: { loopId: 's07-public-loop', owner: null, users: [] },
  location: { iso: '2018-05-30T12:00:00.000Z' },
  character: { emotion: { name: 'NEUTRAL', valence: 0.45, confidence: 0.2 } },
};

function check(id, condition, detail) {
  if (!condition) errors.push({ id, detail });
}
check('schema', receipt.schemaVersion === 1, `got ${receipt.schemaVersion}`);
check('task', receipt.task === 'S-07 public Chitchat boundary proof', `got ${receipt.task}`);
check('result', receipt.result === 'pass', `got ${receipt.result}`);
check('verification', receipt.verification === 'DEFENSIVE_ONLY', `got ${receipt.verification}`);
check('scope base', receipt.scope?.worktreeBaseRevision === '1b9b7fdbf72462b65caf538e206625a11ec8b130', 'worktree base is not pinned');
check('scope root equivalent', receipt.scope?.rootEquivalentRevision === '99a758c5d5babe33a1a97d4585e44728efa4e158', 'root-equivalent revision is not pinned');
check('scope unchanged', receipt.scope?.productionScopeUnchanged === true, 'production scope marker is false');
check('scope files', stable(receipt.scope?.scopeFiles) === stable(expectedScopeFiles), 'routing/chitchat scope file inventory changed');
check('runtime', receipt.runtime === 'v22.22.0', `got ${receipt.runtime}`);
check('outbound count', receipt.outboundRequestCount === requestIds.size, `got ${receipt.outboundRequestCount}`);

const rows = Array.isArray(receipt.rows) ? receipt.rows : [];
check('row cardinality', rows.length === expectedIds.length, `got ${rows.length}`);
const rowById = new Map();
for (const row of rows) {
  if (rowById.has(row?.id)) errors.push({ id: `duplicate:${row?.id}`, detail: 'duplicate public-boundary row' });
  rowById.set(row?.id, row);
}
check('row IDs', stable(rows.map(row => row.id)) === stable(expectedIds), 'row IDs/order differ from pinned plan');
for (const id of expectedIds) {
  const row = rowById.get(id);
  check(`${id}: present`, !!row, 'missing row');
  if (!row) continue;
  check(`${id}: text`, row.text === expectedTexts[id], `got ${row.text}`);
  if (Object.hasOwn(expectedNlu, id)) check(`${id}: parser NLU`, stable(row.nlu) === stable(expectedNlu[id]), 'parser output changed');
  if (id === 'nlu-omitted') check(`${id}: NLU omitted`, stable(row.nlu) === stable({ state: 'omitted' }), 'omitted NLU marker changed');
  if (id === 'nlu-null') check(`${id}: NLU null`, row.nlu === null, 'null NLU marker changed');
  if (requestIds.has(id)) {
    const request = row.request;
    const decision = row.decision;
    check(`${id}: request`, !!request, 'missing captured request');
    check(`${id}: decision`, !!decision, 'missing route decision');
    if (!request || !decision) continue;
    check(`${id}: memo`, stable(decision.memo) === stable(expectedMemos[id]), `got ${stable(decision.memo)}`);
    check(`${id}: response skill`, row.responseSkillID === 'chitchat-skill', `got ${row.responseSkillID}`);
    check(`${id}: envelope`, request.type === 'LISTEN_LAUNCH' && request.msgID === '<uuid-v4>' && request.ts === '<number>', 'captured envelope changed');
    check(`${id}: general`, stable(request.data?.general) === stable(general), 'general context changed');
    check(`${id}: runtime`, stable(request.data?.runtime) === stable(runtime), 'runtime context changed');
    check(`${id}: skill`, stable(request.data?.skill) === stable({ id: 'chitchat-skill' }), 'skill context changed');
    const result = request.data?.result;
    check(`${id}: result object`, !!result && typeof result === 'object' && !Array.isArray(result), 'result is absent/null/array');
    if (!result || typeof result !== 'object') continue;
    check(`${id}: result keys`, stable(Object.keys(result).sort()) === stable(['asr', 'memo', 'nlu']), `keys ${Object.keys(result).sort()}`);
    check(`${id}: result NLU`, stable(result.nlu) === stable(row.nlu), 'outbound NLU differs from input');
    check(`${id}: result ASR`, result.asr?.text === row.text, 'outbound ASR differs from input');
    check(`${id}: result memo`, stable(result.memo) === stable(decision.memo), 'outbound memo differs from route');
  } else if (noRouteIds.has(id)) {
    check(`${id}: no route`, row.decision === null && row.request === null && row.responseSkillID === null, 'unexpected route/request');
  }
}
for (const id of ['semispecific-entities-omitted', 'semispecific-entities-null']) {
  const row = rowById.get(id);
  check(`${id}: generic memo`, stable(row?.decision?.memo) === stable(expectedMemos[id]), 'semispecific null/missing entities produced a different memo');
  check(`${id}: no SemiSpecificResponse`, row?.decision?.memo?.type !== 'SemiSpecificResponse', 'malformed semispecific memo was emitted');
}

const guards = Array.isArray(receipt.malformedGuards) ? receipt.malformedGuards : [];
check('malformed guard cardinality', guards.length === malformedIds.length, `got ${guards.length}`);
check('malformed guard IDs', stable(guards.map(item => item.id)) === stable(malformedIds), 'malformed guard inventory changed');
for (const guard of guards) {
  const expectedGuard = expectedGuards.get(guard.id);
  check(`${guard.id}: guard present`, !!expectedGuard, 'unexpected malformed guard');
  if (!expectedGuard) continue;
  check(`${guard.id}: pass`, guard.pass === true, 'guard is not passing');
  check(`${guard.id}: assertion`, guard.assertion === expectedGuard[0], 'guard assertion changed');
  check(`${guard.id}: evidence`, stable(guard.evidence) === stable(expectedGuard[1]), 'guard evidence changed');
}

const result = { result: errors.length ? 'fail' : 'pass', errors: errors.length, checkedRows: rows.length, checkedGuards: guards.length, outboundRequestCount: receipt.outboundRequestCount };
console.log(JSON.stringify(result));
if (result.result !== 'pass') process.exitCode = 1;
