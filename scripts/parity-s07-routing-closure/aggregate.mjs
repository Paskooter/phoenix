#!/usr/bin/env node

// Recompute the complete closure from compact per-batch rows.  The aggregate
// deliberately does not trust a child comparator receipt: falsification edits
// stale receipts and must still be rejected here.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getLibrary } from '../../packages/skills/src/chitchat/library.js';

const dir = path.resolve(process.argv[2]);
const plan = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'));
const normalization = JSON.parse(fs.readFileSync(path.join(dir, 'normalization-differential.json'), 'utf8'));
const expected = JSON.parse(fs.readFileSync(new URL('./expected-inventory.json', import.meta.url), 'utf8'));
const stable = value => JSON.stringify(value);
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const errors = [];
const normalizationExpected = expected.normalization;
if (normalization.schemaVersion !== 1) errors.push(`normalization differential schemaVersion ${normalization.schemaVersion} != 1`);
if (normalization.mode !== 'candidate-normalization-differential') errors.push(`normalization differential mode ${normalization.mode} is not pinned`);
if (normalization.sourceRevision !== normalizationExpected.sourceRevision) errors.push('normalization differential sourceRevision is not pinned');
if (normalization.candidateRevision !== normalizationExpected.candidateRevision) errors.push('normalization differential candidateRevision is not pinned');
if (normalization.candidateRuntime !== normalizationExpected.candidateRuntime) errors.push('normalization differential candidateRuntime is not pinned');
if (normalization.sourceCapture?.sha256 !== normalizationExpected.sourceCaptureSha256) errors.push('normalization differential source capture SHA-256 is not pinned');
if (normalization.sourceCapture?.sourceRevision !== normalizationExpected.sourceRevision) errors.push('normalization differential source capture revision is not pinned');
if (normalization.sourceCapture?.runtime !== normalizationExpected.sourceRuntime) errors.push('normalization differential source capture runtime is not pinned');
const rows = [];
const promptlessRoutingRows = [];
const promptlessSemispecificRows = [];
let observedSourceRows = 0;
let observedCandidateRows = 0;
const mimRouteEntries = [];
function withoutPromptIds(value) {
  if (Array.isArray(value)) return value.map(withoutPromptIds);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'prompt_id').map(([key, child]) => [key, withoutPromptIds(child)]));
}
function routingProjection(row) {
  if (!row) return null;
  const value = row.value || null;
  return {
    id: row.id,
    class: row.class,
    ok: row.ok,
    error: row.error || null,
    wire: row.wire || null,
    value: value ? {
      type: value.type || null,
      final: value.final,
      fireAndForget: value.fireAndForget,
      trace: value.trace || null,
      analytics: value.analytics || {},
      prompts: (value.prompts || []).map(prompt => ({ type: prompt.type, mim_id: prompt.mim_id, mim_type: prompt.mim_type, prompt_sub_category: prompt.prompt_sub_category })),
    } : null,
  };
}
function comparable(row, descriptor) {
  return descriptor.comparison === 'routing' ? routingProjection(row) : withoutPromptIds(row);
}

if (plan.schemaVersion !== expected.schemaVersion) errors.push(`plan schemaVersion ${plan.schemaVersion} != ${expected.schemaVersion}`);
if (plan.task !== expected.task) errors.push(`plan task ${plan.task} != ${expected.task}`);
if (plan.referenceRevision !== expected.referenceRevision) errors.push(`plan referenceRevision ${plan.referenceRevision} != ${expected.referenceRevision}`);
if (plan.candidateRevision !== expected.candidateRevision) errors.push(`plan candidateRevision ${plan.candidateRevision} != ${expected.candidateRevision}`);
if (plan.candidateRuntime !== expected.candidateRuntime) errors.push(`plan candidateRuntime ${plan.candidateRuntime} != ${expected.candidateRuntime}`);
if (plan.sourceRunnerSha256 !== expected.sourceRunnerSha256) errors.push('plan source runner digest differs from pinned expected runner');
if (plan.candidateRunnerSha256 !== expected.candidateRunnerSha256) errors.push('plan candidate runner digest differs from pinned expected runner');
if (plan.batchSize !== expected.batchSize) errors.push(`plan batchSize ${plan.batchSize} != ${expected.batchSize}`);
if (plan.rows !== expected.rows) errors.push(`plan rows ${plan.rows} != ${expected.rows}`);
if (plan.batches?.length !== expected.batches) errors.push(`plan batch count ${plan.batches?.length} != ${expected.batches}`);
if (stable(plan.classCounts) !== stable(expected.classCounts)) errors.push('plan classCounts differ from pinned expected inventory');
if (stable(plan.sourceInventory) !== stable(expected.sourceInventory)) errors.push('plan sourceInventory differs from pinned expected inventory');
if (stable(plan.malformedPrecedenceIds) !== stable(expected.malformedPrecedenceIds)) errors.push('plan malformed precedence inventory differs');
if (stable(plan.collisionIds) !== stable(expected.collisionIds)) errors.push('plan collision inventory differs');
if (plan.boundarySpecSha256 !== expected.boundarySpecSha256) errors.push('plan boundary spec digest differs');
const planBatchInventory = (plan.batches || []).map(({ name, index, start, count, ids }) => ({ name, index, start, count, ids }));
const planIds = (plan.batches || []).flatMap(batch => batch.ids || []);
const rowIdsSha256 = sha(JSON.stringify(planIds));
const batchInventorySha256 = sha(JSON.stringify(planBatchInventory));
if (rowIdsSha256 !== expected.rowIdsSha256) errors.push('plan row ID inventory digest differs');
if (batchInventorySha256 !== expected.batchInventorySha256) errors.push('plan batch inventory digest differs');
const expectedById = new Map(planIds.map(id => [id, null]));
if (new Set(planIds).size !== planIds.length) errors.push('plan row ID inventory contains duplicates');
let expectedStart = 0;
for (const [index, batch] of (plan.batches || []).entries()) {
  if (batch.index !== index) errors.push(`plan batch index ${batch.name}=${batch.index}, expected ${index}`);
  if (batch.start !== expectedStart) errors.push(`plan batch start ${batch.name}=${batch.start}, expected ${expectedStart}`);
  if (batch.count !== (batch.ids || []).length) errors.push(`plan batch count ${batch.name}=${batch.count}, ids=${batch.ids?.length}`);
  expectedStart += batch.count || 0;
}
if (expectedStart !== plan.rows) errors.push(`plan batch ranges total ${expectedStart} != ${plan.rows}`);
for (const batch of plan.batches) {
  const spec = JSON.parse(fs.readFileSync(path.join(dir, batch.name), 'utf8'));
  if (spec.schemaVersion !== 1 || spec.task !== 'S-07') errors.push(`${batch.name}: invalid spec schema/task`);
  if (spec.referenceRevision !== expected.referenceRevision) errors.push(`${batch.name}: referenceRevision ${spec.referenceRevision} != pinned ${expected.referenceRevision}`);
  if (spec.cases?.length !== batch.count) errors.push(`${batch.name}: spec case count ${spec.cases?.length} != plan count ${batch.count}`);
  if (stable((spec.cases || []).map(row => row.id)) !== stable(batch.ids || [])) errors.push(`${batch.name}: spec case IDs differ from plan batch IDs`);
  if (batch.start + batch.count > plan.rows) errors.push(`${batch.name}: range exceeds plan rows`);
  for (const row of spec.cases || []) if (row.expectedMimIds) mimRouteEntries.push({ id: row.id, expectedMimIds: row.expectedMimIds });
  const source = JSON.parse(fs.readFileSync(path.join(dir, `${batch.name}.source.json`), 'utf8'));
  const candidate = JSON.parse(fs.readFileSync(path.join(dir, `${batch.name}.candidate.json`), 'utf8'));
  const sourceRows = source.rows || [];
  const candidateRows = candidate.rows || [];
  observedSourceRows += sourceRows.length;
  observedCandidateRows += candidateRows.length;
  const batchIds = new Set(batch.ids || []);
  const sourceMap = new Map();
  const candidateMap = new Map();
  for (const row of sourceRows) {
    if (sourceMap.has(row?.id)) errors.push(`duplicate source row ${row?.id}`);
    sourceMap.set(row?.id, row);
  }
  for (const row of candidateRows) {
    if (candidateMap.has(row?.id)) errors.push(`duplicate candidate row ${row?.id}`);
    candidateMap.set(row?.id, row);
  }
  for (const row of sourceRows) if (!batchIds.has(row?.id)) errors.push(`${batch.name}: source unexpected row ${row?.id}`);
  for (const row of candidateRows) if (!batchIds.has(row?.id)) errors.push(`${batch.name}: candidate unexpected row ${row?.id}`);
  if (sourceRows.length !== spec.cases.length) errors.push(`${batch.name} source cardinality ${sourceRows.length} != ${spec.cases.length}`);
  if (candidateRows.length !== spec.cases.length) errors.push(`${batch.name} candidate cardinality ${candidateRows.length} != ${spec.cases.length}`);
  if (source.referenceRevision !== expected.referenceRevision) errors.push(`${batch.name}: source receipt referenceRevision ${source.referenceRevision}`);
  if (source.runtime !== 'v8.9.4') errors.push(`${batch.name}: source runtime ${source.runtime} != v8.9.4`);
  if (source.image !== 'node@sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c') errors.push(`${batch.name}: source image is not pinned`);
  if (source.sourceTables?.inventory?.equivalent !== true) errors.push(`${batch.name}: source inventory equivalence is not true`);
  for (const [kind, expectedInventory] of Object.entries(expected.sourceInventory)) {
    if (kind === 'categoryValues' || kind === 'stems' || kind === 'categories' || kind === 'semispecificMims') continue;
    const actualCount = source.sourceTables?.counts?.[kind];
    if (actualCount !== expectedInventory.count) errors.push(`${batch.name}: source ${kind} count ${actualCount} != ${expectedInventory.count}`);
  }
  for (const descriptor of spec.cases) {
    const sourceRow = sourceMap.get(descriptor.id);
    const candidateRow = candidateMap.get(descriptor.id);
    if (!sourceRow) errors.push(`${batch.name} source missing ${descriptor.id}`);
    if (!candidateRow) errors.push(`${batch.name} candidate missing ${descriptor.id}`);
    if (sourceRow && candidateRow) {
      const semanticEqual = stable(comparable(sourceRow, descriptor)) === stable(comparable(candidateRow, descriptor));
      const exactEqual = descriptor.comparison === 'routing'
        ? semanticEqual
        : stable(sourceRow) === stable(candidateRow);
      const expectedDifference = descriptor.expectedDifference || null;
      if (!semanticEqual && !expectedDifference) errors.push(`${descriptor.id}: unexpected semantic difference`);
      if (!exactEqual && !expectedDifference) errors.push(`${descriptor.id}: unexpected exact difference`);
      if (semanticEqual && expectedDifference) errors.push(`${descriptor.id}: expected difference disappeared (${expectedDifference})`);
      rows.push({
        id: descriptor.id,
        class: descriptor.class,
        expectedDifference,
        semanticEqual,
        exactEqual,
        sourcePresent: true,
        candidatePresent: true,
        sourceError: sourceRow.error || null,
        candidateError: candidateRow.error || null,
        sourcePromptIds: promptIds(sourceRow),
        candidatePromptIds: promptIds(candidateRow),
      });
    } else {
      rows.push({ id: descriptor.id, class: descriptor.class, expectedDifference: descriptor.expectedDifference || null, semanticEqual: false, exactEqual: false, sourcePresent: !!sourceRow, candidatePresent: !!candidateRow, sourcePromptIds: promptIds(sourceRow), candidatePromptIds: promptIds(candidateRow) });
    }
  }
}
if (observedSourceRows !== plan.rows) errors.push(`retained source rows ${observedSourceRows} != plan rows ${plan.rows}`);
if (observedCandidateRows !== plan.rows) errors.push(`retained candidate rows ${observedCandidateRows} != plan rows ${plan.rows}`);
const mimRouteInventorySha256 = sha(JSON.stringify(mimRouteEntries.sort((a, b) => a.id.localeCompare(b.id))));
if (plan.mimRouteInventorySha256 !== expected.mimRouteInventorySha256) errors.push('plan MIM route inventory digest differs from pinned expected inventory');
if (mimRouteInventorySha256 !== expected.mimRouteInventorySha256) errors.push('batch MIM route inventory digest differs from pinned expected inventory');

function promptIds(value) {
  if (Array.isArray(value)) return value.flatMap(promptIds);
  if (!value || typeof value !== 'object') return [];
  return (value.prompt_id === undefined ? [] : [value.prompt_id]).concat(Object.entries(value).filter(([key]) => key !== 'prompt_id').flatMap(([, child]) => promptIds(child)));
}
function firstPrompt(row) { return row?.value?.prompts?.[0] || null; }
const seenSource = new Map();
const seenCandidate = new Map();
for (const row of rows) {
  if (row.sourcePresent) seenSource.set(row.id, (seenSource.get(row.id) || 0) + 1);
  if (row.candidatePresent) seenCandidate.set(row.id, (seenCandidate.get(row.id) || 0) + 1);
}
for (const id of planIds) {
  if (seenSource.get(id) !== 1) errors.push(`source inventory count ${id}=${seenSource.get(id) || 0}`);
  if (seenCandidate.get(id) !== 1) errors.push(`candidate inventory count ${id}=${seenCandidate.get(id) || 0}`);
}
for (const [id, count] of seenSource) if (!expectedById.has(id) || count !== 1) errors.push(`source extra/duplicate ${id}=${count}`);
for (const [id, count] of seenCandidate) if (!expectedById.has(id) || count !== 1) errors.push(`candidate extra/duplicate ${id}=${count}`);

// Check route invariants separately from the source/candidate equality.  A
// paired corruption that changes both sides must still be rejected.
for (const batch of plan.batches) {
  const source = JSON.parse(fs.readFileSync(path.join(dir, `${batch.name}.source.json`), 'utf8'));
  const candidate = JSON.parse(fs.readFileSync(path.join(dir, `${batch.name}.candidate.json`), 'utf8'));
  const sourceMap = new Map((source.rows || []).map(row => [row.id, row]));
  const candidateMap = new Map((candidate.rows || []).map(row => [row.id, row]));
  for (const descriptor of JSON.parse(fs.readFileSync(path.join(dir, batch.name), 'utf8')).cases) {
    for (const [side, row] of [['source', sourceMap.get(descriptor.id)], ['candidate', candidateMap.get(descriptor.id)]]) {
      if (!row || descriptor.expectedDifference) continue;
      const prompt = firstPrompt(row);
      const trace = row.value?.trace || [];
      const expectedTransition = descriptor.expectedTransition || (descriptor.id === 'valid-emotion-scripted-reclassified' ? 'EmotionCommand' : null);
      if (expectedTransition && !trace.includes(expectedTransition)) {
        errors.push(`${descriptor.id}: ${side} trace lacks ${expectedTransition}`);
      }
      if (!prompt) {
        if (descriptor.class === 'malformed') continue;
        const analyticsEvents = Object.values(row.value?.analytics || {}).flat();
        const query = analyticsEvents.find(event => event.event === 'Chitchat Query');
        const directNoPrompt = ['direct-scripted-mim', 'direct-emotion-mim', 'memo-type', 'normalization-collision'].includes(descriptor.class)
          || descriptor.id === 'valid-emotion-scripted-reclassified';
        if (expectedTransition && query?.properties?.success === true && trace.includes(expectedTransition) && directNoPrompt) {
          promptlessRoutingRows.push({ id: descriptor.id, side, transition: expectedTransition });
          continue;
        }
        if (descriptor.class === 'semispecific') {
          // Zodiac is the pinned zero-eligible case: its Entry-Core prompts
          // require runtime fields absent from this deterministic launch
          // context.  Preserve the exact successful transition envelope and
          // record this as a no-prompt baseline outcome.  The direct MIM and
          // weighted lanes still exercise its prompt under eligible context.
          const successfulSemiSpecific = trace.join('|') === 'Reactive|SemiSpecificResponse|Success|Done'
            && row.ok === true && row.value?.final === true;
          if (successfulSemiSpecific && query?.properties?.success === true) {
            promptlessSemispecificRows.push({ id: descriptor.id, side, transition: expectedTransition || null });
            continue;
          }
          if (descriptor.id === 'semi:RI_JBO_Is_SS:Zodiac' && successfulSemiSpecific) {
            promptlessSemispecificRows.push({ id: descriptor.id, side, transition: expectedTransition || null, baseline: 'zero-eligible-prompts' });
            continue;
          }
        }
        errors.push(`${descriptor.id}: ${side} has no prompt`);
        continue;
      }
      if (descriptor.class === 'semispecific') {
        const allowed = descriptor.expectedMimIds?.length
          ? descriptor.expectedMimIds
          : (descriptor.semispecific?.allowedCategories || []).map(category => `${descriptor.semispecific.stem}_${category}`);
        if (!allowed.includes(prompt.mim_id)) errors.push(`${descriptor.id}: ${side} selected ${prompt.mim_id}, allowed ${allowed.join(',')}`);
      }
      if (descriptor.expectedMimIds?.length && !descriptor.expectedMimIds.includes(prompt.mim_id)) {
        errors.push(`${descriptor.id}: ${side} selected ${prompt.mim_id}, expected one of ${descriptor.expectedMimIds.join(',')}`);
      }
      if ((descriptor.class === 'semispecific-unreachable-category' || descriptor.class === 'semispecific-unresolvable-category') && prompt.mim_id !== 'CC_Fallback') errors.push(`${descriptor.id}: ${side} selected ${prompt.mim_id}, expected CC_Fallback`);
      if (descriptor.id === 'memo-type:UnknownType' && prompt.mim_id !== 'CC_Fallback') errors.push(`${descriptor.id}: ${side} selected ${prompt.mim_id}, expected CC_Fallback`);
    }
  }
}

// The seven known malformed-precedence rows remain explicit open findings.
const malformedExpectations = {
  'malformed-result-omitted': ['Cannot read property \'nlu\' of undefined', 'Chitchat launched without required memo!'],
  'malformed-result-null': ['Cannot read property \'nlu\' of null', 'Chitchat launched without required memo!'],
  'malformed-result-empty': ['Cannot read property \'intent\' of undefined', 'Chitchat launched without required memo!'],
  'malformed-nlu-omitted': ['Cannot read property \'intent\' of undefined', 'RA_JBO_FlipCoin_AN_05'],
  'malformed-nlu-null': ['Cannot read property \'intent\' of null', 'RA_JBO_FlipCoin_AN_05'],
  'malformed-semi-entities-omitted': ['Cannot convert undefined or null to object', 'CC_GQA_Failure_scripted_AN_12'],
  'malformed-semi-entities-null': ['Cannot convert undefined or null to object', 'CC_GQA_Failure_scripted_AN_12'],
};
for (const [id, [sourceMessage, candidateValue]] of Object.entries(malformedExpectations)) {
  const row = rows.find(item => item.id === id);
  if (!row) { errors.push(`malformed precedence row missing ${id}`); continue; }
  if (row.sourceError?.message !== sourceMessage) errors.push(`${id}: source error changed to ${row.sourceError?.message}`);
  if (candidateValue.endsWith('!')) {
    if (row.candidateError?.message !== candidateValue) errors.push(`${id}: candidate error changed to ${row.candidateError?.message}`);
  } else if (!row.candidatePromptIds.includes(candidateValue)) errors.push(`${id}: candidate prompt ${candidateValue} missing`);
}

// Compare the source inventory against the candidate library.  This catches a
// missing MIM/category even when no selected row happens to exercise it.
const lib = getLibrary();
const sorted = values => [...values].sort();
const candidateInventory = {
  scripted: { count: lib.scripted.size, sortedSha256: sha(JSON.stringify(sorted(lib.scripted))) },
  emotion: { count: lib.emotion.size, sortedSha256: sha(JSON.stringify(sorted(lib.emotion))) },
  fallback: { count: lib.fallback.size, sortedSha256: sha(JSON.stringify(sorted(lib.fallback))) },
  semispecificMims: { count: Object.values(lib.semiSpecificStems).flat().length, sortedSha256: sha(JSON.stringify(sorted(Object.entries(lib.semiSpecificStems).flatMap(([stem, cats]) => cats.map(category => `${stem}_${category}`)))) ) },
  stems: { count: Object.keys(lib.semiSpecificStems).length, sortedSha256: sha(JSON.stringify(Object.fromEntries(Object.entries(lib.semiSpecificStems).sort().map(([stem, cats]) => [stem, sorted(cats)])))) },
  categories: { count: Object.keys(lib.semiSpecificCategories).length, sortedSha256: sha(JSON.stringify(sorted(Object.keys(lib.semiSpecificCategories)))) },
  categoryValues: { sortedSha256: sha(JSON.stringify(Object.fromEntries(Object.keys(lib.semiSpecificCategories).sort().map(category => [category, lib.semiSpecificCategories[category]])))) },
};
for (const key of Object.keys(candidateInventory)) {
  for (const field of Object.keys(candidateInventory[key])) {
    if (candidateInventory[key][field] !== plan.sourceInventory[key][field]) errors.push(`inventory ${key}.${field}: source ${plan.sourceInventory[key][field]} candidate ${candidateInventory[key][field]}`);
  }
}
const sourceMetadata = plan.batches.map(batch => {
  const source = JSON.parse(fs.readFileSync(path.join(dir, `${batch.name}.source.json`), 'utf8'));
  return { referenceRevision: source.referenceRevision, runtime: source.runtime, image: source.image, runnerSha256: source.runnerSha256, sourceTables: source.sourceTables };
});
const candidateMetadata = plan.batches.map(batch => {
  const candidate = JSON.parse(fs.readFileSync(path.join(dir, `${batch.name}.candidate.json`), 'utf8'));
  return { candidateRevision: candidate.candidateRevision, runtime: candidate.runtime, runnerSha256: candidate.runnerSha256 };
});
const sourceRevisionSet = new Set(sourceMetadata.map(item => item.referenceRevision));
const sourceRuntimeSet = new Set(sourceMetadata.map(item => item.runtime));
const sourceImageSet = new Set(sourceMetadata.map(item => item.image));
const candidateRevisionSet = new Set(candidateMetadata.map(item => item.candidateRevision));
const candidateRuntimeSet = new Set(candidateMetadata.map(item => item.runtime));
const sourceRunnerSha256 = sha(fs.readFileSync(new URL('../parity-s07-boundaries/run-source.cjs', import.meta.url)));
const candidateRunnerSha256 = sha(fs.readFileSync(new URL('../parity-s07-boundaries/run-candidate.mjs', import.meta.url)));
if (sourceRunnerSha256 !== expected.sourceRunnerSha256) errors.push('source boundary runner file digest differs from pinned expected runner');
if (candidateRunnerSha256 !== expected.candidateRunnerSha256) errors.push('candidate boundary runner file digest differs from pinned expected runner');
if (sourceRevisionSet.size !== 1 || !sourceRevisionSet.has(expected.referenceRevision)) errors.push('source receipt revisions are inconsistent');
if (sourceRuntimeSet.size !== 1 || !sourceRuntimeSet.has('v8.9.4')) errors.push('source receipt runtimes are inconsistent');
if (sourceImageSet.size !== 1 || !sourceImageSet.has('node@sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c')) errors.push('source receipt images are inconsistent');
if (sourceMetadata.some(item => item.runnerSha256 !== sourceRunnerSha256)) errors.push('source receipt runner digest does not match boundary runner file');
if (candidateMetadata.some(item => item.runnerSha256 !== candidateRunnerSha256)) errors.push('candidate receipt runner digest does not match boundary runner file');
if (candidateRevisionSet.size !== 1 || !candidateRevisionSet.has(expected.candidateRevision)) errors.push('candidate receipt revisions are inconsistent');
if (candidateRuntimeSet.size !== 1 || !candidateRuntimeSet.has(expected.candidateRuntime)) errors.push('candidate receipt runtimes are inconsistent');
const receipt = {
  schemaVersion: 1,
  task: 'S-07 routing closure',
  result: errors.length || normalization.result !== 'pass' ? 'fail' : 'open',
  verification: 'UNKNOWN',
  sourceRevision: plan.referenceRevision,
  candidateRevision: candidateMetadata[0]?.candidateRevision || 'unknown',
  sourceRuntime: sourceMetadata[0]?.runtime || null,
  sourceImage: sourceMetadata[0]?.image || null,
  sourceRunnerSha256,
  candidateRunnerSha256,
  candidateRuntime: candidateMetadata[0]?.runtime || null,
  batchSize: plan.batchSize,
  batches: plan.batches.length,
  plannedRows: plan.rows,
  retainedRows: rows.length,
  sourceRowsObserved: observedSourceRows,
  candidateRowsObserved: observedCandidateRows,
  semanticMatches: rows.filter(row => row.semanticEqual).length,
  exactMatches: rows.filter(row => row.exactEqual).length,
  expectedMalformedDifferences: plan.malformedPrecedenceIds,
  observedMalformedDifferences: rows.filter(row => row.expectedDifference === 'source-malformed-precedence' && !row.semanticEqual).map(row => row.id),
  normalization: {
    result: normalization.result,
    mode: normalization.mode,
    rows: normalization.rows,
    exactRows: normalization.exactRows,
    differences: normalization.differences?.length || 0,
    sourceRevision: normalization.sourceRevision,
    candidateRevision: normalization.candidateRevision,
    candidateRuntime: normalization.candidateRuntime,
    sourceCapture: normalization.sourceCapture,
  },
  classCounts: plan.classCounts,
  inventory: { source: plan.sourceInventory, candidate: candidateInventory },
  rowIdsSha256,
  batchInventorySha256,
  boundarySpecSha256: plan.boundarySpecSha256,
  mimRouteInventorySha256,
  sourceRunnersSha256: sha(JSON.stringify(sourceMetadata.map(item => item.runnerSha256))),
  candidateRunnersSha256: sha(JSON.stringify(candidateMetadata.map(item => item.runnerSha256))),
  promptlessRoutingRows: { count: promptlessRoutingRows.length, idsSha256: sha(JSON.stringify(promptlessRoutingRows)) },
  promptlessSemispecificRows: { count: promptlessSemispecificRows.length, idsSha256: sha(JSON.stringify(promptlessSemispecificRows)) },
  coverageErrors: errors,
};
fs.writeFileSync(path.join(dir, 'routing-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({ result: receipt.result, verification: receipt.verification, plannedRows: receipt.plannedRows, retainedRows: receipt.retainedRows, semanticMatches: receipt.semanticMatches, exactMatches: receipt.exactMatches, malformedDifferences: receipt.observedMalformedDifferences.length, normalization: receipt.normalization, coverageErrors: errors.length }));
if (receipt.result === 'fail') process.exitCode = 1;
