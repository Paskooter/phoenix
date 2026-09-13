#!/usr/bin/env node

// S-09's matrix is deliberately generated from a compact declaration so the
// 54 archived Weather.test.js names and their branch vectors stay reviewable.
// The generated JSON is committed and is the only input consumed by either
// runner.

const cases = [];
const add = (group, name, operation, runs, sourceLine) => {
  cases.push({
    id: `s09:${group}:${String(cases.filter(c => c.group === group).length + 1).padStart(2, '0')}`,
    group,
    sourceName: name,
    sourceLine,
    operation,
    runs,
  });
};

const run = (opts = {}, extra = {}) => ({ opts, localISO: '2017-10-10T12:00:00.000-05:00', ...extra });
const evening = (opts = {}, extra = {}) => run(opts, { localISO: '2017-10-10T18:00:00.000-05:00', ...extra });
const parse = (opts = {}, extra = {}) => run(opts, { operation: 'parse', ...extra });

// The names and line numbers below are copied from the pinned source test
// file.  A case may have more than one run where the archived test chains two
// assertions under one `it` block.
add('top-level', 'Basic and Intro MIMs if icon data is available', 'logic', [
  run({ yest: { icon: null, high: null, low: null }, today: { icon: 'clear-day', high: null, low: null }, tomorrow: { icon: 'rain', high: null, low: null } }),
  evening({ yest: { icon: null, high: null, low: null }, today: { icon: 'clear-day', high: null, low: null }, tomorrow: { icon: 'rain', high: null, low: null } }),
], 66);
add('top-level', 'ServiceDown MIM if today.icon data is not available', 'logic', [run({ today: { icon: null } })], 85);
add('top-level', 'ServiceDown MIM if no data is available', 'logic', [run(null, { variant: 'no-data' })], 94);

add('parse', 'return undefined if no data', 'parse', [parse(null, { variant: 'no-data' })], 104);
add('parse', 'return undefined if no today data', 'parse', [parse({}, { variant: 'null-today' })], 111);
add('parse', 'return today and yesterday data if no tomorrow data', 'parse', [parse({}, { variant: 'truncate-tomorrow' })], 119);
add('parse', 'return today and tomorrow data if no yesterday data', 'parse', [parse({}, { variant: 'null-yesterday' })], 134);
add('parse', 'onlyWeatherActive === true if no other active categories', 'parse', [parse({}, { active: ['weather'] })], 151);
add('parse', 'onlyWeatherActive === false if any other active categories', 'parse', [parse({}, { active: ['weather', 'calendar'] })], 159);
add('parse', 'temp in °C if userPrefs.useCelsius', 'parse', [parse({}, { prefs: { useCelsius: true } })], 167);
add('parse', 'temp in °F if !userPrefs.useCelsius', 'parse', [parse({}, { prefs: { useCelsius: false } })], 178);
add('parse', 'get random weather prefix', 'parse', [parse({}, { randomPrefix: true })], 188);
add('parse', 'replace < with "less than"', 'parse', [parse({ today: { summary: 'Light snow (< 1 in.) and breezy overnight.' } })], 196);
add('parse', 'replace > with "more than"', 'parse', [parse({ today: { summary: 'Light snow (> 1 ft.) and breezy overnight.' } })], 205);
add('parse', 'replace < with "less than" when not followed by "in." or "ft."', 'parse', [parse({ today: { summary: 'Light snow (< 1 unit) and breezy overnight.' } })], 214);
add('parse', 'replace "in." with "inches"', 'parse', [parse({ today: { summary: 'Snow (9-11 in.) and breezy overnight.' } })], 223);
add('parse', 'replace "ft." with "feet"', 'parse', [parse({ today: { summary: 'Snow (9-11 ft.) and breezy overnight.' } })], 232);

const dayBase = { tomorrow: { icon: null, high: null, low: null } };
add('daytime', 'all data for today even if no tomorrow data', 'logic', [run(dayBase)], 248);
add('daytime', 'data.weather.summary is today summary', 'logic', [run(dayBase)], 258);
add('daytime', 'convert DarkSky "night" icon to "day" version', 'logic', [run({ ...dayBase, today: { icon: 'partly-cloudy-night' } })], 266);
add('daytime', 'Intro MIM', 'logic', [run(dayBase)], 275);
add('daytime', 'Condition Change MIM if change meets criteria', 'logic', [run({ ...dayBase, yest: { icon: 'cloudy' }, today: { icon: 'rain' } })], 281);
add('daytime', 'NO Condition Change MIM if NO condition change', 'logic', [run({ ...dayBase, yest: { icon: 'rain' }, today: { icon: 'rain' } })], 289);
add('daytime', 'NO Condition Change MIM without yesterday.icon', 'logic', [run({ ...dayBase, yest: { icon: null }, today: { icon: 'rain' } })], 297);
add('daytime', 'WeatherComment if NO condition change from yesterday', 'logic', [run({ ...dayBase, yest: { icon: 'rain' }, today: { icon: 'rain' } })], 305);
add('daytime', 'NO WeatherComment if condition change from yesterday', 'logic', [run({ ...dayBase, yest: { icon: 'clear-day' }, today: { icon: 'rain' } })], 313);
add('daytime', 'WetNowDryLater if currently wet but dry later (after comment)', 'logic', [run({ ...dayBase, current: { icon: 'sleet' }, today: { icon: 'clear-day' } })], 325);
add('daytime', 'WetNowDryLater if currently wet but dry later (after precip change)', 'logic', [run({ ...dayBase, yest: { icon: 'rain' }, current: { icon: 'rain' }, today: { icon: 'clear-day' } })], 333);
add('daytime', 'NO WetNowDryLater if currently wet and wet later', 'logic', [run({ ...dayBase, yest: { icon: 'snow' }, current: { icon: 'sleet' }, today: { icon: 'snow' } })], 342);
add('daytime', 'TodayHighLow MIM (and NOT TempChange MIM) if < 10°F change', 'logic', [run({ ...dayBase, yest: { high: 55 }, today: { high: 60 } })], 352);
add('daytime', 'TodayHighLow MIM (and NOT TempChange MIM) if no yest data', 'logic', [run({ ...dayBase, yest: { high: null }, today: { high: 60 } })], 361);
add('daytime', 'Works with °C', 'logic', [run({ ...dayBase, yest: { high: 85 }, today: { high: 95 } }, { prefs: { useCelsius: true } })], 372);
add('daytime', 'Hotter MIM if temp change is +10°F or more and above 85°', 'logic', [run({ ...dayBase, yest: { high: 85 }, today: { high: 95 } })], 382);
add('daytime', 'Warmer MIM if temp change is +10°F or more and below 85°', 'logic', [run({ ...dayBase, yest: { high: 60 }, today: { high: 75 } })], 391);
add('daytime', 'Cooler MIM if temp change is -10°F or more and above 40°', 'logic', [run({ ...dayBase, yest: { high: 60 }, today: { high: 45 } })], 400);
add('daytime', 'Colder MIM if temp change is -10°F or more and below 40°', 'logic', [run({ ...dayBase, yest: { high: 30 }, today: { high: 18 } })], 409);

add('evening', 'all data for tomorrow even if no today data', 'logic', [evening({ today: { icon: null, high: null, low: null } })], 427);
add('evening', 'data.weather.summary is tomorrow summary', 'logic', [evening({ today: { icon: null, high: null, low: null } })], 437);
add('evening', 'IntroTomorrow MIM', 'logic', [evening({ today: { icon: null, high: null, low: null } })], 445);
add('evening', 'NO Condition Change MIM even if change meets criteria', 'logic', [evening({ today: { icon: 'rain' }, yest: { icon: 'cloudy' } })], 451);
add('evening', 'NO WetNowDryLater if currently wet and dry later today or tomorrow', 'logic', [evening({ today: { icon: 'clear-day' }, tomorrow: { icon: 'clear-day' }, current: { icon: 'rain' } })], 459);
add('evening', 'WeatherComment even if condition change from yesterday', 'logic', [evening({ today: { icon: 'clear' }, tomorrow: { icon: 'rain' }, yest: { icon: 'cloudy' } })], 469);
add('evening', 'TomorrowHighLow MIM (NOT TempChange) if < 10°F change', 'logic', [evening({ today: { high: 60 }, tomorrow: { high: 60 }, yest: { high: 55 } })], 479);
add('evening', 'TomorrowHighLow MIM (NOT TempChange) even if > 10°F change', 'logic', [evening({ today: { high: 60 }, tomorrow: { high: 75 }, yest: { high: 45 } })], 489);
add('evening', 'TomorrowHighLow MIM (NOT TempChange) if no yest data', 'logic', [evening({ today: { high: 60 }, tomorrow: { high: 75 }, yest: { high: null } })], 499);

add('views', 'no temp view if no data, or only icon data', 'logic', [
  run({ today: { icon: null } }),
  run({ yest: { icon: null, high: null, low: null }, today: { icon: 'clear-day', high: null, low: null }, tomorrow: { high: null, low: null } }),
], 512);
add('views', 'use today data if before 5PM', 'logic', [run({ today: { high: 80 }, tomorrow: { high: 70 } })], 528);
add('views', 'use tomorrow data if after 5PM', 'logic', [evening({ today: { high: 80 }, tomorrow: { high: 70 } })], 538);
add('views', 'background is cold if below 40°F', 'logic', [run({ today: { high: 39 } })], 549);
add('views', 'background is hot if above 85°F', 'logic', [run({ today: { high: 86 } })], 557);
add('views', 'background is normal if between 40°F and 85°F', 'logic', [
  run({ today: { high: 40 } }),
  run({ today: { high: 85 } }),
], 565);
add('views', 'icon, high temp, low temp match darkSky data', 'logic', [run({ today: { high: 66, low: 57, icon: 'rain' } })], 581);
add('views', 'high temp, low temp are in °C if useCelsius = true', 'logic', [run({ today: { high: 66, low: 57 } }, { prefs: { useCelsius: true } })], 594);
add('views', 'temp x position should be offset if 1 or 3 characters', 'logic', [run({ today: { high: 6, low: -57, icon: 'rain' } })], 607);

const expected = { 'top-level': 3, parse: 14, daytime: 19, evening: 9, views: 9 };
const counts = Object.fromEntries(Object.keys(expected).map(group => [group, cases.filter(c => c.group === group).length]));
for (const [group, count] of Object.entries(expected)) {
  if (counts[group] !== count) throw new Error(`S-09 matrix group ${group}: expected ${count}, got ${counts[group]}`);
}
if (cases.length !== 54) throw new Error(`S-09 matrix: expected 54 named cases, got ${cases.length}`);

const matrix = {
  schema: 'phoenix.parity.s09.weather-matrix.v1',
  task: 'S-09',
  reference: {
    repo: 'jiboV2/pegasus',
    revision: '5c0a7390539663ba749d360de348a428c088505c',
    testPath: 'packages/report-skill/tests/subskills/Weather.test.js',
    testSha256: 'b2209e30f28ae672d99b5842da8c673c6733f4b0af09bb0bf4f01420ddd8eeac',
    sourcePaths: [
      'packages/report-skill/src/subskills/weather/WeatherData.ts',
      'packages/report-skill/src/subskills/weather/WeatherParse.ts',
      'packages/report-skill/src/subskills/weather/WeatherMimLogic.ts',
      'packages/report-skill/src/subskills/weather/WeatherViews.ts',
    ],
  },
  runtime: {
    sourceImage: 'node:8.9.4-slim',
    sourceImageDigest: 'sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c',
    timezone: 'UTC',
    randomSeed: 0x50454741,
    defaultLocalISO: '2017-10-10T12:00:00.000-05:00',
    eveningLocalISO: '2017-10-10T18:00:00.000-05:00',
  },
  counts: { namedCases: 54, expandedRuns: cases.reduce((n, c) => n + c.runs.length, 0), groups: counts },
  cases,
};

const out = new URL('./matrix.json', import.meta.url);
await import('node:fs/promises').then(fs => fs.writeFile(out, `${JSON.stringify(matrix, null, 2)}\n`));
console.log(JSON.stringify({ out: out.pathname, namedCases: matrix.counts.namedCases, expandedRuns: matrix.counts.expandedRuns, groups: counts }));
