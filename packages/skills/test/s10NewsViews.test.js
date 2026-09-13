import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSlimSequence } from '../src/graph/mims/slimmer.js';
import { loadMimFile } from '../src/graph/mims/promptData.js';
import { newsViews } from '../src/report/newsViews.js';

// Source basis: jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c,
// packages/report-skill/src/subskills/news/NewsViews.ts,
// packages/report-skill/resources/views/newsHeadline.json,
// packages/report-skill/tests/subskills/News.test.js, and the six News*.mim
// files under packages/report-skill/mims.

const MIM_DIR = fileURLToPath(new URL('../resources/mims/report/en-us/', import.meta.url));
const CATEGORY_GRADIENT = 'assets/personal-report-skill/news/categoryGradient_v01.crn';

const item = (category, source = `${category}-image`, width = 512, height = 300) => ({
  category,
  image: { source, width, height },
});

const components = (view) => ({
  image: view.componentConfigs.find((component) => component.id === 'headlineClip'),
  category: view.componentConfigs.find((component) => component.id === 'categoryClip'),
  label: view.componentConfigs.find((component) => component.id === 'categoryText'),
});

test('S-10 archived view row: landscape image fills width with centered crop', async () => {
  const [view] = await newsViews([item('technology', 'fakePreviewURL', 512, 300)]);
  const { image } = components(view);

  assert.equal(image.transform.scaleX, 1280 / 512);
  assert.equal(image.transform.scaleY, image.transform.scaleX);
  assert.equal(image.position.x, 0);
  assert.equal(image.position.y, -15);
});

test('S-10 archived view row: widescreen landscape image fills height', async () => {
  const [view] = await newsViews([item('technology', 'widePreviewURL', 512, 200)]);
  const { image } = components(view);

  assert.equal(image.transform.scaleX, 720 / 200);
  assert.equal(image.transform.scaleY, image.transform.scaleX);
  assert.equal(image.position.x, -282);
  assert.equal(image.position.y, 0);
});

test('S-10 archived view row: portrait image fills height', async () => {
  const [view] = await newsViews([item('technology', 'portraitPreviewURL', 300, 512)]);
  const { image } = components(view);

  assert.equal(image.transform.scaleX, 720 / 512);
  assert.equal(image.transform.scaleY, image.transform.scaleX);
  assert.equal(image.position.x, 429);
  assert.equal(image.position.y, 0);
});

test('S-10 archived view row: view contains the headline image component and source asset', async () => {
  const [view] = await newsViews([item('technology', 'fakePreviewURL')]);
  const { image } = components(view);

  assert.equal(image.id, 'headlineClip');
  assert.deepEqual(image.assets[0], {
    id: 'headlinePng',
    src: 'fakePreviewURL',
    type: 'texture',
  });
});

test('S-10 archived view row: generated image view IDs are unique', async () => {
  const views = await newsViews([
    item('technology', 'firstPreviewURL'),
    item('technology', 'secondPreviewURL'),
  ]);

  assert.deepEqual(views.map((view) => view.viewConfig.id), ['headlineView_0', 'headlineView_1']);
});

test('S-10 archived view row: leaveEmpty remains true until the final image', async () => {
  const views = await newsViews([
    item('technology', 'one'),
    item('business', 'two'),
    item('strange', 'three'),
    item('sports', 'four'),
  ]);

  assert.deepEqual(views.map((view) => view.defaultSelect.leaveEmpty), [true, true, true, false]);
  assert.equal(Object.hasOwn(views[0].defaultSelect, 'removeAll'), false);
  assert.equal(Object.hasOwn(views[3].defaultSelect, 'removeAll'), true);
  assert.equal(views[3].defaultSelect.removeAll, true);
});

test('S-10 archived view row: category overlay uses title case and Strange News', async () => {
  const views = await newsViews([
    item('technology', 'technology-image'),
    item('business', 'business-image'),
    item('strange', 'strange-image'),
  ]);

  assert.deepEqual(views.map((view) => components(view).label.text), [
    'Technology', 'Business', 'Strange News',
  ]);
  for (const view of views) {
    const { category } = components(view);
    assert.equal(category.assets[0].src, CATEGORY_GRADIENT);
    assert.deepEqual(category.position, { x: 0, y: 353 });
    assert.deepEqual(category.transform, { scaleX: 1280, scaleY: 1 });
  }
});

test('S-10 preserves the source no-view error and inferred radix dimensions', async () => {
  await assert.rejects(() => newsViews([]), TypeError);

  // NewsViews.ts calls parseInt(value) without a radix. This is observable for
  // legacy AP metadata that carries hexadecimal dimensions.
  const [view] = await newsViews([item('technology', 'legacy-image', '0x200', '0x12c')]);
  const { image } = components(view);
  assert.equal(image.transform.scaleX, 1280 / 512);
  assert.equal(image.transform.scaleY, 1280 / 512);
  assert.equal(image.position.x, 0);
  assert.equal(image.position.y, -15);
});

const NEWS_MIMS = {
  NewsAppSetup: {
    gui: null,
    esAutoTagging: true,
    prompts: [
      ["Sorry, for me to give you the news, you'll need to enable at least one news category in the Jibo <phoneme ph='a p p'> app </phoneme>.", 'NewsAppSetup_AN_01'],
      ["Oh, to get the news, you just need to select at least one news category in the Jibo <phoneme ph='a p p'> app </phoneme>.", 'NewsAppSetup_AN_02'],
      ["To get the news part of the personal report, you'll need to choose at least one news category in the Jibo <phoneme ph='a p p'> app </phoneme>.", 'NewsAppSetup_AN_03'],
    ],
  },
  NewsHeadline: {
    gui: { type: 'Javascript', data: 'views.newsImages.shift()', pause: true },
    esAutoTagging: { hotWords: false, punctuation: true, voice: true, beat: false },
    prompts: [[
      "<anim cat='news' meta='news-stinger' nonBlocking='true' /><break size='0.75'/><pitch band='0.9'><pitch mult='0.95'>${skill.news.headlines.shift()}</pitch></pitch>",
      'NewsHeadline_AN_01',
    ]],
  },
  NewsIntro: {
    gui: null,
    esAutoTagging: { hotWords: false, punctuation: true, voice: true, beat: false },
    prompts: [
      ["<anim cat='news' meta='news-intro, no-eye-end' nonBlocking='true' />Here's today's news, from the associated press.", 'NewsIntro_AN_01'],
      ["<anim cat='news' meta='news-intro, no-eye-end' nonBlocking='true' />Now for today's news, from the associated press.", 'NewsIntro_AN_02'],
      ["<anim cat='news' meta='news-intro, no-eye-end' nonBlocking='true' />Here's what's in the news today, from the associated press.", 'NewsIntro_AN_03'],
      ["<anim cat='news' meta='news-intro, no-eye-end' nonBlocking='true' />Here's the news, brought to us by the associated press.", 'NewsIntro_AN_04'],
    ],
  },
  NewsIntroCategory: {
    gui: null,
    esAutoTagging: true,
    prompts: [
      ["Sure. Here's ${newsCategory} news from the associated press.", 'NewsIntroCategory_AN_01'],
      ["Of course. Here's the latest in ${newsCategory}, from the associated press.", 'NewsIntroCategory_AN_02'],
      ["You got it, the latest ${newsCategory} headlines, from the associated press.", 'NewsIntroCategory_AN_03'],
    ],
  },
  NewsOutro: {
    gui: null,
    esAutoTagging: true,
    prompts: [[
      "<duration stretch='1.05'>And <pitch mult='1.1'>that's</pitch> what's new in the news.</duration>",
      'NewsOutro_AN_01',
    ]],
  },
  NewsServiceDown: {
    gui: null,
    esAutoTagging: true,
    prompts: [
      ["Sorry, the news service seems to be down. <break size='.2'/> Maybe it wasn't very interesting anyway.", 'NewsServiceDown_AN_01'],
      ["Looks like I can't access my news source right now, sorry.", 'NewsServiceDown_AN_02'],
      ["It seems I can't access the news headlines at the moment, I'm sorry.", 'NewsServiceDown_AN_03'],
      ["I'm afraid our news service isn't working right now. Sorry about that.", 'NewsServiceDown_AN_04'],
    ],
  },
};

test('S-10 inventories every vendored News MIM and preserves source references', () => {
  for (const [name, expected] of Object.entries(NEWS_MIMS)) {
    const mim = loadMimFile(join(MIM_DIR, `${name}.mim`));
    assert.equal(mim.mim_type, 'announcement', `${name}: type`);
    assert.deepEqual(mim.gui, expected.gui, `${name}: gui`);
    assert.deepEqual(mim.es_auto_tagging, expected.esAutoTagging, `${name}: ES auto-tagging`);
    assert.deepEqual(mim.prompts.map((prompt) => [prompt.prompt, prompt.prompt_id]), expected.prompts, `${name}: prompt inventory`);
  }
});

function emptyMimState() {
  return { noMatch: 0, noInput: 0, noMatchMax: false, noInputMax: false };
}

async function renderNewsMim(name, promptData, viewData = {}) {
  const path = join(MIM_DIR, `${name}.mim`);
  const data = {
    runtime: {},
    local: viewData,
    skill: { session: { data: { _mim: emptyMimState() } } },
    log: { warn() {}, error() {} },
  };
  return generateSlimSequence(
    { category: 'Entry-Core', subCategory: 'AN', noMatch: 0, noInput: 0 },
    {
      mimDataProvider: [path],
      promptDataProvider: () => promptData,
      viewDataProvider: () => viewData,
    },
    data,
    { rng: () => 0 },
  );
}

test('S-10 renders headline title, attribution, category reference, and headline view ESML', async () => {
  const headline = 'Jibo robot makes a comeback';
  const view = (await newsViews([item('technology', 'story-preview')]))[0];
  const headlineSequence = await renderNewsMim(
    'NewsHeadline',
    { news: { headlines: [headline] } },
    { news: { headlines: [headline] }, views: { newsImages: [view] } },
  );
  const headlineSlim = headlineSequence.children[0];
  assert.equal(headlineSlim.config.play.meta.mim_id, 'NewsHeadline');
  assert.equal(headlineSlim.config.play.meta.prompt_id, 'NewsHeadline_AN_01');
  assert.equal(headlineSlim.config.play.esml, "<anim cat='news' meta='news-stinger' nonBlocking='true' /><break size='0.75'/><pitch band='0.9'><pitch mult='0.95'>Jibo robot makes a comeback</pitch></pitch>");
  assert.deepEqual(headlineSlim.config.display.view.context.data, view);
  assert.equal(headlineSlim.config.display.view.context.pause, true);

  const introSequence = await renderNewsMim('NewsIntro', { news: { headlines: [] } });
  assert.equal(introSequence.children[0].config.play.esml, "<anim cat='news' meta='news-intro, no-eye-end' nonBlocking='true' />Here's today's news, from the associated press.");

  const categorySequence = await renderNewsMim('NewsIntroCategory', {
    newsCategory: 'Technology',
  });
  assert.equal(categorySequence.children[0].config.play.esml, "Sure. Here's Technology news from the associated press.");
});
