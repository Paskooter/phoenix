// D-06 runtime probe — real news payloads, real categories, real prefetch.
//
// Runs the actual data service (packages/data/src/index.js) against the live BBC/NPR
// provider feeds and records:
//   A. one GET per AP sourceID with polling off — payload shape per category;
//   B. a poller-enabled service: the initial poll warms every key, a later GET is a
//      cache hit that issues no provider request, and the interval re-polls;
//   C. per-category failure isolation (one feed down, the other ten still cached);
//   D. shutdown cleanup: closing the server clears the poll interval.
//
// Usage: node scripts/d06-news-prefetch-probe.mjs [--out FILE]
import { writeFileSync } from 'node:fs';
import { createDataService } from '../packages/data/src/index.js';
import { TTLCache } from '../packages/data/src/cache.js';
import { CATEGORIES, defaultRssGet, NEWS_POLL_INTERVAL_MS } from '../packages/data/src/news.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const entries = (xml) => (xml.match(/<entry>/g) || []).length;

async function getJson(port, path) {
  const res = await fetch(`http://localhost:${port}${path}`);
  const body = await res.text();
  let json = null;
  try { json = JSON.parse(body); } catch { /* a relay error envelope is plain text */ }
  return { status: res.status, type: res.headers.get('content-type'), body, json };
}

const report = { pollIntervalDefaultMS: NEWS_POLL_INTERVAL_MS, categories: {}, phaseA: {}, phaseB: {}, phaseC: {}, phaseD: {} };

// ------------------------------------------------------------ Phase A: cold cache, all categories live
{
  const cache = new TTLCache();
  const fetches = [];
  const svc = createDataService({ cache, newsGet: async (url) => { fetches.push(url); return defaultRssGet(url); } });
  const server = await svc.listen(0);
  const port = server.address().port;
  try {
    for (const sourceID of Object.keys(CATEGORIES)) {
      const r = await getJson(port, `/v1/ap_news?sourceID=${sourceID}`);
      const xml = r.json.relayData;
      const header = (xml.match(/^[\s\S]*?<\/entry>/) || [''])[0];
      const headlines = [...xml.matchAll(/<apcm:ExtendedHeadLine>([^<]*)<\/apcm:ExtendedHeadLine>/g)].map((m) => m[1]);
      report.categories[sourceID] = {
        categoryName: CATEGORIES[sourceID],
        status: r.status,
        lassoDataFromRedis: r.json.lassoDataFromRedis,
        entries: entries(xml),
        entriesWithProviderImage: (xml.match(/media-reference source=/g) || []).length,
        headerEntryHasNoSummaryOrMedia: !/<entry>[\s\S]*?<summary>/.test(header) && !/media-reference source=/.test(header),
        feedHeaderTitle: headlines[0] || null,
        firstStoryHeadline: headlines[1] || null,
        sampleExcerpt: sourceID === '42209' ? xml.slice(0, 900) : undefined,
      };
    }
    report.phaseA = {
      intent: 'cold cache + polling off: every category is a live provider fetch (miss envelope)',
      providerFetches: fetches.length,
      distinctProviderFeeds: [...new Set(fetches)].sort(),
      cachedKeys: [...cache.m.keys()].sort(),
      allMissEnvelope: Object.values(report.categories).every((c) => c.lassoDataFromRedis === false && c.status === 200),
    };
  } finally { await new Promise((r) => server.close(r)); }
}

// ------------------------------------------------------------ Phase B: poller warms every key
{
  const cache = new TTLCache();
  let providerFetches = 0;
  const svc = createDataService({
    cache,
    newsGet: async (url) => { providerFetches++; return defaultRssGet(url); },
    newsPolling: { enabled: true, intervalMS: 1500 },
  });
  const server = await svc.listen(0);
  const port = server.address().port;
  try {
    const afterStart = { providerFetches, cachedKeyCount: cache.m.size, cachedKeys: [...cache.m.keys()].sort(), isPolling: svc.newsPoller.isPolling() };
    if (!afterStart.isPolling || afterStart.cachedKeyCount !== 11) throw new Error(`phase B: poller did not warm the cache: ${JSON.stringify(afterStart)}`);
    const hit = await getJson(port, '/v1/ap_news?sourceID=42209');
    const afterHit = {
      providerFetches,
      lassoDataFromRedis: hit.json.lassoDataFromRedis,
      contentType: hit.type,
      entriesServed: entries(hit.json.relayData),
      networkRequestsForHit: providerFetches - afterStart.providerFetches,
    };
    while (providerFetches < 22) await sleep(100);
    report.phaseB = {
      intent: 'poller enabled: the init poll warms all eleven keys and a GET is served from the warmed key',
      afterStart,
      afterHit,
      afterSecondPoll: {
        providerFetches,
        pollsCompleted: Math.round(providerFetches / 11),
        cachedEntryShape: (() => { const e = cache.get('ap_news:42209'); return { lassoDataFromRedis: e.lassoDataFromRedis, lassoInsertedIntoRedisAt: e.lassoInsertedIntoRedisAt, relayDataEntries: entries(e.relayData) }; })(),
      },
    };
  } finally { await new Promise((r) => server.close(r)); }
}

// ------------------------------------------------------------ Phase C: one feed down
{
  const cache = new TTLCache();
  let nprUp = false;
  const svc = createDataService({
    cache,
    newsGet: async (url) => {
      if (url.includes('npr.org') && !nprUp) { const e = new Error('Request failed with status code 503'); e.response = { status: 503, statusText: 'Service Unavailable', data: 'down' }; throw e; }
      return defaultRssGet(url);
    },
    newsPolling: { enabled: true, intervalMS: 60000 },
  });
  const server = await svc.listen(0);
  const port = server.address().port;
  try {
    const national = await getJson(port, '/v1/ap_news?sourceID=42210');
    const general = await getJson(port, '/v1/ap_news?sourceID=42209');
    const first = {
      cachedKeyCount: cache.m.size,
      missingKeys: Object.keys(CATEGORIES).map((id) => `ap_news:${id}`).filter((k) => !cache.m.has(k)),
      nationalMiss: { status: national.status, body: national.body, type: national.type },
      generalHit: general.json && general.json.lassoDataFromRedis,
    };
    nprUp = true;                        // next poll: the failed category recovers
    await svc.newsPoller.pollOnce();
    const second = { cachedKeyCount: cache.m.size, missingKeys: Object.keys(CATEGORIES).map((id) => `ap_news:${id}`).filter((k) => !cache.m.has(k)) };
    report.phaseC = {
      intent: 'one provider feed fails: only that key stays uncached and a later poll caches it',
      failedPoll: first,
      recoveredPoll: second,
    };
  } finally { await new Promise((r) => server.close(r)); }
}

// ------------------------------------------------------------ Phase D: shutdown cleanup
{
  const cache = new TTLCache();
  let providerFetches = 0;
  const svc = createDataService({
    cache,
    newsGet: async (url) => { providerFetches++; return defaultRssGet(url); },
    newsPolling: { enabled: true, intervalMS: 300 },
  });
  const server = await svc.listen(0);
  await sleep(50);
  const beforeClose = providerFetches;
  await new Promise((r) => server.close(r));
  await sleep(700);                      // > two intervals: a leaked timer would keep fetching
  report.phaseD = {
    intent: 'close(): the interval is cleared, so no further provider fetches happen after shutdown',
    fetchesAtClose: beforeClose,
    fetchesAfterCloseAndWait: providerFetches,
    isPollingAfterClose: svc.newsPoller.isPolling(),
    leaked: providerFetches !== beforeClose,
    cacheKeysRemaining: cache.m.size,
  };
}

// ------------------------------------------------------------ Phase E: the frozen consumer
{
  const { parseXml } = await import('../packages/skills/src/report/xml.js');
  const { newsParse } = await import('../packages/skills/src/report/news.js');
  const cache = new TTLCache();
  const svc = createDataService({ cache, newsGet: async (url) => defaultRssGet(url) });
  const server = await svc.listen(0);
  const port = server.address().port;
  try {
    const raw = [];
    for (const sourceID of Object.keys(CATEGORIES)) {
      const r = await getJson(port, `/v1/ap_news?sourceID=${sourceID}`);
      raw.push({ category: { name: CATEGORIES[sourceID], sourceID: Number(sourceID) }, data: parseXml(r.json.relayData) });
    }
    const parsed = newsParse(raw);              // report-skill NewsParse.ts:99-163 port
    const perCategory = {};
    for (const [name, list] of Object.entries(parsed)) {
      perCategory[name] = {
        storiesAfterHeaderOffset: list.length,
        headlines: list.map((i) => i.headline).slice(0, 3),
        imageSources: list.map((i) => i.image && i.image.source).slice(0, 2),
      };
    }
    report.phaseE = {
      intent: 'live provider payloads -> the original consumer (parseXml + newsParse): headers dropped, images resolved',
      totalPlayableStories: Object.values(parsed).reduce((n, l) => n + l.length, 0),
      categoriesWithStories: Object.entries(perCategory).filter(([, v]) => v.storiesAfterHeaderOffset > 0).map(([k]) => k),
      categoriesWithoutStories: Object.entries(perCategory).filter(([, v]) => v.storiesAfterHeaderOffset === 0).map(([k]) => k),
      perCategory,
    };
  } finally { await new Promise((r) => server.close(r)); }
}

const text = JSON.stringify(report, null, 2);
console.log(text);
const out = process.argv.indexOf('--out');
if (out > -1 && process.argv[out + 1]) writeFileSync(process.argv[out + 1], text + '\n');
