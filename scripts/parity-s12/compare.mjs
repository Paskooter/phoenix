#!/usr/bin/env node

// Fail-closed source/candidate comparator for S-12. Missing or duplicated row
// IDs are coverage failures even when both receipts omit the same data.

import fs from 'node:fs';
import path from 'node:path';

const [sourcePath, candidatePath, receiptPath = path.join(path.dirname(candidatePath || '.'), 'differential-receipt.json'), expectedPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'matrix.json')] = process.argv.slice(2);
if (!sourcePath || !candidatePath) throw new Error('usage: compare.mjs <source.json> <candidate.json> [receipt.json]');

const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const candidate = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
const coverageErrors = [];

function rowsFor(receipt, label) {
  if (!receipt || receipt.schema !== 's12-calendar-receipt-v1') {
    coverageErrors.push(`${label} schema is missing or unsupported`);
    return [];
  }
  if (!Array.isArray(receipt.rows)) {
    coverageErrors.push(`${label}.rows is not an array`);
    return [];
  }
  const seen = new Set();
  for (const [index, row] of receipt.rows.entries()) {
    if (!row || typeof row.id !== 'string' || row.id.length === 0) {
      coverageErrors.push(`${label}.rows[${index}] is missing row ID`);
    } else if (seen.has(row.id)) {
      coverageErrors.push(`${label} duplicate row ID ${row.id}`);
    } else {
      seen.add(row.id);
    }
    for (const key of ['semantic', 'action']) {
      if (!row || !Object.hasOwn(row, key)) {
        coverageErrors.push(`${label}.${row?.id || index} is missing ${key}`);
        continue;
      }
      const value = row[key];
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        coverageErrors.push(`${label}.${row?.id || index}.${key} must be a non-null object`);
      }
    }
    const semantic = row && row.semantic;
    if (semantic && typeof semantic === 'object' && !Array.isArray(semantic)) {
      if (typeof semantic.endDate !== 'string' || semantic.endDate.length === 0) coverageErrors.push(`${label}.${row.id}.semantic.endDate is missing`);
      if (!Array.isArray(semantic.requests)) coverageErrors.push(`${label}.${row.id}.semantic.requests must be an array`);
      if (!Object.hasOwn(semantic, 'parsed')) coverageErrors.push(`${label}.${row.id}.semantic.parsed is missing`);
    }
    const action = row && row.action;
    if (action && typeof action === 'object' && !Array.isArray(action)) {
      for (const key of ['responseType', 'final', 'action', 'analytics', 'transitions']) {
        if (!Object.hasOwn(action, key)) coverageErrors.push(`${label}.${row.id}.action.${key} is missing`);
      }
      if (typeof action.final !== 'boolean') coverageErrors.push(`${label}.${row.id}.action.final must be boolean`);
      if (!Array.isArray(action.transitions)) coverageErrors.push(`${label}.${row.id}.action.transitions must be an array`);
      const graphAction = action.action;
      if (!graphAction || typeof graphAction !== 'object' || Array.isArray(graphAction)) {
        coverageErrors.push(`${label}.${row.id}.action.action must be a non-null object`);
      } else {
        if (!graphAction.config || typeof graphAction.config !== 'object') coverageErrors.push(`${label}.${row.id}.action.action.config is missing`);
        const jcp = graphAction.config && graphAction.config.jcp;
        if (!jcp || typeof jcp !== 'object' || !Array.isArray(jcp.children)) coverageErrors.push(`${label}.${row.id}.action.action.config.jcp.children is missing`);
      }
    }
  }
  return receipt.rows;
}

const sourceRows = rowsFor(source, 'source');
const candidateRows = rowsFor(candidate, 'candidate');
if (sourceRows.length !== candidateRows.length) {
  coverageErrors.push(`source.rows cardinality ${sourceRows.length} != candidate.rows cardinality ${candidateRows.length}`);
}

const sourceIDs = sourceRows.map((row) => row && row.id);
const candidateIDs = candidateRows.map((row) => row && row.id);
if (JSON.stringify(sourceIDs) !== JSON.stringify(candidateIDs)) {
  coverageErrors.push(`row ID/order mismatch: source=${JSON.stringify(sourceIDs)} candidate=${JSON.stringify(candidateIDs)}`);
}
const expectedIDs = Array.isArray(expected.cases) ? expected.cases.map((row) => row && row.id) : [];
if (JSON.stringify(sourceIDs) !== JSON.stringify(expectedIDs)) {
  coverageErrors.push(`source row ID/order does not match expected matrix: source=${JSON.stringify(sourceIDs)} expected=${JSON.stringify(expectedIDs)}`);
}
if (JSON.stringify(candidateIDs) !== JSON.stringify(expectedIDs)) {
  coverageErrors.push(`candidate row ID/order does not match expected matrix: candidate=${JSON.stringify(candidateIDs)} expected=${JSON.stringify(expectedIDs)}`);
}

function withoutRevision(value) {
  if (Array.isArray(value)) return value.map(withoutRevision);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value)) {
    if (key === 'sourceRevision' || key === 'candidateRevision') continue;
    out[key] = withoutRevision(value[key]);
  }
  return out;
}

function equal(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function promptSignature(action) {
  const prompts = [];
  const walk = (value) => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== 'object') return;
    if (value.play && value.play.meta) {
      prompts.push({
        prompt_id: value.play.meta.prompt_id,
        mim_id: value.play.meta.mim_id,
        mim_type: value.play.meta.mim_type,
        esml: value.play.esml,
        display: value.display || null,
      });
    }
    for (const child of Object.values(value)) walk(child);
  };
  walk(action);
  return prompts;
}

const rowResults = [];
let semanticMatches = 0;
let promptMatches = 0;
let actionMatches = 0;
const semanticDifferences = [];
const promptDifferences = [];
const actionDifferences = [];

for (let index = 0; index < Math.max(sourceRows.length, candidateRows.length); index += 1) {
  const left = sourceRows[index];
  const right = candidateRows[index];
  const id = left?.id || right?.id || `row-${index}`;
  if (!left || !right || left.id !== right.id) {
    rowResults.push({ id, semantic: false, prompt: false, action: false, error: 'missing or reordered row' });
    continue;
  }
  const semantic = equal(withoutRevision(left.semantic), withoutRevision(right.semantic));
  const prompt = equal(promptSignature(left.action), promptSignature(right.action));
  const action = equal(left.action, right.action);
  rowResults.push({ id, semantic, prompt, action });
  if (semantic) semanticMatches += 1;
  else semanticDifferences.push({ id, source: left.semantic, candidate: right.semantic });
  if (prompt) promptMatches += 1;
  else promptDifferences.push({ id, source: promptSignature(left.action), candidate: promptSignature(right.action) });
  if (action) actionMatches += 1;
  else actionDifferences.push({ id, source: left.action, candidate: right.action });
}

const result = {
  schema: 's12-calendar-differential-v1',
  result: coverageErrors.length || semanticDifferences.length || promptDifferences.length || actionDifferences.length ? 'fail' : 'pass',
  totalRows: rowResults.length,
  semanticMatches,
  promptMatches,
  actionMatches,
  coverageErrors,
  semanticDifferences,
  promptDifferences,
  actionDifferences,
  rowResults,
};
fs.writeFileSync(receiptPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(`result=${result.result} rows=${result.totalRows} semanticMatches=${result.semanticMatches} promptMatches=${result.promptMatches} actionMatches=${result.actionMatches} coverageErrors=${result.coverageErrors.length}`);
process.exitCode = result.result === 'pass' ? 0 : 1;
