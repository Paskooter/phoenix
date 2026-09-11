// D-06 — news polling/prefetch, category coverage and provider attribution.
//
// Pins the parts of the source APNewsHandler that the D-01 relay framework does not
// cover: `init()` polling across every apnews.CATEGORIES sourceID, per-category cache
// updates, per-category failure isolation, the poll interval and `close()` cleanup.
//
// Reference: pegasus packages/lasso/src/relay/APNewsHandler.ts (@5c0a7390539663ba749d360…
// and mirror jiboV2/pegasus)
//   21      cacheSecondsToLive = 65 * 60
//   28      pollIntervalMS || TimeUtils.hoursToMs(1)
//   32-40   init(): await pollAndCacheAll(); setInterval(..., pollIntervalMS)
//   42-45   close(): clearInterval
//   62-78   fetchAllNews: every sourceID in apnews.CATEGORIES, per-category try/catch
//   80-90   cacheAllNews: per-category try/catch around redisSet
//   AbstractRelayRequestHandler.ts:182-198 redisSet skips an empty response
//   packages/interfaces/src/personalreport/apnews.ts:15-27 CATEGORIES
//   packages/test-utils/src/lasso-test/APNewsTestData.ts  original AP fixtures
//   lasso/tests/relay/APNews.test.ts:76-137               original polling tests
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createDataService } from '../src/index.js';
import { TTLCache } from '../src/cache.js';
import {
  CATEGORIES, NEWS_CACHE_TTL_SECONDS, NEWS_POLL_INTERVAL_MS, RSS_TIMEOUT_MS,
  buildApFeedXml, cacheNewsEntry, createNewsPoller, defaultRssGet, fetchNews,
  installNewsPolling, newsCacheEntry, parseRssItems, resolveNewsPolling,
} from '../src/news.js';

const KEY_IDS = Object.keys(CATEGORIES);
const ALL_KEYS = KEY_IDS.map((id) => `ap_news:${id}`).sort();

const FEED = `<?xml version="1.0"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>Provider Headlines</title>
    <copyright><![CDATA[Copyright: (C) Provider, see https://provider.test/terms]]></copyright>
    <item><title>First story</title><description>One description</description>
      <media:thumbnail url="https://cdn.example.test/one.jpg" width="240" height="135" /></item>
    <item><title>Second story</title><description>Two description</description>
      <media:thumbnail url="https://cdn.example.test/two.jpg" width="240" height="135" /></item>
  </channel>
</rss>`;

const FEED_UPDATED = FEED.replace('<title>First story</title>', '<title>Updated story</title>');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = async (service) => {
  const server = await service.listen(0);
  return { server, port: server.address().port };
};
const close = (server) => new Promise((r) => server.close(r));
const get = (port, path) => fetch(`http://localhost:${port}${path}`);

async function waitFor(predicate, timeoutMS = 2000) {
  const deadline = Date.now() + timeoutMS;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(10);
  }
  return false;
}

// ---------------------------------------------------------------------------
// 1. category coverage — every AP sourceID, exactly as the interface table
// ---------------------------------------------------------------------------

test('D06/1 CATEGORIES is the full apnews.CATEGORIES table (11 ids, exact names, order)', () => {
  // packages/interfaces/src/personalreport/apnews.ts:1-27 — CategoryName enum + CATEGORIES map.
  assert.deepEqual(Object.entries(CATEGORIES), [
    ['42200', 'business'], ['42201', 'entertainment'], ['42202', 'international'],
    ['42203', 'health'], ['42204', 'strange'], ['42205', 'politics'],
    ['42206', 'science'], ['42207', 'sports'], ['42208', 'technology'],
    ['42209', 'general'], ['42210', 'national'],
  ]);
  assert.deepEqual(Object.values(CATEGORIES).sort(), [
    'business', 'entertainment', 'general', 'health', 'international',
    'national', 'politics', 'science', 'sports', 'strange', 'technology',
  ]);
  assert.equal(NEWS_CACHE_TTL_SECONDS, 65 * 60, 'APNewsHandler.ts:21');
  assert.equal(NEWS_POLL_INTERVAL_MS, 60 * 60 * 1000, 'TimeUtils.hoursToMs(1), APNewsHandler.ts:28');
  assert.equal(RSS_TIMEOUT_MS, 10000, 'the RSS shim fetches with a 10 s axios timeout');
});

// ---------------------------------------------------------------------------
// 2. polling configuration (APNewsConfig { pollingEnabled, pollIntervalMS })
// ---------------------------------------------------------------------------

test('D06/2 resolveNewsPolling: off by default, ETCO_lasso_apNews* overrides, 1 h default interval', () => {
  assert.deepEqual(resolveNewsPolling({}), { pollingEnabled: false, pollIntervalMS: NEWS_POLL_INTERVAL_MS });
  assert.deepEqual(
    resolveNewsPolling({ ETCO_lasso_apNewsPollingEnabled: 'true', ETCO_lasso_apNewsPollIntervalMS: '250' }),
    { pollingEnabled: true, pollIntervalMS: 250 },
  );
  assert.equal(resolveNewsPolling({ ETCO_lasso_apNewsPollingEnabled: 'false' }).pollingEnabled, false);
  assert.equal(resolveNewsPolling({ ETCO_lasso_apNewsPollIntervalMS: 'nonsense' }).pollIntervalMS, NEWS_POLL_INTERVAL_MS);
});

test('D06/3 polling disabled never touches a provider or the cache (start() is a no-op)', async () => {
  const cache = new TTLCache();
  let fetches = 0;
  const poller = createNewsPoller({ cache, get: async () => { fetches++; return FEED; }, pollingEnabled: false });
  assert.equal(await poller.start(), false);
  assert.equal(poller.isPolling(), false);
  assert.equal(fetches, 0);
  assert.equal(cache.m.size, 0);
  await sleep(30);
  assert.equal(fetches, 0);
});

test('D06/4 the poll interval reaches setInterval as configured (default 1 h)', () => {
  const seen = [];
  const timers = { setInterval: (fn, ms) => { seen.push(ms); return 1; }, clearInterval: () => {} };
  const cache = new TTLCache();
  const a = createNewsPoller({ cache, get: async () => FEED, pollingEnabled: true, timers });
  const b = createNewsPoller({ cache, get: async () => FEED, pollingEnabled: true, pollIntervalMS: 250, timers });
  assert.equal(a.intervalMS, NEWS_POLL_INTERVAL_MS);
  assert.equal(b.intervalMS, 250);
  return a.start().then(() => b.start()).then(() => assert.deepEqual(seen, [NEWS_POLL_INTERVAL_MS, 250]));
});

// ---------------------------------------------------------------------------
// 3. category-specific cache updates (pollAndCacheAll / fetchAllNews / cacheAllNews)
// ---------------------------------------------------------------------------

test('D06/5 the init poll warms every category key with the relay cache shape and the 65 m TTL', async () => {
  const cache = new TTLCache();
  const asked = [];
  const poller = createNewsPoller({ cache, get: async (url) => { asked.push(url); return FEED; }, pollingEnabled: true });
  assert.equal(await poller.start(), true);
  poller.stop();

  assert.equal(asked.length, 11, 'one provider fetch per sourceID (APNewsHandler.ts:62-78)');
  assert.deepEqual([...cache.m.keys()].sort(), ALL_KEYS);
  for (const key of ALL_KEYS) {
    const entry = cache.get(key);
    assert.equal(entry.lassoDataFromRedis, true, `${key} is stored as a cache result`);
    assert.equal(typeof entry.lassoInsertedIntoRedisAt, 'string');
    assert.equal(new Date(entry.lassoInsertedIntoRedisAt).toISOString(), entry.lassoInsertedIntoRedisAt);
    assert.match(entry.relayData, /<apcm:ExtendedHeadLine>First story<\/apcm:ExtendedHeadLine>/);
    const ttl = cache.m.get(key).exp - Date.now();
    assert.ok(ttl > 65 * 60 * 1000 - 2000 && ttl <= 65 * 60 * 1000, `${key} TTL is 3900 s, got ${ttl}`);
  }
});

test('D06/6 a poll-warmed entry is byte-identical to a relay-miss entry for the same key', async () => {
  const missCache = new TTLCache();
  const svc = createDataService({ cache: missCache, newsGet: async () => FEED });
  const { server, port } = await listen(svc);
  try {
    const res = await (await get(port, '/v1/ap_news?sourceID=42209')).json();
    assert.equal(res.lassoDataFromRedis, false);

    const pollCache = new TTLCache();
    const poller = createNewsPoller({ cache: pollCache, get: async () => FEED, pollingEnabled: true });
    await poller.start();
    poller.stop();

    const relayEntry = missCache.m.get('ap_news:42209');
    const pollEntry = pollCache.m.get('ap_news:42209');
    assert.deepEqual(
      { ...pollEntry.v, lassoInsertedIntoRedisAt: null },
      { ...relayEntry.v, lassoInsertedIntoRedisAt: null },
      'the warmed key is indistinguishable from a live miss write',
    );
    assert.ok(Math.abs(pollEntry.exp - relayEntry.exp) < 1000, 'both use the 3900 s relay TTL');

    // And a GET served from the poll-warmed key reports a cache hit.
    const svc2 = createDataService({ cache: pollCache, newsGet: async () => { throw new Error('must not fetch'); } });
    const second = await listen(svc2);
    try {
      const hit = await (await get(second.port, '/v1/ap_news?sourceID=42209')).json();
      assert.equal(hit.lassoDataFromRedis, true);
      assert.equal(hit.relayData, relayEntry.v.relayData);
    } finally { await close(second.server); }
  } finally { await close(server); }
});

test('D06/7 the interval re-polls and replaces the cached payload (original poll test)', async () => {
  const cache = new TTLCache();
  let body = FEED;
  const poller = createNewsPoller({ cache, get: async () => body, pollingEnabled: true, pollIntervalMS: 20 });
  await poller.start();
  try {
    const first = cache.get('ap_news:42209');
    assert.match(first.relayData, /First story/);
    body = FEED_UPDATED;
    const replaced = await waitFor(() => /Updated story/.test(cache.get('ap_news:42209').relayData));
    assert.ok(replaced, 'the hourly interval re-fetched and re-cached the category');
    assert.equal(cache.m.size, 11, 'still exactly the eleven category keys');
  } finally { poller.stop(); }
});

test('D06/8 stop() clears the interval: no provider fetch after shutdown', async () => {
  const cache = new TTLCache();
  let fetches = 0;
  const poller = createNewsPoller({ cache, get: async () => { fetches++; return FEED; }, pollingEnabled: true, pollIntervalMS: 10 });
  await poller.start();
  assert.equal(fetches, 11, 'the init poll is awaited before the interval is armed');
  assert.equal(poller.isPolling(), true);
  poller.stop();
  assert.equal(poller.isPolling(), false);
  const afterStop = fetches;
  assert.equal(afterStop % 11, 0, 'polls are whole-category passes');
  await sleep(120);                       // twelve cancelled 10 ms ticks
  assert.equal(fetches, afterStop, 'clearInterval stopped the polling loop');
});

// ---------------------------------------------------------------------------
// 4. per-category failure isolation (the original 'failed poll does NOT fail later polls')
// ---------------------------------------------------------------------------

test('D06/9 one failing feed leaves only its own key uncached and the next poll recovers it', async () => {
  const cache = new TTLCache();
  const errors = [];
  let nprDown = true;
  const poller = createNewsPoller({
    cache,
    get: async (url) => {
      if (url.includes('npr.org') && nprDown) throw new Error('RSS 503');
      return FEED;
    },
    pollingEnabled: true,
    log: { error: (...args) => errors.push(args.join(' ')) },
  });
  await poller.start();
  try {
    assert.equal(cache.m.size, 10);
    assert.deepEqual(ALL_KEYS.filter((k) => !cache.m.has(k)), ['ap_news:42210'], 'the national (NPR) key stays a miss');
    assert.equal(cache.get('ap_news:42209').lassoDataFromRedis, true, 'other categories cached normally');
    assert.ok(errors.some((line) => line.includes('Error fetching 42210')), 'per-category error is logged');
    assert.ok(
      errors.some((line) => line.includes('Skipping Redis SET because APNews response is empty')),
      'an empty provider result is never cached (AbstractRelayRequestHandler.ts:182-186)',
    );

    nprDown = false;
    await poller.pollOnce();
    assert.equal(cache.m.size, 11);
    assert.equal(cache.get('ap_news:42210').lassoDataFromRedis, true);
  } finally { poller.stop(); }
});

test('D06/10 cacheNewsEntry skips an empty reply instead of writing a falsy entry', () => {
  const cache = new TTLCache();
  const logged = [];
  assert.equal(cacheNewsEntry(cache, 'ap_news:42209', null, { log: { error: (m) => logged.push(m) } }), false);
  assert.equal(cache.m.size, 0);
  assert.deepEqual(logged, ['Skipping Redis SET because APNews response is empty']);
  assert.equal(cacheNewsEntry(cache, 'ap_news:42209', '<feed/>'), true);
  assert.equal(cache.get('ap_news:42209').relayData, '<feed/>');
  assert.equal(NEWS_CACHE_TTL_SECONDS, 3900);
});

// ---------------------------------------------------------------------------
// 5. the real data service: init()/close() parity
// ---------------------------------------------------------------------------

test('D06/11 createDataService: the poll warms the keys, a GET is served without a provider request, close() stops polling', async () => {
  const cache = new TTLCache();
  let fetches = 0;
  const svc = createDataService({
    cache,
    newsGet: async () => { fetches++; return FEED; },
    newsPolling: { enabled: true },          // default 1 h interval: no tick can race this test
  });
  assert.equal(svc.newsPoller.isPolling(), false, 'nothing polls before listen() (init())');
  const { server, port } = await listen(svc);
  try {
    assert.equal(svc.newsPoller.isPolling(), true);
    assert.equal(fetches, 11, 'the init poll fetched every category');
    assert.deepEqual([...cache.m.keys()].sort(), ALL_KEYS);

    const hit = await (await get(port, '/v1/ap_news?sourceID=42209')).json();
    assert.equal(hit.lassoDataFromRedis, true);
    assert.equal(fetches, 11, 'the warmed key served the hit: no provider request');
    assert.match(hit.relayData, /Provider Headlines/);
  } finally {
    await close(server);
  }
  assert.equal(svc.newsPoller.isPolling(), false, 'server close cleared the interval (APNewsHandler.close)');
});

test('D06/12 installNewsPolling accepts the source config names and leaves polling off by default', async () => {
  const cache = new TTLCache();
  let fetches = 0;
  const svc = createDataService({ cache, newsGet: async () => { fetches++; return FEED; } });
  const { server, port } = await listen(svc);
  try {
    assert.equal(svc.newsPoller.pollingEnabled, false, 'the deployment config decides (APNewsConfig.pollingEnabled)');
    assert.equal(fetches, 0);
    const res = await (await get(port, '/v1/ap_news?sourceID=42209')).json();
    assert.equal(res.lassoDataFromRedis, false, 'a cold cache still relays live');
    assert.equal(fetches, 1, 'exactly the one live fetch for the GET');
  } finally { await close(server); }

  const direct = createNewsPoller({ cache, get: async () => FEED, pollingEnabled: true, pollIntervalMS: 60_000 });
  assert.equal(await direct.start(), true);
  direct.stop();
  assert.equal(installNewsPolling(null, { cache, get: async () => FEED, enabled: true }).pollingEnabled, true,
    'the service-facing alias maps onto the APNewsConfig name');
});

// ---------------------------------------------------------------------------
// 6. upstream + cache errors on the news relay
// ---------------------------------------------------------------------------

test('D06/13 a provider error reproduces the upstream status through the news relay', async () => {
  const svc = createDataService({
    newsGet: async () => {
      const err = new Error('Request failed with status code 503');
      err.response = { status: 503, statusText: 'Service Unavailable', data: 'down' };
      throw err;
    },
  });
  const { server, port } = await listen(svc);
  try {
    const res = await get(port, '/v1/ap_news?sourceID=42209');
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(await res.text(), 'Error getting APNews data: "down"');
  } finally { await close(server); }
});

test('D06/14 defaultRssGet raises an axios-shaped error on a non-2xx provider reply', async () => {
  const provider = http.createServer((_req, res) => { res.writeHead(503, { 'content-type': 'text/plain' }); res.end('provider down'); });
  await new Promise((r) => provider.listen(0, r));
  const url = `http://localhost:${provider.address().port}/rss.xml`;
  try {
    await assert.rejects(() => defaultRssGet(url), (err) => {
      assert.equal(err.response.status, 503, 'the relay maps this to the upstream status (AbstractRelayRequestHandler.ts:159-161)');
      assert.equal(err.response.data, 'provider down');
      return true;
    });
  } finally { await new Promise((r) => provider.close(r)); }
});

// ---------------------------------------------------------------------------
// 7. provider attribution / header handling against the AP fixture shape
// ---------------------------------------------------------------------------

test('D06/15 the adapter carries provider rights/author and never invents AP attribution', async () => {
  const items = parseRssItems(FEED, 10);
  assert.equal(items.length, 2);
  const xml = buildApFeedXml(items, 'Provider Headlines', { rights: 'Copyright: (C) Provider', author: 'Provider Headlines' });
  // APNewsTestData.ts entry shape: <title>, <author><name>, <rights>, <summary>, apcm metadata.
  assert.match(xml, /<entry>\s*<title>Provider Headlines<\/title>\s*<author><name>Provider Headlines<\/name><\/author>\s*<rights>Copyright: \(C\) Provider<\/rights>/);
  assert.match(xml, /<author><name>Provider Headlines<\/name><\/author>/);
  assert.equal((xml.match(/<rights>Copyright: \(C\) Provider<\/rights>/g) || []).length, 3, 'feed + header + both stories');
  assert.doesNotMatch(xml, /The Associated Press/, 'no AP attribution is fabricated for an RSS provider');
  assert.doesNotMatch(xml, /Copyright 2018/, 'no AP fixture year is copied');
  // The digest/header entry keeps the fixture boundary: title + metadata, no summary, no media.
  const header = xml.slice(0, xml.indexOf('</entry>') + 8);
  assert.doesNotMatch(header, /<summary>/);
  assert.doesNotMatch(header, /media-reference source=/);
  assert.match(header, /<apcm:ExtendedHeadLine>Provider Headlines<\/apcm:ExtendedHeadLine>/);

  // End to end: the provider's own channel <copyright> reaches every entry's <rights>,
  // the role the AP fixtures give to the AP rights statement. No AP fixture string is
  // ever emitted for an RSS provider.
  const relayed = await fetchNews({ sourceID: 42209 }, { get: async () => FEED });
  const rights = 'Copyright: (C) Provider, see https://provider.test/terms';
  assert.equal((relayed.match(new RegExp(`<rights>${rights.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}</rights>`, 'g')) || []).length, 3);
  assert.match(relayed, /<author><name>Provider Headlines<\/name><\/author>/);
  assert.doesNotMatch(relayed, /The Associated Press/);
});

test('D06/16 buildApFeedXml omits attribution fields the provider did not supply', () => {
  const xml = buildApFeedXml(parseRssItems(FEED, 10));
  assert.doesNotMatch(xml, /<author>/);
  assert.doesNotMatch(xml, /<rights>/);
  assert.equal(NEWS_POLL_INTERVAL_MS, 3600000);
});
