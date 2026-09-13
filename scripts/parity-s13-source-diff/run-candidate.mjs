#!/usr/bin/env node

// Run the current Phoenix report-view helpers in the digest-pinned candidate
// runtime.  It deliberately receives no source output or golden file.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const protocol = createRequire(import.meta.url)('./protocol.cjs');

const candidateRoot = path.resolve(process.argv[2]);
const matrixPath = path.resolve(process.argv[3]);
const outputPath = path.resolve(process.argv[4]);
const contractPath = path.resolve(process.argv[5]);

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const fileSha = file => protocol.sha(fs.readFileSync(file));
const fail = message => { throw new Error(message); };
const requireMap = (map, label) => Object.entries(map || {}).sort(([a], [b]) => a.localeCompare(b)).forEach(([relative, expected]) => {
  const file = path.join(candidateRoot, relative);
  if (!fs.existsSync(file)) fail(`missing candidate ${label}: ${relative}`);
  const actual = fileSha(file);
  if (actual !== expected) fail(`candidate ${label} changed: ${relative}`);
});

function checkMatrix(matrix, contract) {
  if (fileSha(matrixPath) !== contract.matrixSha256) fail('matrix is not the pinned S-13 matrix');
  if (!contract || contract.schema !== 'phoenix.parity.s13.report-view-contract.v1') fail('contract schema mismatch');
  if (process.env.PHOENIX_S13_CONTRACT_SHA256 !== fileSha(contractPath)) fail('contract digest environment pin mismatch');
  if (matrix.schema !== 'phoenix.parity.s13.report-view-matrix.v1' || matrix.rows.length !== 61) fail('matrix schema/row count mismatch');
  if (JSON.stringify(matrix.counts.groups) !== JSON.stringify({ weather: 20, traffic: 7, depart: 4, news: 5, calendar: 25 })) fail('matrix group counts mismatch');
}

function checkCandidate(matrix, contract) {
  if (!matrix.candidate || matrix.candidate.implementationRevision !== contract.candidate.implementationRevision) fail('candidate implementation revision pin mismatch');
  requireMap(matrix.candidate.paths, 'module');
  requireMap(matrix.candidate.resources, 'resource');
  requireMap(matrix.candidate.dependencies, 'dependency');
}

function freezeClock(matrix) {
  process.env.TZ = matrix.runtime.timezone;
  const RealDate = Date;
  const fixedNow = RealDate.parse(matrix.runtime.clockISO);
  globalThis.Date = class FixtureDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [fixedNow])); }
    static now() { return fixedNow; }
  };
  let randomState = matrix.runtime.randomSeed >>> 0;
  Math.random = () => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState / 0x100000000;
  };
}

async function loadFunctions() {
  const weather = await import(pathToFileURL(path.join(candidateRoot, 'packages/skills/src/report/weatherViews.js')).href);
  const news = await import(pathToFileURL(path.join(candidateRoot, 'packages/skills/src/report/newsViews.js')).href);
  const commute = await import(pathToFileURL(path.join(candidateRoot, 'packages/skills/src/report/commuteViews.js')).href);
  const calendar = await import(pathToFileURL(path.join(candidateRoot, 'packages/skills/src/report/calendarViews.js')).href);
  return { weather: weather.hiLoTempView, news: news.newsViews, traffic: commute.trafficView, depart: commute.departView, calendar: calendar.calEventViews };
}

async function runRows(matrix, functions) {
  const rows = [];
  for (const spec of matrix.rows) {
    const outcome = await protocol.capture(() => functions[spec.kind](...protocol.argumentsFor(spec)));
    rows.push({
      id: spec.id,
      group: spec.group,
      sourceName: spec.sourceName,
      sourceLine: spec.sourceLine,
      kind: spec.kind,
      assertionCount: spec.assertionCount,
      specSha256: protocol.rowHash(spec),
      runs: [{ index: 0, sha256: protocol.rowHash(outcome), outcome }],
    });
  }
  if (rows.length !== matrix.counts.namedCases) fail(`row count mismatch: ${rows.length}`);
  return rows;
}

async function main() {
  const matrix = readJson(matrixPath);
  const contract = readJson(contractPath);
  checkMatrix(matrix, contract);
  checkCandidate(matrix, contract);
  const testedRevision = process.env.PHOENIX_S13_TESTED_REVISION;
  if (!/^[0-9a-f]{40}$/.test(testedRevision || '')) fail(`candidate tested revision malformed: ${testedRevision || '<missing>'}`);
  if (process.version !== matrix.runtime.candidate.node) fail(`candidate runtime mismatch: ${process.version}`);
  freezeClock(matrix);
  const started = Date.now();
  const functions = await loadFunctions();
  const rows = await runRows(matrix, functions);
  const receipt = {
    schema: 'phoenix.parity.s13.report-view-receipt.v1',
    result: 'pass',
    runtime: {
      node: process.version,
      platform: process.platform,
      timezone: process.env.TZ,
      clockISO: matrix.runtime.clockISO,
      randomSeed: matrix.runtime.randomSeed,
      network: matrix.runtime.network,
      image: matrix.runtime.candidate.image,
      imageDigest: matrix.runtime.candidate.imageDigest,
    },
    candidate: {
      implementationRevision: matrix.candidate.implementationRevision,
      testedRevision,
      modules: matrix.candidate.paths,
      moduleSha256: matrix.candidate.paths,
      resources: matrix.candidate.resources,
      resourceSha256: matrix.candidate.resources,
      dependencies: matrix.candidate.dependencies,
      dependencySha256: matrix.candidate.dependencies,
      matrixSha256: fileSha(matrixPath),
      contractSha256: fileSha(contractPath),
    },
    counts: matrix.counts,
    elapsedMs: Date.now() - started,
    rows,
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ result: 'pass', rows: rows.length, fulfilled: rows.filter(row => row.runs[0].outcome.status === 'fulfilled').length, rejected: rows.filter(row => row.runs[0].outcome.status === 'rejected').length, out: outputPath })}\n`);
}

main().catch(error => {
  const failure = { schema: 'phoenix.parity.s13.report-view-receipt.v1', result: 'fail', runtime: { node: process.version }, error: { name: error.name || 'Error', message: String(error.message || error) } };
  try { fs.mkdirSync(path.dirname(outputPath), { recursive: true }); fs.writeFileSync(outputPath, `${JSON.stringify(failure, null, 2)}\n`); } catch (_) {}
  process.stderr.write(`${failure.error.name}: ${failure.error.message}\n`);
  process.exitCode = 1;
});
