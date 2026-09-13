#!/usr/bin/env node

// Candidate-side companion to run-source.cjs. It imports Phoenix's current
// News implementation and records the same parsed news, ordered MIMs, image
// views, and deterministic identity/time observables.

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
const fixtureSource = matrix.reference.fixtureSource;
if (!fixtureSource) throw new Error('matrix omits APNewsTestData fixture source record');
const fixtureArtifactPath = path.join(here, 'ap-fixtures.json');
if (!fs.existsSync(fixtureArtifactPath)) throw new Error(`missing APNewsTestData projection artifact: ${fixtureArtifactPath}`);
if (sourceHash(fixtureArtifactPath) !== fixtureSource.artifactSha256) throw new Error('APNewsTestData projection artifact changed');
const fixtureArtifact = JSON.parse(fs.readFileSync(fixtureArtifactPath, 'utf8'));
if (!fixtureArtifact.source || fixtureArtifact.source.sha256 !== fixtureSource.sourceSha256 || fixtureArtifact.source.compiledSha256 !== fixtureSource.compiledSha256) {
  throw new Error('APNewsTestData projection provenance mismatch');
}
if (JSON.stringify(fixtureArtifact.source.exports) !== JSON.stringify(fixtureSource.exports)) throw new Error('APNewsTestData export inventory mismatch');
if (JSON.stringify(Object.keys(fixtureArtifact.exports || {}).sort()) !== JSON.stringify(fixtureSource.exports.slice().sort())) throw new Error('APNewsTestData projection has unexpected exports');
const fixtureRecords = {};
(matrix.apFixtures || []).forEach(spec => {
  const record = fixtureArtifact.exports && fixtureArtifact.exports[spec.exportName];
  if (!record) throw new Error(`missing APNewsTestData export projection: ${spec.exportName}`);
  if (!record.data || !record.data.feed || !Array.isArray(record.data.feed.entry)) throw new Error(`invalid APNewsTestData projection: ${spec.exportName}`);
  if (record.category.name !== spec.category || record.category.sourceID !== spec.sourceID) throw new Error(`APNewsTestData metadata mismatch: ${spec.exportName}`);
  fixtureRecords[spec.id] = record;
});

process.env.TZ = matrix.runtime.timezone;
const RealDate = Date;
const fixedNow = RealDate.parse(matrix.runtime.clockISO);
global.Date = class FixtureDate extends RealDate {
  constructor(...args) { super(...(args.length ? args : [fixedNow])); }
  static now() { return fixedNow; }
};

function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function sourceHash(file) { return sha(fs.readFileSync(file)); }
function fail(message) { throw new Error(message); }

const started = Date.now();

let randomState = matrix.runtime.randomSeed >>> 0;
Math.random = function seededRandom() {
  randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
  return randomState / 0x100000000;
};

const candidateModulePath = process.env.PHOENIX_S10_NEWS_MODULE || path.join(root, 'packages/skills/src/report/news.js');
const news = await import(pathToFileURL(candidateModulePath).href);

async function executeRaw(raw, run) {
  const parsed = news.newsParse(raw);
  const data = {
    skill: { session: { data: { _personalReport: {} } } },
    local: { views: {}, news: parsed },
    runtime: fixture.makeRuntime(run, matrix.runtime.clockISO),
    log: { createChild() { return this; }, debug() {}, info() {}, warn() {}, error() {} },
  };
  await new news.NewsMimLogic().exit(data);
  return fixture.projectLocal(data.local);
}

async function execute(run) {
  return executeRaw(fixture.createRawNewsData(run.opts, run.activeNewsCategories), run);
}

async function executeApFixture(spec) {
  return executeRaw([fixtureRecords[spec.id]], {
    opts: { IDedSpeaker: true },
    activeNewsCategories: {},
    localISO: spec.localISO,
  });
}

function rowHash(value) { return sha(JSON.stringify(fixture.stable(value))); }

const cases = [];
let expandedRuns = 0;
for (const item of matrix.cases) {
  const result = { id: item.id, group: item.group, sourceName: item.sourceName, sourceLine: item.sourceLine, assertionCount: item.assertionCount, runs: [] };
  for (let index = 0; index < item.runs.length; index += 1) {
    const value = await execute(item.runs[index]);
    result.runs.push({ index, sha256: rowHash(value), value });
    expandedRuns += 1;
  }
  cases.push(result);
}
if (cases.length !== matrix.counts.namedCases) fail(`case count mismatch: ${cases.length}`);
if (expandedRuns !== matrix.counts.expandedRuns) fail(`run count mismatch: ${expandedRuns}`);

const fixtureResults = [];
for (const spec of matrix.apFixtures || []) {
  const value = await executeApFixture(spec);
  fixtureResults.push({
    id: spec.id,
    exportName: spec.exportName,
    sourceEntryCount: fixtureRecords[spec.id].data.feed.entry.length,
    runs: [{ index: 0, sha256: rowHash(value), value }],
  });
}

const modulePaths = [
  candidateModulePath,
  path.join(root, 'packages/skills/src/report/newsViews.js'),
];
const receipt = {
  schema: 'phoenix.parity.s10.news-receipt.v1',
  result: 'pass',
  runtime: { node: process.version, platform: process.platform, timezone: process.env.TZ, clockISO: matrix.runtime.clockISO },
  candidate: {
    revision: process.env.PHOENIX_S10_REVISION || 'worktree',
    moduleSha256: Object.fromEntries(modulePaths.map(file => [path.relative(root, file), sourceHash(file)])),
    resourceSha256: { 'packages/skills/resources/views/newsHeadline.json': sourceHash(path.join(root, 'packages/skills/resources/views/newsHeadline.json')) },
    fixtureArtifactSha256: sourceHash(fixtureArtifactPath),
  },
  counts: { namedCases: cases.length, expandedRuns, expandedAssertions: matrix.counts.expandedAssertions, fixtureProbes: fixtureResults.length },
  elapsedMs: Date.now() - started,
  cases,
  fixtures: fixtureResults,
};
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ result: receipt.result, namedCases: cases.length, expandedRuns, out: outPath })}\n`);
