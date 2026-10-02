import { createHash } from 'node:crypto';
import { newsHttpUrl, plainNewsText, newsWordCount, classifyNewsContent, isOpinionNews } from '@phoenix/contracts';

// Provider-specific requests stop here. The worker consumes normalized articles,
// so a later LumenFeed adapter does not change generation, storage, or the skill.
export const WORLD_NEWS_ENDPOINT = 'https://api.worldnewsapi.com/search-news';
export const NEWS_EDITION = 'us-national-v1';
const PUBLISHERS = {
  'bbc.co.uk': 'BBC News', 'bbc.com': 'BBC News', 'apnews.com': 'Associated Press',
  'reuters.com': 'Reuters', 'npr.org': 'NPR', 'cnn.com': 'CNN', 'cbsnews.com': 'CBS News',
  'nbcnews.com': 'NBC News', 'abcnews.go.com': 'ABC News', 'theguardian.com': 'The Guardian',
  'nytimes.com': 'The New York Times', 'washingtonpost.com': 'The Washington Post',
  'usatoday.com': 'USA Today', 'nasa.gov': 'NASA', 'sciencedaily.com': 'Science Daily',
  'espn.com': 'ESPN', 'theverge.com': 'The Verge', 'arstechnica.com': 'Ars Technica',
  'globalvoices.org': 'Global Voices', 'aljazeera.com': 'Al Jazeera', 'bloomberg.com': 'Bloomberg',
  'foxnews.com': 'Fox News', 'news.sky.com': 'Sky News', 'independent.co.uk': 'The Independent',
  'newsweek.com': 'Newsweek', 'forbes.com': 'Forbes', 'cnbc.com': 'CNBC',
  'news.yahoo.com': 'Yahoo News', 'wired.com': 'Wired', 'space.com': 'Space dot com',
};

export async function boundedJson(response, maxBytes = 2 * 1024 * 1024) {
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error('News upstream response too large');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function worldNewsQuery(category, config, now) {
  const query = new URLSearchParams({
    language: 'en', number: String(config.candidatesPerCategory),
    'source-country': 'us', entities: 'LOC:USA',
    sort: 'publish-time', 'sort-direction': 'DESC',
    'earliest-publish-date': new Date(now - config.maxAgeMs).toISOString().slice(0, 19).replace('T', ' '),
    'latest-publish-date': new Date(now).toISOString().slice(0, 19).replace('T', ' '),
  });
  // Publisher country alone does not make an article domestic: also require
  // a US location entity. Legacy world/general IDs now use this US selection.
  if (category === 'strange') query.set('text', 'unusual OR quirky OR bizarre');
  else if (!['general', 'national', 'international'].includes(category)) query.set('categories', category);
  return query;
}

export function normalizeWorldArticle(raw, { now, maxAgeMs }) {
  if (!raw || typeof raw !== 'object') return null;
  if (isOpinionNews(raw)) return null;
  const url = newsHttpUrl(raw.url);
  const title = plainNewsText(raw.title, 240);
  const fullText = plainNewsText(raw.text);
  const date = String(raw.publish_date || '');
  const publishedMs = Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(date) ? date.replace(' ', 'T') + 'Z' : date);
  if (!url || !title || newsWordCount(fullText) < 80 || !Number.isFinite(publishedMs)
      || publishedMs > now + 300000 || now - publishedMs > maxAgeMs) return null;
  const host = new URL(url).hostname.replace(/^www\./, '');
  const publisher = PUBLISHERS[host] || Object.entries(PUBLISHERS).find(([domain]) => host.endsWith('.' + domain))?.[1]
    || host.replace(/\./g, ' dot ').replace(/-/g, ' ');
  if (publisher.length > 100) return null;
  // A bounded set of paragraph-sized passages is enough for a one-minute source
  // read while keeping token spend predictable. Original text remains available
  // to the worker's content filters before this prompt excerpt is made.
  // Split without discarding text around decimals or abbreviations. Matching
  // only runs without punctuation can silently lose the start of such facts.
  const passages = fullText.split(/(?<=[.!?])\s+/u);
  const paragraphs = [];
  let selected = '';
  for (const passage of passages) {
    if (selected.length + passage.length + 1 > 8500) break;
    selected += passage + ' ';
    paragraphs.push({ id: paragraphs.length + 1, text: passage.trim() });
  }
  if (!paragraphs.length) return null;
  return {
    id: createHash('sha256').update(url).digest('hex'), title, url, publisher,
    publishedAt: new Date(publishedMs).toISOString(), fullText,
    flags: classifyNewsContent(String(raw.title || '') + ' ' + String(raw.text || '')),
    imageUrl: newsHttpUrl(raw.image), paragraphs,
    contentHash: createHash('sha256').update(title + '\n' + String(raw.text || '')).digest('hex'),
  };
}

export function createWorldNewsProvider(config, { fetchImpl = fetch } = {}) {
  return {
    id: 'worldnews',
    requestPoints: 1 + config.candidatesPerCategory * 0.01,
    async fetchCategory(category, { now = Date.now(), signal } = {}) {
      const url = new URL(WORLD_NEWS_ENDPOINT);
      url.search = worldNewsQuery(category, config, now).toString();
      const response = await fetchImpl(url, {
        headers: { 'x-api-key': config.apiKey, Accept: 'application/json' },
        signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(15000)]),
        redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel();
        const error = new Error(`World News HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      const data = await boundedJson(response);
      if (!Array.isArray(data.news)) throw new Error('Invalid World News response');
      return { articles: data.news.slice(0, config.candidatesPerCategory)
        .filter(raw => raw && String(raw.source_country || '').toLowerCase() === 'us')
        .map(raw => normalizeWorldArticle(raw, { now, maxAgeMs: config.maxAgeMs })).filter(Boolean),
      quotaLeft: response.headers.get('x-api-quota-left') };
    },
  };
}
