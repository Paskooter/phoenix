#!/usr/bin/env node

// Candidate-side companion to run-source.cjs.  It invokes Phoenix's actual
// report weather module and records the same projected observable values.

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
const started = Date.now();
const require = createRequire(import.meta.url);
const fixture = require(path.join(here, 'fixtures.cjs'));

process.env.TZ = matrix.runtime.timezone;
const weather = await import(pathToFileURL(path.join(root, 'packages/skills/src/report/weather.js')).href);

function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function sourceHash(file) { return sha(fs.readFileSync(file)); }
function fail(message) { throw new Error(message); }

let randomState = matrix.runtime.randomSeed >>> 0;
Math.random = function seededRandom() {
  randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
  return randomState / 0x100000000;
};

function rawFor(run) {
  const raw = fixture.createRawWeatherData(run.variant === 'no-data' ? null : run.opts);
  return fixture.applyVariant(raw, run.variant);
}

async function execute(run, operation) {
  const prefs = fixture.buildPrefs(run);
  const parsed = await weather.weatherParse(rawFor(run), prefs);
  if (operation === 'parse') return fixture.projectWeather(parsed);
  const data = {
    skill: { session: { data: { _personalReport: {} } } },
    local: { views: {}, weather: parsed },
    runtime: { location: { iso: run.localISO } },
    log: { createChild() { return this; }, debug() {}, info() {}, warn() {}, error() {} },
  };
  await new weather.WeatherMimLogic().exit(data);
  return fixture.projectLocal(data.local);
}

const cases = [];
let expandedRuns = 0;
for (const item of matrix.cases) {
  const result = { id: item.id, group: item.group, sourceName: item.sourceName, sourceLine: item.sourceLine, runs: [] };
  let index = 0;
  for (const run of item.runs) {
    const value = await execute(run, item.operation || run.operation || 'logic');
    const canonical = JSON.stringify(fixture.stable(value));
    result.runs.push({ index, sha256: sha(canonical), value });
    index += 1;
    expandedRuns += 1;
  }
  cases.push(result);
}
if (cases.length !== matrix.counts.namedCases) fail(`case count mismatch: ${cases.length}`);
if (expandedRuns !== matrix.counts.expandedRuns) fail(`run count mismatch: ${expandedRuns}`);

const modulePaths = [
  path.join(root, 'packages/skills/src/report/weather.js'),
  path.join(root, 'packages/skills/src/report/weatherViews.js'),
];
const receipt = {
  schema: 'phoenix.parity.s09.weather-receipt.v1',
  result: 'pass',
  runtime: { node: process.version, platform: process.platform, timezone: process.env.TZ },
  candidate: { revision: process.env.PHOENIX_S09_REVISION || 'worktree', moduleSha256: Object.fromEntries(modulePaths.map(file => [path.relative(root, file), sourceHash(file)])) },
  counts: { namedCases: cases.length, expandedRuns },
  elapsedMs: Date.now() - started,
  cases,
};
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`);
process.stdout.write(JSON.stringify({ result: receipt.result, namedCases: cases.length, expandedRuns, out: outPath }) + '\n');
