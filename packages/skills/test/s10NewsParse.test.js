// S-10 — NewsParse / archived News.test.js parser and filter parity.
// The source reference is jiboV2/pegasus at 5c0a7390539663ba749d360de348a428c088505c.
// These fixtures keep the AP/NITF nesting because parser behavior depends on it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { NewsMimLogic, newsParse } from '../src/report/news.js';

const CLEAN_SUMMARY = 'A clean summary about ordinary things.';
const FULL_IMAGE = { source: 'full', width: '4000', height: '3000' };
const THUMB_IMAGE = { source: 'thumbnail', width: '128', height: '80' };

function goodImage(source = 'preview', width = '640', height = '360') {
  return { source, width, height };
}

function imageContent(preview) {
  return [{
    nitf: [{
      body: [{
        'body.content': [{
          media: [{
            'media-reference': [
              { $: FULL_IMAGE },
              { $: preview },
              { $: THUMB_IMAGE },
            ],
          }],
        }],
      }],
    }],
  }];
}

function makeEntry({
  headline = 'Headline',
  summary = CLEAN_SUMMARY,
  summaryField,
  imageMeta = goodImage(),
  includeContent = true,
} = {}) {
  const entry = {
    summary: summaryField === undefined ? [summary] : summaryField,
    'apcm:ContentMetadata': [{ 'apcm:ExtendedHeadLine': [headline] }],
  };
  if (includeContent) entry.content = imageContent(imageMeta);
  return entry;
}

function makeCategory(name, entries) {
  return {
    category: { name },
    data: { feed: { entry: entries } },
  };
}

function makeSeries(name, {
  count = 5,
  headlineFor,
  summaryFor,
  summaryFieldFor,
  imageFor,
} = {}) {
  return makeCategory(name, Array.from({ length: count }, (_, index) => makeEntry({
    headline: headlineFor ? headlineFor(index) : name + ' headline ' + (index + 1),
    summary: summaryFor ? summaryFor(index) : CLEAN_SUMMARY,
    summaryField: summaryFieldFor ? summaryFieldFor(index) : undefined,
    imageMeta: imageFor ? imageFor(index) : goodImage(),
  })));
}

function makeNews(categories) {
  return categories;
}

function runtimeFor(mode) {
  const birthdate = mode === 'adult' ? '1990-01-01' : mode === 'child' ? '2016-06-12' : undefined;
  return {
    perception: { speaker: 'u1' },
    loop: { users: birthdate ? [{ id: 'u1', birthdate }] : [] },
    location: { iso: '2026-06-12T12:00:00.000Z' },
  };
}

async function runLogic(rawNews, mode = 'adult') {
  const data = {
    local: { news: newsParse(rawNews), views: {} },
    runtime: runtimeFor(mode),
    skill: { session: { data: { _personalReport: { singleSkill: null } } } },
  };
  await new NewsMimLogic('News Logic').exit(data);
  return data;
}

function assertServiceDown(data) {
  assert.equal(data.local.mimPaths.length, 1);
  assert.match(data.local.mimPaths[0], /NewsServiceDown\.mim$/);
}

function parserHeadlines(summary) {
  const parsed = newsParse([makeCategory('fixture', [
    makeEntry({ headline: 'Provider header' }),
    makeEntry({ headline: 'Candidate', summary }),
    makeEntry({ headline: 'Tail' }),
  ])]);
  return parsed.fixture.map((item) => item.headline);
}

test('S-10 BANNED_KEYWORDS is the exact 361-word set from the pinned NewsParse.ts', () => {
  const moduleSource = readFileSync(new URL('../src/report/news.js', import.meta.url), 'utf8');
  const declaration = moduleSource.match(/const BANNED_KEYWORDS = new Set\(\[[\s\S]*?\]\);/);
  assert.ok(declaration, 'BANNED_KEYWORDS declaration');
  const keywords = [...declaration[0].matchAll(/"((?:\\.|[^"\\])*)"/g)]
    .map((match) => JSON.parse('"' + match[1] + '"'));
  assert.equal(keywords.length, 361);
  assert.equal(new Set(keywords).size, 361);
  const digest = createHash('sha256').update([...new Set(keywords)].sort().join('\n')).digest('hex');
  assert.equal(digest, 'cb255099f5922535589f6b5290f6486a4ecccb4e629da7b5d578766d58e4fd92');
});

test('S-10 parser removes incomplete items before the source header slice and keeps preview metadata', () => {
  const parsed = newsParse([makeCategory('fixture', [
    makeEntry({ headline: 'Provider header' }),
    makeEntry({ headline: 'Missing image', includeContent: false }),
    makeEntry({ headline: 'Empty preview metadata', imageMeta: {} }),
    makeEntry({ headline: 'Correction: corrected story' }),
    makeEntry({ headline: 'Playable story', imageMeta: goodImage('preview-url', '512', '300') }),
  ])]);
  assert.deepEqual(parsed.fixture.map((item) => item.headline), ['Playable story']);
  assert.deepEqual(parsed.fixture[0].image, goodImage('preview-url', '512', '300'));
});

test('S-10 parser always removes the first post-filter item as the provider header', () => {
  const parsed = newsParse([makeCategory('fixture', [
    makeEntry({ summaryField: [] }),
    makeEntry({ headline: 'First real story' }),
    makeEntry({ headline: 'Second real story' }),
  ])]);
  assert.deepEqual(parsed.fixture.map((item) => item.headline), ['Second real story']);
});

test('S-10 parser uses summary words for adult classification', () => {
  const parsed = newsParse([makeCategory('fixture', [
    makeEntry({ headline: 'Provider header' }),
    makeEntry({ headline: 'Adult story', summary: 'A sexy story' }),
    makeEntry({ headline: 'Clean story' }),
  ])]);
  assert.equal(parsed.fixture[0].headline, 'Adult story');
  assert.equal(parsed.fixture[0].adult, true);
  assert.equal(parsed.fixture[1].headline, 'Clean story');
  assert.equal(parsed.fixture[1].adult, false);
});

test('S-10 parser preserves missing-summary filtering and source non-string summary failure', () => {
  const parsed = newsParse([makeCategory('fixture', [
    makeEntry({ headline: 'Provider header' }),
    makeEntry({ headline: 'Missing summary', summaryField: [] }),
    makeEntry({ headline: 'Playable story' }),
  ])]);
  assert.deepEqual(parsed.fixture.map((item) => item.headline), ['Playable story']);

  assert.throws(() => newsParse([makeCategory('fixture', [
    makeEntry({ headline: 'Provider header' }),
    makeEntry({ headline: 'Numeric summary', summary: 42 }),
  ])]), TypeError);
});

test('S-10 parser filters representative aliases from the complete banned dictionary', () => {
  const aliases = [
    '4r5e', '5h1t', 'a55', 'ar5e', 'asswhole', 'a_s_s', 'b1tch',
    'ballbag', 'biatch', 'c0ck', 'cl1t', 'fagging', 'fcuk', 'fudgepacker',
    'n1gga', 'p0rn', 'pron', 'sh1t', 't1tt1e5', 'tw4t', 'v14gra', 'w00se',
  ];
  for (const alias of aliases) {
    assert.deepEqual(parserHeadlines(alias), ['Tail'], alias);
  }
  assert.deepEqual(parserHeadlines('ordinary'), ['Candidate', 'Tail']);
});

test('S-10 parser inserts a headline in the duplicate set only after image extraction succeeds', () => {
  const parsed = newsParse([makeCategory('fixture', [
    makeEntry({ headline: 'Provider header' }),
    makeEntry({ headline: 'Same story', includeContent: false }),
    makeEntry({ headline: 'Same story' }),
    makeEntry({ headline: 'Tail' }),
  ])]);
  assert.deepEqual(parsed.fixture.map((item) => item.headline), ['Same story', 'Tail']);
});

test('S-10 parser reserves a headline when preview metadata is present but incomplete', () => {
  const parsed = newsParse([makeCategory('fixture', [
    makeEntry({ headline: 'Provider header' }),
    makeEntry({ headline: 'Same story', imageMeta: {} }),
    makeEntry({ headline: 'Same story' }),
    makeEntry({ headline: 'Tail' }),
  ])]);
  assert.deepEqual(parsed.fixture.map((item) => item.headline), ['Tail']);
});

test('S-10 parser keeps source validation and malformed-shape behavior', () => {
  assert.throws(
    () => newsParse([{ error: 'provider unavailable' }]),
    /There was a problem getting NewsData\. provider unavailable/,
  );
  assert.throws(
    () => newsParse([{ category: { name: 'fixture' }, data: { feed: {} } }]),
    /NewsData returned incomplete data\./,
  );
  assert.throws(
    () => newsParse([{ data: { feed: { entry: [] } }, category: {} }]),
    /NewsData returned incomplete category info\./,
  );
  assert.throws(
    () => newsParse([{ category: { name: 'fixture' }, data: { feed: { entry: {} } } }]),
    TypeError,
  );
});

test('S-10 NewsMimLogic preserves the source failure for an undefined category array', async () => {
  const data = {
    local: { news: { fixture: undefined }, views: {} },
    runtime: runtimeFor('adult'),
    skill: { session: { data: { _personalReport: { singleSkill: null } } } },
  };
  await assert.rejects(() => new NewsMimLogic('News Logic').exit(data), TypeError);
});

test('S-10 archived: ServiceDown MIM if no data from service', async () => {
  assertServiceDown(await runLogic(null, 'nonID'));
});

test('S-10 archived: ServiceDown MIM if active categories but no headlines', async () => {
  const data = await runLogic(makeNews([
    makeCategory('technology', []),
    makeCategory('business', []),
  ]));
  assertServiceDown(data);
  assert.equal(data.local.views.newsImages, undefined);
});

test('S-10 archived: play default categories if user is not IDed', async () => {
  const data = await runLogic(makeNews([
    makeSeries('general'),
    makeSeries('technology'),
    makeSeries('sports'),
    makeSeries('business'),
  ]), 'nonID');
  assert.equal(data.local.views.newsImages.length, 4);
  assert.equal(data.local.mimPaths.length, 5);
  assert.deepEqual(data.local.news.headlines.map((headline) => headline.split(' ')[0]), [
    'general', 'technology', 'sports', 'business',
  ]);
});

test('S-10 archived: play 3 headlines if only 1 category active', async () => {
  const data = await runLogic(makeNews([makeSeries('technology')]));
  assert.equal(data.local.mimPaths.length, 4);
  assert.deepEqual(data.local.news.headlines.map((headline) => headline.split(' ')[0]), [
    'technology', 'technology', 'technology',
  ]);
  assert.notEqual(data.local.news.headlines[0], data.local.news.headlines[1]);
  assert.notEqual(data.local.news.headlines[1], data.local.news.headlines[2]);
});

test('S-10 archived: play 2 headlines per category if 2 categories active', async () => {
  const data = await runLogic(makeNews([
    makeSeries('technology'),
    makeSeries('business'),
  ]));
  assert.equal(data.local.mimPaths.length, 5);
  assert.deepEqual(data.local.news.headlines.map((headline) => headline.split(' ')[0]), [
    'technology', 'technology', 'business', 'business',
  ]);
});

test('S-10 archived: play 1 headline per category if >= 3 categories active', async () => {
  const data = await runLogic(makeNews([
    makeSeries('technology'),
    makeSeries('business'),
    makeSeries('strange'),
    makeSeries('sports'),
  ]));
  assert.equal(data.local.views.newsImages.length, 4);
  assert.equal(data.local.mimPaths.length, 5);
  assert.deepEqual(data.local.news.headlines.map((headline) => headline.split(' ')[0]), [
    'technology', 'business', 'strange', 'sports',
  ]);
});

test('S-10 archived: play 5 random categories if >= 5 categories active', async () => {
  const data = await runLogic(makeNews([
    makeSeries('technology'),
    makeSeries('business'),
    makeSeries('strange'),
    makeSeries('national'),
    makeSeries('international'),
    makeSeries('general'),
    makeSeries('sports'),
  ]));
  assert.equal(data.local.views.newsImages.length, 5);
  assert.equal(data.local.mimPaths.length, 6);
  assert.equal(data.local.news.headlines.length, 5);
});

test('S-10 archived: filters news items without summary', async () => {
  const data = await runLogic(makeNews([
    makeSeries('technology', { summaryFieldFor: () => [] }),
    makeSeries('business', { summaryFieldFor: () => [] }),
    makeSeries('strange', { summaryFieldFor: () => [] }),
  ]));
  assertServiceDown(data);
});

test('S-10 archived: filters corrections', async () => {
  const data = await runLogic(makeNews([
    makeSeries('technology', { headlineFor: (index) => 'Correction: technology headline ' + (index + 1) }),
    makeSeries('business', { headlineFor: (index) => 'Correction: business headline ' + (index + 1) }),
    makeSeries('strange', { headlineFor: (index) => 'Correction: strange headline ' + (index + 1) }),
  ]));
  assertServiceDown(data);
});

test('S-10 archived: filters banned words in summary', async () => {
  const data = await runLogic(makeNews([
    makeSeries('technology', { summaryFor: () => 'A fudgepacker summary' }),
    makeSeries('business', { summaryFor: () => 'A fudgepacker summary' }),
    makeSeries('strange', { summaryFor: () => 'A fudgepacker summary' }),
  ]));
  assertServiceDown(data);
});

test('S-10 archived: filters adult headlines for children', async () => {
  const data = await runLogic(makeNews([
    makeSeries('technology', { summaryFor: () => 'A sexy story' }),
    makeSeries('business', { summaryFor: () => 'A sexy story' }),
    makeSeries('strange', { summaryFor: () => 'A sexy story' }),
  ]), 'child');
  assertServiceDown(data);
});

test('S-10 archived: filters adult headlines for non-IDed speaker', async () => {
  const data = await runLogic(makeNews([
    makeSeries('technology', { summaryFor: () => 'A sexy story' }),
    makeSeries('business', { summaryFor: () => 'A sexy story' }),
    makeSeries('strange', { summaryFor: () => 'A sexy story' }),
  ]), 'nonID');
  assertServiceDown(data);
});

test('S-10 archived: does NOT filter adult headlines for IDed adults', async () => {
  const data = await runLogic(makeNews([
    makeSeries('technology', { summaryFor: () => 'A sexy story' }),
    makeSeries('business', { summaryFor: () => 'A sexy story' }),
    makeSeries('strange', { summaryFor: () => 'A sexy story' }),
  ]), 'adult');
  assert.equal(data.local.views.newsImages.length, 3);
  assert.equal(data.local.mimPaths.length, 4);
  assert.deepEqual(data.local.news.headlines.map((headline) => headline.split(' ')[0]), [
    'technology', 'business', 'strange',
  ]);
});

test('S-10 archived: filters out duplicate news items', async () => {
  const technology = makeSeries('technology');
  const business = makeSeries('business');
  business.data.feed.entry.unshift(technology.data.feed.entry[0], technology.data.feed.entry[1]);

  const data = await runLogic(makeNews([technology, business]));
  const flatHeadlines = data.local.news.headlines;
  assert.deepEqual([...new Set(flatHeadlines)], flatHeadlines);
});
