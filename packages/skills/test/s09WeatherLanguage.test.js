// S-09 — report weather language/resources against the pinned Pegasus source.
// Source: jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c
//   packages/report-skill/src/subskills/weather/WeatherMimLogic.ts
//   packages/report-skill/src/subskills/weather/WeatherParse.ts
//   packages/report-skill/mims/en-us/*.mim
//   packages/report-skill/resources/{mimPromptText.json,views/weatherHiLo.json}
//
// The per-file bytes/hashes below were captured from the Jibo/Gebo MCP at the
// source revision above. Keeping them in the test makes the re-homed language
// library auditable without requiring a live source checkout at test time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildPromptData,
  generateSlimFromMim,
  generateSlimSequence,
  loadMims,
  PromptCategory,
  PromptSubCategory,
} from '../src/index.js';
import { WeatherMimLogic, weatherParse } from '../src/report/weather.js';

const SOURCE_REVISION = '5c0a7390539663ba749d360de348a428c088505c';
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SKILLS = resolve(TEST_DIR, '..');
const WEATHER_MIM_DIR = join(SKILLS, 'resources', 'mims', 'report', 'en-us');
const WEATHER_RESOURCE_DIR = join(SKILLS, 'resources');

const INVENTORY = Object.freeze({
  'WeatherBasicClearDay.mim': { bytes: 3789, sha256: 'fbbdffb2dce3e68fc98005e48fc89193876c8dbf378c51189e6c3ee38d5beeab', prompts: 8, refs: ['skill.weather.icon'] },
  'WeatherBasicClearNight.mim': { bytes: 3893, sha256: 'f8268ba89ef37278b46f9e3b778bac79d97e87229c4baaddbcae461a92bd1fce', prompts: 8, refs: ['skill.weather.icon'] },
  'WeatherBasicFog.mim': { bytes: 3681, sha256: '6ce27d943a5d5b104437d4d5a6d801fa4c3ed5578bf9129dce89cdfa71700ee3', prompts: 8, refs: ['skill.weather.icon'] },
  'WeatherBasicPartlyCloudyDay.mim': { bytes: 4098, sha256: '945dcfab3aea91a5dcf7ff3598dc9ef6d9976082d7b126540ce4b080ee71f98f', prompts: 8, refs: ['skill.weather.icon'] },
  'WeatherBasicPartlyCloudyNight.mim': { bytes: 4016, sha256: '8581b9a6a6c26e8000e9e7e067fb7baff9b685a3e340926b0682f7bf337885ec', prompts: 8, refs: ['skill.weather.icon'] },
  'WeatherBasicRain.mim': { bytes: 3766, sha256: 'd33ded50caf5e2bb67ee0b574e08a91d1c4ff980fff2386e44284584bcda4070', prompts: 8, refs: ['skill.weather.icon'] },
  'WeatherBasicSleet.mim': { bytes: 3733, sha256: 'd0f6bbd38d7d064af1cccfe818302a46ca67fa522881370fedc543af12c8209c', prompts: 8, refs: ['skill.weather.icon'] },
  'WeatherBasicSnow.mim': { bytes: 3728, sha256: '5ec7a2dcf8013ff11b0e6c71a49ff5c4f78951299e1944047460617216178572', prompts: 8, refs: ['skill.weather.icon'] },
  'WeatherBasicWind.mim': { bytes: 3626, sha256: '937e0ad0d22e7e5e6f575e1985ff522f978413f2c72b336e94d2145e81d31bbc', prompts: 8, refs: ['skill.weather.icon'] },
  'WeatherChangeClearWet.mim': { bytes: 8098, sha256: '44ee57018fbe3dc4ca684d471028b0a43bce243ecc128dccbe5a6130fdd8db83', prompts: 17, refs: ['skill.weather.icon', 'skill.weather.prefix', 'skill.weather.summary', "dt.now.isInRange('6/1', '8/31')", "dt.now.isInRange('7/1', '8/31')", "dt.now.isInRange('6/1', '9/30')"] },
  'WeatherChangeCloudyClear.mim': { bytes: 6094, sha256: 'd72e9c6836410953c5626e077daf797d499bc16eb5a463ccca989357f5f0de2e', prompts: 13, refs: ['skill.weather.icon', 'skill.weather.prefix', 'skill.weather.summary'] },
  'WeatherChangeCloudyWet.mim': { bytes: 8607, sha256: '16ceba95bbcc05b6ccd92c7cd1935198d29df8524caffe61d0b8247c57692099', prompts: 18, refs: ['skill.weather.icon', 'skill.weather.prefix', 'skill.weather.summary', "dt.now.isInRange('6/1', '8/31')", "dt.now.isInRange('7/1', '8/31')"] },
  'WeatherChangeWetClear.mim': { bytes: 8401, sha256: '2fda24a7af249ecbfb52415b5e4fce5f62097aa9d3e6ce9364fe2588fe4ec322', prompts: 18, refs: ['skill.weather.icon', 'skill.weather.prefix', 'skill.weather.summary', "dt.now.isInRange('6/1', '8/31')", "dt.now.isInRange('7/1', '8/31')"] },
  'WeatherCommentClearDay.mim': { bytes: 6131, sha256: 'e1d13d9b4be6499def1a827a83770d75cd885999c30eb8748477e8d1ff55c434', prompts: 13, refs: ['skill.weather.icon', 'skill.weather.prefix', 'skill.weather.summary'] },
  'WeatherCommentClearNight.mim': { bytes: 4335, sha256: '33a20c851210e22e3c73293e24435dace53a0d67dc0834cffd7389be7ea4d0c0', prompts: 9, refs: ['skill.weather.icon', 'skill.weather.prefix', 'skill.weather.summary'] },
  'WeatherCommentCloudy.mim': { bytes: 3903, sha256: '98449639710c9df54b16bf72b564f5608acdcc242a28a25e916ac3398f0fa839', prompts: 8, refs: ['skill.weather.icon', 'skill.weather.prefix', 'skill.weather.summary'] },
  'WeatherCommentFog.mim': { bytes: 3856, sha256: '30ea40e9979108fcb52e754c6b153a5b5eda58574afe0b7872b26a7e172f250a', prompts: 8, refs: ['skill.weather.icon', 'skill.weather.prefix', 'skill.weather.summary'] },
  'WeatherCommentPartlyCloudyDay.mim': { bytes: 5056, sha256: '973a5c7a4fe5bbaafed3599f0c9bc4d6d6b58a964a6dc392c56bc086852f2a39', prompts: 10, refs: ['skill.weather.icon', 'skill.weather.prefix', 'skill.weather.summary'] },
  'WeatherCommentPartlyCloudyNight.mim': { bytes: 4595, sha256: '21b59cabcd158d07de0a9e93cc6fb1cfd464d699925057c89d39e258a7ae2dc8', prompts: 9, refs: ['skill.weather.icon', 'skill.weather.prefix', 'skill.weather.summary'] },
  'WeatherCommentRain.mim': { bytes: 6050, sha256: 'dbc84a60fb0377f155ba6ff546c19f7832ef8fa0c0be5913ab35d95e6f05d94f', prompts: 13, refs: ['skill.weather.icon', 'skill.weather.prefix', 'skill.weather.summary', "dt.now.isInRange('6/1', '9/30')"] },
  'WeatherCommentSleet.mim': { bytes: 3846, sha256: '268b51174be625cda7409aaa72aaa36acb03ca62f4eec7353cbf1445a5edabe4', prompts: 8, refs: ['skill.weather.icon', 'skill.weather.prefix', 'skill.weather.summary'] },
  'WeatherCommentSnow.mim': { bytes: 5555, sha256: '1b52b50571088017f6daffa2577314c083fd7747c5c39b5c64b98adabc8f59a7', prompts: 12, refs: ['skill.weather.icon', 'skill.weather.prefix', 'skill.weather.summary'] },
  'WeatherCommentWind.mim': { bytes: 3347, sha256: 'f2ef2a0feffe389d77394cf4bd88d191cc1d34e3b04c352ffd4ed34a0f24a38d', prompts: 7, refs: ['skill.weather.icon', 'skill.weather.prefix', 'skill.weather.summary'] },
  'WeatherIntro.mim': { bytes: 5036, sha256: 'e6bfbdb404413e3b9394f14ee7d220847b531d77dbc0117e0a7383aa85b2b3e5', prompts: 16, refs: ['skill.weather.onlyWeatherActive'] },
  'WeatherIntroTomorrow.mim': { bytes: 5262, sha256: '2e06c1d16ec833711731668ab688cfdae8cfd29490a70d80063f1145750601fa', prompts: 16, refs: ['skill.weather.onlyWeatherActive'] },
  'WeatherServiceDown.mim': { bytes: 1502, sha256: '3b88e4d19dba9224ee5a9cc67c8142f500c4d443bde07bbc855903c3b6012897', prompts: 4, refs: [] },
  'WeatherTodayColder.mim': { bytes: 3268, sha256: 'aaf2777d12fbb6ba9f4978c357513f2304192d51ce4d90fbbd23980bc2206ba1', prompts: 8, refs: ['skill.weather.today.highTemp', 'skill.weather.today.lowTemp'] },
  'WeatherTodayCooler.mim': { bytes: 3233, sha256: 'f22a85e8225c4eaa6cd32c20c12486c06eef39dd816f5b965b3ca75c4d296929', prompts: 8, refs: ['skill.weather.today.highTemp', 'skill.weather.today.lowTemp'] },
  'WeatherTodayHighLow.mim': { bytes: 2115, sha256: '11c54bbae52d1c983642cd44dd4cde941386ddee163ff6ad3a06f1615bc7bea3', prompts: 5, refs: ['skill.weather.today.highTemp', 'skill.weather.today.lowTemp'] },
  'WeatherTodayHotter.mim': { bytes: 4455, sha256: '7782e1f11a1cf05a931795104779c55f94b07b5fee117a1607732d01e7879e0a', prompts: 11, refs: ['skill.weather.today.highTemp', 'skill.weather.today.lowTemp'] },
  'WeatherTodayWarmer.mim': { bytes: 4086, sha256: '8208e2f9c4530e8cb97ef64e9efde49f95e738d8e4e336538614f602ac62d2ef', prompts: 10, refs: ['skill.weather.today.highTemp', 'skill.weather.today.lowTemp'] },
  'WeatherTomorrowHighLow.mim': { bytes: 2177, sha256: '311cad3fc68a3872fa37b911909e8818e55acaa3192fa73921f02137d9ee93eb', prompts: 5, refs: ['skill.weather.tomorrow.highTemp', 'skill.weather.tomorrow.lowTemp'] },
  'WeatherWetNowDryLater.mim': { bytes: 620, sha256: 'e2a138b0ddc00512cea0d92107aa9da21c4a6e1e1eaf6155cf4d7d4182e67107', prompts: 1, refs: [] },
  'WetNowDryLater.mim': { bytes: 4783, sha256: 'cf3267aa2107303c507d1aa344a9946d535a3d3fff94c6a29469baf1e21b10c1', prompts: 13, refs: ['skill.weather.current.icon'] },
});

const SOURCE_PROMPT_TEXT_SHA256 = '1b987df35fd07a0094e502898071ac066544798c955f44b862cadb115cc61f71';
const SOURCE_WEATHER_VIEW_SHA256 = '89cbcfd06e3e18d34226e7e600b756446078199db53335300ba4c5884c9d8a4a';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const files = () => readdirSync(WEATHER_MIM_DIR)
  .filter((name) => name.startsWith('Weather') || name === 'WetNowDryLater.mim')
  .sort();
const sourceRefs = (raw) => [...new Set([
  ...(raw.match(/skill\.weather(?:\.[A-Za-z0-9_]+)+/g) || []),
  ...(raw.match(/dt\.now\.isInRange\('[^']+', '[^']+'\)/g) || []),
])].sort();
const mimIds = (value) => value.map((path) => basename(path, '.mim'));

function weatherData({
  iso = '2026-06-12T12:00:00-04:00',
  singleSkill = 'weather',
  entities = {},
  yestIcon = 'clear-day',
  yestHigh = 65,
  todayIcon = 'clear-day',
  todayHigh = 70,
  todayLow = 55,
  tomorrowIcon = 'rain',
  tomorrowHigh = 72,
  tomorrowLow = 53,
  currentIcon = todayIcon,
  useCelsius = false,
  todaySummary = 'Clear skies.',
  tomorrowSummary = 'Rain tomorrow.',
} = {}) {
  return {
    local: {
      weather: {
        yest: { icon: yestIcon, highTemp: yestHigh, lowTemp: 50, summary: 'Yesterday.' },
        today: { icon: todayIcon, highTemp: todayHigh, lowTemp: todayLow, summary: todaySummary },
        tomorrow: { icon: tomorrowIcon, highTemp: tomorrowHigh, lowTemp: tomorrowLow, summary: tomorrowSummary },
        current: { icon: currentIcon, temp: 65, summary: 'Current.' },
        // WeatherMimLogic promotes the selected day into these root fields
        // before the report MIMs are rendered.
        icon: todayIcon,
        summary: todaySummary,
        useCelsius,
        onlyWeatherActive: true,
        prefix: 'Looks like',
      },
      views: {},
    },
    runtime: { location: { iso } },
    skill: { session: { data: { _personalReport: { singleSkill, nlu: { entities } } } } },
  };
}

function entryConfig() {
  return { category: PromptCategory.ENTRY, subCategory: PromptSubCategory.ANNOUNCEMENT, index: 1, noMatch: 0, noInput: 0 };
}

test('S-09 inventory: all 34 weather MIMs and both weather resources match MCP source bytes', () => {
  assert.equal(SOURCE_REVISION, '5c0a7390539663ba749d360de348a428c088505c');
  assert.deepEqual(files(), Object.keys(INVENTORY).sort());

  for (const name of files()) {
    const raw = readFileSync(join(WEATHER_MIM_DIR, name), 'utf8');
    const mim = JSON.parse(raw);
    const expected = INVENTORY[name];
    assert.equal(Buffer.byteLength(raw), expected.bytes, `${name}: byte length`);
    assert.equal(sha256(raw), expected.sha256, `${name}: SHA-256`);
    assert.equal(mim.prompts.length, expected.prompts, `${name}: prompt count`);
    assert.deepEqual(sourceRefs(raw), [...expected.refs].sort(), `${name}: dynamic references`);
  }

  assert.equal(sha256(readFileSync(join(WEATHER_RESOURCE_DIR, 'report-mimPromptText.json')), SOURCE_PROMPT_TEXT_SHA256), '1b987df35fd07a0094e502898071ac066544798c955f44b862cadb115cc61f71');
  assert.equal(sha256(readFileSync(join(WEATHER_RESOURCE_DIR, 'views', 'weatherHiLo.json')), SOURCE_WEATHER_VIEW_SHA256), '89cbcfd06e3e18d34226e7e600b756446078199db53335300ba4c5884c9d8a4a');
});

test('S-09 loader: every weather MIM is loaded from its Phoenix path and gets the source filename ID fallback', async () => {
  const paths = files().map((name) => join(WEATHER_MIM_DIR, name));
  const loaded = await loadMims(paths, {});
  assert.equal(loaded.length, 34);
  assert.deepEqual(loaded.map((mim) => mim.mim_id).sort(), files().map((name) => basename(name, '.mim')).sort());
  assert.ok(loaded.every((mim) => mim.mim_type === 'announcement'));
  assert.ok(loaded.every((mim) => Array.isArray(mim.prompts) && mim.prompts.length > 0));
});

test('S-09 prompt rendering: every weather MIM resolves its dynamic values through the Phoenix Slimmer', async () => {
  const paths = files().map((name) => join(WEATHER_MIM_DIR, name));
  const loaded = await loadMims(paths, {});
  // Use rain for the current condition so WetNowDryLater has a valid source
  // branch while the selected-day icon remains clear-day.
  const weather = weatherData({ currentIcon: 'rain' }).local.weather;
  const promptData = buildPromptData({ location: { iso: '2026-06-12T12:00:00-04:00' } }, { weather });

  for (const mim of loaded) {
    const slim = generateSlimFromMim(mim, entryConfig(), promptData, { rng: () => 0 });
    assert.ok(slim && slim.play, `${mim.mim_id}: selected Entry-Core/AN prompt`);
    assert.equal(slim.play.meta.mim_id, mim.mim_id);
    assert.ok(mim.prompts.some((prompt) => prompt.prompt_id === slim.play.meta.prompt_id), `${mim.mim_id}: prompt metadata`);
    assert.equal(slim.play.esml.includes('${'), false, `${mim.mim_id}: all template variables resolved`);
    const refs = INVENTORY[`${mim.mim_id}.mim`].refs;
    for (const ref of refs) {
      if (ref.startsWith('skill.weather.icon')) assert.match(slim.play.esml, /meta='clear-day'/);
      if (ref === 'skill.weather.current.icon') assert.match(slim.play.esml, /raining/);
      if (ref === 'skill.weather.prefix') assert.match(slim.play.esml, /Looks like/);
      if (ref === 'skill.weather.summary') assert.match(slim.play.esml, /Clear skies\.|Rain tomorrow\./);
      if (ref.includes('today.highTemp')) assert.match(slim.play.esml, /70/);
      if (ref.includes('today.lowTemp')) assert.match(slim.play.esml, /55/);
      if (ref.includes('tomorrow.highTemp')) assert.match(slim.play.esml, /72/);
      if (ref.includes('tomorrow.lowTemp')) assert.match(slim.play.esml, /53/);
    }
  }
});

test('S-09 parse: source-shaped weather data supplies prompt prefix, units, tomorrow data, and sanitized summaries', async () => {
  const prefs = {
    weather: { useCelsius: false, active: true },
    calendar: { active: false }, commute: { active: false }, news: { active: false },
  };
  const parsed = await weatherParse([
    { daily: { data: [{ temperatureHigh: 60, temperatureLow: 40, summary: 'Yesterday', icon: 'cloudy' }] } },
    { currently: { temperature: 71, summary: 'Snow (< 1 in.)', icon: 'rain' }, daily: { data: [
      { temperatureHigh: 75.2, temperatureLow: 54.7, summary: 'Rain', icon: 'rain' },
      { temperatureHigh: 80.1, temperatureLow: 59.1, summary: 'Clear', icon: 'clear-day' },
    ] } },
  ], prefs);
  assert.ok(parsed && parsed.prefix);
  assert.equal(parsed.today.highTemp, 75);
  assert.equal(parsed.today.lowTemp, 55);
  assert.equal(parsed.tomorrow.highTemp, 80);
  assert.equal(parsed.current.temp, 71);
  assert.equal(parsed.current.summary, 'Snow (less than 1 inch)');
  assert.equal(parsed.onlyWeatherActive, true);
});

test('S-09 sequence: location-local 5 PM cutoff selects today at 17:30 and tomorrow at 18:00', async () => {
  const today = weatherData({
    singleSkill: null,
    iso: '2026-06-12T17:30:00-04:00',
    todayIcon: 'clear-day', currentIcon: 'clear-day', tomorrowIcon: 'rain',
  });
  await new WeatherMimLogic().exit(today);
  assert.deepEqual(mimIds(today.local.mimPaths), ['WeatherIntro', 'WeatherCommentClearDay', 'WeatherTodayHighLow']);

  const tomorrow = weatherData({
    singleSkill: null,
    iso: '2026-06-12T18:00:00-04:00',
    todayIcon: 'clear-day', currentIcon: 'clear-day', tomorrowIcon: 'rain',
  });
  await new WeatherMimLogic().exit(tomorrow);
  assert.deepEqual(mimIds(tomorrow.local.mimPaths), ['WeatherIntroTomorrow', 'WeatherCommentRain', 'WeatherTomorrowHighLow']);

  const sequence = await generateSlimSequence(entryConfig(), {
    mimDataProvider: tomorrow.local.mimPaths,
    promptDataProvider: () => ({ weather: tomorrow.local.weather }),
    viewDataProvider: () => tomorrow.local,
  }, tomorrow, { rng: () => 0 });
  assert.ok(sequence);
  assert.deepEqual(sequence.children.map((slim) => slim.config.play.meta.mim_id), ['WeatherIntroTomorrow', 'WeatherCommentRain', 'WeatherTomorrowHighLow']);
  assert.ok(sequence.children.every((slim) => !slim.config.play.esml.includes('${')));
});

test('S-09 condition table: all source condition-change branches suppress comments', async () => {
  const cases = [
    ['cloudy→clear', 'cloudy', 'clear-day', 'WeatherChangeCloudyClear'],
    ['cloudy→wet', 'cloudy', 'rain', 'WeatherChangeCloudyWet'],
    ['wet→clear', 'rain', 'clear-day', 'WeatherChangeWetClear'],
    ['clear→wet', 'clear-day', 'snow', 'WeatherChangeClearWet'],
  ];
  for (const [label, yestIcon, todayIcon, expected] of cases) {
    const data = weatherData({ yestIcon, todayIcon, currentIcon: todayIcon });
    await new WeatherMimLogic().exit(data);
    const ids = mimIds(data.local.mimPaths);
    assert.equal(ids[1], expected, label);
    assert.equal(ids.some((id) => id.startsWith('WeatherComment')), false, `${label}: comment suppressed`);
  }
});

test('S-09 temperature table: °F/°C thresholds select hotter, warmer, cooler, and colder MIMs', async () => {
  const cases = [
    ['hotter F', false, 80, 95, 'WeatherTodayHotter'],
    ['warmer F', false, 60, 75, 'WeatherTodayWarmer'],
    ['cooler F', false, 60, 45, 'WeatherTodayCooler'],
    ['colder F', false, 30, 18, 'WeatherTodayColder'],
    ['hotter C', true, 20, 30, 'WeatherTodayHotter'],
    ['warmer C', true, 20, 26, 'WeatherTodayWarmer'],
    ['cooler C', true, 20, 14, 'WeatherTodayCooler'],
    ['colder C', true, 20, 3, 'WeatherTodayColder'],
  ];
  for (const [label, useCelsius, yestHigh, todayHigh, expected] of cases) {
    const data = weatherData({ useCelsius, yestHigh, todayHigh, todayIcon: 'clear-day', currentIcon: 'clear-day' });
    await new WeatherMimLogic().exit(data);
    assert.equal(mimIds(data.local.mimPaths)[2], expected, label);
  }
});

test('S-09 icon/service table: every source Basic icon and ServiceDown path remains reachable', async () => {
  // The pinned source maps `cloudy` to BasicCloudy, but its MIM inventory has
  // no WeatherBasicCloudy.mim. Keep the source path assertion below and make
  // the omission explicit rather than inventing prompt content.
  assert.equal(existsSync(join(WEATHER_MIM_DIR, 'WeatherBasicCloudy.mim')), false);
  const icons = [
    ['clear-day', '12:00', 'WeatherBasicClearDay'],
    ['clear-night', '22:00', 'WeatherBasicClearNight'],
    ['rain', '12:00', 'WeatherBasicRain'],
    ['snow', '12:00', 'WeatherBasicSnow'],
    ['sleet', '12:00', 'WeatherBasicSleet'],
    ['fog', '12:00', 'WeatherBasicFog'],
    ['wind', '12:00', 'WeatherBasicWind'],
    ['cloudy', '12:00', 'WeatherBasicCloudy'],
    ['partly-cloudy-day', '12:00', 'WeatherBasicPartlyCloudyDay'],
    ['partly-cloudy-night', '22:00', 'WeatherBasicPartlyCloudyNight'],
  ];
  for (const [icon, time, expected] of icons) {
    const data = weatherData({
      iso: `2026-06-12T${time}:00-04:00`,
      todayIcon: icon, currentIcon: icon,
      todayHigh: null, todayLow: null, todaySummary: null,
    });
    data.local.weather.today = { icon };
    await new WeatherMimLogic().exit(data);
    assert.deepEqual(mimIds(data.local.mimPaths), ['WeatherIntro', expected], icon);
  }

  const down = weatherData({ todayIcon: null, currentIcon: null });
  down.local.weather.today = {};
  await new WeatherMimLogic().exit(down);
  assert.deepEqual(mimIds(down.local.mimPaths), ['WeatherServiceDown']);
});

test('S-09 wet-now branch and tomorrow request preserve exact MIM order', async () => {
  const wet = weatherData({ todayIcon: 'clear-day', currentIcon: 'rain', tomorrowIcon: 'clear-day' });
  await new WeatherMimLogic().exit(wet);
  assert.deepEqual(mimIds(wet.local.mimPaths), ['WeatherIntro', 'WeatherCommentClearDay', 'WeatherWetNowDryLater', 'WeatherTodayHighLow']);

  const requestedTomorrow = weatherData({ entities: { date: 'tomorrow' }, todayIcon: 'rain', currentIcon: 'rain', tomorrowIcon: 'clear-day' });
  await new WeatherMimLogic().exit(requestedTomorrow);
  assert.deepEqual(mimIds(requestedTomorrow.local.mimPaths), ['WeatherIntroTomorrow', 'WeatherCommentClearDay', 'WeatherTomorrowHighLow']);
});
