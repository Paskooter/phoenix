#!/usr/bin/env node

// The comparator must reject a receipt that looks plausible but changes one
// ordered MIM. This guards against an accidentally permissive parity lane.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [matrixPath, sourcePath, candidatePath] = process.argv.slice(2);
if (!matrixPath || !sourcePath || !candidatePath) {
  throw new Error('usage: negative-control.mjs <matrix.json> <source.json> <candidate.json>');
}

const forged = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
if (!forged.rows || !forged.rows[0] || !forged.rows[0].response
  || !Array.isArray(forged.rows[0].response.mimIds)
  || forged.rows[0].response.mimIds.length < 2) {
  throw new Error('candidate receipt has no mutable ordered MIM sequence');
}
[forged.rows[0].response.mimIds[0], forged.rows[0].response.mimIds[1]] = [
  forged.rows[0].response.mimIds[1], forged.rows[0].response.mimIds[0],
];

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 's10-news-negative-'));
const forgedPath = path.join(tempDir, 'candidate-forged.json');
const comparisonPath = path.join(tempDir, 'comparison.json');
fs.writeFileSync(forgedPath, `${JSON.stringify(forged, null, 2)}\n`);

const here = path.dirname(fileURLToPath(import.meta.url));
const comparator = path.join(here, 'compare.mjs');
const result = spawnSync(process.execPath, [comparator, matrixPath, sourcePath, forgedPath, comparisonPath], {
  cwd: path.resolve(here, '../..'),
  encoding: 'utf8',
  stdio: 'pipe',
});
const comparison = JSON.parse(fs.readFileSync(comparisonPath, 'utf8'));
const rejected = result.status !== 0 && comparison.result === 'fail'
  && comparison.differences.some((difference) => difference.kind === 'mim-order');
console.log(JSON.stringify({ result: rejected ? 'pass' : 'fail', rejected, differences: comparison.differences.length }));
if (!rejected) process.exitCode = 1;
