'use strict';

// Execute the compiled Pegasus News parser, MIM logic, and view builder under
// the pinned Node 8.9.4 image. The source modules are the oracle; this file
// only supplies deterministic test inputs and records observables.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ref = path.resolve(process.argv[2]);
const matrixPath = path.resolve(process.argv[3]);
const outPath = path.resolve(process.argv[4]);
const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
const fixture = require(path.join(__dirname, 'fixtures.cjs'));

function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function fileSha(file) { return sha(fs.readFileSync(file)); }
function fail(message) { throw new Error(message); }
function mkdirp(dir) {
  if (fs.existsSync(dir)) return;
  const parent = path.dirname(dir);
  if (parent !== dir) mkdirp(parent);
  try { fs.mkdirSync(dir); } catch (error) { if (!fs.existsSync(dir)) throw error; }
}

const compiledPath = path.join(ref, 'parity-compiled.json');
if (!fs.existsSync(compiledPath)) fail(`missing compiled source record: ${compiledPath}`);
if (!matrix.reference.compiledRecordSha256) fail('matrix omits compiled source record hash');
if (fileSha(compiledPath) !== matrix.reference.compiledRecordSha256) fail('pinned compiled source record changed');
const compiled = JSON.parse(fs.readFileSync(compiledPath, 'utf8'));
if (compiled.referenceRevision !== matrix.reference.revision) fail(`source revision mismatch: ${compiled.referenceRevision}`);

const requiredInputs = matrix.reference.sourcePaths;
const requiredOutputs = [
  'packages/report-skill/lib/subskills/news/NewsData.js',
  'packages/report-skill/lib/subskills/news/NewsFactory.js',
  'packages/report-skill/lib/subskills/news/NewsParse.js',
  'packages/report-skill/lib/subskills/news/NewsMimLogic.js',
  'packages/report-skill/lib/subskills/news/NewsViews.js',
  'packages/report-skill/lib/subskills/news/index.js',
];
requiredInputs.forEach(file => {
  const pinned = matrix.reference.sourceHashes && matrix.reference.sourceHashes[file];
  if (!pinned) fail(`matrix omits required source hash: ${file}`);
  if (fileSha(path.join(ref, file)) !== pinned) fail(`pinned source file changed: ${file}`);
  const expected = compiled.inputs && compiled.inputs[file];
  if (!expected) fail(`compiled source record omits required input: ${file}`);
  if (fileSha(path.join(ref, file)) !== expected) fail(`compiled source input changed: ${file}`);
});
requiredOutputs.forEach(file => {
  const pinned = matrix.reference.compiledHashes && matrix.reference.compiledHashes[file];
  if (!pinned) fail(`matrix omits required compiled output hash: ${file}`);
  if (fileSha(path.join(ref, file)) !== pinned) fail(`pinned source output changed: ${file}`);
  const expected = compiled.outputs && compiled.outputs[file];
  if (!expected) fail(`compiled source record omits required output: ${file}`);
  if (fileSha(path.join(ref, file)) !== expected) fail(`compiled source output changed: ${file}`);
});

const requiredResources = matrix.reference.resourceHashes || {};
if (!Object.keys(requiredResources).length) fail('matrix omits required source resource hashes');
Object.keys(requiredResources).forEach(file => {
  if (fileSha(path.join(ref, file)) !== requiredResources[file]) fail(`pinned source resource changed: ${file}`);
});

const fixtureSource = matrix.reference.fixtureSource;
if (!fixtureSource) fail('matrix omits APNewsTestData fixture source record');
if (fileSha(path.join(ref, fixtureSource.sourcePath)) !== fixtureSource.sourceSha256) fail('pinned APNewsTestData source changed');
if (fileSha(path.join(ref, fixtureSource.compiledPath)) !== fixtureSource.compiledSha256) fail('pinned APNewsTestData compiled fixture changed');
const fixtureCompiledExpected = compiled.outputs && compiled.outputs[fixtureSource.compiledPath];
if (!fixtureCompiledExpected || fixtureCompiledExpected !== fixtureSource.compiledSha256) fail('compiled source record APNewsTestData hash mismatch');
const fixtureArtifactPath = path.join(__dirname, 'ap-fixtures.json');
if (!fs.existsSync(fixtureArtifactPath)) fail(`missing APNewsTestData projection artifact: ${fixtureArtifactPath}`);
if (fileSha(fixtureArtifactPath) !== fixtureSource.artifactSha256) fail('APNewsTestData projection artifact changed');
const fixtureArtifact = JSON.parse(fs.readFileSync(fixtureArtifactPath, 'utf8'));
if (!fixtureArtifact.source || fixtureArtifact.source.sha256 !== fixtureSource.sourceSha256 || fixtureArtifact.source.compiledSha256 !== fixtureSource.compiledSha256) {
  fail('APNewsTestData projection provenance mismatch');
}
if (JSON.stringify(fixtureArtifact.source.exports) !== JSON.stringify(fixtureSource.exports)) fail('APNewsTestData export inventory mismatch');
if (JSON.stringify(Object.keys(fixtureArtifact.exports || {}).sort()) !== JSON.stringify(fixtureSource.exports.slice().sort())) fail('APNewsTestData projection has unexpected exports');
const fixtureRecords = {};
(matrix.apFixtures || []).forEach(spec => {
  const record = fixtureArtifact.exports && fixtureArtifact.exports[spec.exportName];
  if (!record) fail(`missing APNewsTestData export projection: ${spec.exportName}`);
  if (!record.data || !record.data.feed || !Array.isArray(record.data.feed.entry)) fail(`invalid APNewsTestData projection: ${spec.exportName}`);
  if (record.category.name !== spec.category || record.category.sourceID !== spec.sourceID) fail(`APNewsTestData metadata mismatch: ${spec.exportName}`);
  fixtureRecords[spec.id] = record;
});

const sourceTest = path.join(ref, matrix.reference.testPath);
if (!fs.existsSync(sourceTest)) fail(`missing pinned source test: ${sourceTest}`);
if (fileSha(sourceTest) !== matrix.reference.testSha256) fail('pinned News.test.js hash mismatch');
const sourceTestSupport = path.join(ref, matrix.reference.testSupportPath);
if (!fs.existsSync(sourceTestSupport)) fail(`missing pinned test helper: ${sourceTestSupport}`);
if (fileSha(sourceTestSupport) !== matrix.reference.testSupportSha256) fail('pinned News TestUtils.js hash mismatch');
if (process.version !== 'v8.9.4') fail(`expected Node 8.9.4, got ${process.version}`);

process.env.TZ = matrix.runtime.timezone;
const RealDate = Date;
const fixedNow = RealDate.parse(matrix.runtime.clockISO);
global.Date = class FixtureDate extends RealDate {
  constructor() {
    const args = Array.prototype.slice.call(arguments);
    if (args.length) super(...args);
    else super(fixedNow);
  }
  static now() { return fixedNow; }
};
const started = Date.now();

let randomState = matrix.runtime.randomSeed >>> 0;
Math.random = function seededRandom() {
  randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
  return randomState / 0x100000000;
};

const newsParse = require(path.join(ref, 'packages/report-skill/lib/subskills/news/NewsParse.js')).newsParse;
const NewsMimLogic = require(path.join(ref, 'packages/report-skill/lib/subskills/news/NewsMimLogic.js')).NewsMimLogic;

function executeRaw(raw, run) {
  const parsed = newsParse(raw);
  const data = {
    skill: { session: { data: { _personalReport: {} } } },
    local: { views: {}, news: parsed },
    runtime: fixture.makeRuntime(run, matrix.runtime.clockISO),
    log: { createChild() { return this; }, debug() {}, info() {}, warn() {}, error() {} },
  };
  return Promise.resolve(new NewsMimLogic().exit(data)).then(() => fixture.projectLocal(data.local));
}

function execute(run) {
  return executeRaw(fixture.createRawNewsData(run.opts, run.activeNewsCategories), run);
}

function executeApFixture(spec) {
  return executeRaw([fixtureRecords[spec.id]], {
    opts: { IDedSpeaker: true },
    activeNewsCategories: {},
    localISO: spec.localISO,
  });
}

function rowHash(value) { return sha(JSON.stringify(fixture.stable(value))); }

async function main() {
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
  const receipt = {
    schema: 'phoenix.parity.s10.news-receipt.v1',
    result: 'pass',
    runtime: { node: process.version, platform: process.platform, timezone: process.env.TZ, clockISO: matrix.runtime.clockISO },
    reference: {
      repo: matrix.reference.repo,
      revision: matrix.reference.revision,
      testPath: matrix.reference.testPath,
      testSha256: fileSha(sourceTest),
      testSupportPath: matrix.reference.testSupportPath,
      testSupportSha256: fileSha(sourceTestSupport),
      compiledRecordSha256: fileSha(compiledPath),
      sourceHashes: {},
      compiledHashes: {},
      resourceHashes: {},
    },
    counts: { namedCases: cases.length, expandedRuns, expandedAssertions: matrix.counts.expandedAssertions, fixtureProbes: fixtureResults.length },
    elapsedMs: Date.now() - started,
    cases,
    fixtures: fixtureResults,
  };
  requiredInputs.forEach(file => { receipt.reference.sourceHashes[file] = fileSha(path.join(ref, file)); });
  requiredOutputs.forEach(file => { receipt.reference.compiledHashes[file] = fileSha(path.join(ref, file)); });
  Object.keys(requiredResources).forEach(file => { receipt.reference.resourceHashes[file] = fileSha(path.join(ref, file)); });
  receipt.reference.fixtureSource = {
    sourcePath: fixtureSource.sourcePath,
    sourceSha256: fileSha(path.join(ref, fixtureSource.sourcePath)),
    compiledPath: fixtureSource.compiledPath,
    compiledSha256: fileSha(path.join(ref, fixtureSource.compiledPath)),
    artifactPath: fixtureSource.artifactPath,
    artifactSha256: fileSha(fixtureArtifactPath),
    exports: fixtureSource.exports,
  };
  mkdirp(path.dirname(outPath));
  fs.writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ result: receipt.result, namedCases: cases.length, expandedRuns, out: outPath })}\n`);
}

main().catch(error => {
  const receipt = { schema: 'phoenix.parity.s10.news-receipt.v1', result: 'fail', runtime: { node: process.version }, error: String(error && error.stack || error) };
  try {
    mkdirp(path.dirname(outPath));
    fs.writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`);
  } catch (_) {}
  process.stderr.write(`${receipt.error}\n`);
  process.exitCode = 1;
});
