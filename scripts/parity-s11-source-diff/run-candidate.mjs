#!/usr/bin/env node

// Candidate-side companion to run-source.cjs. It imports the current Phoenix
// Commute implementation and records the same parsed state, ordered MIMs, and
// complete view JSON under the same deterministic clock.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const matrixPath = path.resolve(process.argv[2]);
const outPath = path.resolve(process.argv[3]);
const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
const fixture = createRequire(import.meta.url)(path.join(here, 'fixtures.cjs'));

function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function fileSha(file) { return sha(fs.readFileSync(file)); }
function canonical(value) { return JSON.stringify(fixture.stable(value)); }
function rowHash(value) { return sha(canonical(value)); }
function fail(message) { throw new Error(message); }

if (!matrix.candidate || !Array.isArray(matrix.candidate.paths)) fail('matrix omits candidate provenance');
matrix.candidate.paths.forEach(file => {
  const actual = fileSha(path.join(root, file));
  if (!matrix.candidate.hashes || matrix.candidate.hashes[file] !== actual) fail(`candidate source changed: ${file}`);
});
(matrix.candidate.resourcePaths || []).forEach(file => {
  const actual = fileSha(path.join(root, file));
  if (!matrix.candidate.resourceHashes || matrix.candidate.resourceHashes[file] !== actual) fail(`candidate resource changed: ${file}`);
});
if (!Array.isArray(matrix.candidate.dependencyPaths) || !matrix.candidate.dependencyHashes) fail('matrix omits candidate dependency provenance');
matrix.candidate.dependencyPaths.forEach(file => {
  const actual = fileSha(path.join(root, file));
  if (matrix.candidate.dependencyHashes[file] !== actual) fail('candidate dependency changed: ' + file);
});

process.env.TZ = matrix.runtime.timezone;
const RealDate = Date;
const fixedNow = RealDate.parse(matrix.runtime.clockISO);
globalThis.Date = class FixtureDate extends RealDate {
  constructor(...args) { super(...(args.length ? args : [fixedNow])); }
  static now() { return fixedNow; }
};
let randomState = matrix.runtime.randomSeed >>> 0;
Math.random = function seededRandom() {
  randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
  return randomState / 0x100000000;
};
const started = Date.now();

const commute = await import(pathToFileURL(path.join(root, 'packages/skills/src/report/commute.js')).href);
const calendar = await import(pathToFileURL(path.join(root, 'packages/skills/src/report/calendar.js')).href);

async function parseForRun(item) {
  const cal = calendar.calendarParse(item.rawCalendar, item.data);
  if (item.run.directLocalData) {
    const value = await commute.commuteParse(item.rawCommute, item.localISO, item.prefs);
    return fixture.projectCommute(value);
  }
  const value = await commute.commuteParse(item.rawCommute, item.localISO, {
    userPrefs: item.prefs,
    calendar: cal,
  });
  return fixture.projectCommute(value);
}

async function logicForRun(item) {
  const cal = calendar.calendarParse(item.rawCalendar, item.data);
  const parsed = await commute.commuteParse(item.rawCommute, item.localISO, {
    userPrefs: item.prefs,
    calendar: cal,
  });
  item.data.local.commute = parsed;
  await new commute.CommuteMimLogic().exit(item.data);
  return fixture.projectLocal(item.data.local, {
    candidateMimRoot: path.join(root, 'packages/skills/resources/mims/report/en-us'),
  });
}

async function execute(run) {
  const materialized = fixture.materialize(run);
  materialized.run = run;
  if (run.operation === 'getData') return commute.getData({ commute: materialized.prefs.commute }, materialized.data);
  if (run.operation === 'parse') return parseForRun(materialized);
  if (run.operation === 'logic') return logicForRun(materialized);
  fail(`unknown operation: ${run.operation}`);
}

function runSpecs(specs) {
  return (async () => {
    const results = [];
    let expandedRuns = 0;
    for (const spec of specs) {
      const result = {
        id: spec.id,
        group: spec.group,
        sourceName: spec.sourceName,
        ...(spec.sourceLine === undefined ? {} : { sourceLine: spec.sourceLine }),
        assertionCount: spec.assertionCount,
        runs: [],
      };
      for (let index = 0; index < spec.runs.length; index += 1) {
        const value = fixture.encode(await execute(spec.runs[index]));
        result.runs.push({ index, sha256: rowHash(value), value });
        expandedRuns += 1;
      }
      results.push(result);
    }
    return { results, expandedRuns };
  })();
}

const primary = await runSpecs(matrix.cases);
if (primary.results.length !== matrix.counts.namedCases) fail(`case count mismatch: ${primary.results.length}`);
if (primary.expandedRuns !== matrix.counts.expandedRuns) fail(`expanded run count mismatch: ${primary.expandedRuns}`);
const supplementalSpec = matrix.supplemental || { cases: [], counts: { namedCases: 0, expandedRuns: 0, expandedAssertions: 0, groups: {} } };
const supplemental = await runSpecs(supplementalSpec.cases || []);
if (supplemental.results.length !== supplementalSpec.counts.namedCases) fail(`supplemental case count mismatch: ${supplemental.results.length}`);
if (supplemental.expandedRuns !== supplementalSpec.counts.expandedRuns) fail(`supplemental run count mismatch: ${supplemental.expandedRuns}`);

const receipt = {
  schema: 'phoenix.parity.s11.commute-receipt.v1',
  result: 'pass',
  runtime: {
    node: process.version,
    platform: process.platform,
    timezone: process.env.TZ,
    clockISO: matrix.runtime.clockISO,
    randomSeed: matrix.runtime.randomSeed,
  },
  candidate: {
    revision: process.env.PHOENIX_S11_REVISION || 'worktree',
    moduleSha256: Object.fromEntries(matrix.candidate.paths.map(file => [file, fileSha(path.join(root, file))])),
    resourceSha256: Object.fromEntries((matrix.candidate.resourcePaths || []).map(file => [file, fileSha(path.join(root, file))])),
    dependencySha256: Object.fromEntries(matrix.candidate.dependencyPaths.map(file => [file, fileSha(path.join(root, file))])),
    matrixSha256: fileSha(matrixPath),
    contractSha256: fileSha(path.join(here, 'contract.json')),
  },
  counts: {
    namedCases: primary.results.length,
    expandedRuns: primary.expandedRuns,
    expandedAssertions: matrix.counts.expandedAssertions,
    groups: matrix.counts.groups,
  },
  elapsedMs: Date.now() - started,
  cases: primary.results,
  supplemental: {
    counts: supplementalSpec.counts,
    cases: supplemental.results,
  },
};
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ result: receipt.result, namedCases: primary.results.length, expandedRuns: primary.expandedRuns, expandedAssertions: matrix.counts.expandedAssertions, supplementalRuns: supplemental.expandedRuns, out: outPath })}\n`);
