import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { validateNews, parseRssItems, buildApFeedXml, fetchNews, CATEGORIES } from '../src/news.js';
import { createDataService } from '../src/index.js';

const PORT = 7798;

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel>
  <item><title>Mars rover finds water</title><description><![CDATA[<p>Big news from <b>Mars</b> &amp; beyond</p>]]></description></item>
  <item><title>Markets rally</title><description>Stocks up 2%</description></item>
</channel></rss>`;

const RSS_WITH_IMAGES = `<?xml version="1.0"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>World headlines</title>
    <item>
      <title>Media content story</title>
      <description><![CDATA[<p>Provider description.</p>]]></description>
      <media:content url="https://cdn.example.test/trailer.mp4" width="1280" height="720" medium="video" />
      <media:content url="https://cdn.example.test/media-content.jpg?x=1&amp;y=2" width="640" height="360" medium="image" />
    </item>
    <item>
      <title>Thumbnail story</title>
      <description>Thumbnail description</description>
      <media:thumbnail url="https://cdn.example.test/thumbnail.jpg" width="480" height="270" />
    </item>
    <item>
      <title>Enclosure story</title>
      <description>Enclosure description</description>
      <enclosure url="https://cdn.example.test/enclosure.jpg" type="image/jpeg" width="800" height="450" />
    </item>
    <item>
      <title>No dimensions story</title>
      <description>No dimensions are available.</description>
      <enclosure url="https://cdn.example.test/unknown.jpg" type="image/jpeg" />
    </item>
  </channel>
</rss>`;

const ATOM_WITH_IMAGE = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom headlines</title>
  <entry>
    <title>Atom enclosure story</title>
    <summary>Atom summary</summary>
    <link rel="alternate" href="https://example.test/story" />
    <link rel="enclosure" href="https://cdn.example.test/atom.jpg" type="image/jpeg" media:width="1024" media:height="576" />
  </entry>
</feed>`;

test('validateNews requires a known sourceID', () => {
  assert.throws(() => validateNews(new URLSearchParams('')), /Source ID required/);
  assert.throws(() => validateNews(new URLSearchParams('sourceID=999')), /Invalid Source ID/);
  assert.deepEqual(validateNews(new URLSearchParams('sourceID=42209')), { sourceID: 42209 });
  assert.equal(CATEGORIES[42209], 'general');
});

test('parseRssItems extracts titles + CDATA descriptions, stripping tags', () => {
  const items = parseRssItems(RSS, 10);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'Mars rover finds water');
  assert.equal(items[0].description, 'Big news from Mars & beyond');
});

test('parseRssItems preserves provider image URL and dimensions across RSS image forms', () => {
  const items = parseRssItems(RSS_WITH_IMAGES, 10);
  assert.deepEqual(items.map((item) => item.image), [
    { source: 'https://cdn.example.test/media-content.jpg?x=1&y=2', width: '640', height: '360' },
    { source: 'https://cdn.example.test/thumbnail.jpg', width: '480', height: '270' },
    { source: 'https://cdn.example.test/enclosure.jpg', width: '800', height: '450' },
    undefined,
  ]);
});

test('parseRssItems preserves Atom enclosure dimensions and does not infer missing values', () => {
  const [item] = parseRssItems(ATOM_WITH_IMAGE, 10);
  assert.deepEqual(item.image, {
    source: 'https://cdn.example.test/atom.jpg', width: '1024', height: '576',
  });
});

test('buildApFeedXml emits the AP feed shape (apcm:ExtendedHeadLine + summary)', () => {
  const xml = buildApFeedXml(parseRssItems(RSS, 10));
  assert.match(xml, /xmlns:apcm="http:\/\/ap\.org\/schemas/);
  assert.match(xml, /<apcm:ExtendedHeadLine>Mars rover finds water<\/apcm:ExtendedHeadLine>/);
  assert.match(xml, /<summary>Big news from Mars &amp; beyond<\/summary>/);
});

test('buildApFeedXml does not invent a summary when the provider omits it', () => {
  const xml = buildApFeedXml([{ title: 'Only provider title', description: '' }]);
  assert.doesNotMatch(xml, /<summary>Only provider title<\/summary>/);
  assert.match(xml, /<apcm:ExtendedHeadLine>Only provider title<\/apcm:ExtendedHeadLine>/);
});

test('fetchNews emits the provider header and AP preview media slot without invented media', async () => {
  const xml = await fetchNews({ sourceID: 42209 }, { get: async () => RSS_WITH_IMAGES });
  assert.match(xml, /<entry>\s*<title>World headlines<\/title>[\s\S]*?<apcm:ExtendedHeadLine>World headlines<\/apcm:ExtendedHeadLine>/);
  assert.match(xml, /source="https:\/\/cdn\.example\.test\/media-content\.jpg\?x=1&amp;y=2" width="640" height="360"/);
  assert.match(xml, /<title>No dimensions story<\/title>[\s\S]*?<\/apcm:ContentMetadata>\s*<\/entry>/);
  assert.doesNotMatch(xml, /source="https:\/\/cdn\.example\.test\/unknown\.jpg"/);
});

test('fetchNews does not promote the first story to a synthetic header when feed title is absent', async () => {
  const xml = await fetchNews({ sourceID: 42209 }, { get: async () => RSS });
  assert.equal((xml.match(/<apcm:ExtendedHeadLine>/g) || []).length, 2);
});

let server;
let fetchCount = 0;
before(async () => {
  fetchCount = 0;
  const svc = createDataService({ newsGet: async () => { fetchCount++; return RSS; } });
  server = await svc.listen(PORT);
});
after(() => server?.close?.());

test('GET /v1/ap_news: envelope (miss->false, hit->true) with AP XML relayData', async () => {
  const r1 = await (await fetch(`http://localhost:${PORT}/v1/ap_news?sourceID=42209`)).json();
  assert.equal(r1.lassoDataFromRedis, false);
  assert.match(r1.relayData, /apcm:ExtendedHeadLine/);
  assert.equal(fetchCount, 1);

  const r2 = await (await fetch(`http://localhost:${PORT}/v1/ap_news?sourceID=42209`)).json();
  assert.equal(r2.lassoDataFromRedis, true);
  assert.equal(fetchCount, 1, 'served from cache');
});

test('bad sourceID -> 400', async () => {
  const res = await fetch(`http://localhost:${PORT}/v1/ap_news?sourceID=nope`);
  assert.equal(res.status, 400);
});
