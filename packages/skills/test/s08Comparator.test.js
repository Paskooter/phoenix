// The source/candidate comparator must fail closed when a receipt drops a
// descriptor row. Without this guard, two missing rows compare as equal.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const evidence = path.join(root, 'docs/parity/evidence/2026-09-13/s08-personal-report');
const comparator = path.join(root, 'scripts/parity-s08/compare.mjs');
const spec = path.join(root, 'scripts/parity-s08/matrix-spec.json');

test('S-08 comparator rejects the same descriptor missing from both receipts', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-s08-compare-'));
  try {
    const receipts = {};
    for (const name of ['source-runtime.json', 'candidate-runtime.json']) {
      const target = path.join(temp, name);
      fs.copyFileSync(path.join(evidence, name), target);
      receipts[name] = JSON.parse(fs.readFileSync(target, 'utf8'));
    }
    const removedId = receipts['source-runtime.json'].graph.at(-1).id;
    for (const name of ['source-runtime.json', 'candidate-runtime.json']) {
      const receipt = receipts[name];
      assert.equal(receipt.graph.at(-1).id, removedId);
      receipt.graph = receipt.graph.filter(row => row.id !== removedId);
      fs.writeFileSync(path.join(temp, name), `${JSON.stringify(receipt, null, 2)}\n`);
    }

    const result = spawnSync(process.execPath, [comparator, temp, spec], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, `comparator unexpectedly passed: ${result.stdout}`);
    const receipt = JSON.parse(fs.readFileSync(path.join(temp, 'differential-receipt.json'), 'utf8'));
    assert.equal(receipt.result, 'fail');
    assert.ok(receipt.coverageErrors.some(error => error.includes('source.graph cardinality')));
    assert.ok(receipt.coverageErrors.some(error => error.includes('source.graph is missing row ID')));
    assert.ok(receipt.coverageErrors.some(error => error.includes('candidate.graph cardinality')));
    assert.ok(receipt.coverageErrors.some(error => error.includes('candidate.graph is missing row ID')));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
