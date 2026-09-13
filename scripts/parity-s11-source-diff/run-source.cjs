'use strict';

// Execute the pinned Pegasus Commute parser, MIM logic, and view builders in
// the exact Node 8.9.4 source runtime.  The harness supplies only deterministic
// fixtures and records semantic observables; source modules remain the oracle.

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var ref = path.resolve(process.argv[2]);
var matrixPath = path.resolve(process.argv[3]);
var outPath = path.resolve(process.argv[4]);
var matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
var fixture = require(path.join(__dirname, 'fixtures.cjs'));

function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function fileSha(file) { return sha(fs.readFileSync(file)); }
function canonical(value) { return JSON.stringify(fixture.stable(value)); }
function rowHash(value) { return sha(canonical(value)); }
function fail(message) { throw new Error(message); }
function mkdirp(dir) {
  if (fs.existsSync(dir)) return;
  var parent = path.dirname(dir);
  if (parent !== dir) mkdirp(parent);
  try { fs.mkdirSync(dir); } catch (error) { if (!fs.existsSync(dir)) throw error; }
}
function requirePinnedFile(relative, hashMap, label) {
  var expected = hashMap && hashMap[relative];
  if (!expected) fail('matrix omits ' + label + ' hash: ' + relative);
  var absolute = path.join(ref, relative);
  if (!fs.existsSync(absolute)) fail('missing pinned ' + label + ': ' + absolute);
  var actual = fileSha(absolute);
  if (actual !== expected) fail('pinned ' + label + ' changed: ' + relative);
  return actual;
}

var compiledPath = path.join(ref, 'parity-compiled.json');
if (!fs.existsSync(compiledPath)) fail('missing compiled source record: ' + compiledPath);
if (!matrix.reference || !matrix.reference.compiledRecordSha256) fail('matrix omits compiled source record hash');
if (fileSha(compiledPath) !== matrix.reference.compiledRecordSha256) fail('pinned compiled source record changed');
var compiled = JSON.parse(fs.readFileSync(compiledPath, 'utf8'));
if (compiled.referenceRevision !== matrix.reference.revision) fail('source revision mismatch: ' + compiled.referenceRevision);

var sourcePaths = matrix.reference.sourcePaths || [];
var compiledPaths = matrix.reference.compiledPaths || [];
var sourceHashes = matrix.reference.sourceHashes || {};
var compiledHashes = matrix.reference.compiledHashes || {};
sourcePaths.forEach(function (file) {
  var actual = requirePinnedFile(file, sourceHashes, 'source file');
  if (!compiled.inputs || compiled.inputs[file] !== actual) fail('compiled source input mismatch: ' + file);
});
compiledPaths.forEach(function (file) {
  var actual = requirePinnedFile(file, compiledHashes, 'compiled source file');
  if (!compiled.outputs || compiled.outputs[file] !== actual) fail('compiled source output mismatch: ' + file);
});
var resourceHashes = matrix.reference.resourceHashes || {};
if (!Object.keys(resourceHashes).length) fail('matrix omits source resource hashes');
Object.keys(resourceHashes).forEach(function (file) {
  requirePinnedFile(file, resourceHashes, 'source resource');
});

var testPath = matrix.reference.testPath;
var testSupportPath = matrix.reference.testSupportPath;
if (!testPath || !testSupportPath) fail('matrix omits archived test provenance');
if (fileSha(path.join(ref, testPath)) !== matrix.reference.testSha256) fail('archived Commute test hash mismatch');
if (fileSha(path.join(ref, testSupportPath)) !== matrix.reference.testSupportSha256) fail('archived TestUtils hash mismatch');
if (process.version !== 'v8.9.4') fail('expected Node 8.9.4, got ' + process.version);

// The archived test's beforeEach freezes the baseline 08:00 local instant.
// Some rows then change opts.localISO, so the request clock intentionally stays
// at this matrix value for every row.
process.env.TZ = matrix.runtime.timezone;
var RealDate = Date;
var fixedNow = RealDate.parse(matrix.runtime.clockISO);
global.Date = class FixtureDate extends RealDate {
  constructor() {
    var args = Array.prototype.slice.call(arguments);
    if (args.length) super(...args);
    else super(fixedNow);
  }
  static now() { return fixedNow; }
};
var randomState = matrix.runtime.randomSeed >>> 0;
Math.random = function seededRandom() {
  randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
  return randomState / 0x100000000;
};
var started = Date.now();

var commuteModule = require(path.join(ref, 'packages/report-skill/lib/subskills/commute/index.js'));
var commuteParse = commuteModule.commuteParse;
var commuteGetData = commuteModule.data.getData;
var CommuteMimLogic = commuteModule.mims.CommuteMimLogic;
var calendarParse = require(path.join(ref, 'packages/report-skill/lib/subskills/calendar/CalendarParse.js')).calendarParse;

function parseForRun(item) {
  var cal = calendarParse(item.rawCalendar, item.data);
  if (item.run.directLocalData) {
    // This preserves the archived no-maps test's intentional third argument:
    // createUserPrefs(...) rather than { userPrefs, calendar }.
    return commuteParse(item.rawCommute, item.localISO, item.prefs).then(function (value) {
      return fixture.projectCommute(value);
    });
  }
  return commuteParse(item.rawCommute, item.localISO, {
    userPrefs: item.prefs,
    calendar: cal,
  }).then(function (value) {
    return fixture.projectCommute(value);
  });
}

function logicForRun(item) {
  var cal = calendarParse(item.rawCalendar, item.data);
  return commuteParse(item.rawCommute, item.localISO, {
    userPrefs: item.prefs,
    calendar: cal,
  }).then(function (commute) {
    item.data.local.commute = commute;
    return new CommuteMimLogic().exit(item.data).then(function () {
      return fixture.projectLocal(item.data.local);
    });
  });
}

function execute(run) {
  var materialized = fixture.materialize(run);
  materialized.run = run;
  if (run.operation === 'getData') {
    return commuteGetData({ commute: materialized.prefs.commute }, materialized.data);
  }
  if (run.operation === 'parse') return parseForRun(materialized);
  if (run.operation === 'logic') return logicForRun(materialized);
  return Promise.reject(new Error('unknown operation: ' + run.operation));
}

function makeReceipt(cases) {
  var receipt = {
    schema: 'phoenix.parity.s11.commute-receipt.v1',
    result: 'pass',
    runtime: {
      node: process.version,
      platform: process.platform,
      timezone: process.env.TZ,
      clockISO: matrix.runtime.clockISO,
      randomSeed: matrix.runtime.randomSeed,
    },
    reference: {
      repo: matrix.reference.repo,
      revision: matrix.reference.revision,
      testPath: testPath,
      testSha256: fileSha(path.join(ref, testPath)),
      testSupportPath: testSupportPath,
      testSupportSha256: fileSha(path.join(ref, testSupportPath)),
      compiledRecordSha256: fileSha(compiledPath),
      sourcePaths: sourcePaths,
      sourceHashes: {},
      compiledPaths: compiledPaths,
      compiledHashes: {},
      resourceHashes: {},
    },
    counts: {
      namedCases: cases.length,
      expandedRuns: matrix.counts.expandedRuns,
      expandedAssertions: matrix.counts.expandedAssertions,
      groups: matrix.counts.groups,
    },
    elapsedMs: Date.now() - started,
    cases: cases,
  };
  sourcePaths.forEach(function (file) { receipt.reference.sourceHashes[file] = fileSha(path.join(ref, file)); });
  compiledPaths.forEach(function (file) { receipt.reference.compiledHashes[file] = fileSha(path.join(ref, file)); });
  Object.keys(resourceHashes).forEach(function (file) { receipt.reference.resourceHashes[file] = fileSha(path.join(ref, file)); });
  return receipt;
}

async function main() {
  var cases = [];
  var expandedRuns = 0;
  for (var c = 0; c < matrix.cases.length; c += 1) {
    var spec = matrix.cases[c];
    var result = {
      id: spec.id,
      group: spec.group,
      sourceName: spec.sourceName,
      sourceLine: spec.sourceLine,
      assertionCount: spec.assertionCount,
      runs: [],
    };
    for (var i = 0; i < spec.runs.length; i += 1) {
      var value = await execute(spec.runs[i]);
      result.runs.push({ index: i, sha256: rowHash(value), value: value });
      expandedRuns += 1;
    }
    cases.push(result);
  }
  if (cases.length !== matrix.counts.namedCases) fail('case count mismatch: ' + cases.length);
  if (expandedRuns !== matrix.counts.expandedRuns) fail('expanded run count mismatch: ' + expandedRuns);
  var supplementalSpecs = (matrix.supplemental && matrix.supplemental.cases) || [];
  var supplementalCases = [];
  var supplementalRuns = 0;
  for (var s = 0; s < supplementalSpecs.length; s += 1) {
    var supplementalSpec = supplementalSpecs[s];
    var supplementalResult = {
      id: supplementalSpec.id,
      group: supplementalSpec.group,
      sourceName: supplementalSpec.sourceName,
      assertionCount: supplementalSpec.assertionCount,
      runs: [],
    };
    for (var j = 0; j < supplementalSpec.runs.length; j += 1) {
      var supplementalValue = await execute(supplementalSpec.runs[j]);
      supplementalResult.runs.push({ index: j, sha256: rowHash(supplementalValue), value: supplementalValue });
      supplementalRuns += 1;
    }
    supplementalCases.push(supplementalResult);
  }
  if (matrix.supplemental && supplementalCases.length !== matrix.supplemental.counts.namedCases) fail('supplemental case count mismatch: ' + supplementalCases.length);
  if (matrix.supplemental && supplementalRuns !== matrix.supplemental.counts.expandedRuns) fail('supplemental run count mismatch: ' + supplementalRuns);
  var receipt = makeReceipt(cases);
  receipt.supplemental = {
    counts: matrix.supplemental ? matrix.supplemental.counts : { namedCases: 0, expandedRuns: 0, expandedAssertions: 0, groups: {} },
    cases: supplementalCases,
  };
  mkdirp(path.dirname(outPath));
  fs.writeFileSync(outPath, JSON.stringify(receipt, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ result: receipt.result, namedCases: cases.length, expandedRuns: expandedRuns, expandedAssertions: matrix.counts.expandedAssertions, supplementalRuns: supplementalRuns, out: outPath }) + '\n');
}

main().then(function () {
  // Pegasus leaves logging/timer handles open in this legacy runtime.  The
  // synchronous receipt write above is complete, so terminate here instead
  // of leaving the digest-pinned container alive indefinitely.
  process.exit(0);
}).catch(function (error) {
  var receipt = {
    schema: 'phoenix.parity.s11.commute-receipt.v1',
    result: 'fail',
    runtime: { node: process.version },
    error: String(error && error.stack || error),
  };
  try {
    mkdirp(path.dirname(outPath));
    fs.writeFileSync(outPath, JSON.stringify(receipt, null, 2) + '\n');
  } catch (_) {}
  process.stderr.write(receipt.error + '\n');
  process.exit(1);
});
