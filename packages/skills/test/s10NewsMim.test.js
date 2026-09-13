import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { NewsMimLogic } from '../src/report/news.js';
import { SettingsClient } from '../src/report/settingsClient.js';
import { speakerIsAdult, yearsToMs } from '../src/report/utils.js';

// Source basis: jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c,
// packages/report-skill/src/subskills/news/NewsMimLogic.ts,
// packages/report-skill/src/utils.ts, SettingsClient.ts, and
// packages/report-skill/tests/subskills/News.test.js.

const NOW_ISO = '2026-06-12T12:00:00Z';

function story(category, index, { adult = false } = {}) {
  return {
    category,
    adult,
    headline: `${category}-${index}`,
    image: { source: `fixture:${category}-${index}`, width: 512, height: 300 },
  };
}

function newsFor(categories, storiesPerCategory = 1) {
  return Object.fromEntries(categories.map((category) => [
    category,
    Array.from({ length: storiesPerCategory }, (_, index) => story(category, index + 1)),
  ]));
}

function makeData({
  news = {},
  singleSkill = null,
  speaker = null,
  birthdate,
  users,
  iso = NOW_ISO,
} = {}) {
  const loopUsers = users === undefined
    ? (speaker ? [{ id: speaker, birthdate }] : [])
    : users;
  return {
    local: { news, views: {} },
    runtime: {
      perception: { speaker },
      loop: { users: loopUsers },
      location: { iso },
    },
    skill: { session: { data: { _personalReport: { singleSkill } } } },
  };
}

async function run(options = {}) {
  const data = makeData(options);
  const result = await new NewsMimLogic('News Logic').exit(data);
  assert.equal(result.transition, 'Done');
  return data;
}

function mimIds(data) {
  return data.local.mimPaths.map((path) => basename(path, '.mim'));
}

function headlines(data) {
  return data.local.news.headlines;
}

test('S-10 preserves default and configured category order through MIMs and headlines', async () => {
  const defaults = SettingsClient.getDefaultPrefs().news.activeNewsCategories;
  const defaultOrder = Object.keys(defaults).filter((category) => defaults[category]);
  assert.deepEqual(defaultOrder, ['technology', 'sports', 'business', 'national']);

  const defaultData = await run({ news: newsFor(defaultOrder) });
  assert.deepEqual(headlines(defaultData), defaultOrder.map((category) => `${category}-1`));
  assert.deepEqual(mimIds(defaultData), [
    'NewsIntro', 'NewsHeadline', 'NewsHeadline', 'NewsHeadline', 'NewsHeadline',
  ]);

  const configuredOrder = ['strange', 'business', 'technology'];
  const configuredData = await run({ news: newsFor(configuredOrder) });
  assert.deepEqual(headlines(configuredData), configuredOrder.map((category) => `${category}-1`));
  assert.deepEqual(mimIds(configuredData), [
    'NewsIntro', 'NewsHeadline', 'NewsHeadline', 'NewsHeadline',
  ]);
});

test('S-10 selects 3 stories for one category, 2 per category for two, and 1 per category for 3+', async () => {
  const one = await run({ news: newsFor(['technology'], 4) });
  assert.deepEqual(headlines(one), ['technology-1', 'technology-2', 'technology-3']);
  assert.equal(one.local.views.newsImages.length, 3);
  assert.deepEqual(mimIds(one), ['NewsIntro', 'NewsHeadline', 'NewsHeadline', 'NewsHeadline']);

  const two = await run({ news: newsFor(['technology', 'business'], 3) });
  assert.deepEqual(headlines(two), [
    'technology-1', 'technology-2', 'business-1', 'business-2',
  ]);
  assert.equal(two.local.views.newsImages.length, 4);
  assert.deepEqual(mimIds(two), [
    'NewsIntro', 'NewsHeadline', 'NewsHeadline', 'NewsHeadline', 'NewsHeadline',
  ]);

  const three = await run({ news: newsFor(['technology', 'business', 'sports'], 2) });
  assert.deepEqual(headlines(three), ['technology-1', 'business-1', 'sports-1']);
  assert.equal(three.local.views.newsImages.length, 3);
  assert.deepEqual(mimIds(three), ['NewsIntro', 'NewsHeadline', 'NewsHeadline', 'NewsHeadline']);
});

test('S-10 trims more than five categories with source random-splice behavior and preserves survivors order', async () => {
  const categories = ['technology', 'sports', 'business', 'science', 'entertainment', 'strange', 'health'];
  const previousRandom = Math.random;
  Math.random = () => 0;
  try {
    const data = await run({ news: newsFor(categories) });
    assert.deepEqual(headlines(data), [
      'business-1', 'science-1', 'entertainment-1', 'strange-1', 'health-1',
    ]);
    assert.deepEqual(mimIds(data), [
      'NewsIntro', 'NewsHeadline', 'NewsHeadline', 'NewsHeadline', 'NewsHeadline', 'NewsHeadline',
    ]);
  } finally {
    Math.random = previousRandom;
  }
});

test('S-10 appends Outro only for the single news skill', async () => {
  const single = await run({ news: newsFor(['technology'], 3), singleSkill: 'news' });
  assert.deepEqual(mimIds(single), ['NewsIntro', 'NewsHeadline', 'NewsHeadline', 'NewsHeadline', 'NewsOutro']);

  const fullReport = await run({ news: newsFor(['technology'], 3), singleSkill: null });
  assert.deepEqual(mimIds(fullReport), ['NewsIntro', 'NewsHeadline', 'NewsHeadline', 'NewsHeadline']);

  // A different single skill must not accidentally receive NewsOutro.
  const weather = await run({ news: newsFor(['technology'], 3), singleSkill: 'weather' });
  assert.equal(mimIds(weather).includes('NewsOutro'), false);
});

test('S-10 distinguishes service-down, app-setup, and empty-category fallbacks', async () => {
  const noService = await run({ news: null });
  assert.deepEqual(mimIds(noService), ['NewsServiceDown']);
  assert.deepEqual(noService.local.views, {});

  const noCategories = await run({ news: {} });
  assert.deepEqual(mimIds(noCategories), ['NewsAppSetup']);
  assert.deepEqual(noCategories.local.views, {});

  const noHeadlines = await run({ news: { technology: [] } });
  assert.deepEqual(mimIds(noHeadlines), ['NewsServiceDown']);
  assert.deepEqual(noHeadlines.local.views, {});
});

test('S-10 filters adult stories before applying the per-category limit', async () => {
  const news = {
    technology: [
      story('technology', 'adult-first', { adult: true }),
      story('technology', 'safe-1'),
      story('technology', 'safe-2'),
      story('technology', 'safe-3'),
      story('technology', 'safe-4'),
    ],
  };
  const child = await run({ news: structuredClone(news) });
  assert.deepEqual(headlines(child), ['technology-safe-1', 'technology-safe-2', 'technology-safe-3']);

  const adult = await run({
    news: structuredClone(news),
    speaker: 'adult',
    birthdate: Date.parse(NOW_ISO) - yearsToMs(13),
  });
  assert.deepEqual(headlines(adult), ['technology-adult-first', 'technology-safe-1', 'technology-safe-2']);
});

test('S-10 speakerIsAdult uses the source 13-year inclusive boundary with offset-aware now', async () => {
  const cases = [
    { name: 'positive offset exact boundary', iso: '2026-06-12T12:00:00+09:00' },
    { name: 'negative offset exact boundary', iso: '2026-06-11T19:00:00-08:00' },
  ];
  for (const { name, iso } of cases) {
    const instant = Date.parse(iso);
    const exact = makeData({ speaker: 'u1', birthdate: instant - yearsToMs(13), iso });
    const younger = makeData({ speaker: 'u1', birthdate: instant - yearsToMs(13) + 1, iso });
    assert.equal(speakerIsAdult(exact), true, `${name}: exact threshold is adult`);
    assert.equal(speakerIsAdult(younger), false, `${name}: one millisecond younger is child`);
  }

  const adultBirthdate = Date.parse(NOW_ISO) - yearsToMs(18);
  assert.equal(speakerIsAdult(makeData({ users: [{ id: 'other', birthdate: adultBirthdate }], speaker: 'u1' })), false);
  assert.equal(speakerIsAdult(makeData({ users: [{ id: 'u1' }], speaker: 'u1' })), false);
  assert.equal(speakerIsAdult(makeData({ users: [{ id: 'u1', birthdate: adultBirthdate }] })), false);
});

test('S-10 hides adult stories for unidentified and child speakers, while allowing identified adults', async () => {
  const adultOnly = { technology: [story('technology', 1, { adult: true })] };

  const unidentified = await run({ news: adultOnly });
  assert.deepEqual(mimIds(unidentified), ['NewsServiceDown']);

  const child = await run({
    news: adultOnly,
    speaker: 'child',
    birthdate: Date.parse(NOW_ISO) - yearsToMs(13) + 1,
  });
  assert.deepEqual(mimIds(child), ['NewsServiceDown']);

  const identifiedAdult = await run({
    news: adultOnly,
    speaker: 'adult',
    birthdate: Date.parse(NOW_ISO) - yearsToMs(13),
  });
  assert.deepEqual(mimIds(identifiedAdult), ['NewsIntro', 'NewsHeadline']);
  assert.deepEqual(headlines(identifiedAdult), ['technology-1']);
});

test('S-10 keeps the source negative control: a non-adult item remains playable without a speaker', async () => {
  const data = await run({ news: { technology: [story('technology', 1)] } });
  assert.deepEqual(mimIds(data), ['NewsIntro', 'NewsHeadline']);
  assert.deepEqual(headlines(data), ['technology-1']);
});
