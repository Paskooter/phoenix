#!/usr/bin/env node

// Fail-closed source differential for the four Phoenix report-view helpers.
// In run mode this file orchestrates two isolated runtimes. In receipt mode it
// validates previously produced receipts without trusting their metadata.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const worktree = path.resolve(here, '../..');
const CONTRACT_SHA256 = '243c31360328c453069f064e7ded88b80454c865f81d2831e7936f28080c92c3';
const EXPECTED = {
  schema: 'phoenix.parity.s13.report-view-matrix.v1',
  contractSchema: 'phoenix.parity.s13.report-view-contract.v1',
  receiptSchema: 'phoenix.parity.s13.report-view-receipt.v1',
  differentialSchema: 'phoenix.parity.s13.report-view-differential.v1',
  task: 'S-13',
  implementationRevision: '0902410c597f8dc424af60ee98fc4d32f19a1bb0',
  counts: { namedCases: 61, expandedRuns: 61, expandedAssertions: 61, groups: { weather: 20, traffic: 7, depart: 4, news: 5, calendar: 25 } },
};

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const fileSha = file => sha(fs.readFileSync(file));
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const canonical = value => JSON.stringify(stable(value));
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.keys(value).sort().reduce((out, key) => { out[key] = stable(value[key]); return out; }, {});
  return value;
}
const rowHash = value => sha(canonical(value));
const display = value => {
  const text = JSON.stringify(value);
  return text && text.length > 300 ? `${text.slice(0, 297)}...` : value;
};
function firstDifference(a, b, at = '$') {
  if (canonical(a) === canonical(b)) return null;
  if (typeof a !== typeof b || a === null || b === null) return { path: at, source: display(a), candidate: display(b) };
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return { path: at, source: display(a), candidate: display(b) };
    for (let i = 0; i < a.length; i += 1) {
      const difference = firstDifference(a[i], b[i], `${at}[${i}]`);
      if (difference) return difference;
    }
  } else if (typeof a === 'object') {
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      const difference = firstDifference(a[key], b[key], `${at}.${key}`);
      if (difference) return difference;
    }
  }
  return { path: at, source: display(a), candidate: display(b) };
}
function fail(message) { throw new Error(message); }
function mkdirp(dir) { fs.mkdirSync(dir, { recursive: true }); }
function mapEqual(a, b) { return canonical(a || {}) === canonical(b || {}); }
function requireMap(root, map, label) {
  for (const [relative, expected] of Object.entries(map || {}).sort(([a], [b]) => a.localeCompare(b))) {
    const file = path.join(root, relative);
    if (!fs.existsSync(file)) fail(`missing ${label}: ${relative}`);
    const actual = fileSha(file);
    if (actual !== expected) fail(`${label} changed: ${relative}`);
  }
}

function parseArgs(argv) {
  const args = {
    out: path.join(worktree, '.parity/runs/s13-report-views'),
    reference: process.env.PHOENIX_S13_REFERENCE || path.resolve(worktree, '../phoenix/.parity/reference/5c0a7390539663ba749d360de348a428c088505c'),
    harnessRoot: here,
    candidateRoot: worktree,
    matrix: null,
    contract: null,
    sourceReceipt: null,
    candidateReceipt: null,
    candidateRevision: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') args.out = path.resolve(argv[++i]);
    else if (arg === '--reference') args.reference = path.resolve(argv[++i]);
    else if (arg === '--harness-root') args.harnessRoot = path.resolve(argv[++i]);
    else if (arg === '--candidate-root') args.candidateRoot = path.resolve(argv[++i]);
    else if (arg === '--candidate-revision') args.candidateRevision = argv[++i];
    else if (arg === '--matrix') args.matrix = path.resolve(argv[++i]);
    else if (arg === '--contract') args.contract = path.resolve(argv[++i]);
    else if (arg === '--source-receipt') args.sourceReceipt = path.resolve(argv[++i]);
    else if (arg === '--candidate-receipt') args.candidateReceipt = path.resolve(argv[++i]);
    else if (arg === '--help') {
      console.log('Usage: node compare.mjs [--out DIR] [--reference DIR]');
      console.log('       node compare.mjs --source-receipt SOURCE --candidate-receipt CANDIDATE [--out DIR]');
      process.exit(0);
    } else fail(`unknown argument: ${arg}`);
  }
  args.matrix ||= path.join(args.harnessRoot, 'matrix.json');
  args.contract ||= path.join(args.harnessRoot, 'contract.json');
  if ((args.sourceReceipt === null) !== (args.candidateReceipt === null)) fail('receipt mode requires both receipts');
  if (args.candidateRevision !== null && args.sourceReceipt === null) fail('--candidate-revision is only valid in receipt mode');
  return args;
}

function validateContract(contract, contractPath, matrix, matrixPath, harnessRoot) {
  if (fileSha(contractPath) !== CONTRACT_SHA256) fail('immutable S-13 contract changed');
  if (contract.schema !== EXPECTED.contractSchema || contract.task !== EXPECTED.task) fail('contract identity mismatch');
  if (contract.matrixSha256 !== fileSha(matrixPath)) fail('matrix is not pinned by contract');
  if (matrix.schema !== EXPECTED.schema || matrix.task !== EXPECTED.task || matrix.base !== EXPECTED.implementationRevision) fail('matrix identity mismatch');
  if (canonical(matrix.counts) !== canonical(EXPECTED.counts)) fail('matrix counts/distribution mismatch');
  if (contract.matrixSha256 !== contract.matrix.sha256 || contract.matrix.counts === undefined) fail('contract matrix pin incomplete');
  if (canonical(contract.matrix.counts) !== canonical(matrix.counts)) fail('contract matrix counts mismatch');
  if (canonical(contract.matrix.rowIds) !== canonical(matrix.rows.map(row => row.id))) fail('contract matrix row IDs mismatch');
  const comparator = fs.readFileSync(path.join(harnessRoot, 'compare.mjs'), 'utf8').replace(/const CONTRACT_SHA256 = '[0-9a-f_]{16,64}';/, "const CONTRACT_SHA256 = '__CONTRACT_SHA256__';");
  if (sha(comparator) !== contract.comparatorSha256) fail('comparator implementation changed');
}

function validateMatrix(matrix) {
  if (!Array.isArray(matrix.rows) || matrix.rows.length !== EXPECTED.counts.namedCases) fail('matrix row count mismatch');
  const seen = new Set();
  const groups = { weather: 0, traffic: 0, depart: 0, news: 0, calendar: 0 };
  matrix.rows.forEach((row, index) => {
    if (!row || typeof row.id !== 'string' || seen.has(row.id)) fail(`matrix duplicate/malformed row ${index}`);
    seen.add(row.id);
    if (!Object.prototype.hasOwnProperty.call(groups, row.kind)) fail(`matrix unknown row kind ${row.id}`);
    groups[row.kind] += 1;
    if (row.group !== row.kind || !Number.isInteger(row.sourceLine) || typeof row.sourceName !== 'string' || row.assertionCount !== 1 || !Array.isArray(row.args)) fail(`matrix incomplete row ${row.id}`);
    if (rowHash(row) !== row.specSha256 && row.specSha256 !== undefined) fail(`matrix self-hash mismatch ${row.id}`);
  });
  if (canonical(groups) !== canonical(EXPECTED.counts.groups)) fail('matrix group inventory mismatch');
}

function validateReference(referenceRoot, matrix, contract) {
  const reference = matrix.reference;
  if (!reference || reference.revision !== contract.reference.revision) fail('reference revision mismatch');
  if (reference.imageDigest !== contract.reference.imageDigest) fail('reference image mismatch');
  requireMap(referenceRoot, {
    [reference.preparedPath]: reference.preparedSha256,
    [reference.compiledPath]: reference.compiledSha256,
    [reference.rootManifestPath]: reference.rootManifestSha256,
    [reference.lockPath]: reference.lockSha256,
    [reference.reportManifestPath]: reference.reportManifestSha256,
  }, 'source provenance');
  requireMap(referenceRoot, reference.testFiles, 'archived source test');
  requireMap(referenceRoot, reference.sourcePaths, 'source TypeScript');
  requireMap(referenceRoot, reference.compiledPaths, 'compiled source');
  requireMap(referenceRoot, reference.resources, 'source resource');
  requireMap(referenceRoot, contract.reference.dependencyManifest, 'source dependency manifest');
  if (sha(canonical(contract.reference.dependencyManifest)) !== contract.reference.dependencyManifestSha256) fail('source dependency manifest self-hash mismatch');
  const prepared = readJson(path.join(referenceRoot, reference.preparedPath));
  if (prepared.referenceRevision !== reference.revision || prepared.relocatedLockSha256 !== reference.lockSha256) fail('prepared source metadata mismatch');
  const compiled = readJson(path.join(referenceRoot, reference.compiledPath));
  if (compiled.referenceRevision !== reference.revision || compiled.runtime !== 'v8.9.4') fail('compiled source metadata mismatch');
  requireMap(referenceRoot, compiled.inputs, 'compiled input dependency');
  requireMap(referenceRoot, compiled.outputs, 'compiled output dependency');
  for (const [file, expected] of Object.entries(reference.sourcePaths)) if (!compiled.inputs || compiled.inputs[file] !== expected) fail(`compiled input mismatch: ${file}`);
  for (const [file, expected] of Object.entries(reference.compiledPaths)) if (!compiled.outputs || compiled.outputs[file] !== expected) fail(`compiled output mismatch: ${file}`);
}

function gitRevision(root) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) fail(`cannot resolve candidate revision: ${result.stderr || result.status}`);
  return result.stdout.trim();
}
function isAncestor(ancestor, descendant, root) {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd: root, encoding: 'utf8' });
  return result.status === 0;
}
function validateCandidate(candidateRoot, matrix, contract, suppliedRevision) {
  const implementationRevision = contract.candidate.implementationRevision;
  if (!implementationRevision || !/^[0-9a-f]{40}$/.test(implementationRevision)) fail('candidate implementation revision pin malformed');
  const testedRevision = suppliedRevision || (candidateRoot === worktree ? gitRevision(candidateRoot) : null);
  if (!testedRevision || !/^[0-9a-f]{40}$/.test(testedRevision)) fail(`candidate tested revision malformed: ${testedRevision || '<missing>'}`);
  if (candidateRoot === worktree && !isAncestor(implementationRevision, testedRevision, candidateRoot)) fail('candidate tested revision does not contain pinned implementation');
  if (candidateRoot !== worktree && testedRevision !== implementationRevision) fail('overlay candidate tested revision must equal implementation pin');
  if (!mapEqual(matrix.candidate.paths, contract.candidate.paths) || !mapEqual(matrix.candidate.resources, contract.candidate.resources) || !mapEqual(matrix.candidate.dependencies, contract.candidate.dependencies)) fail('candidate provenance differs from contract');
  requireMap(candidateRoot, matrix.candidate.paths, 'candidate module');
  requireMap(candidateRoot, matrix.candidate.resources, 'candidate resource');
  requireMap(candidateRoot, matrix.candidate.dependencies, 'candidate dependency');
  return { implementationRevision, testedRevision };
}

function validateHarness(contract, harnessRoot) {
  for (const [relative, expected] of Object.entries(contract.harness || {}).sort(([a], [b]) => a.localeCompare(b))) {
    const file = path.join(harnessRoot, relative);
    if (!fs.existsSync(file) || fileSha(file) !== expected) fail(`harness file changed: ${relative}`);
  }
}

function validateRows(receipt, side, matrix) {
  if (!Array.isArray(receipt.rows) || receipt.rows.length !== matrix.rows.length) fail(`${side} row count mismatch`);
  const seen = new Set();
  receipt.rows.forEach((row, index) => {
    const spec = matrix.rows[index];
    if (!row || typeof row.id !== 'string' || seen.has(row.id)) fail(`${side} duplicate/malformed row ${row && row.id}`);
    seen.add(row.id);
    if (row.id !== spec.id) fail(`${side} row reorder/missing at index ${index}: ${row.id}`);
    if (row.group !== spec.group || row.kind !== spec.kind || row.sourceName !== spec.sourceName || row.sourceLine !== spec.sourceLine || row.assertionCount !== spec.assertionCount) fail(`${side} row metadata mismatch ${row.id}`);
    if (row.specSha256 !== rowHash(spec)) fail(`${side} input provenance mismatch ${row.id}`);
    if (!Array.isArray(row.runs) || row.runs.length !== 1) fail(`${side} run count mismatch ${row.id}`);
    const run = row.runs[0];
    if (!run || run.index !== 0 || !Object.prototype.hasOwnProperty.call(run, 'outcome') || typeof run.sha256 !== 'string') fail(`${side} incomplete run ${row.id}`);
    if (run.sha256 !== rowHash(run.outcome)) fail(`${side} row self-hash mismatch ${row.id}`);
    if (!run.outcome || !['fulfilled', 'rejected'].includes(run.outcome.status)) fail(`${side} invalid tagged outcome ${row.id}`);
    if (run.outcome.status === 'fulfilled' && !Object.prototype.hasOwnProperty.call(run.outcome, 'value')) fail(`${side} fulfilled outcome missing value ${row.id}`);
    if (run.outcome.status === 'rejected' && (!run.outcome.error || typeof run.outcome.error.name !== 'string' || typeof run.outcome.error.message !== 'string')) fail(`${side} rejected outcome missing error ${row.id}`);
  });
  if (seen.size !== matrix.rows.length) fail(`${side} row omission`);
}

function validateReceipt(receipt, side, matrix, contract, testedRevision) {
  if (!receipt || receipt.schema !== EXPECTED.receiptSchema || receipt.result !== 'pass') fail(`${side} receipt is not a passing S-13 receipt`);
  if (canonical(receipt.counts) !== canonical(matrix.counts)) fail(`${side} counts mismatch`);
  const runtime = side === 'source' ? matrix.runtime.source : matrix.runtime.candidate;
  if (!receipt.runtime || receipt.runtime.node !== runtime.node || receipt.runtime.imageDigest !== runtime.imageDigest || receipt.runtime.image !== runtime.image || receipt.runtime.timezone !== matrix.runtime.timezone || receipt.runtime.clockISO !== matrix.runtime.clockISO || receipt.runtime.randomSeed !== matrix.runtime.randomSeed || receipt.runtime.network !== matrix.runtime.network) fail(`${side} runtime controls mismatch`);
  validateRows(receipt, side, matrix);
  if (side === 'source') {
    const source = receipt.source;
    if (!source || source.repo !== matrix.reference.repo || source.revision !== matrix.reference.revision || source.preparedSha256 !== matrix.reference.preparedSha256 || source.compiledSha256 !== matrix.reference.compiledSha256 || source.dependencyManifestSha256 !== contract.reference.dependencyManifestSha256 || source.matrixSha256 !== contract.matrixSha256 || source.contractSha256 !== CONTRACT_SHA256) fail('source receipt provenance mismatch');
    if (!mapEqual(source.sourcePaths, matrix.reference.sourcePaths) || !mapEqual(source.compiledPaths, matrix.reference.compiledPaths) || !mapEqual(source.resources, matrix.reference.resources)) fail('source receipt dependency maps mismatch');
  } else {
    const candidate = receipt.candidate;
    if (!candidate || candidate.implementationRevision !== contract.candidate.implementationRevision || !/^[0-9a-f]{40}$/.test(candidate.testedRevision || '') || candidate.testedRevision !== testedRevision || candidate.matrixSha256 !== contract.matrixSha256 || candidate.contractSha256 !== CONTRACT_SHA256) fail('candidate receipt provenance mismatch');
    if (!mapEqual(candidate.moduleSha256, matrix.candidate.paths) || !mapEqual(candidate.resourceSha256, matrix.candidate.resources) || !mapEqual(candidate.dependencySha256, matrix.candidate.dependencies)) fail('candidate receipt dependency maps mismatch');
  }
}

function runCommand(argv, logPath, env = {}) {
  const result = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 16 * 1024 * 1024 });
  fs.writeFileSync(logPath, `${result.stdout || ''}${result.stderr || ''}`);
  return { argv, status: result.status, signal: result.signal, log: path.basename(logPath) };
}
function runRuntimes(args, matrix, out, revisions) {
  mkdirp(out);
  const harness = args.harnessRoot;
  const sourceImage = `node@${matrix.runtime.source.imageDigest}`;
  const candidateImage = `node@${matrix.runtime.candidate.imageDigest}`;
  const sourceCommand = [
    'docker', 'run', '--rm', '--network', 'none',
    '--env', `PHOENIX_S13_CONTRACT_SHA256=${CONTRACT_SHA256}`,
    '--mount', `type=bind,source=${args.reference},target=/reference,readonly`,
    '--mount', `type=bind,source=${harness},target=/harness,readonly`,
    '--mount', `type=bind,source=${out},target=/run`,
    sourceImage, 'node', '/harness/run-source.cjs', '/reference', '/harness/matrix.json', '/run/source.json', '/harness/contract.json',
  ];
  const sourceResult = runCommand(sourceCommand, path.join(out, 'source.log'), { PHOENIX_S13_CONTRACT_SHA256: CONTRACT_SHA256 });
  const candidateCommand = [
    'docker', 'run', '--rm', '--network', 'none',
    '--env', `PHOENIX_S13_TESTED_REVISION=${revisions.testedRevision}`,
    '--env', `PHOENIX_S13_CONTRACT_SHA256=${CONTRACT_SHA256}`,
    '--mount', `type=bind,source=${args.candidateRoot},target=/candidate,readonly`,
    '--mount', `type=bind,source=${harness},target=/harness,readonly`,
    '--mount', `type=bind,source=${out},target=/run`,
    candidateImage, 'node', '/harness/run-candidate.mjs', '/candidate', '/harness/matrix.json', '/run/candidate.json', '/harness/contract.json',
  ];
  const candidateResult = runCommand(candidateCommand, path.join(out, 'candidate.log'), { PHOENIX_S13_CONTRACT_SHA256: CONTRACT_SHA256 });
  return { sourceResult, candidateResult };
}

function compareReceipts(source, candidate, matrix) {
  const differences = [];
  for (let index = 0; index < matrix.rows.length; index += 1) {
    const sourceRow = source.rows[index];
    const candidateRow = candidate.rows[index];
    const difference = firstDifference(sourceRow.runs[0].outcome, candidateRow.runs[0].outcome);
    if (difference) differences.push({ index, id: matrix.rows[index].id, kind: matrix.rows[index].kind, ...difference });
  }
  return differences;
}

function writeReport(args, matrix, source, candidate, commands, fatal, differences, revision) {
  mkdirp(args.out);
  const receiptSummary = receipt => receipt && Array.isArray(receipt.rows)
    ? { rows: receipt.rows.length, fulfilled: receipt.rows.filter(row => row.runs && row.runs[0] && row.runs[0].outcome && row.runs[0].outcome.status === 'fulfilled').length, rejected: receipt.rows.filter(row => row.runs && row.runs[0] && row.runs[0].outcome && row.runs[0].outcome.status === 'rejected').length }
    : null;
  const report = {
    schema: EXPECTED.differentialSchema,
    task: EXPECTED.task,
    result: fatal || differences.length ? 'fail' : 'pass',
    candidateImplementationRevision: matrix.candidate.implementationRevision,
    candidateTestedRevision: revision,
    counts: matrix.counts,
    source: receiptSummary(source),
    candidate: receiptSummary(candidate),
    commands,
    receipts: source && candidate ? { sourceSha256: fileSha(args.sourceReceipt || path.join(args.out, 'source.json')), candidateSha256: fileSha(args.candidateReceipt || path.join(args.out, 'candidate.json')) } : null,
    differences,
    fatal: fatal || null,
  };
  fs.writeFileSync(path.join(args.out, 'comparison.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const matrix = readJson(args.matrix);
  const contract = readJson(args.contract);
  let source = null;
  let candidate = null;
  let commands = {};
  let fatal = null;
  let differences = [];
  let revision = args.candidateRevision || null;
  try {
    validateContract(contract, args.contract, matrix, args.matrix, args.harnessRoot);
    validateMatrix(matrix);
    validateHarness(contract, args.harnessRoot);
    validateReference(args.reference, matrix, contract);
    const revisions = validateCandidate(args.candidateRoot, matrix, contract, revision);
    revision = revisions.testedRevision;
    if (!args.sourceReceipt) commands = runRuntimes(args, matrix, args.out, revisions);
    const sourcePath = args.sourceReceipt || path.join(args.out, 'source.json');
    const candidatePath = args.candidateReceipt || path.join(args.out, 'candidate.json');
    if (!fs.existsSync(sourcePath) || !fs.existsSync(candidatePath)) fail('source/candidate receipt missing after runtime execution');
    source = readJson(sourcePath);
    candidate = readJson(candidatePath);
    validateReceipt(source, 'source', matrix, contract, revision);
    validateReceipt(candidate, 'candidate', matrix, contract, revision);
    differences = compareReceipts(source, candidate, matrix);
  } catch (error) {
    fatal = String(error && error.message || error);
  }
  const report = writeReport(args, matrix, source, candidate, commands, fatal, differences, revision);
  console.log(JSON.stringify({ result: report.result, rows: report.counts.namedCases, matches: report.counts.namedCases - report.differences.length, differences: report.differences.length, fatal: report.fatal, out: path.join(args.out, 'comparison.json') }));
  if (report.result !== 'pass') process.exitCode = 1;
}

main();
