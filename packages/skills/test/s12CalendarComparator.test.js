// S-12 source/candidate receipt controls. Missing IDs, duplicates, and
// prompt/action-only drift must fail the review instead of comparing absences.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const evidence = path.join(root, 'docs/parity/evidence/2026-09-13/s12-calendar');
const comparator = path.join(root, 'scripts/parity-s12/compare.mjs');

function copyReceipts(temp) {
  const source = path.join(temp, 'source.json');
  const candidate = path.join(temp, 'candidate.json');
  fs.copyFileSync(path.join(evidence, 'source-runtime.json'), source);
  fs.copyFileSync(path.join(evidence, 'candidate-runtime.json'), candidate);
  return { source, candidate, receipt: path.join(temp, 'differential.json') };
}

test('S-12 real HTTP candidate receipt covers all report rows and matches source', () => {
  const realCandidate = path.join(evidence, 'real-service-candidate.json');
  const realDifferential = path.join(evidence, 'real-service-differential.json');
  const source = path.join(evidence, 'source-runtime.json');
  const result = spawnSync(process.execPath, [comparator, source, realCandidate, realDifferential], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const receipt = JSON.parse(fs.readFileSync(realDifferential, 'utf8'));
  const candidate = JSON.parse(fs.readFileSync(realCandidate, 'utf8'));
  assert.equal(receipt.result, 'pass');
  assert.equal(receipt.totalRows, 21);
  assert.equal(receipt.semanticMatches, 21);
  assert.equal(receipt.promptMatches, 21);
  assert.equal(receipt.actionMatches, 21);
  assert.equal(candidate.service.rows.length, 21);
  assert.ok(candidate.service.rows.every((row) => row.probes.length === row.providerCalls.length));
  assert.ok(candidate.service.rows.filter((row) => row.probes.some((probe) => probe.status === 502)).length === 2);
  assert.ok(candidate.service.rows.filter((row) => row.probes.every((probe) => probe.status === 200 && probe.envelope.lassoDataFromRedis === true)).length === 19);
});

function run(receipts) {
  return spawnSync(process.execPath, [comparator, receipts.source, receipts.candidate, receipts.receipt], { encoding: 'utf8' });
}

test('S-12 comparator accepts the complete 21-row source/candidate receipt', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-s12-receipt-'));
  const receipts = copyReceipts(temp);
  const result = run(receipts);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const receipt = JSON.parse(fs.readFileSync(receipts.receipt, 'utf8'));
  assert.equal(receipt.result, 'pass');
  assert.equal(receipt.totalRows, 21);
  assert.equal(receipt.semanticMatches, 21);
  assert.equal(receipt.promptMatches, 21);
  assert.equal(receipt.actionMatches, 21);
  const sourceReceipt = JSON.parse(fs.readFileSync(receipts.source, 'utf8'));
  assert.deepEqual(sourceReceipt.actionIdPaths, [
    'config.jcp.id',
    'config.jcp.children[*].id',
    'config.jcp.children[*].config.play.id',
    'config.jcp.children[*].config.display.id',
  ]);
});

test('S-12 comparator rejects the same row omitted from both receipts', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-s12-coverage-'));
  const receipts = copyReceipts(temp);
  for (const file of [receipts.source, receipts.candidate]) {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    value.rows.pop();
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  }
  const result = run(receipts);
  assert.notEqual(result.status, 0, result.stdout);
  const receipt = JSON.parse(fs.readFileSync(receipts.receipt, 'utf8'));
  assert.equal(receipt.result, 'fail');
  assert.ok(receipt.coverageErrors.some((error) => error.includes('expected matrix')));
  assert.ok(receipt.coverageErrors.some((error) => error.includes('out of order') || error.includes('expected matrix')));
});

test('S-12 comparator rejects a duplicated row ID', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-s12-duplicate-'));
  const receipts = copyReceipts(temp);
  const value = JSON.parse(fs.readFileSync(receipts.candidate, 'utf8'));
  value.rows.push(value.rows[0]);
  fs.writeFileSync(receipts.candidate, `${JSON.stringify(value, null, 2)}\n`);
  const result = run(receipts);
  assert.notEqual(result.status, 0, result.stdout);
  const receipt = JSON.parse(fs.readFileSync(receipts.receipt, 'utf8'));
  assert.equal(receipt.result, 'fail');
  assert.ok(receipt.coverageErrors.some((error) => error.includes('duplicate row ID google-personal-today')));
});

test('S-12 comparator rejects a prompt-only candidate mutation', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-s12-prompt-'));
  const receipts = copyReceipts(temp);
  const value = JSON.parse(fs.readFileSync(receipts.candidate, 'utf8'));
  const first = value.rows[0].action.action;
  first.config.jcp.children[0].config.play.esml += ' forged';
  fs.writeFileSync(receipts.candidate, `${JSON.stringify(value, null, 2)}\n`);
  const result = run(receipts);
  assert.notEqual(result.status, 0, result.stdout);
  const receipt = JSON.parse(fs.readFileSync(receipts.receipt, 'utf8'));
  assert.equal(receipt.result, 'fail');
  assert.equal(receipt.semanticMatches, 21);
  assert.equal(receipt.promptMatches, 20);
  assert.equal(receipt.actionMatches, 20);
  assert.equal(receipt.promptDifferences[0].id, 'google-personal-today');
});

test('S-12 comparator rejects an action-only candidate mutation', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-s12-action-'));
  const receipts = copyReceipts(temp);
  const value = JSON.parse(fs.readFileSync(receipts.candidate, 'utf8'));
  value.rows[0].action.action.config.version = 'forged';
  fs.writeFileSync(receipts.candidate, `${JSON.stringify(value, null, 2)}\n`);
  const result = run(receipts);
  assert.notEqual(result.status, 0, result.stdout);
  const receipt = JSON.parse(fs.readFileSync(receipts.receipt, 'utf8'));
  assert.equal(receipt.result, 'fail');
  assert.equal(receipt.semanticMatches, 21);
  assert.equal(receipt.promptMatches, 21);
  assert.equal(receipt.actionMatches, 20);
  assert.equal(receipt.actionDifferences[0].id, 'google-personal-today');
});
