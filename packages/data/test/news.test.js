import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { validateNews, parseRssItems, buildApFeedXml, CATEGORIES } from '../src/news.js';
import { createDataService } from '../src/index.js';

const PORT = 7798;

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel>
  <item><title>Mars rover finds water</title><description><![CDATA[<p>Big news from <b>Mars</b> &amp; beyond</p>]]></description></item>
  <item><title>Markets rally</title><description>Stocks up 2%</description></item>
</channel></rss>`;

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

test('buildApFeedXml emits the AP feed shape (apcm:ExtendedHeadLine + summary)', () => {
  const xml = buildApFeedXml(parseRssItems(RSS, 10));
  assert.match(xml, /xmlns:apcm="http:\/\/ap\.org\/schemas/);
  assert.match(xml, /<apcm:ExtendedHeadLine>Mars rover finds water<\/apcm:ExtendedHeadLine>/);
  assert.match(xml, /<summary>Big news from Mars &amp; beyond<\/summary>/);
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
