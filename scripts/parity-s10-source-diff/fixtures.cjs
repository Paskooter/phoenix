'use strict';

// News.test.js uses TestUtils.createRawNewsData.  This is the small, explicit
// fixture declaration shared by both runners; the parser, MIM logic, speaker
// age check, and view builder themselves always come from the side under test.

const DEFAULT_OPTS = {
  mockNoHeadlines: false,
  duplicateItems: false,
  childSpeaker: false,
  userNotIDed: false,
  IDedSpeaker: true,
  bannedWord: false,
  correction: false,
  adultWord: false,
  noSummary: false,
};

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function titleCase(value) { return value.slice(0, 1).toUpperCase().concat(value.slice(1)); }

function createNewsItem(i, category, opts) {
  const imageWidth = opts.imageWidth || 512;
  const imageHeight = opts.imageHeight || 300;
  const correction = opts.correction ? 'Correction:' : '';
  const testWord = opts.adultWord ? 'sexy' : opts.bannedWord ? 'fudgepacker' : '';
  return {
    'apcm:ContentMetadata': [
      { 'apcm:ExtendedHeadLine': [`${correction} ${titleCase(category)} Headline ${i}: The ${category} folks did a new ${category} thing!`] },
    ],
    summary: opts.noSummary ? [] : [`Oh ${testWord}, a ${category} thing happened, ${testWord}!`],
    content: [{ nitf: [{ body: [{ 'body.content': [{ media: [{ 'media-reference': [
      { '$': { source: 'fakeFullURL', width: 4000, height: 3000 } },
      { '$': { source: 'fakePreviewURL', width: imageWidth, height: imageHeight } },
      { '$': { source: 'fakeThumbnailURL', width: 128, height: 80 } },
    ] }] }] }] }] }],
  };
}

function createRawNewsData(opts, activeCategories) {
  if (opts === null) return undefined;
  const merged = Object.assign({}, DEFAULT_OPTS, opts || {});
  const defaultActive = { general: true, technology: true, sports: true, business: true };
  const active = merged.userNotIDed ? defaultActive : (activeCategories || {});
  const categoryNames = Object.keys(active).filter(category => active[category]);
  const raw = categoryNames.map(category => {
    const rawCategory = { category: { name: category, sourceID: 0 }, data: { feed: { entry: [] } } };
    if (!merged.mockNoHeadlines) {
      for (let i = 1; i <= 5; i += 1) rawCategory.data.feed.entry.push(createNewsItem(i, category, merged));
    }
    return rawCategory;
  });
  if (merged.duplicateItems) {
    if (raw.length < 2) throw new Error('duplicateItems fixture requires two categories');
    const duplicateEntries = raw[0].data.feed.entry.slice(0, 2);
    raw[1].data.feed.entry.unshift(...duplicateEntries);
  }
  return raw;
}

function makeRuntime(run, clockISO) {
  const opts = run.opts || {};
  const identified = !!opts.IDedSpeaker;
  const birthdate = opts.childSpeaker
    ? Date.parse(clockISO) - (1000 * 60 * 60 * 24 * 365 * 10)
    : Date.parse('1980-01-01T00:00:00.000Z');
  return {
    perception: identified ? { speaker: 'u1' } : {},
    loop: { loopId: 'loop-1', users: identified ? [{ id: 'u1', accountId: 'acct-1', name: 'Alice Smith', birthdate }] : [] },
    location: { iso: clockISO },
  };
}

function projectImage(image) {
  if (!image) return null;
  return {
    id: image.id === undefined ? null : image.id,
    'mime-type': image['mime-type'] === undefined ? null : image['mime-type'],
    name: image.name === undefined ? null : image.name,
    source: image.source === undefined ? null : image.source,
    height: image.height === undefined ? null : image.height,
    width: image.width === undefined ? null : image.width,
    coding: image.coding === undefined ? null : image.coding,
  };
}

function projectNews(news) {
  if (!news) return null;
  const out = {};
  Object.keys(news).forEach(key => {
    if (key === 'headlines') out[key] = clone(news[key]);
    else if (Array.isArray(news[key])) {
      out[key] = news[key].map(item => ({
        category: item.category === undefined ? null : item.category,
        headline: item.headline === undefined ? null : item.headline,
        adult: item.adult === undefined ? null : item.adult,
        image: projectImage(item.image),
      }));
    } else out[key] = clone(news[key]);
  });
  return out;
}

function basenameMim(value) {
  if (typeof value !== 'string') return value;
  const name = value.split('/').pop();
  return name && name.endsWith('.mim') ? name.slice(0, -4) : name;
}

function projectLocal(local) {
  return {
    mims: (local && local.mimPaths || []).map(basenameMim),
    news: projectNews(local && local.news),
    views: local && local.views && local.views.newsImages === undefined ? null : (local && local.views ? local.views.newsImages : null),
  };
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.keys(value).sort().reduce((out, key) => { out[key] = stable(value[key]); return out; }, {});
  if (typeof value === 'number' && isNaN(value)) return 'NaN';
  return value;
}

module.exports = { clone, createRawNewsData, makeRuntime, projectNews, projectLocal, stable };
