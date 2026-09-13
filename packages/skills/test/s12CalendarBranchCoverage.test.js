// S-12 branch manifest: every source/runtime branch in the bounded matrix must
// have a source, direct Phoenix, and (for report rows) real HTTP receipt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const evidence = path.join(root, 'docs/parity/evidence/2026-09-13/s12-calendar');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'scripts/parity-s12/branch-manifest.json'), 'utf8'));
const matrix = JSON.parse(fs.readFileSync(path.join(root, 'scripts/parity-s12/matrix.json'), 'utf8'));
const parseMatrix = JSON.parse(fs.readFileSync(path.join(root, 'scripts/parity-s12/parse-matrix.json'), 'utf8'));
const source = JSON.parse(fs.readFileSync(path.join(evidence, 'source-runtime.json'), 'utf8'));
const candidate = JSON.parse(fs.readFileSync(path.join(evidence, 'candidate-runtime.json'), 'utf8'));
const real = JSON.parse(fs.readFileSync(path.join(evidence, 'real-service-candidate.json'), 'utf8'));
const parseSource = JSON.parse(fs.readFileSync(path.join(evidence, 'parse-source.json'), 'utf8'));
const parseCandidate = JSON.parse(fs.readFileSync(path.join(evidence, 'parse-candidate.json'), 'utf8'));

function indexRows(receipt, label) {
  assert.equal(Array.isArray(receipt.rows), true, `${label}.rows must be an array`);
  const rows = new Map();
  for (const row of receipt.rows) {
    assert.equal(typeof row?.id, 'string', `${label} row missing id`);
    assert.equal(rows.has(row.id), false, `${label} duplicate ${row.id}`);
    rows.set(row.id, row);
  }
  return rows;
}

function mims(row) {
  const found = [];
  const walk = (value) => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== 'object') return;
    if (value.play?.meta?.mim_id) found.push(value.play.meta.mim_id);
    Object.values(value).forEach(walk);
  };
  walk(row?.action?.action);
  return found;
}

function parsedSummaries(row) {
  return row?.semantic?.parsed?.events?.map((event) => event.summary) || [];
}

function canonicalRequests(actual, expected) {
  const remaining = [...(actual || [])];
  return (expected || []).map((wanted) => {
    const index = remaining.findIndex((request) => request.service === wanted.service && request.calendar === wanted.calendar);
    assert.ok(index >= 0, `missing provider request ${JSON.stringify(wanted)}`);
    return remaining.splice(index, 1)[0];
  });
}

test('S-12 branch manifest is complete and fail-closed across source/direct/HTTP receipts', () => {
  assert.equal(manifest.schema, 's12-calendar-branch-manifest-v1');
  assert.equal(manifest.sourceRevision, 'jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c');
  const sourceRows = indexRows(source, 'source');
  const candidateRows = indexRows(candidate, 'candidate');
  const realRows = indexRows(real, 'real');
  const realServiceRows = indexRows(real.service, 'real service');
  const expectedMatrixIDs = matrix.cases.map((row) => row.id);
  assert.deepEqual([...sourceRows.keys()], expectedMatrixIDs, 'source rows must match matrix order');
  assert.deepEqual([...candidateRows.keys()], expectedMatrixIDs, 'candidate rows must match matrix order');
  assert.deepEqual([...realRows.keys()], expectedMatrixIDs, 'real rows must match matrix order');

  const covered = new Set();
  for (const branch of manifest.branches) {
    assert.equal(typeof branch.id, 'string', 'branch missing id');
    const ids = branch.kind === 'parse' ? branch.parseRowIds : branch.rowIds;
    assert.ok(Array.isArray(ids) && ids.length > 0, `${branch.id}: branch row IDs missing`);
    for (const id of ids) {
      if (branch.kind === 'parse') {
        assert.equal(parseMatrix.cases.some((row) => row.id === id), true, `${branch.id}: unknown parse row ${id}`);
        continue;
      }
      assert.equal(sourceRows.has(id), true, `${branch.id}: source row ${id} missing`);
      assert.equal(candidateRows.has(id), true, `${branch.id}: candidate row ${id} missing`);
      assert.equal(realRows.has(id), true, `${branch.id}: real row ${id} missing`);
      covered.add(id);
      const left = sourceRows.get(id);
      const right = candidateRows.get(id);
      const http = realRows.get(id);
      assert.equal(typeof left.semantic.endDate, 'string', `${id}: source endDate missing`);
      assert.equal(typeof right.semantic.endDate, 'string', `${id}: candidate endDate missing`);
      assert.equal(typeof http.semantic.endDate, 'string', `${id}: real endDate missing`);
      assert.ok(left.action?.action?.config?.jcp?.children?.length >= 1, `${id}: source action graph missing`);
      assert.ok(right.action?.action?.config?.jcp?.children?.length >= 1, `${id}: candidate action graph missing`);

      if (branch.kind === 'action') {
        const rowExpectation = branch.rowExpectations?.[id] || {};
        const expectedMims = rowExpectation.requiredMims || branch.requiredMims || [];
        const forbiddenMims = rowExpectation.forbiddenMims || branch.forbiddenMims || [];
        for (const [label, row] of [['source', left], ['candidate', right], ['real', http]]) {
          const actual = mims(row);
          for (const mim of expectedMims) assert.equal(actual.includes(mim), true, `${branch.id}/${id}: ${label} missing ${mim}; got ${actual.join(',')}`);
          for (const mim of forbiddenMims) assert.equal(actual.includes(mim), false, `${branch.id}/${id}: ${label} unexpectedly included ${mim}`);
          if (rowExpectation.mimSequence) assert.deepEqual(actual, rowExpectation.mimSequence, `${branch.id}/${id}: ${label} MIM sequence`);
          for (const [mim, count] of Object.entries(rowExpectation.mimCounts || {})) {
            assert.equal(actual.filter((value) => value === mim).length, count, `${branch.id}/${id}: ${label} ${mim} count`);
          }
          const actionText = JSON.stringify(row.action.action);
          for (const text of rowExpectation.requiredActionText || []) assert.equal(actionText.includes(text), true, `${branch.id}/${id}: ${label} action lacks ${text}`);
          for (const text of rowExpectation.forbiddenActionText || []) assert.equal(actionText.includes(text), false, `${branch.id}/${id}: ${label} action contains ${text}`);
        }
      }
      if (Object.hasOwn(branch, 'expectedParsed')) {
        for (const [label, row] of [['source', left], ['candidate', right], ['real', http]]) {
          assert.deepEqual(row.semantic.parsed, branch.expectedParsed, `${branch.id}/${id}: ${label} parsed mismatch`);
        }
      }
      if (branch.requiredSummaries || branch.forbiddenSummaries) {
        for (const [label, row] of [['source', left], ['candidate', right], ['real', http]]) {
          const summaries = parsedSummaries(row);
          for (const summary of branch.requiredSummaries || []) assert.equal(summaries.includes(summary), true, `${branch.id}/${id}: ${label} missing summary ${summary}`);
          for (const summary of branch.forbiddenSummaries || []) assert.equal(summaries.includes(summary), false, `${branch.id}/${id}: ${label} unexpectedly has summary ${summary}`);
        }
      }
      if (branch.expectedRequests) {
        const requestShape = (requests) => (requests || []).map((request) => ({ service: request.service, calendar: request.calendar }));
        assert.deepEqual(requestShape(left.semantic.requests), branch.expectedRequests, `${branch.id}/${id}: source requests`);
        assert.deepEqual(requestShape(right.semantic.requests), branch.expectedRequests, `${branch.id}/${id}: candidate requests`);
        const serviceRow = realServiceRows.get(id);
        assert.deepEqual(canonicalRequests(serviceRow?.providerCalls, branch.expectedRequests).map((request) => ({ service: request.service, calendar: request.calendar })), branch.expectedRequests, `${branch.id}/${id}: real provider calls`);
        assert.equal(serviceRow?.providerCalls?.length, branch.expectedRequests.length, `${branch.id}/${id}: real provider call count`);
      }
      if (branch.expectedProbeStatuses) {
        const serviceRow = realServiceRows.get(id);
        const expectedRequests = branch.expectedRequests || [];
        const orderedStatuses = expectedRequests.map((wanted) => {
          const index = serviceRow?.providerCalls?.findIndex((request) => request.service === wanted.service && request.calendar === wanted.calendar);
          assert.ok(index >= 0, `${branch.id}/${id}: missing probe request ${JSON.stringify(wanted)}`);
          return serviceRow.probes[index]?.status;
        });
        assert.deepEqual(orderedStatuses, branch.expectedProbeStatuses, `${branch.id}/${id}: real probe statuses`);
      }
    }
  }
  assert.deepEqual([...covered].sort(), [...new Set(expectedMatrixIDs)].sort(), 'manifest must cover every main matrix row');
});

test('S-12 parse branch manifest is complete across source/direct parse receipts', () => {
  const sourceRows = indexRows(parseSource, 'parse source');
  const candidateRows = indexRows(parseCandidate, 'parse candidate');
  const expectedIDs = parseMatrix.cases.map((row) => row.id);
  assert.deepEqual([...sourceRows.keys()], expectedIDs);
  assert.deepEqual([...candidateRows.keys()], expectedIDs);
  const covered = new Set();
  for (const branch of manifest.branches.filter((entry) => entry.kind === 'parse')) {
    for (const id of branch.parseRowIds) {
      covered.add(id);
      const left = sourceRows.get(id);
      const right = candidateRows.get(id);
      assert.ok(left && right, `${branch.id}/${id}: parse row missing`);
      if (Object.hasOwn(branch, 'expectedParsed')) {
        assert.deepEqual(left.parsed, branch.expectedParsed, `${branch.id}/${id}: source parsed`);
        assert.deepEqual(right.parsed, branch.expectedParsed, `${branch.id}/${id}: candidate parsed`);
      }
      if (branch.expectedEventCount !== undefined) {
        assert.equal(left.parsed?.events?.length, branch.expectedEventCount, `${branch.id}/${id}: source event count`);
        assert.equal(right.parsed?.events?.length, branch.expectedEventCount, `${branch.id}/${id}: candidate event count`);
      }
      for (const summary of branch.requiredSummaries || []) {
        assert.equal(left.parsed?.events?.some((event) => event.summary === summary), true, `${branch.id}/${id}: source summary`);
        assert.equal(right.parsed?.events?.some((event) => event.summary === summary), true, `${branch.id}/${id}: candidate summary`);
      }
    }
  }
  assert.deepEqual([...covered].sort(), [...new Set(expectedIDs)].sort(), 'parse manifest must cover every parse row');
});
