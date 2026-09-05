import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newsViews } from '../src/report/newsViews.js';
import { NewsMimLogic, newsParse } from '../src/report/news.js';

const image = (source = 'http://fixture.invalid/image.jpg', width = '300', height = '512') => ({
  source, width, height,
});

const rawEntry = (headline, entryImage) => {
  const entry = {
    summary: ['A source-shaped summary'],
    'apcm:ContentMetadata': [{ 'apcm:ExtendedHeadLine': [headline] }],
  };
  if (entryImage !== undefined) {
    entry.content = [{ nitf: [{ body: [{ 'body.content': [{ media: [{
      'media-reference': [
        { $: { source: 'full', width: '4000', height: '3000' } },
        { $: entryImage },
        { $: { source: 'thumbnail', width: '128', height: '80' } },
      ],
    }] }] }] }] }];
  }
  return entry;
};

test('S-13 source news parser filters incomplete images and removes the feed header', () => {
  const parsed = newsParse([{
    category: { name: 'science' },
    data: { feed: { entry: [
      rawEntry('Provider header', image()),
      rawEntry('No image'),
      rawEntry('Empty image metadata', image('', '', '')),
      rawEntry('Playable story', image('valid')),
    ] } },
  }]);
  assert.deepEqual(parsed.science.map((item) => item.headline), ['Playable story']);
  assert.deepEqual(parsed.science[0].image, image('valid'));
});

test('S-13 source news view rejects the whole map when one headline is incomplete', async () => {
  await assert.rejects(() => newsViews([
    { category: 'science', image: image('first') },
    { category: 'science' },
  ]), TypeError);
});

test('S-13 source NewsMimLogic propagates an incomplete view failure', async () => {
  const data = {
    local: {
      news: { science: [{ headline: 'No image', adult: false }] },
      views: {},
    },
    runtime: {
      perception: { speaker: 'u1' },
      loop: { users: [{ id: 'u1', birthdate: '1990-01-01' }] },
      location: { iso: '2026-06-12T12:00:00Z' },
    },
    skill: { session: { data: { _personalReport: { singleSkill: 'news' } } } },
  };
  await assert.rejects(() => new NewsMimLogic('News Logic').exit(data), TypeError);
  assert.equal(data.local.views.newsImages, undefined);
  assert.equal(data.local.views.newsImagesUnavailable, undefined);
  assert.equal(data.local.mimPaths, undefined);
});
