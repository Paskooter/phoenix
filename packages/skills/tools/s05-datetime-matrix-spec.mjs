// Generates the frozen input matrix used by the S-05 date/time differential
// probes (s05-datetime-matrix-source.cjs / s05-datetime-matrix-candidate.mjs).
//
// The matrix is deliberately produced from a deterministic generator so the
// pinned original and Phoenix consume byte-identical inputs.  Running this
// script is only necessary when the matrix itself changes; the generated JSON
// fixture is committed.
import fs from 'node:fs';
import path from 'node:path';

const pad = (n, l = 2) => String(n).padStart(l, '0');

function daysInYear(y) {
  return new Date(Date.UTC(y, 1, 29)).getUTCDate() === 29 ? 366 : 365;
}

// --- seasonal-window dates: every day of several years at boundary times and
// --- several offsets, so `isInRange` is exercised across midnight, leap days,
// --- DST-shaped offsets and a non-leap century year.
const seasonDates = [];
const yearRuns = [
  [2020, '00:00:00.000', '-05:00'],
  [2020, '23:59:59.999', '+05:30'],
  [2016, '12:00:00.000', 'Z'],
  [2019, '06:00:00.000', '+14:00'],
  [2100, '00:00:00.000', '-12:00'],
];
for (const [year, time, offset] of yearRuns) {
  const total = daysInYear(year);
  for (let doy = 1; doy <= total; doy += 1) {
    const d = new Date(Date.UTC(year, 0, doy));
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    seasonDates.push(`${y}-${pad(m)}-${pad(day)}T${time}${offset}`);
  }
}
// Extra: leap-day edges, century non-leap edge, US DST transition instants,
// half-hour and quarter-hour offsets, and a missing offset.
seasonDates.push(
  '2000-02-29T00:00:00.000-05:00',
  '1900-02-28T23:59:59.999-05:00',
  '1900-03-01T00:00:00.000-05:00',
  '2024-02-29T00:00:00.000-05:00',
  '2024-02-29T23:59:59.999-05:00',
  '2016-02-29T12:00:00.000+00:00',
  '2016-03-13T01:59:59.999-05:00',
  '2016-03-13T03:00:00.000-04:00',
  '2016-11-06T01:59:59.999-04:00',
  '2016-11-06T01:00:00.000-05:00',
  '2015-12-31T23:59:59.999-12:00',
  '2016-01-01T00:00:00.000+14:00',
  '2020-06-13T10:00:00.000+05:45',
  '2020-06-13T10:00:00.000-09:30',
  '2020-06-13T10:00:00.000+12:45',
  '2020-06-13T10:00:00.000-00:30',
  '2020-06-13T10:00:00.000+00:00',
  '2020-06-13T10:00:00+00:00',
  '2020-06-13T10:00:00.000Z',
);

// --- (now, runtime location iso) pairs for the PromptData dt surface.
const nows = [
  '2018-05-22T23:21:00.159Z',
  '2020-02-29T04:30:00.000Z',
  '2016-03-13T06:59:59.999Z',
  '2016-11-06T05:30:00.000Z',
  '2026-09-11T16:00:00.000Z',
  '2020-01-01T00:00:00.000Z',
  '2019-12-31T23:59:59.999Z',
  '2024-02-29T12:00:00.000Z',
  '2020-12-31T12:00:00.000Z',
];
const dtIsos = [
  '2018-05-22T19:21:00.159-04:00',
  '2018-05-22T23:21:00.159-05:00',
  '2018-05-23T04:51:00.159+05:30',
  '2018-05-22T23:21:00.159Z',
  '2020-02-29T23:30:00.000-05:00',
  '2020-02-29T00:00:00.000+05:30',
  '2016-03-13T01:59:59.999-05:00',
  '2016-03-13T03:00:00.000-04:00',
  '2016-11-06T01:59:59.999-04:00',
  '2016-11-06T01:00:00.000-05:00',
  '2020-01-01T00:00:00.000Z',
  '2020-01-01T00:00:00.000+14:00',
  '2019-12-31T23:59:59.999-12:00',
  '2026-09-11T12:00:00.000-04:00',
  '2026-09-11T12:00:00.000+09:00',
  '2024-02-29T00:00:00.000+00:00',
  '2100-02-28T12:00:00.000-05:00',
  '2100-03-01T12:00:00.000-05:00',
  '2020-12-31T23:59:59.999Z',
  '2021-01-01T00:00:00.000+13:00',
  '2015-12-31T23:59:59.999-12:00',
  '2016-01-01T00:00:00.000+14:00',
  '2020-06-13T10:00:00.000+05:45',
  '2020-06-13T10:00:00.000-09:30',
  '0500-02-28T12:00:00.000-05:00',
  '0999-12-31T23:59:59.999Z',
  '1000-01-01T00:00:00.000Z',
  '2020-02-29T12:00:00.000+00:00',
  '2020-01-31T23:30:00.000-05:00',
  '2020-03-01T00:30:00.000-05:00',
];

const spec = {
  generatedBy: 'packages/skills/tools/s05-datetime-matrix-spec.mjs',
  referenceRevision: '5c0a7390539663ba749d360de348a428c088505c',
  nows,
  dtIsos,
  seasonDates,
  // The pinned `isInRange` accepts `M/D` or `M-D` with one or two digits and no
  // validation, which is why the raw MIM corpus pairs are reused verbatim.
  seasonPairs: JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'test', 'fixtures', 's05-isinrange-pairs.json'), 'utf8')).pairs,
};

const out = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'test', 'fixtures', 's05-datetime-matrix.json');
fs.writeFileSync(out, JSON.stringify(spec));
process.stdout.write(`seasonDates=${seasonDates.length} pairs=${spec.seasonPairs.length} dtIsos=${dtIsos.length} nows=${nows.length}\n`);
