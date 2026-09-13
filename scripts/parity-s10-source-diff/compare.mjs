#!/usr/bin/env node

// Reproducible, fail-closed S-10 differential. Every matrix row and expanded
// run must exist on both sides, carry a valid self-hash, and have identical
// projected parsed news, MIM order, headline selection, image metadata, and
// complete view JSON.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const worktree = path.resolve(here, '../..');
const matrixPath = path.join(here, 'matrix.json');
const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));

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
  return text && text.length > 240 ? `${text.slice(0, 237)}...` : value;
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
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const key of keys) { const d = firstDifference(a[key], b[key], `${at}.${key}`); if (d) return d; }
  }
  return { path: at, source: display(a), candidate: display(b) };
}
const EXPECTED = {
  schema: 'phoenix.parity.s10.news-matrix.v1',
  task: 'S-10',
  base: '575813db688cb0138e7ec73555a6245d5be4c9d1',
  branch: 'w-s10-source-diff',
  counts: { namedCases: 22, expandedRuns: 22, expandedAssertions: 60, fixtureProbes: 2 },
  groups: { 'top-level': 7, filtering: 7, views: 8 },
  inventorySha256: '15a144f31da0db79585aff975be71b6f0dce75cd2b27f5c4157cc072d26a0ab2',
  caseMatrixSha256: '56bf6f16aa1eb8b3f6315b4049c6c76bb1b097d4005f35e15a005bce53783337',
  fixtureMatrixSha256: 'bbcb93feb7f0f8663ad43490e7a82fc1fe696b3ffa2b469ce6f49ae5d3edbebe',
  apFixtures: [
    { id: 's10:ap-fixture:01', exportName: 'apNewsXMLResponse', category: 'entertainment', sourceID: 42201, sourceEntryCount: 11, localISO: '2018-01-01T12:00:00.000Z' },
    { id: 's10:ap-fixture:02', exportName: 'apNewsXMLResponseTwo', category: 'entertainment', sourceID: 42201, sourceEntryCount: 1, localISO: '2018-01-01T12:00:00.000Z' },
  ],
};
function validateMatrix() {
  if (matrix.schema !== EXPECTED.schema || matrix.task !== EXPECTED.task) throw new Error('matrix schema/task mismatch');
  if (!matrix.counts || Object.keys(EXPECTED.counts).some(key => matrix.counts[key] !== EXPECTED.counts[key])) throw new Error('matrix counts mismatch');
  if (canonical(matrix.counts.groups) !== canonical(EXPECTED.groups)) throw new Error('matrix group counts mismatch');
  if (!Array.isArray(matrix.cases) || matrix.cases.length !== EXPECTED.counts.namedCases) throw new Error('matrix named row count mismatch');
  const ids = new Set();
  const inventory = matrix.cases.map(item => {
    if (!item || ids.has(item.id)) throw new Error(`matrix duplicate row ${item && item.id}`);
    ids.add(item.id);
    if (!item.group || !item.sourceName || !Number.isInteger(item.sourceLine) || !Number.isInteger(item.assertionCount)) throw new Error(`matrix incomplete row ${item && item.id}`);
    if (!Array.isArray(item.runs) || !item.runs.length) throw new Error(`matrix row has no runs ${item.id}`);
    return { id: item.id, group: item.group, sourceName: item.sourceName, sourceLine: item.sourceLine, assertionCount: item.assertionCount, runCount: item.runs.length };
  });
  const groupCounts = Object.fromEntries(Object.keys(EXPECTED.groups).map(group => [group, matrix.cases.filter(item => item.group === group).length]));
  if (canonical(groupCounts) !== canonical(EXPECTED.groups)) throw new Error('matrix rows do not match group inventory');
  if (sha(JSON.stringify(inventory)) !== EXPECTED.inventorySha256 || matrix.inventorySha256 !== EXPECTED.inventorySha256) throw new Error('matrix source row inventory hash mismatch');
  if (sha(JSON.stringify(matrix.cases)) !== EXPECTED.caseMatrixSha256 || matrix.caseMatrixSha256 !== EXPECTED.caseMatrixSha256) throw new Error('matrix source row control hash mismatch');
  if (inventory.reduce((sum, item) => sum + item.assertionCount, 0) !== EXPECTED.counts.expandedAssertions) throw new Error('matrix assertion inventory mismatch');
  if (canonical(matrix.apFixtures) !== canonical(EXPECTED.apFixtures) || matrix.fixtureMatrixSha256 !== EXPECTED.fixtureMatrixSha256 || sha(JSON.stringify(matrix.apFixtures)) !== EXPECTED.fixtureMatrixSha256) throw new Error('matrix AP fixture inventory mismatch');
  if (!matrix.reference || !matrix.reference.fixtureSource || matrix.reference.fixtureSource.exports.join('|') !== 'apNewsXMLResponse|apNewsXMLResponseTwo') throw new Error('matrix AP fixture provenance missing');
}
function parseArgs(argv) {
  const defaults = path.resolve(worktree, '../phoenix/.parity/reference/5c0a7390539663ba749d360de348a428c088505c');
  const args = { out: path.join(worktree, '.parity/runs/s10-news'), reference: process.env.PHOENIX_S10_REFERENCE || defaults };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') args.out = path.resolve(argv[++i]);
    else if (argv[i] === '--reference') args.reference = path.resolve(argv[++i]);
    else if (argv[i] === '--help') { console.log('Usage: node compare.mjs [--reference PATH] [--out DIR]'); process.exit(0); }
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}
function run(argv, cwd, logPath, env = {}) {
  const result = spawnSync(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  fs.writeFileSync(logPath, `${result.stdout || ''}${result.stderr || ''}`);
  return { argv, status: result.status, signal: result.signal, log: path.basename(logPath) };
}
function validateReceipt(receipt, side) {
  if (!receipt || receipt.result !== 'pass') throw new Error(`${side} receipt is not pass`);
  if (receipt.schema !== 'phoenix.parity.s10.news-receipt.v1') throw new Error(`${side} receipt schema mismatch`);
  if (!receipt.runtime || receipt.runtime.timezone !== matrix.runtime.timezone || receipt.runtime.clockISO !== matrix.runtime.clockISO) throw new Error(`${side} deterministic clock/timezone mismatch`);
  if (side === 'source' && receipt.runtime.node !== 'v8.9.4') throw new Error('source runtime is not Node 8.9.4');
  if (!receipt.counts || receipt.counts.namedCases !== matrix.counts.namedCases || receipt.counts.expandedRuns !== matrix.counts.expandedRuns || receipt.counts.expandedAssertions !== matrix.counts.expandedAssertions || receipt.counts.fixtureProbes !== matrix.counts.fixtureProbes) throw new Error(`${side} receipt count metadata mismatch`);
  if (!Array.isArray(receipt.cases) || receipt.cases.length !== matrix.counts.namedCases) throw new Error(`${side} named case count mismatch`);
  const expected = new Map(matrix.cases.map(item => [item.id, item]));
  const seen = new Set();
  let runs = 0;
  for (const item of receipt.cases) {
    if (seen.has(item.id)) throw new Error(`${side} duplicate case ${item.id}`);
    seen.add(item.id);
    const spec = expected.get(item.id);
    if (!spec) throw new Error(`${side} unexpected case ${item.id}`);
    if (item.group !== spec.group || item.sourceName !== spec.sourceName || item.sourceLine !== spec.sourceLine || item.assertionCount !== spec.assertionCount) throw new Error(`${side} metadata mismatch ${item.id}`);
    if (!Array.isArray(item.runs) || item.runs.length !== spec.runs.length) throw new Error(`${side} run count mismatch ${item.id}`);
    const runSeen = new Set();
    for (const row of item.runs) {
      if (!Number.isInteger(row.index) || row.index < 0 || row.index >= spec.runs.length) throw new Error(`${side} invalid run index ${item.id}/${row.index}`);
      if (runSeen.has(row.index)) throw new Error(`${side} duplicate run ${item.id}/${row.index}`);
      runSeen.add(row.index);
      if (!Object.prototype.hasOwnProperty.call(row, 'value') || typeof row.sha256 !== 'string') throw new Error(`${side} incomplete run ${item.id}/${row.index}`);
      const actual = sha(canonical(row.value));
      if (actual !== row.sha256) throw new Error(`${side} mutated row hash ${item.id}/${row.index}`);
      runs += 1;
    }
    for (let index = 0; index < spec.runs.length; index += 1) if (!runSeen.has(index)) throw new Error(`${side} missing run ${item.id}/${index}`);
  }
  for (const item of matrix.cases) if (!seen.has(item.id)) throw new Error(`${side} missing case ${item.id}`);
  if (runs !== matrix.counts.expandedRuns) throw new Error(`${side} expanded run count mismatch: ${runs}`);

  if (!Array.isArray(receipt.fixtures) || receipt.fixtures.length !== matrix.counts.fixtureProbes) throw new Error(`${side} AP fixture count mismatch`);
  const expectedFixtures = new Map(matrix.apFixtures.map(item => [item.id, item]));
  const fixtureSeen = new Set();
  for (const item of receipt.fixtures) {
    if (fixtureSeen.has(item.id)) throw new Error(`${side} duplicate AP fixture ${item.id}`);
    fixtureSeen.add(item.id);
    const spec = expectedFixtures.get(item.id);
    if (!spec || item.exportName !== spec.exportName || item.sourceEntryCount !== spec.sourceEntryCount) throw new Error(`${side} AP fixture metadata mismatch ${item.id}`);
    if (!Array.isArray(item.runs) || item.runs.length !== 1) throw new Error(`${side} AP fixture run count mismatch ${item.id}`);
    const row = item.runs[0];
    if (row.index !== 0 || typeof row.sha256 !== 'string' || !Object.prototype.hasOwnProperty.call(row, 'value')) throw new Error(`${side} incomplete AP fixture ${item.id}`);
    if (sha(canonical(row.value)) !== row.sha256) throw new Error(`${side} mutated AP fixture ${item.id}`);
  }
  for (const spec of matrix.apFixtures) if (!fixtureSeen.has(spec.id)) throw new Error(`${side} missing AP fixture ${spec.id}`);

  if (side === 'source') {
    const reference = receipt.reference;
    if (!reference || reference.repo !== matrix.reference.repo || reference.revision !== matrix.reference.revision || reference.testPath !== matrix.reference.testPath || reference.testSha256 !== matrix.reference.testSha256 || reference.testSupportPath !== matrix.reference.testSupportPath || reference.testSupportSha256 !== matrix.reference.testSupportSha256 || reference.compiledRecordSha256 !== matrix.reference.compiledRecordSha256) throw new Error('source reference metadata mismatch');
    if (canonical(reference.sourceHashes) !== canonical(matrix.reference.sourceHashes) || canonical(reference.compiledHashes) !== canonical(matrix.reference.compiledHashes) || canonical(reference.resourceHashes) !== canonical(matrix.reference.resourceHashes)) throw new Error('source reference file hash receipt mismatch');
    if (canonical(reference.fixtureSource) !== canonical(matrix.reference.fixtureSource)) throw new Error('source AP fixture hash receipt mismatch');
  } else {
    if (!receipt.candidate || !receipt.candidate.moduleSha256 || !receipt.candidate.resourceSha256 || receipt.candidate.fixtureArtifactSha256 !== matrix.reference.fixtureSource.artifactSha256) throw new Error('candidate provenance receipt incomplete');
    const expectedViewSha = matrix.reference.resourceHashes['packages/report-skill/resources/views/newsHeadline.json'];
    if (!expectedViewSha || receipt.candidate.resourceSha256['packages/skills/resources/views/newsHeadline.json'] !== expectedViewSha) throw new Error('candidate view resource hash mismatch');
  }
}

const args = parseArgs(process.argv.slice(2));
fs.mkdirSync(args.out, { recursive: true });
const sourceOut = path.join(args.out, 'source.json');
const candidateOut = path.join(args.out, 'candidate.json');
const sourceLog = path.join(args.out, 'source.log');
const candidateLog = path.join(args.out, 'candidate.log');
const commands = [];
let fatal = null;

try { validateMatrix(); } catch (error) { fatal = String(error && error.stack || error); }

if (!fatal) try {
  const image = `${matrix.runtime.sourceImage}@${matrix.runtime.sourceImageDigest}`;
  const imageID = spawnSync('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], { encoding: 'utf8' });
  if (imageID.status !== 0 || imageID.stdout.trim() !== matrix.runtime.sourceImageDigest) throw new Error(`pinned source image unavailable or changed: ${imageID.stdout.trim()}`);
  const sourceArgv = [
    'docker', 'run', '--rm', '--network', 'none',
    '--mount', `type=bind,source=${args.reference},target=/ref,readonly`,
    '--mount', `type=bind,source=${here},target=/harness,readonly`,
    '--mount', `type=bind,source=${matrixPath},target=/matrix.json,readonly`,
    '--mount', `type=bind,source=${args.out},target=/out`,
    image, 'node', '/harness/run-source.cjs', '/ref', '/matrix.json', '/out/source.json',
  ];
  const sourceRun = run(sourceArgv, worktree, sourceLog);
  commands.push({ side: 'source', ...sourceRun });
  if (sourceRun.status !== 0) throw new Error(`source runner failed (see ${sourceLog})`);

  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).stdout.trim();
  const candidateArgv = ['node', path.join(here, 'run-candidate.mjs'), matrixPath, candidateOut];
  const candidateRun = run(candidateArgv, worktree, candidateLog, {
    PHOENIX_S10_REVISION: revision,
    ...(process.env.PHOENIX_S10_NEWS_MODULE ? { PHOENIX_S10_NEWS_MODULE: process.env.PHOENIX_S10_NEWS_MODULE } : {}),
  });
  commands.push({ side: 'candidate', ...candidateRun });
  if (candidateRun.status !== 0) throw new Error(`candidate runner failed (see ${candidateLog})`);
} catch (error) {
  fatal = String(error && error.stack || error);
}

let source;
let candidate;
const differences = [];
if (!fatal) {
  try {
    source = JSON.parse(fs.readFileSync(sourceOut, 'utf8'));
    candidate = JSON.parse(fs.readFileSync(candidateOut, 'utf8'));
    validateReceipt(source, 'source');
    validateReceipt(candidate, 'candidate');
    const sourceById = new Map(source.cases.map(item => [item.id, item]));
    const candidateById = new Map(candidate.cases.map(item => [item.id, item]));
    for (const spec of matrix.cases) {
      const a = sourceById.get(spec.id); const b = candidateById.get(spec.id);
      for (let i = 0; i < spec.runs.length; i += 1) {
        const ar = a.runs[i]; const br = b.runs[i];
        if (ar.index !== br.index) differences.push({ id: spec.id, run: i, kind: 'run-index', source: ar.index, candidate: br.index });
        else if (ar.sha256 !== br.sha256) differences.push({ id: spec.id, run: i, kind: 'value', sourceSha256: ar.sha256, candidateSha256: br.sha256, firstDifference: firstDifference(stable(ar.value), stable(br.value)) });
      }
    }
    const sourceFixturesById = new Map(source.fixtures.map(item => [item.id, item]));
    const candidateFixturesById = new Map(candidate.fixtures.map(item => [item.id, item]));
    for (const spec of matrix.apFixtures) {
      const a = sourceFixturesById.get(spec.id); const b = candidateFixturesById.get(spec.id);
      const ar = a.runs[0]; const br = b.runs[0];
      if (ar.index !== br.index) differences.push({ id: spec.id, run: 0, kind: 'run-index', source: ar.index, candidate: br.index });
      else if (ar.sha256 !== br.sha256) differences.push({ id: spec.id, run: 0, kind: 'value', sourceSha256: ar.sha256, candidateSha256: br.sha256, firstDifference: firstDifference(stable(ar.value), stable(br.value)) });
    }
  } catch (error) { fatal = String(error && error.stack || error); }
}

const groupCounts = Object.fromEntries(Object.keys(matrix.counts.groups).map(group => [group, matrix.cases.filter(item => item.group === group).length]));
const report = {
  schema: 'phoenix.parity.s10.news-differential.v1',
  result: fatal ? 'fail' : (differences.length ? 'diff' : 'pass'),
  task: matrix.task,
  base: EXPECTED.base,
  branch: EXPECTED.branch,
  reference: { ...matrix.reference, sourceImage: matrix.runtime.sourceImage, sourceImageDigest: matrix.runtime.sourceImageDigest, path: args.reference },
  candidate: { worktree, revision: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).stdout.trim() },
  coverage: { namedCases: matrix.counts.namedCases, expandedRuns: matrix.counts.expandedRuns, expandedAssertions: matrix.counts.expandedAssertions, fixtureProbes: matrix.counts.fixtureProbes, groups: groupCounts, source: source && source.counts, candidate: candidate && candidate.counts },
  commands,
  receipts: source && candidate ? { sourceSha256: fileSha(sourceOut), candidateSha256: fileSha(candidateOut) } : null,
  differences,
  fatal,
};
fs.writeFileSync(path.join(args.out, 'comparison.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ result: report.result, namedCases: report.coverage.namedCases, expandedRuns: report.coverage.expandedRuns, differences: differences.length, out: args.out }));
if (report.result !== 'pass') process.exitCode = 1;
