#!/usr/bin/env node

// Exercise the differential's fail-closed boundary. Mutated matrix and
// receipt copies are written only to a temporary directory and must all be
// rejected by compare.mjs.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [matrixArg, sourceArg, candidateArg, outArg] = process.argv.slice(2);
if (!matrixArg || !sourceArg || !candidateArg) throw new Error('usage: falsify.mjs <matrix.json> <source.json> <candidate.json> [falsifier.json]');

const here = path.dirname(fileURLToPath(import.meta.url));
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const originalMatrix = readJSON(matrixArg);
const originalSource = readJSON(sourceArg);
const originalCandidate = readJSON(candidateArg);
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
const canonical = value => JSON.stringify(stable(value));
function rehashRow(row) {
  const copy = { ...row };
  delete copy.sha256;
  row.sha256 = sha(canonical(copy));
}
function swapRows(receipt) {
  const first = receipt.cases[0];
  receipt.cases[0] = receipt.cases[1];
  receipt.cases[1] = first;
}
function removeLastAndAdjust(receipt, providerCount) {
  receipt.cases.pop();
  receipt.counts = { namedCases: 19, requestRuns: 27, providerCalls: providerCount };
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-s11-data-maps-falsify-'));
const compare = path.join(here, 'compare.mjs');
const mutations = [
  {
    name: 'matrix-and-both-receipts-missing-row',
    mutate(matrix, source, candidate) {
      matrix.cases.pop();
      matrix.counts = { ...matrix.counts, namedCases: 19, requestRuns: 27, providerCalls: 16 };
      removeLastAndAdjust(source, 16);
      removeLastAndAdjust(candidate, 16);
    },
  },
  {
    name: 'matrix-and-both-receipts-reordered-rows',
    mutate(matrix, source, candidate) {
      const first = matrix.cases[0];
      matrix.cases[0] = matrix.cases[1];
      matrix.cases[1] = first;
      swapRows(source);
      swapRows(candidate);
    },
  },
  {
    name: 'matrix-and-both-receipts-semantic-rewrite',
    mutate(matrix, source, candidate) {
      const spec = matrix.cases.find(item => item.id === 'validation-invalid-mode');
      spec.expectedError = 'Invalid mode: "rewritten"';
      for (const receipt of [source, candidate]) {
        const row = receipt.cases.find(item => item.id === 'validation-invalid-mode');
        row.expectedError = spec.expectedError;
        rehashRow(row);
      }
    },
  },
  {
    name: 'matrix-and-candidate-receipt-pin-rewrite',
    mutate(matrix, source, candidate) {
      const pathName = 'packages/data/src/maps.js';
      const rewritten = '0'.repeat(64);
      matrix.candidate.hashes[pathName] = rewritten;
      candidate.candidate.hashes[pathName] = rewritten;
    },
  },
  {
    name: 'source-receipt-missing-row',
    mutate(matrix, source) { source.cases.pop(); },
  },
  {
    name: 'candidate-receipt-reordered-rows',
    mutate(matrix, source, candidate) { swapRows(candidate); },
  },
  {
    name: 'candidate-receipt-metadata-rewrite',
    mutate(matrix, source, candidate) { candidate.runtime.network = 'none'; },
  },
  {
    name: 'candidate-semantic-status-rewrite-rehashed',
    mutate(matrix, source, candidate) {
      const row = candidate.cases.find(item => item.id === 'get-miss-google-route');
      row.responses[0].response.status = 201;
      rehashRow(row);
    },
  },
  {
    name: 'candidate-row-self-hash-rewrite',
    mutate(matrix, source, candidate) {
      const row = candidate.cases.find(item => item.id === 'get-miss-google-route');
      row.responses[0].response.body = '{"status":"REWRITTEN"}';
      // Deliberately leave row.sha256 unchanged: the comparator must reject
      // the receipt before relying on cross-side semantic comparison.
    },
  },
];

const results = [];
for (const mutation of mutations) {
  const matrix = JSON.parse(JSON.stringify(originalMatrix));
  const source = JSON.parse(JSON.stringify(originalSource));
  const candidate = JSON.parse(JSON.stringify(originalCandidate));
  mutation.mutate(matrix, source, candidate);
  const matrixPath = path.join(temp, `${mutation.name}.matrix.json`);
  const sourcePath = path.join(temp, `${mutation.name}.source.json`);
  const candidatePath = path.join(temp, `${mutation.name}.candidate.json`);
  const reportPath = path.join(temp, `${mutation.name}.comparison.json`);
  fs.writeFileSync(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`);
  fs.writeFileSync(sourcePath, `${JSON.stringify(source, null, 2)}\n`);
  fs.writeFileSync(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`);
  const run = spawnSync(process.execPath, [compare, matrixPath, sourcePath, candidatePath, reportPath], {
    cwd: path.resolve(here, '../..'),
    env: process.env,
    encoding: 'utf8',
  });
  const rejected = run.status !== 0;
  results.push({
    name: mutation.name,
    rejected,
    exitCode: run.status,
    stdout: String(run.stdout || '').trim().slice(-500),
    stderr: String(run.stderr || '').trim().slice(-500),
  });
  if (!rejected) throw new Error(`falsifier was accepted: ${mutation.name}`);
}

const receipt = { schema: 'phoenix.parity.s11.data-maps-falsifier.v1', result: 'pass', mutations: results };
if (outArg) {
  fs.mkdirSync(path.dirname(path.resolve(outArg)), { recursive: true });
  fs.writeFileSync(path.resolve(outArg), `${JSON.stringify(receipt, null, 2)}\n`);
}
process.stdout.write(`${JSON.stringify({ result: receipt.result, mutations: results.map(item => ({ name: item.name, rejected: item.rejected })), out: outArg || null })}\n`);
