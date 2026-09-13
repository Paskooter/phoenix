#!/usr/bin/env node

// Compare source and Phoenix receipts. Every planned row must occur exactly
// once on each side. The pinned source discovers files with
// FileUtils.findAllFilesWithExt, which appends paths as concurrent stat/open
// operations complete; raw mapping order is therefore recorded and checked,
// while order-only differences are reported as source-discovery allowances.
// Every row's JCP, MIM, prompt, ESML and analytics output remains exact.

import fs from 'node:fs';
import { getLibrary } from '../../packages/skills/src/chitchat/library.js';

const [planPath, sourcePath, candidatePath, outPath] = process.argv.slice(2);
if (!planPath || !sourcePath || !candidatePath || !outPath) throw new Error('usage: compare-library.mjs PLAN SOURCE CANDIDATE OUT');
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const candidate = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
const generatedActionIdPaths = ['config.jcp.config.play.id', 'config.jcp.id'];

function sorted(value) {
  return [...value].sort();
}
function stable(value) { return JSON.stringify(value); }
function mapRows(rows) {
  const out = new Map();
  const duplicates = [];
  for (const row of rows || []) {
    if (out.has(row.id)) duplicates.push(row.id);
    out.set(row.id, row);
  }
  return { out, duplicates };
}
function selectedCategory(row, result) {
  const mim = result && result.mims && result.mims[0];
  if (!mim || !row.mim || !mim.startsWith(`${row.mim}_`)) return null;
  return mim.slice(row.mim.length + 1);
}
function compareSet(label, expected, actual, failures) {
  const e = sorted(expected || []);
  const a = sorted(actual || []);
  if (stable(e) !== stable(a)) failures.push({ kind: 'inventory', label, expected: e, actual: a });
}
function categoryValuesByStem(cases, stem) {
  const values = new Map();
  for (const row of cases) {
    if (!row.family.startsWith('semispecific') || row.mim !== stem) continue;
    for (const [category, value] of Object.entries(row.entities || {})) {
      if (!values.has(category)) values.set(category, new Set());
      values.get(category).add(value);
    }
  }
  return values;
}
function orderCrossings(sourceOrder, candidateOrder) {
  const candidatePosition = new Map(candidateOrder.map((category, index) => [category, index]));
  const crossings = [];
  for (let left = 0; left < sourceOrder.length; left += 1) {
    for (let right = left + 1; right < sourceOrder.length; right += 1) {
      if (candidatePosition.get(sourceOrder[left]) > candidatePosition.get(sourceOrder[right])) {
        crossings.push([sourceOrder[left], sourceOrder[right]]);
      }
    }
  }
  return crossings;
}
function matchingCategories(order, valuesByCategory, value) {
  return order.filter((category) => (valuesByCategory.get(category) || new Set()).has(value));
}

const failures = [];
const allowedDifferences = [];
const overlapDistribution = new Map();
const semispecificOrderAudit = [];
const sourceRows = mapRows(source.rows);
const candidateRows = mapRows(candidate.rows);
const planIds = new Set(plan.cases.map((row) => row.id));
const sourceIds = new Set(source.rows.map((row) => row.id));
const candidateIds = new Set(candidate.rows.map((row) => row.id));
compareSet('plan/source row IDs', [...planIds], [...sourceIds], failures);
compareSet('plan/candidate row IDs', [...planIds], [...candidateIds], failures);
if (sourceRows.duplicates.length) failures.push({ kind: 'duplicate-source-rows', ids: sourceRows.duplicates });
if (candidateRows.duplicates.length) failures.push({ kind: 'duplicate-candidate-rows', ids: candidateRows.duplicates });

const lib = getLibrary();
compareSet('scripted MIM IDs', plan.inventory.sourceMims.ids.scripted, [...lib.scripted], failures);
compareSet('emotion MIM IDs', plan.inventory.sourceMims.ids.emotion, [...lib.emotion], failures);
compareSet('fallback MIM IDs', plan.inventory.sourceMims.ids.fallback, [...lib.fallback], failures);
compareSet('semispecific stems', Object.keys(plan.inventory.semispecific.stemMapping), Object.keys(lib.semiSpecificStems), failures);
for (const [stem, categories] of Object.entries(plan.inventory.semispecific.stemMapping)) {
  compareSet(`stem categories ${stem}`, categories, lib.semiSpecificStems[stem], failures);
}
compareSet('category CSV names', plan.inventory.semispecific.categories, Object.keys(lib.semiSpecificCategories), failures);
for (const [category, count] of Object.entries(plan.inventory.semispecific.valueCounts)) {
  const actual = lib.semiSpecificCategories[category] || [];
  if (actual.length !== count) failures.push({ kind: 'inventory', label: `category value count ${category}`, expected: count, actual: actual.length });
}
if (!source.sourceMappings || !candidate.candidateMappings) {
  failures.push({ kind: 'missing-mapping-receipt', source: !!source.sourceMappings, candidate: !!candidate.candidateMappings });
} else {
  compareSet(
    'source/candidate semispecific stems',
    Object.keys(source.sourceMappings.stemMapping || {}),
    Object.keys(candidate.candidateMappings.stemMapping || {}),
    failures,
  );
  for (const stem of Object.keys(plan.inventory.semispecific.stemMapping)) {
    const sourceOrder = source.sourceMappings.stemMapping[stem] || [];
    const candidateOrder = candidate.candidateMappings.stemMapping[stem] || [];
    const sameSet = stable(sorted(sourceOrder)) === stable(sorted(candidateOrder));
    if (!sameSet) {
      failures.push({ kind: 'semispecific-mapping-set-difference', stem, source: sourceOrder, candidate: candidateOrder });
      continue;
    }
    const valuesByCategory = categoryValuesByStem(plan.cases, stem);
    const values = sorted([...valuesByCategory.values()].flatMap((set) => [...set]));
    const distinctValues = [...new Set(values)];
    const matchedOrderDifferences = [];
    for (const value of distinctValues) {
      const sourceMatched = matchingCategories(sourceOrder, valuesByCategory, value);
      const candidateMatched = matchingCategories(candidateOrder, valuesByCategory, value);
      if (stable(sourceMatched) !== stable(candidateMatched)) {
        matchedOrderDifferences.push({ value, source: sourceMatched, candidate: candidateMatched });
      }
    }
    const crossings = orderCrossings(sourceOrder, candidateOrder);
    const crossingOverlaps = crossings.map(([left, right]) => ({
      categories: [left, right],
      values: sorted([...valuesByCategory.get(left) || []].filter((value) => (valuesByCategory.get(right) || new Set()).has(value))),
    }));
    const observableCrossings = crossingOverlaps.filter((crossing) => crossing.values.length > 0);
    semispecificOrderAudit.push({
      stem,
      source: sourceOrder,
      candidate: candidateOrder,
      crossings: crossingOverlaps,
      observableCrossings,
      matchedOrderDifferences,
    });
    if (matchedOrderDifferences.length || observableCrossings.length) {
      failures.push({
        kind: 'semispecific-matched-order-difference',
        stem,
        matchedOrderDifferences,
        observableCrossings,
      });
    } else if (stable(sourceOrder) !== stable(candidateOrder)) {
      allowedDifferences.push({
        kind: 'source-file-discovery-order',
        mapping: 'stem',
        stem,
        source: sourceOrder,
        candidate: candidateOrder,
        crossings: crossingOverlaps,
        reason: 'all crossed category pairs have empty source-value intersections',
      });
    }
  }
  const sourceCategoryOrder = source.sourceMappings.categoryNames || [];
  const candidateCategoryOrder = candidate.candidateMappings.categoryNames || [];
  const sameCategorySet = stable(sorted(sourceCategoryOrder)) === stable(sorted(candidateCategoryOrder));
  if (!sameCategorySet) {
    failures.push({ kind: 'category-mapping-set-difference', source: sourceCategoryOrder, candidate: candidateCategoryOrder });
  } else if (stable(sourceCategoryOrder) !== stable(candidateCategoryOrder)) {
    allowedDifferences.push({
      kind: 'source-file-discovery-order',
      mapping: 'category-csv',
      source: sourceCategoryOrder,
      candidate: candidateCategoryOrder,
    });
  }
}

for (const planRow of plan.cases) {
  const left = sourceRows.out.get(planRow.id);
  const right = candidateRows.out.get(planRow.id);
  if (!left || !right) continue;
  if (left.error || right.error) {
    if (stable(left.error || null) !== stable(right.error || null)) failures.push({ kind: 'error-difference', id: planRow.id, source: left.error || null, candidate: right.error || null });
    continue;
  }
  const sourceResult = left.result;
  const candidateResult = right.result;
  if (!sourceResult || !candidateResult) {
    if (stable(sourceResult || null) !== stable(candidateResult || null)) failures.push({ kind: 'missing-result', id: planRow.id, source: sourceResult || null, candidate: candidateResult || null });
    continue;
  }
  const expectedActionIdPaths = sourceResult.action ? generatedActionIdPaths : [];
  if (stable(sourceResult.actionIdPaths || []) !== stable(expectedActionIdPaths)
      || stable(candidateResult.actionIdPaths || []) !== stable(expectedActionIdPaths)) {
    failures.push({ kind: 'unexpected-action-id-paths', id: planRow.id, expected: expectedActionIdPaths, source: sourceResult.actionIdPaths || [], candidate: candidateResult.actionIdPaths || [] });
  }
  const sourceCategory = selectedCategory(planRow, sourceResult);
  const candidateCategory = selectedCategory(planRow, candidateResult);
  const categories = planRow.expectedCategories || [];
  if (categories.length > 1) {
    let bucket = overlapDistribution.get(planRow.mim);
    if (!bucket) {
      bucket = { rows: 0, source: {}, candidate: {}, invalid: 0, differences: 0 };
      overlapDistribution.set(planRow.mim, bucket);
    }
    bucket.rows += 1;
    bucket.source[sourceCategory] = (bucket.source[sourceCategory] || 0) + 1;
    bucket.candidate[candidateCategory] = (bucket.candidate[candidateCategory] || 0) + 1;
    const validSourceCategory = categories.includes(sourceCategory);
    const validCandidateCategory = categories.includes(candidateCategory);
    if (!validSourceCategory || !validCandidateCategory) {
      bucket.invalid += 1;
      failures.push({
        kind: 'semispecific-selection-outside-source-set',
        id: planRow.id,
        expectedCategories: categories,
        sourceCategory,
        candidateCategory,
      });
    }
    if (stable(sourceResult) !== stable(candidateResult)) bucket.differences += 1;
  }
  if (stable(sourceResult) !== stable(candidateResult)) {
    const validSourceCategory = categories.includes(sourceCategory);
    const validCandidateCategory = categories.includes(candidateCategory);
    failures.push({ kind: 'observable-difference', id: planRow.id, family: planRow.family, mim: planRow.mim, memoType: planRow.memoType, profile: planRow.profile, expectedCategories: categories, seededSemispecificSet: planRow.family.startsWith('semispecific') && categories.length > 1 ? { sourceCategory, candidateCategory, validSourceCategory, validCandidateCategory } : null, source: sourceResult, candidate: candidateResult });
  }
}

const result = {
  schemaVersion: 1,
  task: 'S-07',
  sourceRevision: plan.sourceRevision,
  planCases: plan.cases.length,
  sourceRows: source.rows.length,
  candidateRows: candidate.rows.length,
  failures,
  allowedDifferences,
  result: failures.length ? 'fail' : 'pass',
  counts: {
    sourceErrors: source.rows.filter((row) => row.error).length,
    candidateErrors: candidate.rows.filter((row) => row.error).length,
    allowedDifferences: allowedDifferences.length,
    mappingOrderDifferences: allowedDifferences.filter((item) => item.kind === 'source-file-discovery-order').length,
    failures: failures.length,
  },
  overlapDistribution: {
    rows: [...overlapDistribution.values()].reduce((sum, bucket) => sum + bucket.rows, 0),
    invalid: [...overlapDistribution.values()].reduce((sum, bucket) => sum + bucket.invalid, 0),
    differences: [...overlapDistribution.values()].reduce((sum, bucket) => sum + bucket.differences, 0),
    byStem: Object.fromEntries(overlapDistribution),
  },
  semispecificOrderAudit,
};
fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ result: result.result, planCases: result.planCases, sourceRows: result.sourceRows, candidateRows: result.candidateRows, allowedDifferences: allowedDifferences.length, failures: failures.length }, null, 2));
process.exitCode = failures.length ? 1 : 0;
