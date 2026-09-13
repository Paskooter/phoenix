'use strict';

// Execute the actual compiled Pegasus WeatherParse, WeatherMimLogic and
// WeatherViews modules under the pinned Node 8.9.4 image.  No implementation
// is copied into this runner: the source modules are the oracle.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ref = path.resolve(process.argv[2]);
const matrixPath = path.resolve(process.argv[3]);
const outPath = path.resolve(process.argv[4]);
const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
const fixture = require(path.join(__dirname, 'fixtures.cjs'));
const started = Date.now();

function sha(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
function fileSha(file) { return sha(fs.readFileSync(file)); }
function fail(message) { throw new Error(message); }

const compiledPath = path.join(ref, 'parity-compiled.json');
if (!fs.existsSync(compiledPath)) fail(`missing compiled source record: ${compiledPath}`);
const compiled = JSON.parse(fs.readFileSync(compiledPath, 'utf8'));
if (compiled.referenceRevision !== matrix.reference.revision) {
  fail(`source revision mismatch: ${compiled.referenceRevision}`);
}
const requiredInputs = matrix.reference.sourcePaths;
const requiredOutputs = [
  'packages/report-skill/lib/subskills/weather/WeatherParse.js',
  'packages/report-skill/lib/subskills/weather/WeatherMimLogic.js',
  'packages/report-skill/lib/subskills/weather/WeatherViews.js',
];
requiredInputs.forEach(file => {
  const expected = compiled.inputs && compiled.inputs[file];
  if (!expected) fail(`compiled source record omits required input: ${file}`);
  const actual = fileSha(path.join(ref, file));
  if (actual !== expected) fail(`compiled source input changed: ${file}`);
});
requiredOutputs.forEach(file => {
  const expected = compiled.outputs && compiled.outputs[file];
  if (!expected) fail(`compiled source record omits required output: ${file}`);
  const actual = fileSha(path.join(ref, file));
  if (actual !== expected) fail(`compiled source output changed: ${file}`);
});
const sourceTest = path.join(ref, matrix.reference.testPath);
if (!fs.existsSync(sourceTest)) fail(`missing pinned source test: ${sourceTest}`);
if (fileSha(sourceTest) !== matrix.reference.testSha256) fail('pinned Weather.test.js hash mismatch');

if (process.version !== 'v8.9.4') fail(`expected Node 8.9.4, got ${process.version}`);
process.env.TZ = matrix.runtime.timezone;

const weatherParse = require(path.join(ref, 'packages/report-skill/lib/subskills/weather/WeatherParse.js')).weatherParse;
const WeatherMimLogic = require(path.join(ref, 'packages/report-skill/lib/subskills/weather/WeatherMimLogic.js')).WeatherMimLogic;

let randomState = matrix.runtime.randomSeed >>> 0;
Math.random = function seededRandom() {
  randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
  return randomState / 0x100000000;
};

function prefsFor(run) {
  return fixture.buildPrefs(run);
}

function rawFor(run) {
  return fixture.applyVariant(fixture.createRawWeatherData(run.variant === 'no-data' ? null : run.opts), run.variant);
}

function projectDay(value) {
  if (!value) return null;
  return {
    highTemp: value.highTemp === undefined ? null : value.highTemp,
    lowTemp: value.lowTemp === undefined ? null : value.lowTemp,
    icon: value.icon === undefined ? null : value.icon,
    summary: value.summary === undefined ? null : value.summary,
  };
}
function projectCurrent(value) {
  if (!value) return null;
  return {
    temp: value.temp === undefined ? null : value.temp,
    icon: value.icon === undefined ? null : value.icon,
    summary: value.summary === undefined ? null : value.summary,
  };
}
function projectWeather(value) {
  if (!value) return null;
  return {
    yest: projectDay(value.yest), today: projectDay(value.today), tomorrow: projectDay(value.tomorrow),
    current: projectCurrent(value.current),
    icon: value.icon === undefined ? null : value.icon,
    summary: value.summary === undefined ? null : value.summary,
    prefix: value.prefix === undefined ? null : value.prefix,
    useCelsius: value.useCelsius === undefined ? null : value.useCelsius,
    onlyWeatherActive: value.onlyWeatherActive === undefined ? null : value.onlyWeatherActive,
  };
}
function basenameMim(value) {
  if (typeof value !== 'string') return value;
  const name = value.split('/').pop();
  return name && name.endsWith('.mim') ? name.slice(0, -4) : name;
}
function projectLocal(local) {
  return {
    mims: (local && local.mimPaths || []).map(basenameMim),
    weather: projectWeather(local && local.weather),
    view: local && local.views && local.views.weatherHiLo === undefined ? null : (local && local.views ? local.views.weatherHiLo : null),
  };
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => { out[key] = stable(value[key]); return out; }, {});
  }
  if (typeof value === 'number' && isNaN(value)) return 'NaN';
  return value;
}

async function execute(run, operation) {
  const prefs = prefsFor(run);
  const parsed = await weatherParse(rawFor(run), prefs);
  if (operation === 'parse') return projectWeather(parsed);
  const data = {
    skill: { session: { data: { _personalReport: {} } } },
    local: { views: {}, weather: parsed },
    runtime: { location: { iso: run.localISO } },
    log: { createChild() { return this; }, debug() {}, info() {}, warn() {}, error() {} },
  };
  await new WeatherMimLogic().exit(data);
  return projectLocal(data.local);
}

async function main() {
  const cases = [];
  let expandedRuns = 0;
  for (let i = 0; i < matrix.cases.length; i += 1) {
    const item = matrix.cases[i];
    const result = { id: item.id, group: item.group, sourceName: item.sourceName, sourceLine: item.sourceLine, runs: [] };
    for (let j = 0; j < item.runs.length; j += 1) {
      const run = item.runs[j];
      const value = await execute(run, item.operation || run.operation || 'logic');
      const canonical = JSON.stringify(stable(value));
      result.runs.push({ index: j, sha256: sha(canonical), value });
      expandedRuns += 1;
    }
    cases.push(result);
  }
  if (cases.length !== matrix.counts.namedCases) fail(`case count mismatch: ${cases.length}`);
  if (expandedRuns !== matrix.counts.expandedRuns) fail(`run count mismatch: ${expandedRuns}`);
  const receipt = {
    schema: 'phoenix.parity.s09.weather-receipt.v1',
    result: 'pass',
    runtime: { node: process.version, platform: process.platform, timezone: process.env.TZ },
    reference: {
      repo: matrix.reference.repo,
      revision: matrix.reference.revision,
      testPath: matrix.reference.testPath,
      testSha256: fileSha(sourceTest),
      compiledRecordSha256: fileSha(compiledPath),
    },
    counts: { namedCases: cases.length, expandedRuns },
    elapsedMs: Date.now() - started,
    cases,
  };
  if (!fs.existsSync(path.dirname(outPath))) fs.mkdirSync(path.dirname(outPath));
  fs.writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(JSON.stringify({ result: receipt.result, namedCases: cases.length, expandedRuns, out: outPath }) + '\n');
}

main().catch(error => {
  const receipt = { schema: 'phoenix.parity.s09.weather-receipt.v1', result: 'fail', runtime: { node: process.version }, error: String(error && error.stack || error) };
  try { if (!fs.existsSync(path.dirname(outPath))) fs.mkdirSync(path.dirname(outPath)); fs.writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`); } catch (_) {}
  process.stderr.write(`${receipt.error}\n`);
  process.exitCode = 1;
});
