#!/usr/bin/env node

// Deterministic, fail-closed aggregation for the bounded weighted S-07 lane.
// The per-batch comparator proves each row.  This script proves that all
// batches form one contiguous context inventory, that every receipt has the
// pinned provenance/runtime/control flags, and that the committed compact
// summary and raw-receipt manifest can be regenerated from /tmp inputs.

import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
function arg(name, fallback = null) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}
function required(name) {
  const value = arg(name);
  if (!value) throw new Error(`missing ${name}`);
  return value;
}
function readJson(file) {
  if (!fs.existsSync(file)) throw new Error(`missing receipt: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function equal(a, b) { return stable(a) === stable(b); }
function fail(message, detail) {
  const suffix = detail === undefined ? '' : `: ${JSON.stringify(detail)}`;
  throw new Error(`${message}${suffix}`);
}
function check(condition, message, detail) { if (!condition) fail(message, detail); }
function increment(map, key, amount = 1) { map[key] = (map[key] || 0) + amount; }
function unique(values) { return [...new Set(values)]; }
function sorted(values) { return [...values].sort(); }
function sumObject(target, input) {
  for (const [key, value] of Object.entries(input || {})) increment(target, key, value);
}
function expand(template, offset) {
  const five = String(offset).padStart(5, '0');
  const source = offset === 0 ? '000' : five;
  return template.replaceAll('{offset}', five).replaceAll('{sourceOffset}', source);
}
function fileRecord(label, file) {
  return { label, path: file, bytes: fs.statSync(file).size, sha256: sha256(file) };
}
function contextIds(cases) { return unique(cases.map((row) => row.contextId || row.id)); }
function assertSameSet(actual, expected, message) {
  const a = sorted(unique(actual));
  const e = sorted(unique(expected));
  check(equal(a, e), message, {
    expectedCount: e.length,
    actualCount: a.length,
    missing: e.filter((id) => !a.includes(id)).slice(0, 10),
    extra: a.filter((id) => !e.includes(id)).slice(0, 10),
  });
}

const contextsPath = required('--contexts');
const eligibilityPath = required('--eligibility');
const planTemplate = required('--plan-template');
const sourceTemplate = required('--source-template');
const candidateTemplate = required('--candidate-template');
const diffTemplate = required('--diff-template');
const outSummary = required('--out-summary');
const outManifest = required('--out-manifest');
const falsificationPath = arg('--falsification');
const aggregateFalsificationPath = arg('--aggregate-falsification');
const sourceRoot = arg('--source-root', '/home/shell/work/phoenix/.parity/reference/5c0a7390539663ba749d360de348a428c088505c');
const batchCount = Number(arg('--batch-count', '24'));
const batchSize = Number(arg('--batch-size', '1000'));

const EXPECTED_SOURCE_REVISION = '5c0a7390539663ba749d360de348a428c088505c';
const EXPECTED_CANDIDATE_REVISION = 'dd2199d0b7f5bff6a5bf799b7e2a115e8e0385ec';
const EXPECTED_SOURCE_RUNTIME = 'v8.9.4';
const EXPECTED_CANDIDATE_RUNTIME = 'v22.22.0';
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
const comparator = path.join(path.dirname(new URL(import.meta.url).pathname), 'compare-weighted.mjs');
check(Number.isInteger(batchCount) && batchCount > 0, 'invalid batch count', batchCount);
check(Number.isInteger(batchSize) && batchSize > 0, 'invalid batch size', batchSize);

const contexts = readJson(contextsPath);
const eligibility = readJson(eligibilityPath);
check(contexts.schemaVersion === 1 && contexts.task === 'S-07' && contexts.stage === 'contexts', 'contexts-schema');
check(contexts.sourceRevision === EXPECTED_SOURCE_REVISION, 'contexts-source-revision', contexts.sourceRevision);
check(contexts.candidateRevision === EXPECTED_CANDIDATE_REVISION, 'contexts-candidate-revision', contexts.candidateRevision);
check(contexts.inventory && contexts.inventory.promptSourceTreeSha256 === EXPECTED_MIM_INVENTORY.treeSha256, 'contexts-mim-tree-digest', contexts.inventory && contexts.inventory.promptSourceTreeSha256);
check(Array.isArray(contexts.cases), 'contexts-cases');
check(eligibility.schemaVersion === 1, 'eligibility-schema', eligibility.schemaVersion);
check(eligibility.sourceRevision === EXPECTED_SOURCE_REVISION, 'eligibility-source-revision', eligibility.sourceRevision);
check(eligibility.sourceRuntime === EXPECTED_SOURCE_RUNTIME, 'eligibility-source-runtime', eligibility.sourceRuntime);
check(eligibility.cases === eligibility.rows.length && eligibility.cases === contexts.cases.length, 'eligibility-context-count', { eligibility: eligibility.cases, rows: eligibility.rows.length, contexts: contexts.cases.length });

const contextById = new Map();
for (const row of contexts.cases) {
  check(!contextById.has(row.id), 'duplicate-context-id', row.id);
  contextById.set(row.id, row);
}
const eligibilityIds = eligibility.rows.map((row) => row.id);
check(equal(eligibilityIds, contexts.cases.map((row) => row.id)), 'context-eligibility-order');

function mimsByFamily() {
  const roots = {
    scripted: `${sourceRoot}/packages/chitchat-skill/mims/scripted-responses`,
    emotion: `${sourceRoot}/packages/chitchat-skill/mims/emotion-responses`,
    fallback: `${sourceRoot}/packages/chitchat-skill/mims/core-responses`,
  };
  const sets = {};
  for (const [family, dir] of Object.entries(roots)) {
    check(fs.existsSync(dir), 'source-mim-directory', dir);
    sets[family] = new Set(fs.readdirSync(dir).filter((name) => name.endsWith('.mim')).map((name) => name.slice(0, -4)));
  }
  return sets;
}
const familySets = mimsByFamily();
function familyFor(mim) {
  if (familySets.fallback.has(mim)) return 'fallback';
  if (familySets.scripted.has(mim)) return 'scripted';
  if (familySets.emotion.has(mim)) return 'emotion';
  fail('unknown-context-mim', mim);
}
const contextCounts = { fallback: 0, scripted: 0, emotion: 0 };
for (const row of contexts.cases) increment(contextCounts, familyFor(row.mim));

let canonicalPlan = null;
let canonicalDiff = null;
const planFiles = [];
const sourceFiles = [];
const candidateFiles = [];
const diffFiles = [];
const batchRanges = [];
const boundaries = {};
const expectedRngCalls = {};
const expectedVmRngCalls = {};
const rowCounts = { fallback: 0, scripted: 0, emotion: 0 };
const runtimes = { source: [], candidate: [] };
const vmControl = { source: [], candidate: [] };
const candidateRevisions = [];
const batchFiles = [];
let branchCases = 0;
let sourceRows = 0;
let candidateRows = 0;
let failures = 0;
let sourceErrors = 0;
let candidateErrors = 0;
let rowObservableDifferences = 0;
let noEligibleCases = 0;
let selectedPromptCases = 0;
let exactTotalCases = 0;
const envelope = { actionPresent: 0, noAction: 0, emotionEvents: 0, querySuccess: 0, queryFailure: 0, queryTypes: {} };
const semanticTemp = fs.mkdtempSync(path.join(os.tmpdir(), 's07-weighted-aggregate-compare-'));

for (let batch = 0; batch < batchCount; batch += 1) {
  const start = batch * batchSize;
  const count = Math.min(batchSize, contexts.cases.length - start);
  check(start < contexts.cases.length, 'batch-start-out-of-range', { batch, start, total: contexts.cases.length });
  check(count > 0, 'empty-batch', { batch, start });
  const planPath = expand(planTemplate, start);
  const sourcePath = expand(sourceTemplate, start);
  const candidatePath = expand(candidateTemplate, start);
  const diffPath = expand(diffTemplate, start);
  const plan = readJson(planPath);
  const source = readJson(sourcePath);
  const candidate = readJson(candidatePath);
  const diff = readJson(diffPath);
  const range = { start, count, total: contexts.cases.length };

  check(plan.schemaVersion === 1 && plan.task === 'S-07' && plan.stage === 'branches', 'plan-schema', planPath);
  check(equal(plan.contextRange, range), 'plan-context-range', { path: planPath, expected: range, actual: plan.contextRange });
  check(plan.contextCases === contexts.cases.length && plan.sourceEligibilityRows === eligibility.rows.length, 'plan-context-count', planPath);
  check(plan.sourceRevision === EXPECTED_SOURCE_REVISION, 'plan-source-revision', planPath);
  check(plan.candidateRevision === EXPECTED_CANDIDATE_REVISION && /^[0-9a-f]{40}$/.test(plan.candidateRevision), 'plan-candidate-revision', { path: planPath, actual: plan.candidateRevision });
  check(equal(plan.inventory, contexts.inventory), 'plan-context-inventory-metadata', { path: planPath });
  check(Array.isArray(plan.cases), 'plan-cases', planPath);
  const expectedContextIds = eligibilityIds.slice(start, start + count);
  assertSameSet(contextIds(plan.cases), expectedContextIds, 'plan-context-inventory');
  check(plan.cases.every((row) => expectedContextIds.includes(row.contextId)), 'plan-context-extra', planPath);

  check(source.schemaVersion === 1 && source.task === 'S-07', 'source-schema', sourcePath);
  check(source.runtime === EXPECTED_SOURCE_RUNTIME, 'source-runtime', { path: sourcePath, actual: source.runtime });
  check(source.sourceRevision === EXPECTED_SOURCE_REVISION, 'source-revision', sourcePath);
  check(source.vmRandomControlled === true, 'source-vm-random-control', sourcePath);
  check(equal(source.mimInventory, EXPECTED_MIM_INVENTORY), 'source-mim-inventory', sourcePath);
  check(source.planCases === plan.cases.length && source.rows.length === plan.cases.length, 'source-case-count', sourcePath);

  check(candidate.schemaVersion === 1 && candidate.task === 'S-07', 'candidate-schema', candidatePath);
  check(candidate.runtime === EXPECTED_CANDIDATE_RUNTIME, 'candidate-runtime', { path: candidatePath, actual: candidate.runtime });
  check(candidate.candidateRevision === EXPECTED_CANDIDATE_REVISION && /^[0-9a-f]{40}$/.test(candidate.candidateRevision), 'candidate-revision', { path: candidatePath, actual: candidate.candidateRevision });
  check(candidate.vmRandomControlled === true, 'candidate-vm-random-control', candidatePath);
  check(equal(candidate.mimInventory, EXPECTED_MIM_INVENTORY), 'candidate-mim-inventory', candidatePath);
  check(candidate.planCases === plan.cases.length && candidate.rows.length === plan.cases.length, 'candidate-case-count', candidatePath);

  check(diff.schemaVersion === 1 && diff.task === 'S-07' && diff.lane === 'weighted', 'diff-schema', diffPath);
  check(diff.result === 'pass' && diff.failureCount === 0 && diff.failures.length === 0, 'diff-result', { path: diffPath, result: diff.result, failures: diff.failures });
  check(diff.sourceRevision === EXPECTED_SOURCE_REVISION, 'diff-source-revision', diffPath);
  check(equal(diff.contextRange, range), 'diff-context-range', { path: diffPath, expected: range, actual: diff.contextRange });
  check(diff.contextCases === contexts.cases.length, 'diff-context-count', diffPath);
  check(diff.planCases === plan.cases.length && diff.sourceRows === source.rows.length && diff.candidateRows === candidate.rows.length, 'diff-case-count', diffPath);
  const expectedInputs = [planPath, sourcePath, candidatePath, eligibilityPath];
  check(Array.isArray(diff.inputs) && diff.inputs.length === expectedInputs.length, 'diff-input-count', { path: diffPath, actual: diff.inputs });
  for (let inputIndex = 0; inputIndex < expectedInputs.length; inputIndex += 1) {
    const recorded = diff.inputs[inputIndex];
    const actualPath = expectedInputs[inputIndex];
    check(recorded && recorded.path === actualPath, 'diff-input-path', { path: diffPath, index: inputIndex, expected: actualPath, actual: recorded && recorded.path });
    check(recorded.bytes === fs.statSync(actualPath).size, 'diff-input-bytes', { path: diffPath, input: actualPath, expected: fs.statSync(actualPath).size, actual: recorded && recorded.bytes });
    check(recorded.sha256 === sha256(actualPath), 'diff-input-sha256', { path: diffPath, input: actualPath, expected: sha256(actualPath), actual: recorded && recorded.sha256 });
  }
  check(diff.sourceErrors === 0 && diff.candidateErrors === 0 && diff.rowObservableDifferences === 0, 'diff-error-counts', diffPath);
  check(diff.mappings && diff.mappings.stemKeyDiffs.length === 0 && diff.mappings.stemMembershipDiffs.length === 0 && diff.mappings.categorySetEqual === true, 'diff-mapping-membership', diffPath);

  // Recompute the semantic comparison from every raw batch.  Input hashes
  // protect against stale receipts, while this rerun also rejects a forged
  // passing differential whose response envelope was changed in both sides.
  const semanticPath = path.join(semanticTemp, `diff-${String(start).padStart(5, '0')}.json`);
  const semanticRun = spawnSync(process.execPath, [comparator, planPath, sourcePath, candidatePath, semanticPath, eligibilityPath], { encoding: 'utf8' });
  check(semanticRun.status === 0, 'aggregate-comparator-status', { path: diffPath, status: semanticRun.status, stdout: semanticRun.stdout && semanticRun.stdout.slice(-1000), stderr: semanticRun.stderr && semanticRun.stderr.slice(-1000) });
  const semanticDiff = readJson(semanticPath);
  check(semanticDiff.result === 'pass' && semanticDiff.failureCount === 0 && semanticDiff.failures.length === 0, 'aggregate-comparator-result', { path: diffPath, result: semanticDiff.result, failures: semanticDiff.failures });
  check(equal(semanticDiff, diff), 'aggregate-comparator-drift', { path: diffPath });

  const auditFields = ['conditionAudit', 'promptAudit', 'eligibilityAudit', 'profileSelfTest'];
  if (!canonicalPlan) canonicalPlan = plan;
  for (const field of auditFields) check(equal(plan[field] || (plan.inventory && plan.inventory.profileSelfTest), canonicalPlan[field] || (canonicalPlan.inventory && canonicalPlan.inventory.profileSelfTest)), `plan-${field}-drift`, planPath);
  if (!canonicalDiff) canonicalDiff = diff;
  for (const field of ['conditionAudit', 'promptAudit', 'eligibilityAudit', 'profileSelfTest']) check(equal(diff[field], canonicalDiff[field]), `diff-${field}-drift`, diffPath);

  branchCases += plan.cases.length;
  sourceRows += source.rows.length;
  candidateRows += candidate.rows.length;
  failures += diff.failureCount;
  sourceErrors += diff.sourceErrors;
  candidateErrors += diff.candidateErrors;
  rowObservableDifferences += diff.rowObservableDifferences;
  noEligibleCases += diff.noEligibleCases;
  selectedPromptCases += diff.selectedPromptCases;
  exactTotalCases += diff.exactTotalCases;
  for (const field of ['actionPresent', 'noAction', 'emotionEvents', 'querySuccess', 'queryFailure']) envelope[field] += diff.envelope && Number(diff.envelope[field]) || 0;
  sumObject(envelope.queryTypes, diff.envelope && diff.envelope.queryTypes);
  sumObject(boundaries, diff.boundaries);
  sumObject(expectedRngCalls, diff.rngCalls.expected);
  sumObject(expectedVmRngCalls, diff.vmRngCalls.expected);
  for (const [mim, countForMim] of Object.entries(diff.mims || {})) increment(rowCounts, familyFor(mim), countForMim);
  runtimes.source.push(source.runtime);
  runtimes.candidate.push(candidate.runtime);
  vmControl.source.push(source.vmRandomControlled);
  vmControl.candidate.push(candidate.vmRandomControlled);
  candidateRevisions.push(candidate.candidateRevision);
  batchRanges.push(range);
  planFiles.push(fileRecord(`plan-${String(start).padStart(5, '0')}`, planPath));
  sourceFiles.push(fileRecord(`source-${String(start).padStart(5, '0')}`, sourcePath));
  candidateFiles.push(fileRecord(`candidate-${String(start).padStart(5, '0')}`, candidatePath));
  diffFiles.push(fileRecord(`differential-${String(start).padStart(5, '0')}`, diffPath));
  batchFiles.push(
    fileRecord(`plan-${String(start).padStart(5, '0')}`, planPath),
    fileRecord(`source-${String(start).padStart(5, '0')}`, sourcePath),
    fileRecord(`candidate-${String(start).padStart(5, '0')}`, candidatePath),
    fileRecord(`differential-${String(start).padStart(5, '0')}`, diffPath),
  );
}

const inventory = canonicalPlan.inventory;
check(inventory && inventory.scripted === familySets.scripted.size && inventory.emotion === familySets.emotion.size && inventory.fallback === familySets.fallback.size, 'mim-inventory', inventory);
check(inventory.total === familySets.scripted.size + familySets.emotion.size + familySets.fallback.size, 'mim-total', inventory);
check(inventory.promptSourceTreeSha256 === EXPECTED_MIM_INVENTORY.treeSha256, 'plan-mim-tree-digest', inventory.promptSourceTreeSha256);
check(branchCases === 132967 && sourceRows === branchCases && candidateRows === branchCases, 'aggregate-row-counts', { branchCases, sourceRows, candidateRows });
check(contextCounts.fallback === 1 && contextCounts.scripted === 22646 && contextCounts.emotion === 740, 'aggregate-context-counts', contextCounts);
check(rowCounts.fallback === 23 && rowCounts.scripted === 128428 && rowCounts.emotion === 4516, 'aggregate-row-family-counts', rowCounts);
check(equal(unique(runtimes.source), [EXPECTED_SOURCE_RUNTIME]), 'aggregate-source-runtime', runtimes.source);
check(equal(unique(runtimes.candidate), [EXPECTED_CANDIDATE_RUNTIME]), 'aggregate-candidate-runtime', runtimes.candidate);
check(vmControl.source.length === batchCount && vmControl.source.every((value) => value === true), 'aggregate-source-vm-control', vmControl.source);
check(vmControl.candidate.length === batchCount && vmControl.candidate.every((value) => value === true), 'aggregate-candidate-vm-control', vmControl.candidate);
check(equal(unique(candidateRevisions), [EXPECTED_CANDIDATE_REVISION]), 'aggregate-candidate-revision', candidateRevisions);
check(failures === 0 && sourceErrors === 0 && candidateErrors === 0 && rowObservableDifferences === 0, 'aggregate-failures', { failures, sourceErrors, candidateErrors, rowObservableDifferences });
check(equal(envelope, {
  actionPresent: 132855,
  noAction: 112,
  emotionEvents: 4516,
  querySuccess: 132944,
  queryFailure: 23,
  queryTypes: { scripted_response: 124289, known_unknown: 1478, loop_member_question: 2684, emotion_query: 4516 },
}), 'aggregate-envelope', envelope);
check(canonicalDiff && canonicalDiff.profileSelfTest && canonicalDiff.profileSelfTest.result === 'pass', 'aggregate-profile-self-test');
if (falsificationPath) {
  const falsification = readJson(falsificationPath);
  check(falsification.result === 'pass' && falsification.checks.every((item) => item.passed === true), 'falsification-result', falsification);
}
if (aggregateFalsificationPath) {
  const falsification = readJson(aggregateFalsificationPath);
  check(falsification.result === 'pass' && falsification.passed === true && falsification.rawUnchanged === true, 'aggregate-falsification-result', falsification);
}

const summary = {
  schemaVersion: 1,
  task: 'S-07',
  lane: 'weighted',
  result: 'pass',
  sourceRevision: EXPECTED_SOURCE_REVISION,
  candidateRevision: EXPECTED_CANDIDATE_REVISION,
  promptSourceTreeSha256: contexts.inventory.promptSourceTreeSha256,
  batchCount,
  contextCases: contexts.cases.length,
  branchCases,
  sourceRows,
  candidateRows,
  failures,
  sourceErrors,
  candidateErrors,
  rowObservableDifferences,
  noEligibleCases,
  boundaries,
  rngCalls: { expected: expectedRngCalls },
  vmRngCalls: { expected: expectedVmRngCalls },
  vmRandomControlled: {
    sourceAllTrue: vmControl.source.every((value) => value === true),
    candidateAllTrue: vmControl.candidate.every((value) => value === true),
    sourceValues: unique(vmControl.source),
    candidateValues: unique(vmControl.candidate),
    batches: batchCount,
  },
  runtime: { source: unique(runtimes.source), candidate: unique(runtimes.candidate) },
  candidateRevisions: unique(candidateRevisions),
  contextCounts,
  rowCounts,
  envelope,
  mimCounts: { fallback: inventory.fallback, scripted: inventory.scripted, emotion: inventory.emotion },
  mimInventory: EXPECTED_MIM_INVENTORY,
  conditionAudit: canonicalPlan.conditionAudit,
  promptAudit: canonicalPlan.promptAudit,
  eligibilityAudit: (() => {
    const audit = JSON.parse(JSON.stringify(canonicalPlan.eligibilityAudit));
    // The raw oracle records the source VM stack for each malformed date.  A
    // compact receipt groups those diagnostics by source condition while the
    // per-row eligibility/error checks above still fail closed.
    const compact = {};
    for (const [key, count] of Object.entries(audit.runtimeErrorGroups || {})) {
      const condition = key.split('|TypeError:')[0];
      compact[condition] = (compact[condition] || 0) + count;
    }
    audit.runtimeErrorGroups = compact;
    return audit;
  })(),
  profileSelfTest: inventory.profileSelfTest,
  boundarySemantics: {
    interior: 'one source-selected interior point per eligible prompt',
    lower: 'one source-selected cumulative lower boundary per eligible prompt; this single row is the strict exact-lower check (no redundant duplicate row)',
    exactTotal: 'one unit=1 control per context; eligible contexts produce no prompt/source ESML undefined, no-eligible contexts produce action null',
  },
  batchRanges,
};
fs.writeFileSync(outSummary, `${JSON.stringify(summary, null, 2)}\n`);

const manifestFiles = [
  fileRecord('contexts', contextsPath),
  fileRecord('eligibility', eligibilityPath),
  ...batchFiles,
  fileRecord('differential-summary', outSummary),
];
if (falsificationPath) manifestFiles.push(fileRecord('falsification-summary', falsificationPath));
if (aggregateFalsificationPath) manifestFiles.push(fileRecord('aggregate-falsification-summary', aggregateFalsificationPath));
const manifest = {
  schemaVersion: 1,
  task: 'S-07',
  lane: 'weighted',
  sourceRevision: EXPECTED_SOURCE_REVISION,
  candidateRevision: EXPECTED_CANDIDATE_REVISION,
  note: 'Raw receipts remain outside Git under /tmp. This manifest records exact byte sizes and SHA-256 hashes for the bounded source/candidate inputs and compact receipts committed beside the review.',
  files: manifestFiles,
};
fs.writeFileSync(outManifest, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ result: 'pass', batchCount, contextCases: contexts.cases.length, branchCases, sourceRows, candidateRows, outSummary, outManifest }, null, 2));
