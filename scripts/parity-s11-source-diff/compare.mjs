#!/usr/bin/env node

// Reproducible, fail-closed S-11 differential. Every archived row and
// supplemental mode probe must be present exactly once on both sides, with
// valid self-hashes, pinned source provenance, deterministic controls, and
// complete projected outputs.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const worktree = path.resolve(here, '../..');
const defaultMatrixPath = path.join(here, 'matrix.json');
const contractPath = path.join(here, 'contract.json');
// This digest is deliberately code-pinned. A matrix or contract replacement
// therefore cannot change the expected inventory by rehashing itself.
const CONTRACT_SHA256 = 'd5a9ded0f9b0c609f66aa986555b59b4e96b2ee01ed5c0eda37f7961b740eef2';
const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
let matrixPath;
let matrix;

function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function fileSha(file) { return sha(fs.readFileSync(file)); }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.keys(value).sort().reduce((out, key) => { out[key] = stable(value[key]); return out; }, {});
  if (typeof value === 'number' && Number.isNaN(value)) return 'NaN';
  return value;
}
function canonical(value) { return JSON.stringify(stable(value)); }
function display(value) {
  const text = JSON.stringify(value);
  return text && text.length > 260 ? `${text.slice(0, 257)}...` : value;
}
function firstDifference(a, b, at = '$') {
  if (Object.is(a, b)) return null;
  if (typeof a !== typeof b || a === null || b === null) return { path: at, source: display(a), candidate: display(b) };
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return { path: at, source: display(a), candidate: display(b) };
    for (let i = 0; i < a.length; i += 1) { const d = firstDifference(a[i], b[i], `${at}[${i}]`); if (d) return d; }
    return { path: at, source: display(a), candidate: display(b) };
  }
  if (typeof a === 'object') {
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      const d = firstDifference(a[key], b[key], `${at}.${key}`);
      if (d) return d;
    }
  }
  return { path: at, source: display(a), candidate: display(b) };
}

const EXPECTED = {
  schema: 'phoenix.parity.s11.commute-matrix.v1',
  receiptSchema: 'phoenix.parity.s11.commute-receipt.v1',
  differentialSchema: 'phoenix.parity.s11.commute-differential.v1',
  task: 'S-11',
  base: '0599e8fe60a2877cda089454a58f50f5316b7098',
  branch: 'w-s11-source-diff',
  primaryCounts: { namedCases: 33, expandedRuns: 33, expandedAssertions: 36 },
  primaryGroups: { 'top-level': 3, 'get-data': 1, parse: 12, 'not-driving': 2, 'driving-departure-over-2h': 2, 'driving-departure-within-2h': 4, 'driving-late': 4, views: 5 },
  supplementalCounts: { namedCases: 5, expandedRuns: 5, expandedAssertions: 0 },
  supplementalGroups: { 'mode-boundary': 5 },
  supplementalIds: [
    's11:supplemental:mode:driving',
    's11:supplemental:mode:transit',
    's11:supplemental:mode:bicycling',
    's11:supplemental:mode:walking',
    's11:supplemental:mode:invalid',
  ],
};

function expectContractFile() {
  if (CONTRACT_SHA256.indexOf('__') === 0 || fileSha(contractPath) !== CONTRACT_SHA256) {
    throw new Error('immutable S-11 contract changed');
  }
  if (contract.schema !== 'phoenix.parity.s11.commute-contract.v1') throw new Error('S-11 contract schema mismatch');
  const comparator = fs.readFileSync(path.join(here, 'compare.mjs'), 'utf8')
    .replace(/const CONTRACT_SHA256 = '[0-9a-f]{64}';/, "const CONTRACT_SHA256 = '__CONTRACT_SHA256__';");
  if (sha(comparator) !== contract.comparatorSha256) throw new Error('comparator implementation changed');
}

function validateContractMatrix() {
  if (fileSha(matrixPath) !== contract.matrixSha256) throw new Error('matrix file is not the pinned S-11 matrix');
  if (matrix.schema !== contract.matrix.schema || matrix.task !== contract.matrix.task
    || matrix.base !== contract.matrix.base || matrix.branch !== contract.matrix.branch) {
    throw new Error('matrix identity differs from immutable S-11 contract');
  }
  if (canonical(matrix.counts) !== canonical(contract.matrix.counts)
    || canonical(matrix.runtime) !== canonical(contract.runtime)
    || canonical(matrix.reference) !== canonical(contract.reference)
    || canonical(matrix.candidate) !== canonical(contract.candidate)) {
    throw new Error('matrix provenance/runtime differs from immutable S-11 contract');
  }
  if (sha(canonical(matrix.cases)) !== contract.matrix.primaryCasesSha256
    || matrix.caseMatrixSha256 !== contract.matrix.caseMatrixSha256
    || matrix.inventorySha256 !== contract.matrix.inventorySha256) {
    throw new Error('primary case inventory differs from immutable S-11 contract');
  }
  if (sha(canonical(matrix.supplemental)) !== contract.matrix.supplementalCasesSha256
    || matrix.supplementalMatrixSha256 !== contract.matrix.supplementalMatrixSha256) {
    throw new Error('supplemental inventory differs from immutable S-11 contract');
  }
}

function validatePrimaryMatrix() {
  if (matrix.schema !== EXPECTED.schema || matrix.task !== EXPECTED.task || matrix.base !== EXPECTED.base || matrix.branch !== EXPECTED.branch) throw new Error('matrix identity mismatch');
  if (canonical(matrix.counts) !== canonical({ ...EXPECTED.primaryCounts, groups: EXPECTED.primaryGroups })) throw new Error('matrix primary counts/group mismatch');
  if (!Array.isArray(matrix.cases) || matrix.cases.length !== EXPECTED.primaryCounts.namedCases) throw new Error('matrix named row count mismatch');
  const ids = new Set();
  const inventory = matrix.cases.map(item => {
    if (!item || typeof item.id !== 'string' || ids.has(item.id)) throw new Error(`matrix duplicate/malformed row ${item && item.id}`);
    ids.add(item.id);
    if (!item.group || typeof item.sourceName !== 'string' || !Number.isInteger(item.sourceLine) || !Number.isInteger(item.assertionCount)) throw new Error(`matrix incomplete row ${item.id}`);
    if (!Array.isArray(item.runs) || item.runs.length !== 1) throw new Error(`matrix row run inventory mismatch ${item.id}`);
    if (!item.runs[0] || !['parse', 'logic', 'getData'].includes(item.runs[0].operation)) throw new Error(`matrix unknown operation ${item.id}`);
    return { id: item.id, group: item.group, sourceName: item.sourceName, sourceLine: item.sourceLine, assertionCount: item.assertionCount, runCount: item.runs.length };
  });
  const groupCounts = Object.fromEntries(Object.keys(EXPECTED.primaryGroups).map(group => [group, matrix.cases.filter(item => item.group === group).length]));
  if (canonical(groupCounts) !== canonical(EXPECTED.primaryGroups)) throw new Error('matrix primary group inventory mismatch');
  if (sha(JSON.stringify(inventory)) !== matrix.inventorySha256) throw new Error('matrix inventory self-hash mismatch');
  if (sha(JSON.stringify(matrix.cases)) !== matrix.caseMatrixSha256) throw new Error('matrix case self-hash mismatch');
  if (inventory.reduce((sum, item) => sum + item.assertionCount, 0) !== EXPECTED.primaryCounts.expandedAssertions) throw new Error('matrix assertion inventory mismatch');
}

function validateSupplementalMatrix() {
  const supplemental = matrix.supplemental;
  if (!supplemental || canonical(supplemental.counts) !== canonical({ ...EXPECTED.supplementalCounts, groups: EXPECTED.supplementalGroups })) throw new Error('matrix supplemental counts/group mismatch');
  if (!Array.isArray(supplemental.cases) || supplemental.cases.length !== EXPECTED.supplementalCounts.namedCases) throw new Error('matrix supplemental row count mismatch');
  const ids = new Set();
  supplemental.cases.forEach(item => {
    if (!item || typeof item.id !== 'string' || ids.has(item.id)) throw new Error(`matrix duplicate/malformed supplemental row ${item && item.id}`);
    ids.add(item.id);
    if (!item.group || !Number.isInteger(item.assertionCount) || item.assertionCount !== 0 || !Array.isArray(item.runs) || item.runs.length !== 1) throw new Error(`matrix incomplete supplemental row ${item.id}`);
    if (item.runs[0].operation !== 'logic') throw new Error(`matrix supplemental operation mismatch ${item.id}`);
  });
  if (JSON.stringify([...ids]) !== JSON.stringify(EXPECTED.supplementalIds)) throw new Error('matrix supplemental mode inventory mismatch');
  const groupCounts = Object.fromEntries(Object.keys(EXPECTED.supplementalGroups).map(group => [group, supplemental.cases.filter(item => item.group === group).length]));
  if (canonical(groupCounts) !== canonical(EXPECTED.supplementalGroups)) throw new Error('matrix supplemental group inventory mismatch');
  if (sha(JSON.stringify(supplemental)) !== matrix.supplementalMatrixSha256) throw new Error('matrix supplemental self-hash mismatch');
}

function parseArgs(argv) {
  const defaultReference = path.resolve(worktree, '../phoenix/.parity/reference/5c0a7390539663ba749d360de348a428c088505c');
  const args = {
    out: path.join(worktree, '.parity/runs/s11-commute'),
    reference: process.env.PHOENIX_S11_REFERENCE || defaultReference,
    matrix: defaultMatrixPath,
    sourceReceipt: null,
    candidateReceipt: null,
    candidateRevision: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') args.out = path.resolve(argv[++i]);
    else if (argv[i] === '--reference') args.reference = path.resolve(argv[++i]);
    else if (argv[i] === '--matrix') args.matrix = path.resolve(argv[++i]);
    else if (argv[i] === '--source-receipt') args.sourceReceipt = path.resolve(argv[++i]);
    else if (argv[i] === '--candidate-receipt') args.candidateReceipt = path.resolve(argv[++i]);
    else if (argv[i] === '--candidate-revision') args.candidateRevision = argv[++i];
    else if (argv[i] === '--help') {
      console.log('Usage: node compare.mjs [--reference PATH] [--matrix PATH] [--out DIR]');
      console.log('       node compare.mjs --source-receipt PATH --candidate-receipt PATH --candidate-revision REV [--out DIR]');
      process.exit(0);
    }
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if ((args.sourceReceipt === null) !== (args.candidateReceipt === null)) throw new Error('receipt check requires both --source-receipt and --candidate-receipt');
  if (args.candidateRevision !== null && args.candidateReceipt === null) throw new Error('--candidate-revision requires receipt check mode');
  return args;
}

function currentRevision(cwd = worktree) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`cannot determine candidate revision: ${result.stderr || result.status}`);
  const revision = result.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error(`invalid candidate revision: ${revision}`);
  return revision;
}

function candidateStatus(cwd = worktree) {
  const result = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('cannot determine candidate worktree status: ' + (result.stderr || result.status));
  return result.stdout.replace(/\s+$/, '');
}

function validateCandidateFiles() {
  const candidate = contract.candidate;
  const check = (files, hashes, label) => {
    if (!Array.isArray(files) || !hashes) throw new Error('contract omits candidate ' + label + ' provenance');
    files.forEach(file => {
      const absolute = path.join(worktree, file);
      if (!fs.existsSync(absolute) || fileSha(absolute) !== hashes[file]) throw new Error('candidate ' + label + ' changed: ' + file);
    });
  };
  check(candidate.paths, candidate.hashes, 'module');
  check(candidate.resourcePaths, candidate.resourceHashes, 'resource');
  check(candidate.dependencyPaths, candidate.dependencyHashes, 'dependency');
}

function validateCandidateWorktree(expectedRevision) {
  if (currentRevision() !== expectedRevision) throw new Error('candidate revision does not match receipt run');
  validateCandidateFiles();
  const allowedHarness = new Set([
    ...contract.harness.paths,
    'scripts/parity-s11-source-diff/compare.mjs',
    'scripts/parity-s11-source-diff/contract.json',
    'scripts/parity-s11-source-diff/make-matrix.mjs',
  ]);
  const dirty = candidateStatus().split('\n').filter(Boolean).filter(line => {
    const file = line.slice(3).replace(/^"|"$/g, '');
    return !allowedHarness.has(file);
  });
  if (dirty.length) throw new Error('candidate worktree is dirty outside the harness: ' + dirty.join(', '));
}

function validateReferenceFiles(referenceRoot) {
  const reference = contract.reference;
  const actual = file => fileSha(path.join(referenceRoot, file));
  if (actual('parity-compiled.json') !== reference.compiledRecordSha256) throw new Error('pinned compiled source record changed');
  const compiled = JSON.parse(fs.readFileSync(path.join(referenceRoot, 'parity-compiled.json'), 'utf8'));
  if (compiled.referenceRevision !== reference.revision) throw new Error('source revision differs from immutable contract');
  for (const [file, expected] of Object.entries(compiled.inputs || {})) {
    if (actual(file) !== expected) throw new Error('pinned source dependency changed: ' + file);
  }
  for (const [file, expected] of Object.entries(compiled.outputs || {})) {
    if (actual(file) !== expected) throw new Error('pinned compiled dependency changed: ' + file);
  }
  if (actual(reference.testPath) !== reference.testSha256) throw new Error('archived Commute test hash mismatch');
  if (actual(reference.testSupportPath) !== reference.testSupportSha256) throw new Error('archived TestUtils hash mismatch');
  for (const [file, expected] of Object.entries(reference.resourceHashes || {})) {
    if (actual(file) !== expected) throw new Error('pinned source resource changed: ' + file);
  }
}

function validateHarnessFiles() {
  for (const [file, expected] of Object.entries(contract.harness.hashes || {})) {
    if (fileSha(path.join(worktree, file)) !== expected) throw new Error('harness file changed: ' + file);
  }
}

function run(argv, cwd, logPath, env = {}) {
  const result = spawnSync(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  fs.writeFileSync(logPath, `${result.stdout || ''}${result.stderr || ''}`);
  return { argv, status: result.status, signal: result.signal, log: path.basename(logPath) };
}

function validateRows(receipt, side, specs, supplemental = false) {
  if (!Array.isArray(receipt)) throw new Error(`${side} ${supplemental ? 'supplemental ' : ''}cases missing`);
  if (receipt.length !== specs.length) throw new Error(`${side} ${supplemental ? 'supplemental ' : ''}case count mismatch`);
  const expected = new Map(specs.map(item => [item.id, item]));
  const seen = new Set();
  for (let index = 0; index < receipt.length; index += 1) {
    const item = receipt[index];
    if (!item || seen.has(item.id)) throw new Error(`${side} duplicate/malformed ${supplemental ? 'supplemental ' : ''}case ${item && item.id}`);
    seen.add(item.id);
    const spec = expected.get(item.id);
    if (!spec) throw new Error(`${side} unexpected ${supplemental ? 'supplemental ' : ''}case ${item.id}`);
    if (item.id !== specs[index].id) throw new Error(`${side} reordered ${supplemental ? 'supplemental ' : ''}case ${item.id}`);
    if (item.group !== spec.group || item.sourceName !== spec.sourceName || item.assertionCount !== spec.assertionCount || (!supplemental && item.sourceLine !== spec.sourceLine) || (supplemental && Object.prototype.hasOwnProperty.call(item, 'sourceLine'))) throw new Error(`${side} metadata mismatch ${item.id}`);
    if (!Array.isArray(item.runs) || item.runs.length !== spec.runs.length) throw new Error(`${side} run count mismatch ${item.id}`);
    const runSeen = new Set();
    item.runs.forEach((row, runIndex) => {
      if (!Number.isInteger(row.index) || row.index < 0 || row.index >= spec.runs.length) throw new Error(`${side} invalid run index ${item.id}/${row && row.index}`);
      if (runSeen.has(row.index)) throw new Error(`${side} duplicate run ${item.id}/${row.index}`);
      if (row.index !== runIndex) throw new Error(`${side} reordered run ${item.id}/${row.index}`);
      runSeen.add(row.index);
      if (typeof row.sha256 !== 'string' || !Object.prototype.hasOwnProperty.call(row, 'value')) throw new Error(`${side} incomplete run ${item.id}/${row.index}`);
      if (sha(canonical(row.value)) !== row.sha256) throw new Error(`${side} mutated row ${item.id}/${row.index}`);
    });
    for (let runIndex = 0; runIndex < spec.runs.length; runIndex += 1) if (!runSeen.has(runIndex)) throw new Error(`${side} missing run ${item.id}/${runIndex}`);
  }
  if (seen.size !== specs.length) throw new Error(`${side} missing ${supplemental ? 'supplemental ' : ''}case`);
}

function validateReceipt(receipt, side) {
  if (!receipt || receipt.result !== 'pass') throw new Error(`${side} receipt is not pass`);
  if (receipt.schema !== EXPECTED.receiptSchema) throw new Error(`${side} receipt schema mismatch`);
  if (!receipt.runtime || receipt.runtime.timezone !== matrix.runtime.timezone || receipt.runtime.clockISO !== matrix.runtime.clockISO || receipt.runtime.randomSeed !== matrix.runtime.randomSeed) throw new Error(`${side} deterministic controls mismatch`);
  if (side === 'source' && receipt.runtime.node !== 'v8.9.4') throw new Error('source runtime is not Node 8.9.4');
  if (canonical(receipt.counts) !== canonical(matrix.counts)) throw new Error(`${side} primary receipt counts mismatch`);
  validateRows(receipt.cases, side, matrix.cases);
  validateRows(receipt.supplemental && receipt.supplemental.cases, side, matrix.supplemental.cases, true);
  if (!receipt.supplemental || canonical(receipt.supplemental.counts) !== canonical(matrix.supplemental.counts)) throw new Error(`${side} supplemental receipt counts mismatch`);
  if (!receipt.runtime || receipt.runtime.timezone !== contract.runtime.timezone || receipt.runtime.clockISO !== contract.runtime.clockISO || receipt.runtime.randomSeed !== contract.runtime.randomSeed) throw new Error(side + ' runtime differs from immutable contract');
  if (side === 'source') {
    const reference = receipt.reference;
    if (!reference || reference.repo !== matrix.reference.repo || reference.revision !== matrix.reference.revision || reference.testPath !== matrix.reference.testPath || reference.testSha256 !== matrix.reference.testSha256 || reference.testSupportPath !== matrix.reference.testSupportPath || reference.testSupportSha256 !== matrix.reference.testSupportSha256 || reference.compiledRecordSha256 !== matrix.reference.compiledRecordSha256) throw new Error('source reference metadata mismatch');
    if (canonical(reference.sourcePaths) !== canonical(matrix.reference.sourcePaths) || canonical(reference.sourceHashes) !== canonical(matrix.reference.sourceHashes) || canonical(reference.compiledPaths) !== canonical(matrix.reference.compiledPaths) || canonical(reference.compiledHashes) !== canonical(matrix.reference.compiledHashes) || canonical(reference.resourceHashes) !== canonical(matrix.reference.resourceHashes)) throw new Error('source reference hash receipt mismatch');
    if (reference.matrixSha256 !== contract.matrixSha256 || reference.contractSha256 !== CONTRACT_SHA256) throw new Error('source run provenance mismatch');
    if (!reference.sourceDependencyHashes || !reference.compiledDependencyHashes) throw new Error('source dependency provenance missing');
    const compiled = JSON.parse(fs.readFileSync(path.join(args.reference, 'parity-compiled.json'), 'utf8'));
    if (canonical(reference.sourceDependencyHashes) !== canonical(compiled.inputs) || canonical(reference.compiledDependencyHashes) !== canonical(compiled.outputs)) throw new Error('source dependency receipt mismatch');
  } else {
    if (!receipt.candidate || receipt.candidate.revision !== expectedCandidateRevision) throw new Error('candidate revision provenance mismatch');
    if (canonical(receipt.candidate.moduleSha256) !== canonical(matrix.candidate.hashes) || canonical(receipt.candidate.resourceSha256) !== canonical(matrix.candidate.resourceHashes)) throw new Error('candidate source/resource provenance mismatch');
    if (canonical(receipt.candidate.dependencySha256) !== canonical(contract.candidate.dependencyHashes)
      || receipt.candidate.matrixSha256 !== contract.matrixSha256
      || receipt.candidate.contractSha256 !== CONTRACT_SHA256) throw new Error('candidate run provenance mismatch');
  }
}

const args = parseArgs(process.argv.slice(2));
matrixPath = args.matrix;
matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
fs.mkdirSync(args.out, { recursive: true });
const sourceOut = args.sourceReceipt || path.join(args.out, 'source.json');
const candidateOut = args.candidateReceipt || path.join(args.out, 'candidate.json');
const sourceLog = path.join(args.out, 'source.log');
const candidateLog = path.join(args.out, 'candidate.log');
const commands = [];
let fatal = null;
let expectedCandidateRevision = null;
try {
  expectContractFile();
  validateHarnessFiles();
  validateReferenceFiles(args.reference);
  validateContractMatrix();
  validatePrimaryMatrix();
  validateSupplementalMatrix();
} catch (error) { fatal = String(error && error.stack || error); }

if (!fatal) try {
  if (args.sourceReceipt) {
    if (!fs.existsSync(sourceOut) || !fs.existsSync(candidateOut)) throw new Error('receipt check input is missing');
    expectedCandidateRevision = args.candidateRevision || currentRevision();
    validateCandidateWorktree(expectedCandidateRevision);
    commands.push({
      mode: 'receipt-check',
      sourceReceipt: sourceOut,
      candidateReceipt: candidateOut,
      candidateRevision: expectedCandidateRevision,
    });
  } else {
    const image = `${matrix.runtime.sourceImage}@${matrix.runtime.sourceImageDigest}`;
    const imageID = spawnSync('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], { encoding: 'utf8' });
    if (imageID.status !== 0 || imageID.stdout.trim() !== matrix.runtime.sourceImageDigest) throw new Error(`pinned source image unavailable or changed: ${imageID.stdout.trim()}`);
    const sourceArgv = [
      'docker', 'run', '--rm', '--network', 'none',
      '--mount', `type=bind,source=${args.reference},target=/ref,readonly`,
      '--mount', `type=bind,source=${here},target=/harness,readonly`,
      '--mount', `type=bind,source=${matrixPath},target=/matrix.json,readonly`,
      '--mount', `type=bind,source=${args.out},target=/out`,
      '-e', `TZ=${matrix.runtime.timezone}`,
      image, 'node', '/harness/run-source.cjs', '/ref', '/matrix.json', '/out/source.json',
    ];
    const sourceRun = run(sourceArgv, worktree, sourceLog);
    commands.push({ side: 'source', ...sourceRun });
    if (sourceRun.status !== 0) throw new Error(`source runner failed (see ${sourceLog})`);
    const revision = currentRevision();
    expectedCandidateRevision = revision;
    validateCandidateWorktree(expectedCandidateRevision);
    const candidateArgv = ['node', path.join(here, 'run-candidate.mjs'), matrixPath, candidateOut];
    const candidateRun = run(candidateArgv, worktree, candidateLog, { PHOENIX_S11_REVISION: revision, PHOENIX_S11_EXPECTED_REVISION: revision });
    commands.push({ side: 'candidate', ...candidateRun });
    if (candidateRun.status !== 0) throw new Error(`candidate runner failed (see ${candidateLog})`);
  }
} catch (error) { fatal = String(error && error.stack || error); }

let source;
let candidate;
const differences = [];
if (!fatal) try {
  source = JSON.parse(fs.readFileSync(sourceOut, 'utf8'));
  candidate = JSON.parse(fs.readFileSync(candidateOut, 'utf8'));
  validateReceipt(source, 'source');
  validateReceipt(candidate, 'candidate');
  const compareCases = (sourceRows, candidateRows, specs, lane) => {
    const sourceById = new Map(sourceRows.map(item => [item.id, item]));
    const candidateById = new Map(candidateRows.map(item => [item.id, item]));
    for (const spec of specs) {
      const a = sourceById.get(spec.id); const b = candidateById.get(spec.id);
      for (let index = 0; index < spec.runs.length; index += 1) {
        const ar = a.runs[index]; const br = b.runs[index];
        if (ar.index !== br.index) differences.push({ lane, id: spec.id, run: index, kind: 'run-index', source: ar.index, candidate: br.index });
        else if (ar.sha256 !== br.sha256) differences.push({ lane, id: spec.id, run: index, kind: 'value', sourceSha256: ar.sha256, candidateSha256: br.sha256, firstDifference: firstDifference(stable(ar.value), stable(br.value)) });
      }
    }
  };
  compareCases(source.cases, candidate.cases, matrix.cases, 'archived');
  compareCases(source.supplemental.cases, candidate.supplemental.cases, matrix.supplemental.cases, 'supplemental');
} catch (error) { fatal = String(error && error.stack || error); }

const primaryGroups = Object.fromEntries(Object.keys(matrix.counts.groups).map(group => [group, matrix.cases.filter(item => item.group === group).length]));
const supplementalGroups = Object.fromEntries(Object.keys(matrix.supplemental.counts.groups).map(group => [group, matrix.supplemental.cases.filter(item => item.group === group).length]));
const report = {
  schema: EXPECTED.differentialSchema,
  result: fatal ? 'fail' : (differences.length ? 'diff' : 'pass'),
  task: matrix.task,
  base: matrix.base,
  branch: matrix.branch,
  contract: {
    sha256: CONTRACT_SHA256,
    matrixSha256: contract.matrixSha256,
    primaryCasesSha256: contract.matrix.primaryCasesSha256,
    supplementalCasesSha256: contract.matrix.supplementalCasesSha256,
  },
  reference: { ...matrix.reference, sourceImage: matrix.runtime.sourceImage, sourceImageDigest: matrix.runtime.sourceImageDigest, path: args.reference },
  candidate: { worktree, revision: candidate && candidate.candidate && candidate.candidate.revision },
  coverage: {
    archived: { namedCases: matrix.counts.namedCases, expandedRuns: matrix.counts.expandedRuns, expandedAssertions: matrix.counts.expandedAssertions, groups: primaryGroups, source: source && source.counts, candidate: candidate && candidate.counts },
    supplemental: { ...matrix.supplemental.counts, groups: supplementalGroups, source: source && source.supplemental && source.supplemental.counts, candidate: candidate && candidate.supplemental && candidate.supplemental.counts, description: matrix.supplemental.coverage },
  },
  commands,
  receipts: source && candidate ? { sourceSha256: fileSha(sourceOut), candidateSha256: fileSha(candidateOut) } : null,
  differences,
  fatal,
};
fs.writeFileSync(path.join(args.out, 'comparison.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ result: report.result, archivedCases: report.coverage.archived.namedCases, archivedRuns: report.coverage.archived.expandedRuns, supplementalRuns: report.coverage.supplemental.expandedRuns, differences: differences.length, out: args.out }));
if (report.result !== 'pass') process.exitCode = 1;
