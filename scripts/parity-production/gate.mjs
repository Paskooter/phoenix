// Production smoke gate: strict comparison first, reviewed security exceptions second.
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  loadApprovedDivergences,
  validateApprovedDivergences,
} from './approved-divergences.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function validateStrictMatch(out, suite) {
  const suiteBytes = readFileSync(resolve(out, 'suite.json'));
  const comparisonBytes = readFileSync(resolve(out, 'comparison.json'));
  const comparison = JSON.parse(comparisonBytes);
  const run = readJson(resolve(out, 'run.json'));
  if (comparison.pass !== true || comparison.measuredAgreement !== true
      || comparison.cases !== suite.cases.length
      || !Array.isArray(comparison.differences) || comparison.differences.length
      || !Array.isArray(comparison.invariants) || comparison.invariants.length
      || !Array.isArray(comparison.coverageGaps) || comparison.coverageGaps.length) {
    throw new Error('strict comparator returned an inconsistent passing result');
  }
  if (run.result !== 'match' || run.cases !== comparison.cases || run.differences !== 0
      || run.invariants !== 0 || run.coverageGaps !== 0 || run.failure || run.cleanupFailures) {
    throw new Error('run.json is inconsistent with a strict passing comparison');
  }
  for (const command of run.commands || []) {
    if (!Number.isInteger(command.exitCode) || command.exitCode !== 0 || command.timedOut) {
      throw new Error(`run.json records a failed tool in a strict pass: ${command.name}`);
    }
  }
  if (!suiteBytes.length || !comparisonBytes.length) throw new Error('strict gate artifacts are empty');
}

function validateApprovedMismatch(out) {
  const suiteBytes = readFileSync(resolve(out, 'suite.json'));
  const comparisonBytes = readFileSync(resolve(out, 'comparison.json'));
  const suite = JSON.parse(suiteBytes);
  const comparison = JSON.parse(comparisonBytes);
  const run = readJson(resolve(out, 'run.json'));
  const manifest = loadApprovedDivergences();
  return validateApprovedDivergences({
    comparison,
    suite,
    suiteBytes,
    comparisonBytes,
    run,
    manifest,
  });
}

if (args.length && !(args.length === 2 && args[0] === '--out')) {
  console.error('Usage: npm run parity:gate -- [--out EMPTY_DIRECTORY]');
  process.exitCode = 2;
} else {
  const out = args.length ? resolve(args[1]) : resolve(root, '.parity/runs/ci-production-' + randomUUID());
  const suite = readJson(resolve(root, 'packages/harness/resources/goldens/production-smoke/suite.json'));
  console.log(`Strict production smoke gate (${suite.cases.length} cases; full corpus remains separately tracked). Evidence: ${out}`);
  const child = spawnSync('python3', [resolve(root, 'scripts/parity-production/run.py'), '--golden', resolve(root, 'packages/harness/resources/goldens/production-smoke'), '--out', out], { stdio: 'inherit', cwd: root });
  if (child.error || child.status === null) {
    console.error(`[parity:gate] production smoke tool failed: ${(child.error && child.error.message) || child.signal || 'unknown termination'}`);
    process.exitCode = 2;
  } else if (child.status === 0) {
    try {
      validateStrictMatch(out, suite);
      process.exitCode = 0;
    } catch (error) {
      console.error(`[parity:gate] strict pass validation failed: ${error.message}`);
      process.exitCode = 2;
    }
  } else if (child.status === 1) {
    try {
      const approval = validateApprovedMismatch(out);
      console.log(`[parity:gate] passed with ${approval.approvedCount} explicitly approved intentional security divergences; run.json remains result=mismatch (source match not claimed).`);
      process.exitCode = 0;
    } catch (error) {
      console.error(`[parity:gate] rejected mismatch: ${error.message}`);
      process.exitCode = 1;
    }
  } else {
    console.error(`[parity:gate] production smoke tool exited ${child.status}; no mismatch was approved.`);
    process.exitCode = child.status;
  }
}
