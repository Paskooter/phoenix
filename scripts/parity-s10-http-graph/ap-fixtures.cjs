'use strict';

// These are AP-shaped XML feeds for the report-skill /v1/ap_news contract.
// They intentionally live beside this harness instead of using the Phoenix
// Data RSS adapter: the source consumes the AP XML envelope directly.

const CATEGORY_BY_SOURCE_ID = Object.freeze({
  '42200': 'business',
  '42201': 'entertainment',
  '42202': 'international',
  '42203': 'health',
  '42204': 'strange',
  '42205': 'politics',
  '42206': 'science',
  '42207': 'sports',
  '42208': 'technology',
  '42209': 'general',
  '42210': 'national',
});

const originalAP = require('./original-ap-fixtures.cjs');

const DEFAULT_SOURCE_IDS = Object.freeze(['42208', '42207', '42200', '42210']);

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function mediaXML(image) {
  if (!image) return '';
  const full = image.full || { source: `${image.source}-full`, width: 4000, height: 3000 };
  const preview = image.preview || image;
  const thumbnail = image.thumbnail || { source: `${image.source}-thumbnail`, width: 128, height: 80 };
  const ref = (value) => {
    const attrs = [];
    if (value.source !== null && value.source !== undefined) attrs.push(`source="${xmlEscape(value.source)}"`);
    if (value.width !== null && value.width !== undefined) attrs.push(`width="${xmlEscape(value.width)}"`);
    if (value.height !== null && value.height !== undefined) attrs.push(`height="${xmlEscape(value.height)}"`);
    return `<media-reference ${attrs.join(' ')} />`;
  };
  return `<content><nitf><body><body.content><media>${ref(full)}${ref(preview)}${ref(thumbnail)}</media></body.content></body></nitf></content>`;
}

function entryXML(story) {
  const summary = story.summary === null || story.summary === undefined
    ? '' : `<summary>${xmlEscape(story.summary)}</summary>`;
  const metadata = story.headline === null || story.headline === undefined
    ? '' : `<apcm:ContentMetadata><apcm:ExtendedHeadLine>${xmlEscape(story.headline)}</apcm:ExtendedHeadLine></apcm:ContentMetadata>`;
  return `<entry>${summary}${metadata}${mediaXML(story.image)}</entry>`;
}

function image(source, width = 512, height = 300) {
  return { source, width, height };
}

function header() {
  return {
    headline: 'Provider feed header',
    summary: 'This AP provider header must be removed before stories are selected.',
    image: image('header-preview', 512, 300),
  };
}

function story(category, label, options = {}) {
  return Object.assign({
    headline: `${category} story ${label}`,
    summary: `${category} summary ${label}`,
    image: image(`${category}-${label.toLowerCase()}-preview`, 512, 300),
  }, options);
}

function categoryStories(category, count, options = {}) {
  const result = [];
  for (let i = 0; i < count; i += 1) {
    result.push(story(category, String.fromCharCode(65 + i), options[i] || {}));
  }
  return result;
}

function fixtureStories(name, category) {
  switch (name) {
    case 'two-categories':
      return categoryStories(category, 3);
    case 'one-category-limit':
      return categoryStories(category, 6);
    case 'strange-category':
      return categoryStories(category, 3);
    case 'header-image-filtering':
      return [
        story(category, 'MissingSummary', { summary: null }),
        story(category, 'MissingPreview', { image: null }),
        story(category, 'MissingSource', { image: { source: null, width: 512, height: 300 } }),
        story(category, 'MissingDimensions', { image: { source: 'missing-dimensions-preview', width: null, height: 300 } }),
        story(category, 'Correction', { headline: 'Correction: stale story must be filtered' }),
        story(category, 'Alpha', { headline: 'Technology Alpha survives header and image filtering' }),
        story(category, 'Beta', { headline: 'Technology Beta remains in source order' }),
        story(category, 'Gamma', { headline: 'Technology Gamma remains playable' }),
      ];
    case 'geometry':
      return [
        story(category, 'Landscape', {
          headline: 'Landscape image story', image: image('landscape-preview', 512, 300),
        }),
        story(category, 'Wide', {
          headline: 'Widescreen image story', image: image('wide-preview', 1600, 400),
        }),
        story(category, 'Portrait', {
          headline: 'Portrait image story', image: image('portrait-preview', 300, 600),
        }),
      ];
    case 'default':
    default:
      return categoryStories(category, 2);
  }
}

function buildFeed(name, sourceID) {
  if (name === 'original-ap-response-one') return originalAP.apNewsXMLResponse;
  if (name === 'original-ap-response-two') return originalAP.apNewsXMLResponseTwo;
  if (name === 'empty') {
    return '<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns:apcm="http://ap.org/schemas/03/2010/contentmetadata"></feed>';
  }
  if (name === 'malformed') {
    return '<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns:apcm="http://ap.org/schemas/03/2010/contentmetadata"><entry>';
  }
  const category = CATEGORY_BY_SOURCE_ID[String(sourceID)] || 'unknown';
  const entries = [header()].concat(fixtureStories(name, category));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns:apcm="http://ap.org/schemas/03/2010/contentmetadata">${entries.map(entryXML).join('')}</feed>`;
}

module.exports = {
  CATEGORY_BY_SOURCE_ID,
  DEFAULT_SOURCE_IDS,
  buildFeed,
};
