// News relay — Phoenix port of lasso/relay/APNewsHandler.ts (the 2026 RSS shim).
// AP's paid feed is gone; fetch free RSS (BBC/NPR) by category and re-emit XML in the AP-feed
// shape report-skill's NewsParse expects after xml2js. Provider image metadata is retained when
// the feed supplies a URL and both dimensions; no dimensions or image URL are inferred.
// relayData is the XML string. Cache TTL 65m.
//
// Reference (pegasus @5c0a7390539663ba749d360de348a428c088505c, mirror jiboV2/pegasus):
//   packages/lasso/src/relay/APNewsHandler.ts
//     18-30   constructor: pollIntervalMS || hoursToMs(1); pollingEnabled
//     21      cacheSecondsToLive = 65 * 60  ("Polls every hour, cache with a small overlap")
//     32-40   init(): if pollingEnabled -> await pollAndCacheAll(), then setInterval(pollIntervalMS)
//     42-45   close(): super.close() + clearInterval(this.pollInterval)
//     50-60   pollAndCacheAll() -> fetchAllNews + cacheAllNews
//     62-78   fetchAllNews: every sourceID in apnews.CATEGORIES, per-category try/catch,
//             redisKey `ap_news:${sourceID}`, a failed category stays null
//     80-90   cacheAllNews: per-category try/catch around redisSet (one failure never aborts)
//     92-112  validateAndExtractInputs / createRedisKey
//     114-133 fetchFromExternal (RSS shim: per-category feed URL, 10 s axios timeout,
//             `Empty RSS reply for <category>` on an empty body)
//   packages/lasso/src/relay/AbstractRelayRequestHandler.ts
//     153-173 fetchData: `.response` error reproduces the upstream status
//     182-198 redisSet: skips an empty response, EX ttl, {relayData,lassoDataFromRedis,inserted-at}
//   packages/interfaces/src/personalreport/apnews.ts:15-27 CATEGORIES
//   packages/test-utils/src/lasso-test/APNewsTestData.ts  original AP feed fixtures
//     every entry carries <author><name>AP</name></author> + <rights>© AP…</rights>;
//     entry[0] is the digest: no <summary> and no media, so the consumer drops it and then
//     applies its own `.slice(1, 11)` header offset (NewsParse.ts:121-157).
//
// Polling configuration follows the source `APNewsConfig { pollingEnabled, pollIntervalMS }`
// (LassoService.ts:28-32) and is read from the service options, or from
// ETCO_lasso_apNewsPollingEnabled / ETCO_lasso_apNewsPollIntervalMS when no option is given.
// Polling is OFF by default here because the source default lives in the deployment config
// file, and because an enabled poller fetches all eleven provider feeds.

// AP sourceID -> category (interfaces/src/personalreport/apnews.ts).
export const CATEGORIES = {
  42200: 'business', 42201: 'entertainment', 42202: 'international', 42203: 'health',
  42204: 'strange', 42205: 'politics', 42206: 'science', 42207: 'sports',
  42208: 'technology', 42209: 'general', 42210: 'national',
};

/** APNewsHandler.ts:21 — `65 * 60`; the poll runs hourly against a 65-minute TTL. */
export const NEWS_CACHE_TTL_SECONDS = 65 * 60;
/** APNewsHandler.ts:28 — `TimeUtils.hoursToMs(1)` (jibo-cai-utils hoursToMs: 60*60*1000). */
export const NEWS_POLL_INTERVAL_MS = 60 * 60 * 1000;
/** APNewsHandler.ts (RSS shim) resolves the feed with an axios `timeout: 10000`. */
export const RSS_TIMEOUT_MS = 10000;

const RSS_FEEDS = {
  general: 'https://feeds.bbci.co.uk/news/rss.xml',
  politics: 'https://feeds.bbci.co.uk/news/politics/rss.xml',
  technology: 'https://feeds.bbci.co.uk/news/technology/rss.xml',
  sports: 'https://feeds.bbci.co.uk/sport/rss.xml',
  business: 'https://feeds.bbci.co.uk/news/business/rss.xml',
  science: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml',
  entertainment: 'https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml',
  health: 'https://feeds.bbci.co.uk/news/health/rss.xml',
  international: 'https://feeds.bbci.co.uk/news/world/rss.xml',
  national: 'https://feeds.npr.org/1001/rss.xml',
  strange: 'https://feeds.bbci.co.uk/news/rss.xml',
};
const RSS_FEEDS_DEFAULT = 'https://feeds.bbci.co.uk/news/rss.xml';

/** feedURL for a sourceID: the per-category table, else the BBC top-stories default. */
export function newsFeedUrl(sourceID) {
  return RSS_FEEDS[CATEGORIES[sourceID]] || RSS_FEEDS_DEFAULT;
}

export function validateNews(q) {
  const raw = q.get('sourceID');
  if (!raw) throw new Error('Source ID required');
  const sourceID = parseInt(raw, 10);
  if (!CATEGORIES[sourceID]) throw new Error(`Invalid Source ID: "${raw}"`);
  return { sourceID };
}

export function newsKey({ sourceID }) { return `ap_news:${sourceID}`; }

/**
 * The exact bytes a relay cache write stores (AbstractRelayRequestHandler.ts:189-194).
 * Kept in one place so a poll-warmed key and a relay-miss key are byte-identical apart
 * from the insertion timestamp.
 * @param {string} relayData
 * @param {() => Date} [now] test seam; defaults to the real clock
 */
export function newsCacheEntry(relayData, now = () => new Date()) {
  return { relayData, lassoDataFromRedis: true, lassoInsertedIntoRedisAt: now().toISOString() };
}

/**
 * `redisSet` (AbstractRelayRequestHandler.ts:182-198 + APNewsHandler.ts:80-90).
 * An empty/falsy provider result is *not* cached; the source logs and returns false.
 * @returns {boolean} whether an entry was written
 */
export function cacheNewsEntry(cache, key, relayData, { log = console, now } = {}) {
  if (!relayData) {
    log?.error?.(`Skipping Redis SET because APNews response is empty`);
    return false;
  }
  cache.set(key, newsCacheEntry(relayData, now), NEWS_CACHE_TTL_SECONDS);
  return true;
}

/**
 * fetchExternal: returns the AP-shaped XML string. opts.get(feedUrl) overrides the RSS fetch.
 * @param {{ sourceID: number }} input
 */
export async function fetchNews(input, { get = defaultRssGet } = {}) {
  const category = CATEGORIES[input.sourceID];
  const feedUrl = newsFeedUrl(input.sourceID);
  const xml = await get(feedUrl);
  if (!xml) throw new Error(`Empty RSS reply for ${category}`);
  const feed = parseRssFeed(String(xml), 10);
  return buildApFeedXml(feed.items, feed.title, { rights: feed.rights, author: feed.author });
}

/**
 * Live provider fetch (APNewsHandler.ts fetchFromExternal, RSS shim): 10 s timeout, and a
 * non-2xx reply surfaces as an axios-shaped error so the relay's fetchError reproduces the
 * upstream status (AbstractRelayRequestHandler.ts:159-161) exactly as `axios.get` did.
 */
export async function defaultRssGet(feedUrl) {
  const res = await fetch(feedUrl, {
    headers: { 'User-Agent': 'jibo-pegasus-news/1.0', Accept: 'application/rss+xml,application/atom+xml,application/xml,text/xml' },
    signal: AbortSignal.timeout(RSS_TIMEOUT_MS),
  });
  const body = await res.text();
  if (!res.ok) {
    const err = new Error(`Request failed with status code ${res.status}`);
    err.response = { status: res.status, statusText: res.statusText, data: body };
    throw err;
  }
  return body;
}

// --- RSS/Atom -> AP feed XML (ported adapter) -------------------------------

export function parseRssItems(xml, limit) {
  return parseRssFeed(xml, limit).items;
}

function parseRssFeed(xml, limit) {
  const source = String(xml);
  const maxItems = limit == null ? Infinity : Math.max(0, Number(limit));
  const feedTitle = extractFeedTitle(source);
  // The provider's own rights statement. The AP fixtures repeat the agency rights on the
  // feed *and* on every entry (APNewsTestData.ts), so the adapter maps the channel
  // <copyright> into the same per-entry position. Nothing is fabricated when it is absent.
  const feedRights = decodeXmlText(extractChannelTag(source, 'copyright'));
  const author = feedTitle ? decodeXmlText(feedTitle) : '';
  const itemRegex = /<(?:item|entry)\b[^>]*>([\s\S]*?)<\/(?:item|entry)>/gi;
  const items = [];
  let m;
  while ((m = itemRegex.exec(source)) !== null && items.length < maxItems) {
    const block = m[1];
    const title = decodeXmlText(extractTag(block, 'title'));
    const desc = decodeXmlText(extractTag(block, 'description') || extractTag(block, 'summary') || extractTag(block, 'content:encoded') || '');
    if (!title) continue;
    const item = { title, description: stripTags(desc) };
    const image = extractImage(block);
    if (image) item.image = image;
    items.push(item);
  }
  return { title: feedTitle, rights: feedRights, author, items };
}

/** The feed/channel header tag, ignoring item/entry bodies. */
function extractChannelTag(xml, tag) {
  const container = /<(?:channel|feed)\b[^>]*>([\s\S]*?)<\/(?:channel|feed)>/i.exec(xml);
  const scope = container ? container[1].replace(/<(?:item|entry)\b[^>]*>[\s\S]*?<\/(?:item|entry)>/gi, '') : '';
  return extractTag(scope, tag);
}

function extractFeedTitle(xml) {
  return decodeXmlText(extractChannelTag(xml, 'title'));
}

function extractTag(block, tag) {
  const cdata = new RegExp(`<${tag}\\b[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, 'i').exec(block);
  if (cdata) return cdata[1];
  const plain = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  return plain ? plain[1] : '';
}

function decodeXmlText(s) {
  if (!s) return '';
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'")
    .replace(/&#xA0;/g, ' ').replace(/&nbsp;/g, ' ').trim();
}

function stripTags(s) { return s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(); }

function parseAttributes(text) {
  const attrs = {};
  const attrPattern = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = attrPattern.exec(text)) !== null) {
    attrs[match[1].toLowerCase()] = decodeXmlText(match[2] == null ? match[3] : match[2]);
  }
  return attrs;
}

function extractImage(block) {
  const tagPattern = /<([\w:.-]+)\b([^>]*?)(?:\/?>)/gi;
  const candidates = [];
  let match;
  while ((match = tagPattern.exec(block)) !== null) {
    const name = match[1].toLowerCase();
    const attrs = parseAttributes(match[2]);
    if (name === 'media:content' || name === 'media:thumbnail') {
      const candidate = imageCandidate(attrs, attrs.url || attrs.href || attrs.src);
      if (candidate) candidates.push(candidate);
    } else if (name === 'enclosure') {
      const candidate = imageCandidate(attrs, attrs.url || attrs.href);
      if (candidate) candidates.push(candidate);
    } else if (name === 'link' && attrs.rel && attrs.rel.toLowerCase() === 'enclosure') {
      const candidate = imageCandidate(attrs, attrs.href || attrs.url);
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates.find((candidate) => candidate.source && candidate.width && candidate.height);
}

function imageCandidate(attrs, source) {
  const medium = (attrs.medium || '').toLowerCase();
  const type = (attrs.type || '').toLowerCase();
  if ((medium && medium !== 'image') || (type && type.indexOf('image/') !== 0)) return null;
  return {
    source,
    width: attrs.width || attrs['media:width'],
    height: attrs.height || attrs['media:height'],
  };
}

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function imageContent(image) {
  const source = escapeXml(image.source);
  const width = escapeXml(image.width);
  const height = escapeXml(image.height);
  // NewsParse reads the AP Preview image at media-reference index 1. The
  // replacement feed has one provider image, so preserve its values there and
  // leave the other role slots without invented URL or dimensions.
  return `
    <content type="text/xml">
      <nitf><body><body.content><media>
        <media-reference />
        <media-reference source="${source}" width="${width}" height="${height}" />
        <media-reference />
      </media></body.content></body></nitf>
    </content>`;
}

/** `<author><name>…</name></author>` — the AP fixtures put the distributing agency here. */
function authorTag(author) {
  return author ? `\n    <author><name>${escapeXml(author)}</name></author>` : '';
}

/** `<rights>…</rights>` — the AP fixtures repeat the feed rights on every entry. */
function rightsTag(rights) {
  return rights ? `\n    <rights>${escapeXml(rights)}</rights>` : '';
}

function apEntry(item, { rights = '', author = '' } = {}) {
  const headline = escapeXml(item.title);
  const summary = item.description ? `\n    <summary>${escapeXml(item.description)}</summary>` : '';
  return `
  <entry>
    <title>${headline}</title>${authorTag(author)}${rightsTag(rights)}${summary}
    <apcm:ContentMetadata>
      <apcm:ExtendedHeadLine>${headline}</apcm:ExtendedHeadLine>
    </apcm:ContentMetadata>${item.image ? imageContent(item.image) : ''}
  </entry>`;
}

/**
 * The digest entry (AP fixture entry[0]): a headline carrier with no `<summary>` and no media,
 * so the source consumer drops it before applying its own `.slice(1, 11)` header offset.
 */
function apHeader(feedTitle, { rights = '', author = '' } = {}) {
  if (!feedTitle) return '';
  const title = escapeXml(feedTitle);
  return `
  <entry>
    <title>${title}</title>${authorTag(author)}${rightsTag(rights)}
    <apcm:ContentMetadata>
      <apcm:ExtendedHeadLine>${title}</apcm:ExtendedHeadLine>
    </apcm:ContentMetadata>
  </entry>`;
}

/**
 * AP-shaped feed for the frozen consumer (NewsParse.ts:121-157 reads `feed.entry[*]`).
 *
 * Fixture-compatible: the apcm 2005 namespace, the digest entry first (title + metadata, no
 * summary, no media), then one entry per story with `<title>`, `<author><name>`, `<rights>`,
 * `<summary>`, `apcm:ExtendedHeadLine` and the NITF media tree whose media-reference[1] is
 * the consumer's Preview slot.
 *
 * Deliberately NOT reproduced, because an RSS provider cannot supply them and the adapter
 * must not present them as parity: the AP feed `id`/`updated`/`apcm:Property FeedProperties`/
 * `link rel=self` and the feed-level `<rights>`, the per-entry AP `id`/`updated`/`published`,
 * the AP media ids and the full/preview/thumbnail variants. See D-06 criterion 3.
 */
export function buildApFeedXml(items, feedTitle = '', { rights = '', author = '' } = {}) {
  const entries = items.map((item) => apEntry(item, { rights, author })).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom" xmlns:apcm="http://ap.org/schemas/03/2005/apcm">${apHeader(feedTitle, { rights, author })}${entries}\n</feed>\n`;
}

// --- polling / prefetch (APNewsHandler.init/close/pollAndCacheAll) ----------

/**
 * setInterval/clearInterval indirection. The source calls the globals; this seam exists so
 * a test can observe the configured interval, it never changes production behaviour.
 */
const DEFAULT_TIMERS = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle),
};

/** `ETCO_lasso_apNewsPollingEnabled` / `ETCO_lasso_apNewsPollIntervalMS` (APNewsConfig). */
export function resolveNewsPolling(env = process.env) {
  const enabled = env?.ETCO_lasso_apNewsPollingEnabled;
  const interval = Number(env?.ETCO_lasso_apNewsPollIntervalMS);
  return {
    pollingEnabled: enabled == null || enabled === '' ? false : String(enabled).toLowerCase() === 'true',
    pollIntervalMS: Number.isFinite(interval) && interval > 0 ? interval : NEWS_POLL_INTERVAL_MS,
  };
}

/**
 * APNewsHandler.ts:32-90. Polls every category in CATEGORIES once at start, then on
 * `pollIntervalMS`; a category whose provider fails is logged and left uncached (its key
 * simply stays a miss and the next GET fetches live), and one failure never aborts another
 * category or a later poll.
 *
 * @param {{ cache: import('./cache.js').TTLCache, get?: Function,
 *           pollingEnabled?: boolean, pollIntervalMS?: number,
 *           log?: { error?: Function, debug?: Function }, now?: () => Date,
 *           timers?: { setInterval: Function, clearInterval: Function } }} opts
 */
export function createNewsPoller({
  cache, get, pollingEnabled = false, pollIntervalMS, log = console, now, timers = DEFAULT_TIMERS,
} = {}) {
  const intervalMS = pollIntervalMS || NEWS_POLL_INTERVAL_MS;
  let timer = null;

  /** fetchAllNews: APNewsHandler.ts:62-78 — every sourceID, failures become null. */
  async function fetchAllNews() {
    const sourceIDs = Object.keys(CATEGORIES).map((key) => parseInt(key, 10));
    return Promise.all(sourceIDs.map(async (sourceID) => {
      let relayData = null;
      try {
        relayData = await fetchNews({ sourceID }, get ? { get } : {});
      } catch (err) {
        log?.error?.(`Error fetching ${sourceID}:`, err?.message ?? err);
      }
      return { redisKey: newsKey({ sourceID }), relayData };
    }));
  }

  /** cacheAllNews: APNewsHandler.ts:80-90 — per-category SET, failures logged. */
  async function cacheAllNews(fetched) {
    await Promise.all(fetched.map(async ({ redisKey, relayData }) => {
      try {
        cacheNewsEntry(cache, redisKey, relayData, { log, now });
      } catch (err) {
        log?.error?.(`Redis SET error (key=${redisKey}):`, err);
      }
    }));
  }

  async function pollOnce() {
    log?.debug?.('Fetching news');
    const fetched = await fetchAllNews();
    log?.debug?.('Fetching finished');
    log?.debug?.('Caching news');
    await cacheAllNews(fetched);
    log?.debug?.('Caching finished');
    return fetched;
  }

  /** init(): poll once, then every intervalMS. Returns whether polling was enabled. */
  async function start() {
    if (!pollingEnabled) return false;
    if (timer) return true;
    await pollOnce();
    // "No need to await hourly polling" (APNewsHandler.ts:36-37): the callback is
    // fire-and-forget, and pollOnce() cannot reject because both phases catch per item.
    timer = timers.setInterval(() => { pollOnce().catch((err) => log?.error?.('APNews poll failed:', err)); }, intervalMS);
    return true;
  }

  /** close(): clearInterval (APNewsHandler.ts:42-45). */
  function stop() {
    if (timer) timers.clearInterval(timer);
    timer = null;
  }

  return {
    start, stop, pollOnce, intervalMS,
    pollingEnabled: !!pollingEnabled,
    isPolling: () => timer !== null,
  };
}

/**
 * Wire the poller to a data service the way LassoService does: the handler polls in `init()`
 * and its interval is cleared in `close()`. Here `init()` is the first `listen()` and
 * `close()` is the server's `close` event, so nothing polls before the service is used and
 * shutdown cannot leak a timer.
 *
 * Options accept the source APNewsConfig names (`pollingEnabled`, `pollIntervalMS`) and the
 * service-facing aliases (`enabled`, `intervalMS`).
 *
 * @param {{ newsPoller?: any, listen: Function }} service
 */
export function installNewsPolling(service, { cache, get, pollingEnabled, pollIntervalMS, enabled, intervalMS, log, now, timers } = {}) {
  const resolved = resolveNewsPolling();
  const enabledOption = pollingEnabled === undefined ? enabled : pollingEnabled;
  const intervalOption = pollIntervalMS === undefined ? intervalMS : pollIntervalMS;
  const poller = createNewsPoller({
    cache,
    get,
    pollingEnabled: enabledOption === undefined ? resolved.pollingEnabled : !!enabledOption,
    pollIntervalMS: intervalOption === undefined ? resolved.pollIntervalMS : intervalOption,
    log,
    now,
    timers,
  });
  if (service) {
    service.newsPoller = poller;
    const listen = service.listen.bind(service);
    service.listen = async (...args) => {
      await poller.start();
      const server = await listen(...args);
      server.once('close', () => poller.stop());
      return server;
    };
  }
  return poller;
}
