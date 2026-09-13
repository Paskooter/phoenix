import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseXml } from '../src/report/xml.js';
import { newsParse } from '../src/report/news.js';
import { newsViews } from '../src/report/newsViews.js';
import { fetchNews, parseRssItems } from '../../data/src/news.js';

// The pinned AP fixture (packages/test-utils/src/lasso-test/APNewsTestData.ts at
// 5c0a7390539663ba749d360de348a428c088505c) uses these same xml2js defaults:
// explicit root/arrays, namespace prefixes as tag names, '$' attributes, and
// '_' only for non-whitespace mixed text. This small fixture keeps the shape
// inspectable without copying the archived provider payload into Phoenix.
const AP_SHAPED_XML = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:apcm="http://ap.org/schemas/03/2005/apcm">
  <title type="xhtml"><apxh:div xmlns:apxh="http://www.w3.org/1999/xhtml"><apxh:span>AP &amp; Headlines</apxh:span></apxh:div></title>
  <apcm:Property Name="FeedProperties">
    <apcm:Property Name="Entitlement" Value="A &quot;feed&quot;" />
    <apcm:Property Name="Sequence" Id="42" />
  </apcm:Property>
  <entry xmlns="http://www.w3.org/2005/Atom">
    <summary><![CDATA[Story &amp; <b>markup</b>]]></summary>
    <apcm:ContentMetadata xmlns:apcm="http://ap.org/schemas/03/2005/apcm">
      <apcm:ExtendedHeadLine>Headline &amp; &#x2014; one</apcm:ExtendedHeadLine>
    </apcm:ContentMetadata>
    <content type="text/xml" xml:lang="en-US">
      <nitf xmlns="">
        <body><body.content><media>
          <media-reference id="full" source="https://cdn.test/full?a=1&amp;b=2" width="4000" height="3000" />
          <media-reference id="preview" source="https://cdn.test/preview?a=1&amp;b=2" width="512" height="300" />
          <media-reference id="thumbnail" source="https://cdn.test/thumb" width="128" height="80" />
        </media>
        <media>
          <media-reference id="second-full" source="https://cdn.test/second-full" width="1000" height="700" />
          <media-reference id="second-preview" source="https://cdn.test/second-preview" width="600" height="400" />
        </media></body.content></body>
      </nitf>
    </content>
  </entry>
</feed>`;

const mediaTree = (refs) => [{ nitf: [{ body: [{ 'body.content': [{ media: [{ 'media-reference': refs }] }] }] }] }];
const full = { $: { source: 'full', width: '4000', height: '3000' } };
const thumbnail = { $: { source: 'thumbnail', width: '128', height: '80' } };

function rawEntry(headline, { summary = 'A clean summary', preview, refs, content = true } = {}) {
  const entry = {
    summary: summary == null ? [] : [summary],
    'apcm:ContentMetadata': [{ 'apcm:ExtendedHeadLine': [headline] }],
  };
  if (content) {
    entry.content = mediaTree(refs || [full, { $: preview }, thumbnail]);
  }
  return entry;
}

test('S10 XML parser preserves AP namespaces, attributes, repeated tags, entities, and CDATA', () => {
  const parsed = parseXml(AP_SHAPED_XML);
  const feed = parsed.feed;

  assert.deepEqual(feed.$, {
    xmlns: 'http://www.w3.org/2005/Atom',
    'xmlns:apcm': 'http://ap.org/schemas/03/2005/apcm',
  });
  assert.equal(feed.title[0].$.type, 'xhtml');
  assert.equal(feed.title[0]['apxh:div'][0]['apxh:span'][0], 'AP & Headlines');
  assert.deepEqual(feed['apcm:Property'][0].$, { Name: 'FeedProperties' });
  assert.deepEqual(feed['apcm:Property'][0]['apcm:Property'].map((item) => item.$), [
    { Name: 'Entitlement', Value: 'A "feed"' },
    { Name: 'Sequence', Id: '42' },
  ]);

  const entry = feed.entry[0];
  assert.equal(entry.summary[0], 'Story &amp; <b>markup</b>', 'CDATA does not decode entities');
  assert.equal(
    entry['apcm:ContentMetadata'][0]['apcm:ExtendedHeadLine'][0],
    'Headline & — one',
    'regular text decodes named and numeric entities',
  );
  assert.deepEqual(entry.content[0].$, { type: 'text/xml', 'xml:lang': 'en-US' });
  const media = entry.content[0].nitf[0].body[0]['body.content'][0].media;
  assert.equal(media.length, 2, 'repeated media tags stay in source order');
  const refs = media[0]['media-reference'];
  assert.equal(refs.length, 3);
  assert.deepEqual(refs[1].$, {
    id: 'preview', source: 'https://cdn.test/preview?a=1&b=2', width: '512', height: '300',
  });
});

test('S10 XML parser rejects malformed AP responses instead of returning a partial feed', () => {
  for (const xml of [
    '<feed><entry>',
    '<feed><entry></feed>',
    '<feed><entry><![CDATA[unfinished</entry></feed>',
    '<feed><entry source=unquoted /></feed>',
    '<feed>&bogus;</feed>',
    '<feed>AT&T</feed>',
  ]) {
    assert.throws(() => parseXml(xml), /Malformed XML/, JSON.stringify(xml));
  }
});

test('S10 XML parser keeps xml2js empty-document and post-root behavior', () => {
  assert.equal(parseXml(''), null);
  assert.equal(parseXml(' \n\t<!-- only a comment --> \n'), null);
  assert.deepEqual(parseXml('<feed><entry /></feed><ignored />'), { feed: { entry: [''] } });
  assert.deepEqual(parseXml('<feed/><!---->'), { feed: '' });
  assert.deepEqual(parseXml('<feed />junk'), { feed: '' });
  assert.deepEqual(parseXml('<feed x="first" x="second" />'), { feed: { $: { x: 'first' } } });
  assert.equal(parseXml('<feed>&#xD800;</feed>').feed, '\uD800');
  assert.deepEqual(parseXml('<feed><entry>  ordinary text  </entry></feed>'), {
    feed: { entry: ['  ordinary text  '] },
  });
});

test('S10 XML parser matches xml2js CDATA, comment, and self-closing edge behavior', () => {
  assert.deepEqual(parseXml('<a x="1"><![CDATA[]]></a>'), { a: { $: { x: '1' } } });
  assert.throws(() => parseXml('<a><!--bad--comment--></a>'), /Malformed XML/);
  assert.throws(() => parseXml('<a / >'), /Malformed XML/);
});

test('S10 NewsParse requires preview index 1 source/width/height and keeps source header offset', () => {
  const parsed = newsParse([{
    category: { name: 'science' },
    data: { feed: { entry: [
      rawEntry('Provider header', { summary: null, content: false }),
      rawEntry('No preview', { refs: [full] }),
      rawEntry('Missing source', { preview: { width: '512', height: '300' } }),
      rawEntry('Missing width', { preview: { source: 'missing-width', height: '300' } }),
      rawEntry('Missing height', { preview: { source: 'missing-height', width: '512' } }),
      rawEntry('First playable', { preview: { source: 'first', width: '512', height: '300' } }),
      rawEntry('Malformed content', { content: true, refs: [{ $: full.$ }, { nope: true }] }),
      rawEntry('Second playable', { preview: { source: 'second', width: '512', height: '300' } }),
    ] } },
  }]);

  assert.deepEqual(parsed.science.map((item) => item.headline), ['Second playable']);
  assert.deepEqual(parsed.science[0].image, { source: 'second', width: '512', height: '300' });
});

test('S10 NewsParse preserves source error and incomplete-data boundaries', () => {
  assert.throws(
    () => newsParse([{ category: { name: 'science' }, error: '503 provider down' }]),
    /There was a problem getting NewsData\. 503 provider down/,
  );
  assert.throws(
    () => newsParse([{ category: { name: 'science' }, data: { feed: {} } }]),
    /NewsData returned incomplete data\./,
  );
  assert.throws(
    () => newsParse([{ data: { feed: { entry: [] } } }]),
    /NewsData returned incomplete category info\./,
  );
});

const RSS_FIXTURE = `<?xml version="1.0"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title><![CDATA[Provider &amp; Headlines]]></title>
    <copyright>Copyright &amp; Terms</copyright>
    <item>
      <title>RSS One &amp; More</title>
      <description><![CDATA[<p>One &amp; <b>summary</b></p>]]></description>
      <media:content url="https://cdn.test/one.jpg?a=1&amp;b=2" width="512" height="300" medium="image" />
    </item>
    <item>
      <title>RSS Two</title>
      <summary>Second summary</summary>
      <enclosure url="https://cdn.test/two.jpg" type="image/jpeg" width="300" height="512" />
    </item>
    <item>
      <title>RSS Without Media</title>
      <description>Provider omitted image dimensions.</description>
      <enclosure url="https://cdn.test/missing.jpg" type="image/jpeg" />
    </item>
  </channel>
</rss>`;

test('S10 RSS adapter round-trips provider stories into the AP preview slot without AP parity claims', async () => {
  assert.deepEqual(parseRssItems(RSS_FIXTURE, 10), [
    {
      title: 'RSS One & More',
      description: 'One & summary',
      image: { source: 'https://cdn.test/one.jpg?a=1&b=2', width: '512', height: '300' },
    },
    {
      title: 'RSS Two',
      description: 'Second summary',
      image: { source: 'https://cdn.test/two.jpg', width: '300', height: '512' },
    },
    { title: 'RSS Without Media', description: 'Provider omitted image dimensions.' },
  ]);

  const relay = await fetchNews({ sourceID: 42209 }, { get: async () => RSS_FIXTURE });
  const parsed = parseXml(relay).feed;
  assert.equal(parsed.entry.length, 4, 'provider header plus three provider entries');

  const header = parsed.entry[0];
  assert.equal(header.title[0], 'Provider & Headlines');
  assert.equal(header.summary, undefined, 'header is intentionally image/summary-less');
  assert.equal(header.content, undefined);
  assert.equal(header['apcm:ContentMetadata'][0]['apcm:ExtendedHeadLine'][0], 'Provider & Headlines');

  const firstStory = parsed.entry[1];
  assert.equal(firstStory.summary[0], 'One & summary');
  const firstRefs = firstStory.content[0].nitf[0].body[0]['body.content'][0].media[0]['media-reference'];
  assert.equal(firstRefs[0], '');
  assert.deepEqual(firstRefs[1].$, {
    source: 'https://cdn.test/one.jpg?a=1&b=2', width: '512', height: '300',
  });
  assert.equal(firstRefs[2], '');

  assert.equal(parsed.id, undefined);
  assert.equal(parsed.updated, undefined);
  assert.equal(parsed['apcm:Property'], undefined);
  assert.equal(firstStory.id, undefined);
  assert.equal(firstStory.updated, undefined);
  assert.equal(firstStory.link, undefined);
  assert.equal(parsed.entry[3].content, undefined, 'provider media gap stays a gap');

  const selected = newsParse([{ category: { name: 'general' }, data: { feed: parsed } }]);
  assert.deepEqual(selected.general.map((item) => item.headline), ['RSS Two']);
  assert.deepEqual(selected.general[0].image, {
    source: 'https://cdn.test/two.jpg', width: '300', height: '512',
  });
  const views = await newsViews(selected.general);
  assert.equal(views[0].componentConfigs[0].assets[0].src, 'https://cdn.test/two.jpg');
  assert.equal(views[0].componentConfigs[0].transform.scaleX, 720 / 512);
});

test('S10 RSS adapter keeps empty and malformed provider responses on their source boundaries', async () => {
  assert.deepEqual(parseRssItems('<rss><channel><item><title>truncated', 10), []);
  await assert.rejects(
    () => fetchNews({ sourceID: 42209 }, { get: async () => '' }),
    /Empty RSS reply for general/,
  );
});
