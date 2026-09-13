#!/usr/bin/env node

// Fail-closed comparator for the weighted S-07 closure lane.  It intentionally
// compares every source-derived branch row in a bounded batch, including the
// source oracle's no-eligible controls.  The source and candidate runners
// already normalize only the two source-generated action IDs; all other wire
// fields remain observable here.

import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runtimeFor: weightedRuntimeFor } = require('./weighted-context.cjs');

const [planPath, sourcePath, candidatePath, outPath, eligibilityPath] = process.argv.slice(2);
if (!planPath || !sourcePath || !candidatePath || !outPath) {
  throw new Error('usage: compare-weighted.mjs PLAN SOURCE CANDIDATE OUT [ELIGIBILITY]');
}

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function equal(a, b) { return stable(a) === stable(b); }
function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function increment(map, key) { map[key] = (map[key] || 0) + 1; }
function contextIdFor(row) { return row.contextId || (row.id.match(/^weighted:(context:[^:]+:\d+)/) || [])[1]; }
function keys(value) { return value && typeof value === 'object' ? Object.keys(value).sort() : []; }
function basicPrompt(item) { return { prompt_id: item.prompt_id, weight: item.weight }; }
function promptExpectation(item) {
  const output = {
    prompt_id: item.prompt_id,
    weight: item.weight,
    esml: item.esml,
    autoRuleConfigPresent: item.autoRuleConfigPresent === true,
  };
  if (output.autoRuleConfigPresent) output.autoRuleConfig = item.autoRuleConfig;
  return output;
}
function profileValue(profile, key) {
  const part = String(profile || '').split('|').find((item) => item.startsWith(`${key}=`));
  return part ? part.slice(key.length + 1) : undefined;
}
const runtimeReferentCache = new Map();
const runtimeReferentErrors = new Map();
function runtimeReferent(profile) {
  if (!runtimeReferentCache.has(profile)) {
    try {
      const runtime = weightedRuntimeFor(profile);
      runtimeReferentCache.set(profile, runtime && runtime.dialog && runtime.dialog.referent);
    } catch (error) {
      runtimeReferentErrors.set(profile, String(error));
      runtimeReferentCache.set(profile, null);
    }
  }
  return runtimeReferentCache.get(profile);
}
function sampledPrompt(eligible, unit) {
  const total = eligible.reduce((sum, item) => sum + item.weight, 0);
  const target = unit * total;
  let ongoing = 0;
  for (const item of eligible) {
    if (item.weight > 0) {
      ongoing += item.weight;
      if (target < ongoing) return item.prompt_id;
    }
  }
  return null;
}
function expectedUnit(row) {
  const boundary = row.boundary || {};
  if (boundary.kind === 'exact-total') return 1;
  if (!Number.isFinite(row.expectedWeightTotal) || row.expectedWeightTotal <= 0) return NaN;
  if (boundary.kind === 'lower') return boundary.lower / row.expectedWeightTotal;
  if (boundary.kind === 'interior') return ((boundary.lower + boundary.upper) / 2) / row.expectedWeightTotal;
  return NaN;
}
function expectedRngValues(row) {
  const unit = expectedUnit(row);
  if (!Number.isFinite(unit) || unit < 0 || unit > 1) return null;
  if (row.mim === 'CC_Fallback') return [unit];
  const dieValue = (side) => (side - 1 + 0.125) / 6;
  return [dieValue(row.diceA), dieValue(row.diceB), row.coin === 'heads' ? 1 : 0, unit];
}

const EXPECTED_MIM_INVENTORY = {
  treeSha256: 'dfc7e6db41c072ef01f431736df5b00abd2f8cff469593fc51b0d1fb977f28ca',
  counts: { scripted: 4369, emotion: 54, fallback: 1 },
  idsSha256: {
    scripted: '9c77e0a971c192eb31e47d7ed6f44217e8b1546159e5ce21fe3a754baed14a46',
    emotion: 'a6eca8b701574703da34975fb9acfa8245380d3084f84ab8d5a9823220db36b2',
    fallback: 'a5ddf758944232d679aa1bd115bf69590b28f408894b0f772f7f4de6e9097a26',
  },
  allIdsSha256: '81a89fe41266295232e4bfdd0abd287b3d4a5efd1c1fcfff373a4a3251c5eb9b',
};

const plan = readJson(planPath);
const source = readJson(sourcePath);
const candidate = readJson(candidatePath);
const eligibility = eligibilityPath ? readJson(eligibilityPath) : null;
const failures = [];
let failureCount = 0;
function fail(code, detail) {
  failureCount += 1;
  if (failures.length < 200) failures.push({ code, detail });
}
function requireValue(condition, code, detail) { if (!condition) fail(code, detail); }

requireValue(plan.schemaVersion === 1 && plan.task === 'S-07' && plan.stage === 'branches', 'plan-schema', { schemaVersion: plan.schemaVersion, task: plan.task, stage: plan.stage });
requireValue(source.schemaVersion === 1 && source.task === 'S-07', 'source-schema', { schemaVersion: source.schemaVersion, task: source.task });
requireValue(candidate.schemaVersion === 1 && candidate.task === 'S-07', 'candidate-schema', { schemaVersion: candidate.schemaVersion, task: candidate.task });
requireValue(source.runtime === 'v8.9.4', 'source-runtime', source.runtime);
requireValue(candidate.runtime === 'v22.22.0', 'candidate-runtime', candidate.runtime);
requireValue(source.sourceRevision === plan.sourceRevision, 'source-revision', { expected: plan.sourceRevision, actual: source.sourceRevision });
requireValue(plan.sourceRevision === '5c0a7390539663ba749d360de348a428c088505c', 'pinned-source-revision', plan.sourceRevision);
requireValue(plan.candidateRevision === 'dd2199d0b7f5bff6a5bf799b7e2a115e8e0385ec' && /^[0-9a-f]{40}$/.test(plan.candidateRevision), 'pinned-candidate-revision', plan.candidateRevision);
requireValue(candidate.candidateRevision === plan.candidateRevision && /^[0-9a-f]{40}$/.test(candidate.candidateRevision), 'candidate-revision', { expected: plan.candidateRevision, actual: candidate.candidateRevision });
requireValue(source.vmRandomControlled === true, 'source-vm-random-control', source.vmRandomControlled);
requireValue(candidate.vmRandomControlled === true, 'candidate-vm-random-control', candidate.vmRandomControlled);
requireValue(plan.inventory && plan.inventory.promptSourceTreeSha256 === EXPECTED_MIM_INVENTORY.treeSha256, 'plan-mim-tree-digest', plan.inventory && plan.inventory.promptSourceTreeSha256);
requireValue(equal(source.mimInventory, EXPECTED_MIM_INVENTORY), 'source-mim-inventory', source.mimInventory);
requireValue(equal(candidate.mimInventory, EXPECTED_MIM_INVENTORY), 'candidate-mim-inventory', candidate.mimInventory);
requireValue(source.planCases === plan.cases.length, 'source-plan-count', { expected: plan.cases.length, actual: source.planCases });
requireValue(candidate.planCases === plan.cases.length, 'candidate-plan-count', { expected: plan.cases.length, actual: candidate.planCases });
requireValue(source.rows.length === plan.cases.length, 'source-row-count', { expected: plan.cases.length, actual: source.rows.length });
requireValue(candidate.rows.length === plan.cases.length, 'candidate-row-count', { expected: plan.cases.length, actual: candidate.rows.length });

const expectedNeverTrue = [
  ['JBO_HowTallAreYou_AN_01', 'false', 'source-literal-false'],
  ['JBO_WhatsFavoriteThing_AN_01', 'false', 'source-literal-false'],
  ['OI_USR_DislikesAllStarGameNHL_AN_01_FnL', "dt.now.isInRange('start_coming_soon', '1/28')", 'source-malformed-date-label'],
  ['OI_USR_DislikesAllStarGameNHL_AN_04_FnL', "dt.now.isInRange('1/29', 'finish_long_way_off')", 'source-malformed-date-label'],
  ['OI_USR_IsThankfulForJibo_AN_05', '!!loop.owner && !!speaker && (loop.owner === speaker)', 'source-distinct-wrapper-identity'],
  ['RA_JBO_Fart_AN_03', 'false /* need Fart SFX */', 'source-literal-false'],
  ['RI_JBO_FeelsSadAboutNoLegs_AN_04', ' ', 'source-blank-condition'],
  ['RI_JBO_IsFriendsWithUser_AN_02', 'speaker==true', 'source-object-vs-boolean'],
  ['RI_JBO_IsHuman_AN_03', 'false', 'source-literal-false'],
];
const actualNeverTrue = (plan.conditionAudit && plan.conditionAudit.neverTrue || []).map((item) => [item.prompt_id, item.condition, item.classification]);
requireValue(equal(actualNeverTrue, expectedNeverTrue), 'condition-never-true-classification', { expected: expectedNeverTrue, actual: actualNeverTrue });
requireValue(plan.conditionAudit && plan.conditionAudit.entries === 4558 && plan.conditionAudit.everyEntryObserved === true && plan.conditionAudit.bothOutcomesObserved === 4549, 'condition-coverage', plan.conditionAudit);
requireValue(plan.promptAudit && plan.promptAudit.sourcePromptIds === 11883 && plan.promptAudit.selectedPromptIds === 11874 && plan.promptAudit.missingAreOnlyNeverTrue === true, 'prompt-coverage', plan.promptAudit);
requireValue(plan.eligibilityAudit && plan.eligibilityAudit.result === 'pass' && plan.eligibilityAudit.topLevelErrors === 0 && plan.eligibilityAudit.unclassified.length === 0, 'eligibility-audit', plan.eligibilityAudit);
requireValue(equal(plan.eligibilityAudit && plan.eligibilityAudit.resolutionErrorGroups, {
  'OI_USR_DislikesLoopMemberAskedAboutBirthday|OI_USR_DislikesLoopMemberAskedAboutBirthday_AN_03|loopMember is not defined': 2,
  'OI_USR_DislikesSpeakerBirthday|OI_USR_DislikesSpeakerBirthday_AN_03|loopMember is not defined': 2,
  'OI_USR_DislikesSummerSolstice|OI_USR_DislikesSummerSolstice_AN_03_FnL|loopMember is not defined': 18,
  'OI_USR_DislikesWinterSolstice|OI_USR_DislikesWinterSolstice_AN_03_FnL|loopMember is not defined': 18,
  'RI_JBO_Is_SS_Zodiac|RI_JBO_Is_SS_Zodiac_AN_01|jiboNLBirthdate is not defined': 3,
  'RI_JBO_Is_SS_Zodiac|RI_JBO_Is_SS_Zodiac_AN_02|jiboNLBirthdate is not defined': 3,
}), 'eligibility-resolution-errors', plan.eligibilityAudit && plan.eligibilityAudit.resolutionErrorGroups);
requireValue(plan.inventory && plan.inventory.profileSelfTest && plan.inventory.profileSelfTest.result === 'pass', 'profile-self-test', plan.inventory && plan.inventory.profileSelfTest);

const sourceIds = new Map();
const candidateIds = new Map();
for (let index = 0; index < source.rows.length; index += 1) {
  const row = source.rows[index];
  if (sourceIds.has(row.id)) fail('source-duplicate-id', { id: row.id, first: sourceIds.get(row.id), duplicate: index });
  else sourceIds.set(row.id, index);
}
for (let index = 0; index < candidate.rows.length; index += 1) {
  const row = candidate.rows[index];
  if (candidateIds.has(row.id)) fail('candidate-duplicate-id', { id: row.id, first: candidateIds.get(row.id), duplicate: index });
  else candidateIds.set(row.id, index);
}
const planIds = new Set();
for (const row of plan.cases) {
  if (planIds.has(row.id)) fail('plan-duplicate-id', row.id);
  planIds.add(row.id);
}
requireValue(sourceIds.size === planIds.size, 'source-id-cardinality', { plan: planIds.size, source: sourceIds.size });
requireValue(candidateIds.size === planIds.size, 'candidate-id-cardinality', { plan: planIds.size, candidate: candidateIds.size });
for (const id of planIds) {
  if (!sourceIds.has(id)) fail('source-missing-id', id);
  if (!candidateIds.has(id)) fail('candidate-missing-id', id);
}
for (const id of sourceIds.keys()) if (!planIds.has(id)) fail('source-extra-id', id);
for (const id of candidateIds.keys()) if (!planIds.has(id)) fail('candidate-extra-id', id);

const oracleByContext = new Map();
if (eligibility) {
  requireValue(eligibility.schemaVersion === 1, 'eligibility-schema', eligibility.schemaVersion);
  requireValue(eligibility.sourceRevision === plan.sourceRevision && eligibility.sourceRevision === '5c0a7390539663ba749d360de348a428c088505c', 'eligibility-source-revision', eligibility.sourceRevision);
  requireValue(eligibility.sourceRuntime === 'v8.9.4', 'eligibility-source-runtime', eligibility.sourceRuntime);
  requireValue(eligibility.cases === eligibility.rows.length && eligibility.cases === plan.contextCases, 'eligibility-case-count', { cases: eligibility.cases, rows: eligibility.rows.length, plan: plan.contextCases });
  const duplicateOracleIds = [];
  for (const row of eligibility.rows || []) {
    if (oracleByContext.has(row.id)) duplicateOracleIds.push(row.id);
    oracleByContext.set(row.id, row);
  }
  requireValue(duplicateOracleIds.length === 0, 'eligibility-duplicate-id', duplicateOracleIds.slice(0, 10));
  requireValue(eligibility.rows.length === plan.contextCases, 'eligibility-context-count', { expected: plan.contextCases, actual: eligibility.rows.length });
  const range = plan.contextRange || { start: 0, count: plan.contextCases, total: plan.contextCases };
  requireValue(Number.isInteger(range.start) && Number.isInteger(range.count) && range.start >= 0 && range.count >= 0 && range.start + range.count <= eligibility.rows.length && range.total === eligibility.rows.length, 'context-range', range);
  const expectedContextIds = (eligibility.rows.slice(range.start, range.start + range.count)).map((row) => row.id);
  const plannedContextIds = [...new Set(plan.cases.map((row) => contextIdFor(row)))];
  requireValue(equal([...plannedContextIds].sort(), [...expectedContextIds].sort()), 'context-inventory', { expectedCount: expectedContextIds.length, plannedCount: plannedContextIds.length, missing: expectedContextIds.filter((id) => !plannedContextIds.includes(id)).slice(0, 10), extra: plannedContextIds.filter((id) => !expectedContextIds.includes(id)).slice(0, 10) });
  const plannedPromptContextIds = Object.keys(plan.promptExpectations || {});
  requireValue(equal(plannedPromptContextIds.sort(), expectedContextIds.slice().sort()), 'prompt-expectation-context-inventory', { expectedCount: expectedContextIds.length, plannedCount: plannedPromptContextIds.length, missing: expectedContextIds.filter((id) => !plannedPromptContextIds.includes(id)).slice(0, 10), extra: plannedPromptContextIds.filter((id) => !expectedContextIds.includes(id)).slice(0, 10) });
  for (const contextId of expectedContextIds) {
    const oracle = oracleByContext.get(contextId);
    requireValue(!!oracle, 'missing-prompt-expectation-oracle', contextId);
    if (oracle) requireValue(equal(plan.promptExpectations[contextId] || [], (oracle.eligible || []).map(promptExpectation)), 'prompt-expectation-oracle', { contextId, expected: (oracle.eligible || []).map(promptExpectation), actual: plan.promptExpectations[contextId] });
  }
  for (const row of eligibility.rows) {
    if (row.error || (row.errors && row.errors.length)) fail('eligibility-row-error', { id: row.id, error: row.error, errors: row.errors });
  }
}

const stats = {
  boundaries: {},
  mims: {},
  sourceRngCalls: {},
  candidateRngCalls: {},
  sourceVmRngCalls: {},
  candidateVmRngCalls: {},
  expectedRngCalls: {},
  expectedVmRngCalls: {},
  noEligibleCases: 0,
  selectedPromptCases: 0,
  exactTotalCases: 0,
  sourceEnvelope: { actionPresent: 0, noAction: 0, emotionEvents: 0, querySuccess: 0, queryFailure: 0, queryTypes: {} },
};
const expectedActionIdPaths = ['config.jcp.config.play.id', 'config.jcp.id'];
function metadata(row) {
  return { id: row.id, family: row.family, mim: row.mim, memoType: row.memoType, profile: row.profile, entities: row.entities || {}, expectedCategory: row.expectedCategory, expectedCategories: row.expectedCategories };
}
function actualPrompts(row) { return row.result && Array.isArray(row.result.prompts) ? row.result.prompts : []; }
function checkAnalytics(row, result, side) {
  const emotion = row.memoType === 'EmotionQuery';
  // Analytics.ts resolves the query type in this order: a concrete dialog
  // referent is a loop-member question, then KU_* MIMs are known-unknown
  // questions, and only then does the memo intent select emotion/scripted.
  // Keep this source-derived precedence explicit so a paired source/candidate
  // forgery cannot make an incorrect shared analytics value pass.
  const resolvedReferent = runtimeReferent(row.profile);
  const resolvedMim = row.expectedOutputMim || row.mim;
  if (runtimeReferentErrors.has(row.profile)) fail(`${side}-weighted-runtime-profile`, { id: row.id, profile: row.profile, error: runtimeReferentErrors.get(row.profile) });
  const queryType = resolvedReferent
    ? 'loop_member_question'
    : resolvedMim.startsWith('KU_')
      ? 'known_unknown'
      : emotion ? 'emotion_query' : 'scripted_response';
  const expectedEvents = emotion ? ['Skill Entry', 'Chitchat Query', 'Chitchat Emotion'] : ['Skill Entry', 'Chitchat Query'];
  const state = profileValue(row.profile, 'emotion');
  const skillEvents = result.analytics && result.analytics['chitchat-skill'];
  requireValue(keys(result.analytics).join('|') === 'chitchat-skill', `${side}-analytics-envelope`, { id: row.id, keys: keys(result.analytics) });
  requireValue(Array.isArray(skillEvents) && equal(skillEvents.map((event) => event.event), expectedEvents), `${side}-analytics-events`, { id: row.id, expected: expectedEvents, actual: skillEvents });
  if (!Array.isArray(skillEvents)) return;
  const expectedSkillEntry = {
    event: 'Skill Entry',
    properties: { initial_intent: 'n/a', domain: '', was_hey_jibo_launch: true, user_initiated: true, last_skill: 'n/a' },
  };
  const expectedQuery = {
    event: 'Chitchat Query',
    properties: { success: row.mim !== 'CC_Fallback', type: queryType },
  };
  requireValue(equal(skillEvents[0], expectedSkillEntry), `${side}-analytics-skill-entry`, { id: row.id, actual: skillEvents[0] });
  requireValue(equal(skillEvents[1], expectedQuery), `${side}-analytics-query`, { id: row.id, actual: skillEvents[1] });
  if (side === 'source') increment(stats.sourceEnvelope.queryTypes, queryType);
  if (emotion) {
    const properties = { emotion_query_type: 'emotion_query' };
    if (state && state !== 'undefined') properties.emotional_state = state;
    requireValue(equal(skillEvents[2], { event: 'Chitchat Emotion', properties }), `${side}-analytics-emotion`, { id: row.id, expected: properties, actual: skillEvents[2] });
  }
}
function checkResult(row, result, side) {
  requireValue(result && result.result, `${side}-missing-result`, row.id);
  if (!result || !result.result) return;
  const wire = result.result;
  const actionExpected = !!row.expectedPrompt || (row.expectedEligible && row.expectedEligible.length > 0);
  if (side === 'source') {
    if (actionExpected) stats.sourceEnvelope.actionPresent += 1;
    else stats.sourceEnvelope.noAction += 1;
    if (row.memoType === 'EmotionQuery') stats.sourceEnvelope.emotionEvents += 1;
    const query = wire.analytics && wire.analytics['chitchat-skill'] && wire.analytics['chitchat-skill'].find((event) => event.event === 'Chitchat Query');
    if (query && query.properties && query.properties.success === true) stats.sourceEnvelope.querySuccess += 1;
    if (query && query.properties && query.properties.success === false) stats.sourceEnvelope.queryFailure += 1;
  }
  const expectedEnvelope = actionExpected
    ? ['action', 'actionIdPaths', 'analytics', 'esml', 'final', 'fireAndForget', 'jcpType', 'mims', 'prompts', 'responseType', 'slims']
    : ['action', 'actionIdPaths', 'analytics', 'final', 'fireAndForget', 'responseType'];
  requireValue(equal(keys(wire), expectedEnvelope), `${side}-result-envelope`, { id: row.id, expected: expectedEnvelope, actual: keys(wire) });
  requireValue(wire.responseType === 'SKILL_ACTION', `${side}-response-type`, { id: row.id, actual: wire.responseType });
  requireValue(wire.final === true, `${side}-final`, { id: row.id, actual: wire.final });
  checkAnalytics(row, wire, side);
  requireValue((wire.action !== null) === actionExpected, `${side}-action-presence`, { id: row.id, expected: actionExpected, actual: !!wire.action });
  if (!actionExpected) {
    requireValue(wire.action === null && wire.fireAndForget === true && equal(wire.actionIdPaths, []), `${side}-no-action-envelope`, { id: row.id, action: wire.action, fireAndForget: wire.fireAndForget, actionIdPaths: wire.actionIdPaths });
    return;
  }
  // Keep forged or malformed rows fail-closed without throwing before the
  // comparator can write its diagnostic receipt.
  if (!wire.action) return;
  requireValue(wire.fireAndForget === false, `${side}-fire-and-forget`, { id: row.id, actual: wire.fireAndForget });
  requireValue(wire.action && keys(wire.action).join('|') === 'config|type' && wire.action.type === 'JCP', `${side}-action-type`, { id: row.id, action: wire.action });
  if (!wire.action.config) return;
  requireValue(wire.action.config && keys(wire.action.config).join('|') === 'jcp|version' && wire.action.config.version === '2.0', `${side}-action-config`, { id: row.id, config: wire.action.config });
  if (!wire.action.config.jcp) return;
  requireValue(wire.action.config.jcp && keys(wire.action.config.jcp).join('|') === 'config|type' && wire.action.config.jcp.type === 'SLIM', `${side}-action-jcp-type`, { id: row.id, jcp: wire.action.config.jcp });
  if (!wire.action.config.jcp.config) return;
  const play = wire.action.config.jcp.config && wire.action.config.jcp.config.play;
  const meta = play && play.meta;
  const exactTotalEligible = !row.expectedPrompt;
  const expectedMetaKeys = exactTotalEligible ? ['mim_id', 'mim_type'] : ['mim_id', 'mim_type', 'prompt_id', 'prompt_sub_category'];
  requireValue(wire.action.config.jcp.config && keys(wire.action.config.jcp.config).join('|') === 'play', `${side}-action-jcp-config`, { id: row.id });
  if (!play) return;
  const expectedPromptOutput = row.expectedPromptOutput;
  const expectedAutoPresent = !exactTotalEligible && expectedPromptOutput && expectedPromptOutput.autoRuleConfigPresent === true;
  const expectedPlayKeys = exactTotalEligible || !expectedPromptOutput
    ? ['esml', 'meta', 'type']
    : expectedAutoPresent ? ['autoRuleConfig', 'esml', 'meta', 'type'] : ['esml', 'meta', 'type'];
  requireValue(play && equal(keys(play), expectedPlayKeys) && play.type === 'PLAY', `${side}-action-play-type`, { id: row.id, play, expectedPlayKeys });
  if (!meta) return;
  requireValue(meta && equal(keys(meta), expectedMetaKeys) && meta.mim_id === row.expectedOutputMim && meta.mim_type === 'announcement', `${side}-action-meta`, { id: row.id, meta, expectedOutputMim: row.expectedOutputMim });
  const normalizedJcpOk = wire.jcpType === 'SLIM' && Array.isArray(wire.slims) && wire.slims.length === 1 && wire.slims[0] && wire.slims[0].play && wire.slims[0].play.type === 'PLAY';
  requireValue(normalizedJcpOk, `${side}-normalized-jcp`, { id: row.id, jcpType: wire.jcpType, slims: wire.slims });
  if (!normalizedJcpOk) return;
  const normalizedSlim = wire.slims[0];
  const normalizedPlay = normalizedSlim.play;
  const expectedEsml = exactTotalEligible ? 'undefined' : expectedPromptOutput && expectedPromptOutput.esml;
  requireValue(equal(keys(normalizedSlim), ['display', 'listen', 'play']) && normalizedSlim.listen === null && normalizedSlim.display === null, `${side}-normalized-slim-shape`, { id: row.id, slim: normalizedSlim });
  requireValue(equal(keys(normalizedPlay), expectedPlayKeys) && normalizedPlay.type === 'PLAY', `${side}-normalized-play-shape`, { id: row.id, expectedPlayKeys, play: normalizedPlay });
  requireValue(equal(normalizedPlay.meta, meta), `${side}-normalized-play-meta`, { id: row.id, expected: meta, actual: normalizedPlay.meta });
  requireValue(normalizedPlay.esml === expectedEsml && wire.action.config.jcp.config.play.esml === expectedEsml && Array.isArray(wire.esml) && wire.esml.length === 1 && wire.esml[0] === expectedEsml, `${side}-normalized-esml`, { id: row.id, expected: expectedEsml, actionEsml: wire.action.config.jcp.config.play.esml, topLevelEsml: wire.esml, slimEsml: normalizedPlay.esml });
  if (expectedAutoPresent) requireValue(equal(normalizedPlay.autoRuleConfig, expectedPromptOutput.autoRuleConfig) && equal(play.autoRuleConfig, expectedPromptOutput.autoRuleConfig), `${side}-normalized-auto-rule-config`, { id: row.id, expected: expectedPromptOutput.autoRuleConfig, action: play.autoRuleConfig, slim: normalizedPlay.autoRuleConfig });
  requireValue(Array.isArray(wire.mims) && wire.mims.length === 1 && wire.mims[0] === row.expectedOutputMim && wire.mims[0] === meta.mim_id, `${side}-normalized-mims`, { id: row.id, mims: wire.mims, meta, expectedOutputMim: row.expectedOutputMim });
  const prompts = actualPrompts(result);
  if (row.expectedPrompt) {
    requireValue(prompts.length === 1 && prompts[0] === row.expectedPrompt, `${side}-expected-prompt`, { id: row.id, expected: row.expectedPrompt, actual: prompts });
    requireValue(expectedPromptOutput && expectedPromptOutput.prompt_id === row.expectedPrompt, `${side}-expected-prompt-output`, { id: row.id, expected: row.expectedPrompt, actual: expectedPromptOutput });
    requireValue(meta.prompt_id === row.expectedPrompt && meta.prompt_sub_category === 'AN', `${side}-selected-prompt-meta`, { id: row.id, meta, expected: row.expectedPrompt });
    requireValue(Array.isArray(wire.esml) && wire.esml.length === 1 && wire.esml[0] !== 'undefined' && wire.esml[0] === expectedPromptOutput.esml && wire.action.config.jcp.config.play.esml === expectedPromptOutput.esml && normalizedPlay.esml === expectedPromptOutput.esml, `${side}-selected-esml`, { id: row.id, expected: expectedPromptOutput.esml, esml: wire.esml, actionEsml: wire.action.config.jcp.config.play.esml, slimEsml: normalizedPlay.esml });
    if (expectedAutoPresent) requireValue(equal(play.autoRuleConfig, expectedPromptOutput.autoRuleConfig), `${side}-selected-auto-rule-config`, { id: row.id, expected: expectedPromptOutput.autoRuleConfig, actual: play.autoRuleConfig });
  } else {
    requireValue(prompts.length === 0, `${side}-exact-total-prompt`, { id: row.id, actual: prompts });
    requireValue(equal(wire.esml, ['undefined']) && wire.action.config.jcp.config.play.esml === 'undefined' && normalizedPlay.esml === 'undefined', `${side}-exact-total-esml`, { id: row.id, actual: wire.esml });
  }
  requireValue(equal(wire.actionIdPaths || [], expectedActionIdPaths), `${side}-action-id-paths`, { id: row.id, actual: wire.actionIdPaths });
}

for (let index = 0; index < plan.cases.length; index += 1) {
  const planRow = plan.cases[index];
  const sourceRow = source.rows[index];
  const candidateRow = candidate.rows[index];
  if (!sourceRow || !candidateRow) continue;
  requireValue(sourceRow.id === planRow.id, 'source-order-or-id', { index, expected: planRow.id, actual: sourceRow.id });
  requireValue(candidateRow.id === planRow.id, 'candidate-order-or-id', { index, expected: planRow.id, actual: candidateRow.id });
  requireValue(!sourceRow.error, 'source-row-error', { id: planRow.id, error: sourceRow.error });
  requireValue(!candidateRow.error, 'candidate-row-error', { id: planRow.id, error: candidateRow.error });
  requireValue(equal(metadata(sourceRow), metadata(candidateRow)), 'source-candidate-row-metadata', { id: planRow.id, source: metadata(sourceRow), candidate: metadata(candidateRow) });
  requireValue(sourceRow.mim === planRow.mim && sourceRow.memoType === planRow.memoType && sourceRow.profile === planRow.profile && sourceRow.family === planRow.family, 'source-plan-row-metadata', { id: planRow.id, plan: metadata(planRow), source: metadata(sourceRow) });
  requireValue(candidateRow.mim === planRow.mim && candidateRow.memoType === planRow.memoType && candidateRow.profile === planRow.profile && candidateRow.family === planRow.family, 'candidate-plan-row-metadata', { id: planRow.id, plan: metadata(planRow), candidate: metadata(candidateRow) });
  const recomputedRngValues = expectedRngValues(planRow);
  requireValue(recomputedRngValues !== null && equal(planRow.rngValues, recomputedRngValues), 'plan-rng-vector', { id: planRow.id, expected: recomputedRngValues, actual: planRow.rngValues, boundary: planRow.boundary, total: planRow.expectedWeightTotal });
  const recomputedPrompt = planRow.boundary && planRow.boundary.kind === 'exact-total' ? null : sampledPrompt(planRow.expectedEligible || [], expectedUnit(planRow));
  requireValue(planRow.expectedPrompt === recomputedPrompt, 'plan-sampled-prompt', { id: planRow.id, expected: recomputedPrompt, actual: planRow.expectedPrompt });
  requireValue(equal(sourceRow.rngInput, planRow.rngValues), 'source-rng-input', { id: planRow.id, expected: planRow.rngValues, actual: sourceRow.rngInput });
  requireValue(equal(candidateRow.rngInput, planRow.rngValues), 'candidate-rng-input', { id: planRow.id, expected: planRow.rngValues, actual: candidateRow.rngInput });
  requireValue(equal(sourceRow.vmRngInput, planRow.vmRngValues), 'source-vm-rng-input', { id: planRow.id, expected: planRow.vmRngValues, actual: sourceRow.vmRngInput });
  requireValue(equal(candidateRow.vmRngInput, planRow.vmRngValues), 'candidate-vm-rng-input', { id: planRow.id, expected: planRow.vmRngValues, actual: candidateRow.vmRngInput });
  requireValue(equal(sourceRow.rngInput, candidateRow.rngInput), 'source-candidate-rng-input', { id: planRow.id });
  requireValue(equal(sourceRow.vmRngInput, candidateRow.vmRngInput), 'source-candidate-vm-rng-input', { id: planRow.id });
  const expectedRngCalls = planRow.expectedRngCalls === undefined
    ? (planRow.mim === 'CC_Fallback' ? 1 : planRow.expectedEligible.length ? 4 : 3)
    : planRow.expectedRngCalls;
  const expectedVmCalls = planRow.expectedVmCalls || 0;
  increment(stats.expectedRngCalls, expectedRngCalls);
  increment(stats.expectedVmRngCalls, expectedVmCalls);
  increment(stats.sourceRngCalls, sourceRow.rngCalls);
  increment(stats.candidateRngCalls, candidateRow.rngCalls);
  increment(stats.sourceVmRngCalls, sourceRow.vmRngCalls);
  increment(stats.candidateVmRngCalls, candidateRow.vmRngCalls);
  requireValue(sourceRow.rngCalls === expectedRngCalls, 'source-rng-call-count', { id: planRow.id, expected: expectedRngCalls, actual: sourceRow.rngCalls });
  requireValue(candidateRow.rngCalls === expectedRngCalls, 'candidate-rng-call-count', { id: planRow.id, expected: expectedRngCalls, actual: candidateRow.rngCalls });
  requireValue(sourceRow.vmRngCalls === expectedVmCalls, 'source-vm-rng-call-count', { id: planRow.id, expected: expectedVmCalls, actual: sourceRow.vmRngCalls });
  requireValue(candidateRow.vmRngCalls === expectedVmCalls, 'candidate-vm-rng-call-count', { id: planRow.id, expected: expectedVmCalls, actual: candidateRow.vmRngCalls });
  const boundaryKind = planRow.boundary && planRow.boundary.kind;
  increment(stats.boundaries, boundaryKind || 'missing');
  increment(stats.mims, planRow.mim);
  if (boundaryKind === 'exact-total') stats.exactTotalCases += 1;
  if (!planRow.expectedEligible.length) stats.noEligibleCases += 1;
  if (planRow.expectedPrompt) stats.selectedPromptCases += 1;
  requireValue(['interior', 'lower', 'exact-lower', 'exact-total'].includes(boundaryKind), 'boundary-kind', { id: planRow.id, boundary: planRow.boundary });
  const weights = (planRow.expectedEligible || []).map((item) => item.weight);
  requireValue(new Set((planRow.expectedEligible || []).map((item) => item.prompt_id)).size === weights.length, 'duplicate-expected-eligible', { id: planRow.id });
  requireValue(weights.every((weight) => Number.isFinite(weight) && weight > 0), 'invalid-expected-weight', { id: planRow.id, weights });
  requireValue(Math.abs(weights.reduce((sum, weight) => sum + weight, 0) - planRow.expectedWeightTotal) < 1e-9, 'expected-weight-total', { id: planRow.id, expected: planRow.expectedWeightTotal, actual: weights.reduce((sum, weight) => sum + weight, 0) });
  if (planRow.expectedPrompt) requireValue((planRow.expectedEligible || []).some((item) => item.prompt_id === planRow.expectedPrompt), 'expected-prompt-outside-eligible', { id: planRow.id, expected: planRow.expectedPrompt });
  if (eligibility) {
    const oracle = oracleByContext.get(contextIdFor(planRow));
    requireValue(!!oracle, 'missing-context-oracle', { id: planRow.id, contextId: contextIdFor(planRow) });
    if (oracle) {
      requireValue(oracle.mim === planRow.mim && oracle.profile === planRow.profile && oracle.diceA === planRow.diceA && oracle.diceB === planRow.diceB && oracle.coin === planRow.coin && equal(oracle.vmRngValues || [], planRow.vmRngValues || []), 'oracle-context-metadata', { id: planRow.id, contextId: contextIdFor(planRow), plan: { mim: planRow.mim, profile: planRow.profile, diceA: planRow.diceA, diceB: planRow.diceB, coin: planRow.coin, vmRngValues: planRow.vmRngValues }, oracle: { mim: oracle.mim, profile: oracle.profile, diceA: oracle.diceA, diceB: oracle.diceB, coin: oracle.coin, vmRngValues: oracle.vmRngValues } });
      const oracleEligible = oracle.eligible || [];
      const expectedEligible = oracleEligible.map(basicPrompt);
      const oracleExpectedOutput = planRow.expectedPrompt ? oracleEligible.find((item) => item.prompt_id === planRow.expectedPrompt) : null;
      requireValue(planRow.expectedOutputMim === (oracle.expectedOutputMim || planRow.mim), 'expected-output-mim-oracle', { id: planRow.id, expected: oracle.expectedOutputMim || planRow.mim, actual: planRow.expectedOutputMim });
      requireValue(equal(planRow.expectedEligible || [], expectedEligible), 'expected-eligible-oracle', { id: planRow.id, expected: expectedEligible, actual: planRow.expectedEligible });
      requireValue(equal(planRow.expectedPromptOutput || null, oracleExpectedOutput ? promptExpectation(oracleExpectedOutput) : null), 'expected-prompt-output-oracle', { id: planRow.id, expected: oracleExpectedOutput ? promptExpectation(oracleExpectedOutput) : null, actual: planRow.expectedPromptOutput });
      const oracleTotal = (oracle.eligible || []).reduce((sum, item) => sum + item.weight, 0);
      requireValue(Math.abs(oracleTotal - planRow.expectedWeightTotal) < 1e-9, 'expected-total-oracle', { id: planRow.id, expected: planRow.expectedWeightTotal, actual: oracleTotal });
      const expectedVmCalls = (oracle.conditionVmCalls || oracle.vmCalls || 0) + (planRow.expectedPrompt ? (oracle.resolutionVmCalls && oracle.resolutionVmCalls[planRow.expectedPrompt] || 0) : 0);
      requireValue(planRow.expectedVmCalls === expectedVmCalls, 'expected-vm-calls-oracle', { id: planRow.id, expected: expectedVmCalls, actual: planRow.expectedVmCalls });
    }
  }
  checkResult(planRow, sourceRow, 'source');
  checkResult(planRow, candidateRow, 'candidate');
  requireValue(equal(sourceRow.result, candidateRow.result), 'source-candidate-observable-difference', { id: planRow.id });
}

function mappingSummary() {
  const sourceMap = source.sourceMappings || {};
  const candidateMap = candidate.candidateMappings || {};
  const sourceStems = sourceMap.stemMapping || {};
  const candidateStems = candidateMap.stemMapping || {};
  const stemKeyDiffs = [...new Set([...Object.keys(sourceStems), ...Object.keys(candidateStems)])].filter((key) => !(key in sourceStems) || !(key in candidateStems));
  const stemMembershipDiffs = [];
  const stemOrderDifferences = [];
  for (const key of Object.keys(sourceStems)) {
    const a = sourceStems[key] || []; const b = candidateStems[key] || [];
    if (stable([...a].sort()) !== stable([...b].sort())) stemMembershipDiffs.push(key);
    if (!equal(a, b)) stemOrderDifferences.push(key);
  }
  const sourceCategories = sourceMap.categoryNames || []; const candidateCategories = candidateMap.categoryNames || [];
  return {
    stemKeyDiffs,
    stemMembershipDiffs,
    categorySetEqual: stable([...sourceCategories].sort()) === stable([...candidateCategories].sort()),
    categoryOrderEqual: equal(sourceCategories, candidateCategories),
    stemOrderDifferences,
  };
}
const mappings = mappingSummary();
requireValue(mappings.stemKeyDiffs.length === 0 && mappings.stemMembershipDiffs.length === 0 && mappings.categorySetEqual, 'mapping-membership', mappings);
const expectedActionPresent = plan.cases.filter((row) => !!row.expectedPrompt || (row.expectedEligible && row.expectedEligible.length > 0)).length;
requireValue(stats.sourceEnvelope.actionPresent === expectedActionPresent && stats.sourceEnvelope.noAction === plan.cases.length - expectedActionPresent, 'source-envelope-counts', { expectedActionPresent, actual: stats.sourceEnvelope, cases: plan.cases.length });

const summary = {
  schemaVersion: 1,
  task: 'S-07',
  lane: 'weighted',
  sourceRevision: plan.sourceRevision,
  result: failureCount ? 'fail' : 'pass',
  planCases: plan.cases.length,
  contextCases: plan.contextCases,
  contextRange: plan.contextRange || null,
  sourceRows: source.rows.length,
  candidateRows: candidate.rows.length,
  failureCount,
  failures,
  sourceErrors: source.rows.filter((row) => row.error).length,
  candidateErrors: candidate.rows.filter((row) => row.error).length,
  rowObservableDifferences: failures.filter((item) => item.code === 'source-candidate-observable-difference').length,
  generatedActionIdPaths: expectedActionIdPaths,
  boundaries: stats.boundaries,
  noEligibleCases: stats.noEligibleCases,
  selectedPromptCases: stats.selectedPromptCases,
  exactTotalCases: stats.exactTotalCases,
  mims: stats.mims,
  rngCalls: { expected: stats.expectedRngCalls, source: stats.sourceRngCalls, candidate: stats.candidateRngCalls },
  vmRngCalls: { expected: stats.expectedVmRngCalls, source: stats.sourceVmRngCalls, candidate: stats.candidateVmRngCalls },
  conditionAudit: plan.conditionAudit,
  promptAudit: plan.promptAudit,
  eligibilityAudit: plan.eligibilityAudit,
  profileSelfTest: plan.inventory && plan.inventory.profileSelfTest,
  mimInventory: EXPECTED_MIM_INVENTORY,
  envelope: stats.sourceEnvelope,
  mappings,
  inputs: [planPath, sourcePath, candidatePath, eligibilityPath].filter(Boolean).map((file) => ({ path: file, bytes: fs.statSync(file).size, sha256: sha256(file) })),
};
fs.writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ outPath, result: summary.result, planCases: summary.planCases, failureCount, noEligibleCases: summary.noEligibleCases, boundaries: summary.boundaries }, null, 2));
if (failureCount) process.exitCode = 1;
