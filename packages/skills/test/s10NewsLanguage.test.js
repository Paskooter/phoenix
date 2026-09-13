// S-10 — report news language/resources against the pinned Pegasus source.
// Source: jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c
//   packages/report-skill/src/subskills/news/{NewsParse,NewsMimLogic,NewsViews}.ts
//   packages/report-skill/mims/en-us/News*.mim
//   packages/report-skill/resources/{mimPromptText.json,views/newsHeadline.json}
//
// The per-file bytes/hashes below were captured from the Jibo/Gebo MCP at the
// source revision above. The test keeps the re-homed news language auditable
// without requiring a live source checkout at test time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
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
import { newsParse, NewsMimLogic } from '../src/report/news.js';
import { newsViews } from '../src/report/newsViews.js';

const SOURCE_REVISION = '5c0a7390539663ba749d360de348a428c088505c';
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SKILLS = resolve(TEST_DIR, '..');
const NEWS_MIM_DIR = join(SKILLS, 'resources', 'mims', 'report', 'en-us');
const NEWS_RESOURCE_DIR = join(SKILLS, 'resources');

const INVENTORY = Object.freeze({
  'NewsAppSetup.mim': { bytes: 1444, sha256: '2358c7ef0446655d6519e0a6906b85f6772bd0b76ca0fcb64c459282cd4b6557', prompts: 3, refs: [] },
  'NewsHeadline.mim': { bytes: 877, sha256: 'ff6b996bf4afa1540e6dc83da920d86babe076acf99f7ed54e7b5093242773be', prompts: 1, refs: ['skill.news.headlines.shift()', 'views.newsImages.shift()'] },
  'NewsIntro.mim': { bytes: 1812, sha256: 'cd296a843b37b72f80aa868b1bc80ee2c848bfc4e99cd3e9135de6dc79739a8d', prompts: 4, refs: [] },
  'NewsIntroCategory.mim': { bytes: 1230, sha256: '6fb6a7acb6e65251e962b7e392571288c2684edc6d1c8c454bd44178bbca29a6', prompts: 3, refs: ['newsCategory'] },
  'NewsOutro.mim': { bytes: 678, sha256: '3404cf8c70a1c215f19c405b7efd1ee0b6b3ac7579833e45ad03d01c9129334c', prompts: 1, refs: [] },
  'NewsServiceDown.mim': { bytes: 1567, sha256: '75a1d96ec9032bbb7e0ae849a7f74e553d0028700a74df980534f0c16d081f5d', prompts: 4, refs: [] },
});

const SOURCE_PROMPT_TEXT_SHA256 = '1b987df35fd07a0094e502898071ac066544798c955f44b862cadb115cc61f71';
const SOURCE_NEWS_VIEW_SHA256 = 'c559b0de05db6adc752280856d38284ec39d10cb3bba98c26f6ef306c3f44500';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const files = () => readdirSync(NEWS_MIM_DIR).filter((name) => name.startsWith('News')).sort();
const sourceRefs = (raw, mim) => [...new Set([
  ...(raw.match(/\$\{([^}]+)\}/g) || []).map((match) => match.slice(2, -1)),
  ...(mim.gui?.data ? [mim.gui.data] : []),
])].sort();
const mimIds = (paths) => paths.map((path) => basename(path, '.mim'));

function entryConfig() {
  return {
    category: PromptCategory.ENTRY,
    subCategory: PromptSubCategory.ANNOUNCEMENT,
    index: 1,
    noMatch: 0,
    noInput: 0,
  };
}

function rngForPrompt(mim, targetIndex) {
  const weights = mim.prompts.map((prompt) => prompt.weight || 1);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const before = weights.slice(0, targetIndex).reduce((sum, weight) => sum + weight, 0);
  return () => (before + weights[targetIndex] / 2) / total;
}

const HEADLINE = 'Technology Headline 1: The technology folks did a new technology thing!';
const NEWS_CATEGORY = 'Technology';

function promptData({ headline = HEADLINE, newsCategory = NEWS_CATEGORY } = {}) {
  return buildPromptData(
    { location: { iso: '2026-06-12T12:00:00-04:00' } },
    { news: { headlines: [headline] }, newsCategory },
  );
}

const image = (source, width = '512', height = '300') => ({
  id: 'preview-id',
  'mime-type': 'image/jpeg',
  name: 'preview.jpg',
  source,
  height: String(height),
  width: String(width),
  coding: 'JPEG',
});

function rawEntry(headline, summary = 'A source-shaped summary.', entryImage = image('https://fixture.invalid/image.jpg')) {
  const entry = {
    summary: Array.isArray(summary) ? summary : [summary],
    'apcm:ContentMetadata': [{ 'apcm:ExtendedHeadLine': [headline] }],
  };
  if (entryImage !== null) {
    entry.content = [{ nitf: [{ body: [{ 'body.content': [{ media: [{
      'media-reference': [
        { $: image('https://fixture.invalid/full.jpg', '4000', '3000') },
        { $: entryImage },
        { $: image('https://fixture.invalid/thumb.jpg', '128', '80') },
      ],
    }] }] }] }] }];
  }
  return entry;
}

function newsRuntime({ singleSkill = null, speaker = 'adult', birthdate = Date.parse('1990-01-01T00:00:00Z') } = {}) {
  return {
    perception: { speaker },
    loop: { users: [{ id: speaker, birthdate }] },
    location: { iso: '2026-06-12T12:00:00-04:00' },
    skill: { session: { data: { _personalReport: { singleSkill } } } },
  };
}

function newsData(news, options = {}) {
  return {
    local: { news, views: {} },
    runtime: newsRuntime(options),
    skill: { session: { data: { _personalReport: { singleSkill: options.singleSkill ?? null } } } },
  };
}

function item(category, index, options = {}) {
  return {
    category,
    adult: options.adult ?? false,
    headline: options.headline || `${category} Headline ${index}`,
    image: options.image || image(`https://fixture.invalid/${category}-${index}.jpg`, options.width || '512', options.height || '300'),
  };
}

test('S-10 inventory: all six News MIMs and both news resources match MCP source bytes', () => {
  assert.equal(SOURCE_REVISION, '5c0a7390539663ba749d360de348a428c088505c');
  assert.deepEqual(files(), Object.keys(INVENTORY).sort());

  for (const name of files()) {
    const raw = readFileSync(join(NEWS_MIM_DIR, name), 'utf8');
    const mim = JSON.parse(raw);
    const expected = INVENTORY[name];
    assert.equal(Buffer.byteLength(raw), expected.bytes, `${name}: byte length`);
    assert.equal(sha256(raw), expected.sha256, `${name}: SHA-256`);
    assert.equal(mim.mim_type, 'announcement', `${name}: source MIM type`);
    assert.equal(mim.prompts.length, expected.prompts, `${name}: prompt count`);
    assert.deepEqual(sourceRefs(raw, mim), [...expected.refs].sort(), `${name}: dynamic references`);
  }

  assert.equal(
    sha256(readFileSync(join(NEWS_RESOURCE_DIR, 'report-mimPromptText.json'))),
    SOURCE_PROMPT_TEXT_SHA256,
    'shared report prompt resource',
  );
  assert.equal(
    sha256(readFileSync(join(NEWS_RESOURCE_DIR, 'views', 'newsHeadline.json'))),
    SOURCE_NEWS_VIEW_SHA256,
    'news headline view resource',
  );
});

test('S-10 loader: every source News MIM loads with its Phoenix filename ID and announcement type', async () => {
  const loaded = await loadMims(files().map((name) => join(NEWS_MIM_DIR, name)), {});
  assert.equal(loaded.length, 6);
  assert.deepEqual(loaded.map((mim) => mim.mim_id).sort(), files().map((name) => basename(name, '.mim')).sort());
  assert.ok(loaded.every((mim) => mim.mim_type === 'announcement'));
  assert.ok(loaded.every((mim) => Array.isArray(mim.prompts) && mim.prompts.length > 0));
});

test('S-10 prompt rendering: every source news prompt resolves exact headline/category ESML', async () => {
  const loaded = await loadMims(files().map((name) => join(NEWS_MIM_DIR, name)), {});

  for (const mim of loaded) {
    for (const [index, prompt] of mim.prompts.entries()) {
      const slim = generateSlimFromMim(mim, entryConfig(), promptData(), { rng: rngForPrompt(mim, index) });
      const expectedEsml = prompt.prompt
        .replaceAll('${skill.news.headlines.shift()}', HEADLINE)
        .replaceAll('${newsCategory}', NEWS_CATEGORY);

      assert.ok(slim && slim.play, `${mim.mim_id}/${prompt.prompt_id}: selected prompt`);
      assert.equal(slim.play.meta.mim_id, mim.mim_id);
      assert.equal(slim.play.meta.prompt_id, prompt.prompt_id);
      assert.equal(slim.play.esml, expectedEsml, `${mim.mim_id}/${prompt.prompt_id}: exact ESML`);
      assert.equal(slim.play.esml.includes('${'), false, `${mim.mim_id}/${prompt.prompt_id}: no unresolved template`);
    }
  }
});

test('S-10 parser: source AP header, incomplete media, corrections, duplicates, and adult flags', () => {
  const parsed = newsParse([
    {
      category: { name: 'technology' },
      data: { feed: { entry: [
        rawEntry('Provider technology header'),
        rawEntry('Technology story one'),
        rawEntry('Technology story without media', 'Safe summary', null),
        rawEntry('Correction: Technology story two'),
        rawEntry('Technology adult story', 'A shooting happened.'),
      ] } },
    },
    {
      category: { name: 'business' },
      data: { feed: { entry: [
        rawEntry('Provider business header'),
        rawEntry('Technology story one'),
        rawEntry('Business story one'),
      ] } },
    },
  ]);

  assert.deepEqual(parsed.technology.map((entry) => entry.headline), ['Technology story one', 'Technology adult story']);
  assert.equal(parsed.technology[1].adult, true);
  assert.deepEqual(parsed.business.map((entry) => entry.headline), ['Business story one']);

  const feed = ['Provider technology header', ...Array.from({ length: 11 }, (_, index) => `Technology capped story ${index + 1}`)];
  const capped = newsParse([{
    category: { name: 'technology' },
    data: { feed: { entry: feed.map((headline) => rawEntry(headline)) } },
  }]);
  assert.deepEqual(capped.technology.map((entry) => entry.headline), feed.slice(1, 11), 'source keeps at most ten stories after the feed header');
});

test('S-10 logic: source item limits, category order, adult filtering, and fallbacks', async () => {
  const technology = [item('technology', 1), item('technology', 2), item('technology', 3), item('technology', 4)];
  const one = newsData({ technology }, { singleSkill: 'news' });
  await new NewsMimLogic('News Logic').exit(one);
  assert.deepEqual(mimIds(one.local.mimPaths), ['NewsIntro', 'NewsHeadline', 'NewsHeadline', 'NewsHeadline', 'NewsOutro']);
  assert.deepEqual(one.local.news.headlines, technology.slice(0, 3).map((entry) => entry.headline));
  assert.equal(one.local.views.newsImages.length, 3);

  const business = [item('business', 1), item('business', 2), item('business', 3)];
  const two = newsData({ technology, business });
  await new NewsMimLogic('News Logic').exit(two);
  assert.deepEqual(mimIds(two.local.mimPaths), ['NewsIntro', 'NewsHeadline', 'NewsHeadline', 'NewsHeadline', 'NewsHeadline']);
  assert.deepEqual(two.local.news.headlines, [
    technology[0].headline, technology[1].headline, business[0].headline, business[1].headline,
  ]);

  const sixCategories = Object.fromEntries(Array.from({ length: 6 }, (_, index) => {
    const category = `category-${index + 1}`;
    return [category, [item(category, 1)]];
  }));
  const many = newsData(sixCategories);
  await new NewsMimLogic('News Logic').exit(many);
  assert.equal(many.local.news.headlines.length, 5, 'source trims configured categories to five');
  assert.equal(many.local.views.newsImages.length, 5, 'source creates one view per selected category item');
  const allConfiguredHeadlines = new Set(Object.values(sixCategories).map(([entry]) => entry.headline));
  assert.ok(many.local.news.headlines.every((headline) => allConfiguredHeadlines.has(headline)), 'trimmed headlines remain source category items');

  const child = newsData({ technology: [item('technology', 1, { adult: true }), item('technology', 2), item('technology', 3)] }, {
    speaker: 'child',
    birthdate: Date.parse('2016-01-01T00:00:00Z'),
  });
  await new NewsMimLogic('News Logic').exit(child);
  assert.deepEqual(child.local.news.headlines, ['technology Headline 2', 'technology Headline 3']);
  assert.deepEqual(mimIds(child.local.mimPaths), ['NewsIntro', 'NewsHeadline', 'NewsHeadline']);

  const appSetup = newsData({});
  await new NewsMimLogic('News Logic').exit(appSetup);
  assert.deepEqual(mimIds(appSetup.local.mimPaths), ['NewsAppSetup']);

  const emptyStories = newsData({ technology: [] });
  await new NewsMimLogic('News Logic').exit(emptyStories);
  assert.deepEqual(mimIds(emptyStories.local.mimPaths), ['NewsServiceDown']);

  const serviceDown = newsData(null);
  await new NewsMimLogic('News Logic').exit(serviceDown);
  assert.deepEqual(mimIds(serviceDown.local.mimPaths), ['NewsServiceDown']);
});

test('S-10 sequence: exact AP headlines render in source order with GUI views and single-skill outro', async () => {
  const stories = [
    item('technology', 1, { headline: 'Technology Headline 1: The technology folks did a new technology thing!' }),
    item('technology', 2, { headline: 'Technology Headline 2: The technology folks did a new technology thing!' }),
    item('technology', 3, { headline: 'Technology Headline 3: The technology folks did a new technology thing!' }),
  ];
  const data = newsData({ technology: stories }, { singleSkill: 'news' });
  await new NewsMimLogic('News Logic').exit(data);

  const sequence = await generateSlimSequence(entryConfig(), {
    mimDataProvider: data.local.mimPaths,
    promptDataProvider: () => ({ news: data.local.news }),
    viewDataProvider: () => data.local,
  }, data, { rng: () => 0 });

  assert.deepEqual(sequence.children.map((slim) => slim.config.play.meta.mim_id), [
    'NewsIntro', 'NewsHeadline', 'NewsHeadline', 'NewsHeadline', 'NewsOutro',
  ]);
  const headlineSlims = sequence.children.slice(1, 4);
  assert.deepEqual(headlineSlims.map((slim) => slim.config.play.esml.match(/Headline \d+/)?.[0]), [
    'Headline 1', 'Headline 2', 'Headline 3',
  ]);
  assert.ok(headlineSlims.every((slim) => slim.config.display?.view?.context?.data?.viewConfig?.id));
  assert.equal(headlineSlims[0].config.display.view.context.data.componentConfigs[0].assets[0].src, 'https://fixture.invalid/technology-1.jpg');
  assert.equal(data.local.views.newsImages.length, 0, 'each NewsHeadline consumes its source view');
  assert.equal(data.local.news.headlines.length, 0, 'each NewsHeadline consumes its source headline');
});

test('S-10 views: source category title, Nimbus attribution asset, image geometry, IDs, and final close', async () => {
  const views = await newsViews([
    { category: 'technology', image: image('technology-image', '512', '300') },
    { category: 'strange', image: image('strange-image', '300', '512') },
  ]);

  assert.equal(views.length, 2);
  assert.deepEqual(views.map((view) => view.viewConfig.id), ['headlineView_0', 'headlineView_1']);
  const categoryText = (view) => view.componentConfigs.find((component) => component.id === 'categoryText').text;
  const categoryAsset = (view) => view.componentConfigs.find((component) => component.id === 'categoryClip').assets[0].src;
  const headline = (view) => view.componentConfigs.find((component) => component.id === 'headlineClip');
  assert.equal(categoryText(views[0]), 'Technology');
  assert.equal(categoryText(views[1]), 'Strange News');
  assert.equal(categoryAsset(views[0]), 'assets/personal-report-skill/news/categoryGradient_v01.crn');
  assert.equal(headline(views[0]).assets[0].src, 'technology-image');
  assert.equal(headline(views[0]).transform.scaleX, 1280 / 512);
  assert.equal(headline(views[0]).position.y, -15);
  assert.equal(headline(views[1]).assets[0].src, 'strange-image');
  assert.equal(headline(views[1]).transform.scaleX, 720 / 512);
  assert.equal(views[0].defaultSelect.leaveEmpty, true);
  assert.equal(views[1].defaultSelect.removeAll, true);
  assert.equal(views[1].defaultSelect.leaveEmpty, false);
});
