#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const spec = JSON.parse(fs.readFileSync(path.resolve(process.argv[2]), 'utf8'));
const receipt = JSON.parse(fs.readFileSync(path.resolve(process.argv[3]), 'utf8'));
const expected = JSON.parse(fs.readFileSync(new URL('./expected-inventory.json', import.meta.url), 'utf8'));
const stable = value => JSON.stringify(value);
const errors = [];
const normalizationExpected = expected.normalization;
if (spec.schemaVersion !== 1) errors.push(`spec schemaVersion ${spec.schemaVersion} != 1`);
if (spec.sourceRevision !== expected.referenceRevision) errors.push(`spec sourceRevision ${spec.sourceRevision} != ${expected.referenceRevision}`);
if (spec.sourceCapture?.sha256 !== normalizationExpected.sourceCaptureSha256) errors.push('spec source capture SHA-256 is not pinned');
if (spec.sourceCapture?.sourceRevision !== normalizationExpected.sourceRevision) errors.push('spec source capture revision is not pinned');
if (spec.sourceCapture?.runtime !== normalizationExpected.sourceRuntime) errors.push('spec source capture runtime is not pinned');
if (receipt.schemaVersion !== 1) errors.push(`receipt schemaVersion ${receipt.schemaVersion} != 1`);
if (receipt.mode !== 'candidate-normalization') errors.push(`receipt mode ${receipt.mode} != candidate-normalization`);
if (receipt.sourceRevision !== expected.referenceRevision) errors.push(`receipt sourceRevision ${receipt.sourceRevision} != ${expected.referenceRevision}`);
if (receipt.candidateRevision !== normalizationExpected.candidateRevision) errors.push('receipt candidateRevision is not pinned');
if (receipt.candidateRuntime !== normalizationExpected.candidateRuntime) errors.push('receipt candidateRuntime is not pinned');
if (receipt.sourceCapture?.sha256 !== normalizationExpected.sourceCaptureSha256) errors.push('receipt source capture SHA-256 is not pinned');
if (receipt.sourceCapture?.sourceRevision !== normalizationExpected.sourceRevision) errors.push('receipt source capture revision is not pinned');
if (receipt.sourceCapture?.runtime !== normalizationExpected.sourceRuntime) errors.push('receipt source capture runtime is not pinned');
if (!Array.isArray(receipt.rows) || receipt.rows.length !== spec.rows.length) {
  errors.push(`row cardinality ${receipt.rows?.length ?? 'missing'} != ${spec.rows.length}`);
}
const expectedIds = new Set(spec.rows.map(row => row.id));
const seen = new Map();
for (const row of receipt.rows || []) {
  seen.set(row.id, (seen.get(row.id) || 0) + 1);
  if (!expectedIds.has(row.id)) errors.push(`unexpected row ${row.id}`);
}
for (const id of expectedIds) {
  if (!seen.has(id)) errors.push(`missing row ${id}`);
  if (seen.get(id) > 1) errors.push(`duplicate row ${id}`);
}

const diffs = [];
for (const descriptor of spec.rows) {
  const row = (receipt.rows || []).find(candidate => candidate.id === descriptor.id);
  if (!row) continue;
  const expectedSource = {
    intent: descriptor.intent,
    entities: descriptor.sourceEntities,
    rules: ['launch'],
    mim: descriptor.sourceMim,
    memoType: 'ScriptedResponse',
  };
  const sourceEqual = stable(row.source) === stable(expectedSource);
  const candidateExpected = {
    intent: descriptor.intent,
    entities: descriptor.sourceEntities,
    rules: ['launch'],
    mim: descriptor.sourceMim,
    memoType: 'ScriptedResponse',
    skillID: 'chitchat-skill',
  };
  const candidateEqual = stable(row.candidate) === stable(candidateExpected);
  if (!sourceEqual || !candidateEqual) {
    diffs.push({ id: descriptor.id, sourceEqual, candidateEqual, source: row.source, candidate: row.candidate, expectedSource, expectedCandidate: candidateExpected });
  }
}
const result = {
  schemaVersion: 1,
  mode: 'candidate-normalization-differential',
  sourceRevision: spec.sourceRevision,
  candidateRevision: receipt.candidateRevision,
  candidateRuntime: receipt.candidateRuntime,
  sourceCapture: receipt.sourceCapture,
  rows: spec.rows.length,
  exactRows: spec.rows.length - diffs.length,
  coverageErrors: errors,
  differences: diffs,
  result: errors.length || diffs.length ? 'fail' : 'pass',
};
const outPath = path.join(path.dirname(path.resolve(process.argv[3])), 'normalization-differential.json');
fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ result: result.result, rows: result.rows, exactRows: result.exactRows, coverageErrors: errors.length, differences: diffs.length }));
if (result.result !== 'pass') process.exitCode = 1;
