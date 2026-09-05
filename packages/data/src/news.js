// News relay — Phoenix port of lasso/relay/APNewsHandler.ts (the 2026 RSS shim).
// AP's paid feed is gone; fetch free RSS (BBC/NPR) by category and re-emit XML in the AP-feed
// shape report-skill's NewsParse expects after xml2js. Provider image metadata is retained when
// the feed supplies a URL and both dimensions; no dimensions or image URL are inferred.
// relayData is the XML string. Cache TTL 65m.

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
  const feed = parseRssFeed(String(xml), 10);
  return buildApFeedXml(feed.items, feed.title);
}

// --- minimal RSS/Atom parsing + AP XML building (ported) -------------------

export function parseRssItems(xml, limit) {
  return parseRssFeed(xml, limit).items;
}

function parseRssFeed(xml, limit) {
  const source = String(xml);
  const maxItems = limit == null ? Infinity : Math.max(0, Number(limit));
  const feedTitle = extractFeedTitle(source);
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
  return { title: feedTitle, items };
}

function extractFeedTitle(xml) {
  const container = /<(?:channel|feed)\b[^>]*>([\s\S]*?)<\/(?:channel|feed)>/i.exec(xml);
  if (!container) return '';
  const withoutItems = container[1].replace(/<(?:item|entry)\b[^>]*>[\s\S]*?<\/(?:item|entry)>/gi, '');
  return decodeXmlText(extractTag(withoutItems, 'title'));
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

function apEntry(item) {
  const headline = escapeXml(item.title);
  const summary = item.description ? `\n    <summary>${escapeXml(item.description)}</summary>` : '';
  return `
  <entry>
    <title>${headline}</title>
    ${summary}
    <apcm:ContentMetadata>
      <apcm:ExtendedHeadLine>${headline}</apcm:ExtendedHeadLine>
    </apcm:ContentMetadata>${item.image ? imageContent(item.image) : ''}
  </entry>`;
}

function apHeader(feedTitle) {
  if (!feedTitle) return '';
  const title = escapeXml(feedTitle);
  return `
  <entry>
    <title>${title}</title>
    <apcm:ContentMetadata>
      <apcm:ExtendedHeadLine>${title}</apcm:ExtendedHeadLine>
    </apcm:ContentMetadata>
  </entry>`;
}

export function buildApFeedXml(items, feedTitle = '') {
  const entries = items.map(apEntry).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom" xmlns:apcm="http://ap.org/schemas/03/2005/apcm">${apHeader(feedTitle)}${entries}\n</feed>\n`;
}
