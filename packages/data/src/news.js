// News relay — Phoenix port of lasso/relay/APNewsHandler.ts (the 2026 RSS shim).
// AP's paid feed is gone; fetch free RSS (BBC/NPR) by category and re-emit XML in the AP-feed
// shape report-skill's NewsParse expects after xml2js: {feed:{entry:[{summary,'apcm:ContentMetadata':
// [{'apcm:ExtendedHeadLine'}]}]}}. relayData is the XML string. Cache TTL 65m.

// AP sourceID -> category (interfaces/src/personalreport/apnews.ts).
export const CATEGORIES = {
  42200: 'business', 42201: 'entertainment', 42202: 'international', 42203: 'health',
  42204: 'strange', 42205: 'politics', 42206: 'science', 42207: 'sports',
  42208: 'technology', 42209: 'general', 42210: 'national',
};

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

export function validateNews(q) {
  const raw = q.get('sourceID');
  if (!raw) throw new Error('Source ID required');
  const sourceID = parseInt(raw, 10);
  if (!CATEGORIES[sourceID]) throw new Error(`Invalid Source ID: "${raw}"`);
  return { sourceID };
}

export function newsKey({ sourceID }) { return `ap_news:${sourceID}`; }

export async function defaultRssGet(feedUrl) {
  const res = await fetch(feedUrl, {
    headers: { 'User-Agent': 'jibo-pegasus-news/1.0', Accept: 'application/rss+xml,application/atom+xml,application/xml,text/xml' },
  });
  if (!res.ok) { const e = new Error(`RSS ${res.status}`); e.status = 502; throw e; }
  return res.text();
}

/** fetchExternal: returns the AP-shaped XML string. opts.get(feedUrl) overrides the RSS fetch. */
export async function fetchNews(input, { get = defaultRssGet } = {}) {
  const category = CATEGORIES[input.sourceID];
  const feedUrl = RSS_FEEDS[category] || RSS_FEEDS_DEFAULT;
  const xml = await get(feedUrl);
  if (!xml) throw new Error(`Empty RSS reply for ${category}`);
  return buildApFeedXml(parseRssItems(String(xml), 10));
}

// --- minimal RSS/Atom parsing + AP XML building (ported) -------------------

export function parseRssItems(xml, limit) {
  const itemRegex = /<(?:item|entry)\b[^>]*>([\s\S]*?)<\/(?:item|entry)>/gi;
  const items = [];
  let m;
  while ((m = itemRegex.exec(xml)) !== null && items.length < limit) {
    const block = m[1];
    const title = decodeXmlText(extractTag(block, 'title'));
    const desc = decodeXmlText(extractTag(block, 'description') || extractTag(block, 'summary') || extractTag(block, 'content:encoded') || '');
    if (title) items.push({ title, description: stripTags(desc) });
  }
  return items;
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

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function buildApFeedXml(items) {
  const entries = items.map((it) => {
    const headline = escapeXml(it.title);
    const summary = escapeXml(it.description || it.title);
    return `\n  <entry>\n    <summary>${summary}</summary>\n    <apcm:ContentMetadata>\n      <apcm:ExtendedHeadLine>${headline}</apcm:ExtendedHeadLine>\n    </apcm:ContentMetadata>\n  </entry>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns:apcm="http://ap.org/schemas/03/2010/contentmetadata">${entries}\n</feed>\n`;
}
