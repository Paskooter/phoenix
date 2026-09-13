'use strict';

// Run the archived compiled view helpers in the digest-pinned Node 8 image.
// The source side is regenerated for every run; no checked-in golden output is
// read.  Each row records a tagged outcome so undefined, non-finite numbers,
// and rejected promises cannot disappear during JSON serialization.

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var protocol = require('./protocol.cjs');

var referenceRoot = path.resolve(process.argv[2]);
var matrixPath = path.resolve(process.argv[3]);
var outputPath = path.resolve(process.argv[4]);
var contractPath = path.resolve(process.argv[5]);

function fail(message) { throw new Error(message); }
function fileSha(file) { return protocol.sha(fs.readFileSync(file)); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function requireFile(relative, expected, label) {
  if (!expected) fail('missing pinned ' + label + ' hash: ' + relative);
  var absolute = path.join(referenceRoot, relative);
  if (!fs.existsSync(absolute)) fail('missing pinned ' + label + ': ' + relative);
  var actual = fileSha(absolute);
  if (actual !== expected) fail('pinned ' + label + ' changed: ' + relative);
  return actual;
}
function requireMap(map, label) {
  Object.keys(map || {}).sort().forEach(function (relative) { requireFile(relative, map[relative], label); });
}
function checkMatrix(matrix, contract) {
  if (fileSha(matrixPath) !== contract.matrixSha256) fail('matrix is not the pinned S-13 matrix');
  if (!contract || contract.schema !== 'phoenix.parity.s13.report-view-contract.v1') fail('contract schema mismatch');
  if (process.env.PHOENIX_S13_CONTRACT_SHA256 !== fileSha(contractPath)) fail('contract digest environment pin mismatch');
  if (matrix.schema !== 'phoenix.parity.s13.report-view-matrix.v1') fail('matrix schema mismatch');
  if (!matrix.rows || matrix.rows.length !== 61 || matrix.counts.namedCases !== 61 || matrix.counts.expandedRuns !== 61) fail('matrix row count mismatch');
  if (JSON.stringify(matrix.counts.groups) !== JSON.stringify({ weather: 20, traffic: 7, depart: 4, news: 5, calendar: 25 })) fail('matrix group counts mismatch');
  var ids = {};
  matrix.rows.forEach(function (row, index) {
    if (!row || typeof row.id !== 'string' || ids[row.id]) fail('duplicate/malformed matrix row ' + index);
    ids[row.id] = true;
    if (row.assertionCount !== 1 || !Array.isArray(row.args) || !row.kind) fail('incomplete matrix row ' + row.id);
  });
}
function checkReference(matrix, contract) {
  var reference = matrix.reference;
  if (!reference || reference.revision !== contract.reference.revision) fail('source revision mismatch');
  if (reference.imageDigest !== contract.reference.imageDigest) fail('source image digest mismatch');
  requireFile(reference.preparedPath, reference.preparedSha256, 'prepared source record');
  requireFile(reference.compiledPath, reference.compiledSha256, 'compiled source record');
  requireFile(reference.rootManifestPath, reference.rootManifestSha256, 'source root manifest');
  requireFile(reference.lockPath, reference.lockSha256, 'source lockfile');
  requireFile(reference.reportManifestPath, reference.reportManifestSha256, 'source report manifest');
  requireMap(reference.testFiles, 'archived source test');
  requireMap(reference.sourcePaths, 'source TypeScript');
  requireMap(reference.compiledPaths, 'compiled source');
  requireMap(reference.resources, 'source resource');

  var prepared = readJson(path.join(referenceRoot, reference.preparedPath));
  if (prepared.referenceRevision !== reference.revision) fail('prepared source revision mismatch');
  if (prepared.relocatedLockSha256 !== reference.lockSha256) fail('prepared lock hash mismatch');
  var compiled = readJson(path.join(referenceRoot, reference.compiledPath));
  if (compiled.referenceRevision !== reference.revision || compiled.runtime !== 'v8.9.4') fail('compiled source provenance mismatch');
  requireMap(compiled.inputs, 'compiled input dependency');
  requireMap(compiled.outputs, 'compiled output dependency');
  Object.keys(reference.sourcePaths).forEach(function (file) {
    if (!compiled.inputs || compiled.inputs[file] !== reference.sourcePaths[file]) fail('source input is absent from compiled record: ' + file);
  });
  Object.keys(reference.compiledPaths).forEach(function (file) {
    if (!compiled.outputs || compiled.outputs[file] !== reference.compiledPaths[file]) fail('compiled output is absent from compiled record: ' + file);
  });
  requireMap(contract.reference.dependencyManifest, 'source package manifest');
}

function freezeClock(matrix) {
  process.env.TZ = matrix.runtime.timezone;
  var RealDate = Date;
  var fixedNow = RealDate.parse(matrix.runtime.clockISO);
  global.Date = class FixtureDate extends RealDate {
    constructor() {
      var args = Array.prototype.slice.call(arguments);
      if (args.length) super(...args); else super(fixedNow);
    }
    static now() { return fixedNow; }
  };
  var randomState = matrix.runtime.randomSeed >>> 0;
  Math.random = function seededRandom() {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState / 0x100000000;
  };
}

function loadFunctions() {
  return {
    weather: require(path.join(referenceRoot, 'packages/report-skill/lib/subskills/weather/WeatherViews.js')).hiLoTempView,
    news: require(path.join(referenceRoot, 'packages/report-skill/lib/subskills/news/NewsViews.js')).newsViews,
    traffic: require(path.join(referenceRoot, 'packages/report-skill/lib/subskills/commute/CommuteViews.js')).trafficView,
    depart: require(path.join(referenceRoot, 'packages/report-skill/lib/subskills/commute/CommuteViews.js')).departView,
    calendar: require(path.join(referenceRoot, 'packages/report-skill/lib/subskills/calendar/CalendarViews.js')).calEventViews,
  };
}

function execute(spec, functions) {
  var args = protocol.argumentsFor(spec);
  return protocol.capture(function () { return functions[spec.kind].apply(null, args); });
}

function makeReceipt(matrix, contract, cases, started) {
  return {
    schema: 'phoenix.parity.s13.report-view-receipt.v1',
    result: 'pass',
    runtime: {
      node: process.version,
      platform: process.platform,
      timezone: process.env.TZ,
      clockISO: matrix.runtime.clockISO,
      randomSeed: matrix.runtime.randomSeed,
      network: matrix.runtime.network,
      image: matrix.runtime.source.image,
      imageDigest: matrix.runtime.source.imageDigest,
    },
    source: {
      repo: matrix.reference.repo,
      revision: matrix.reference.revision,
      preparedSha256: fileSha(path.join(referenceRoot, matrix.reference.preparedPath)),
      compiledSha256: fileSha(path.join(referenceRoot, matrix.reference.compiledPath)),
      dependencyManifestSha256: contract.reference.dependencyManifestSha256,
      matrixSha256: fileSha(matrixPath),
      contractSha256: fileSha(contractPath),
      sourcePaths: matrix.reference.sourcePaths,
      compiledPaths: matrix.reference.compiledPaths,
      resources: matrix.reference.resources,
    },
    counts: matrix.counts,
    elapsedMs: Date.now() - started,
    rows: cases,
  };
}

// Node 8 does not provide top-level await.  Keep all rows sequential and let
// the promise chain terminate the process once the receipt is complete.
function runRows(matrix, contract, functions, started) {
  var rows = [];
  var chain = Promise.resolve();
  matrix.rows.forEach(function (spec) {
    chain = chain.then(function () {
      return execute(spec, functions).then(function (outcome) {
        rows.push({
          id: spec.id,
          group: spec.group,
          sourceName: spec.sourceName,
          sourceLine: spec.sourceLine,
          kind: spec.kind,
          assertionCount: spec.assertionCount,
          specSha256: protocol.rowHash(spec),
          runs: [{ index: 0, sha256: protocol.rowHash(outcome), outcome: outcome }],
        });
      });
    });
  });
  return chain.then(function () {
    if (rows.length !== matrix.counts.namedCases) fail('row count mismatch: ' + rows.length);
    var receipt = makeReceipt(matrix, contract, rows, started);
    protocol.mkdirp(path.dirname(outputPath), fs, path);
    fs.writeFileSync(outputPath, JSON.stringify(receipt, null, 2) + '\n');
    process.stdout.write(JSON.stringify({ result: 'pass', rows: rows.length, fulfilled: rows.filter(function (r) { return r.runs[0].outcome.status === 'fulfilled'; }).length, rejected: rows.filter(function (r) { return r.runs[0].outcome.status === 'rejected'; }).length, out: outputPath }) + '\n');
  });
}

try {
  var matrix = readJson(matrixPath);
  var contract = readJson(contractPath);
  checkMatrix(matrix, contract);
  checkReference(matrix, contract);
  if (process.version !== matrix.runtime.source.node) fail('source runtime mismatch: ' + process.version);
  freezeClock(matrix);
  var functions = loadFunctions();
  runRows(matrix, contract, functions, Date.now()).then(function () { process.exit(0); }, function (error) {
    var receipt = { schema: 'phoenix.parity.s13.report-view-receipt.v1', result: 'fail', runtime: { node: process.version }, error: { name: error.name || 'Error', message: String(error.message || error) } };
    try { protocol.mkdirp(path.dirname(outputPath), fs, path); fs.writeFileSync(outputPath, JSON.stringify(receipt, null, 2) + '\n'); } catch (_) {}
    process.stderr.write(receipt.error.name + ': ' + receipt.error.message + '\n');
    process.exit(1);
  });
} catch (error) {
  var failure = { schema: 'phoenix.parity.s13.report-view-receipt.v1', result: 'fail', runtime: { node: process.version }, error: { name: error.name || 'Error', message: String(error.message || error) } };
  try { protocol.mkdirp(path.dirname(outputPath), fs, path); fs.writeFileSync(outputPath, JSON.stringify(failure, null, 2) + '\n'); } catch (_) {}
  process.stderr.write(failure.error.name + ': ' + failure.error.message + '\n');
  process.exit(1);
}
