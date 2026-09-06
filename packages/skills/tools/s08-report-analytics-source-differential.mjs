#!/usr/bin/env node

// Review-only control: execute the pinned compiled original Analytics builder
// and the candidate builder over the same synthetic graph data. This tool is
// intentionally outside test/ so node --test does not execute a source probe.

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildResultsAnalytics } from '../src/report/analytics.js';

const here = dirname(fileURLToPath(import.meta.url));
const reference = process.argv[2] || resolve(here, '../../../.parity/reference/5c0a7390539663ba749d360de348a428c088505c');
const sourcePath = resolve(reference, 'packages/report-skill/lib/Analytics.js');
const sourceBytes = readFileSync(sourcePath);
const sourceRequire = createRequire(sourcePath);
const sourceBuilder = sourceRequire(sourcePath).buildResultsAnalytics;

const vectors = [
  {
    id: 'full-weather-news-success', configured: false,
    active: { weather: true, calendar: false, commute: false, news: true },
    result: { weather: { relayData: {} }, news: { relayData: {} } },
  },
  {
    id: 'full-weather-provider-failure', configured: null,
    active: { weather: true, calendar: false, commute: false, news: true },
    result: { news: { relayData: {} } },
  },
  {
    id: 'single-calendar', configured: false,
    active: { weather: false, calendar: true, commute: false, news: false },
    result: { calendar: [] },
  },
  {
    id: 'single-commute-provider-failure', configured: true,
    active: { weather: false, calendar: false, commute: true, news: false },
    result: {},
  },
  {
    id: 'no-active-services', configured: false,
    active: { weather: false, calendar: false, commute: false, news: false },
    result: {},
  },
];

function makeData(vector) {
  return {
    skill: { session: { data: { _personalReport: { userPrefsConfigured: vector.configured } } } },
    local: { userPrefs: Object.fromEntries(Object.entries(vector.active).map(([k, active]) => [k, { active }])) },
    result: vector.result,
  };
}

const cases = vectors.map((vector) => {
  const source = sourceBuilder(makeData(vector));
  const candidate = buildResultsAnalytics(makeData(vector));
  return { id: vector.id, source, candidate, equal: JSON.stringify(source) === JSON.stringify(candidate) };
});

const output = {
  referenceRevision: '5c0a7390539663ba749d360de348a428c088505c',
  sourcePath,
  sourceSha256: createHash('sha256').update(sourceBytes).digest('hex'),
  candidatePath: resolve(here, '../src/report/analytics.js'),
  cases,
  pass: cases.every((entry) => entry.equal),
};
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
