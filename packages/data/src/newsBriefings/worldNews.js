import { createHash } from 'node:crypto';
import { newsHttpUrl, plainNewsText, newsWordCount, classifyNewsContent, isOpinionNews } from '@phoenix/contracts';
import { newsProviderDiagnostics } from './diagnostics.js';

// Both adapters feed the same normalized articles to generation and storage.
// Bounded JSON reads and content inspection are shared with LumenFeed below.
export const WORLD_NEWS_ENDPOINT = 'https://api.worldnewsapi.com/search-news';
export const NEWS_EDITION = 'us-national-v1';
const PUBLISHERS = {
  'bbc.co.uk': 'BBC News', 'bbc.com': 'BBC News', 'apnews.com': 'Associated Press',
  'reuters.com': 'Reuters', 'npr.org': 'NPR', 'cnn.com': 'CNN', 'cbsnews.com': 'CBS News',
  'nbcnews.com': 'NBC News', 'abcnews.go.com': 'ABC News', 'theguardian.com': 'The Guardian',
  'nytimes.com': 'The New York Times', 'washingtonpost.com': 'The Washington Post',
  'usatoday.com': 'USA Today', 'nasa.gov': 'NASA', 'sciencedaily.com': 'Science Daily',
  'espn.com': 'ESPN', 'theverge.com': 'The Verge', 'arstechnica.com': 'Ars Technica',
  'pbs.org': 'PBS NewsHour', 'medicalxpress.com': 'Medical Xpress', 'upi.com': 'UPI',
  'huffpost.com': 'HuffPost', 'variety.com': 'Variety', 'hollywoodreporter.com': 'The Hollywood Reporter',
  'cbssports.com': 'CBS Sports',
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

export function normalizeWorldArticle(raw, options) {
  return inspectWorldArticle(raw, options).article || null;
}

// Shared content validation after each adapter translates its wire fields.
export function inspectWorldArticle(raw, { now, maxAgeMs }) {
  if (!raw || typeof raw !== 'object') return { reason: 'invalid' };
  if (isOpinionNews(raw)) return { reason: 'opinion' };
  const url = newsHttpUrl(raw.url);
  const title = plainNewsText(raw.title, 240);
  const fullText = plainNewsText(raw.text);
  const date = String(raw.publish_date || '');
  const publishedMs = Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(date) ? date.replace(' ', 'T') + 'Z' : date);
  if (!url) return { reason: 'url' };
  if (!title) return { reason: 'title' };
  if (newsWordCount(fullText) < 80) return { reason: 'text' };
  if (!Number.isFinite(publishedMs)) return { reason: 'date' };
  if (publishedMs > now + 300000) return { reason: 'future' };
  if (now - publishedMs > maxAgeMs) return { reason: 'stale' };
  const host = new URL(url).hostname.replace(/^www\./, '');
  const publisher = PUBLISHERS[host] || Object.entries(PUBLISHERS).find(([domain]) => host.endsWith('.' + domain))?.[1]
    || host.replace(/\./g, ' dot ').replace(/-/g, ' ');
  if (publisher.length > 100) return { reason: 'publisher' };
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
  // A provider can flatten paragraph breaks without adding sentence punctuation.
  // Keep a word-bounded source prefix rather than rejecting a long first passage.
  // This remains an excerpt, not a completed sentence or generated factual padding.
  if (!paragraphs.length) {
    const boundary = fullText.lastIndexOf(' ', 8499);
    if (boundary > 0) paragraphs.push({ id: 1, text: fullText.slice(0, boundary) });
  }
  if (!paragraphs.length) return { reason: 'excerpt' };
  return { article: {
    id: createHash('sha256').update(url).digest('hex'), title, url, publisher,
    publishedAt: new Date(publishedMs).toISOString(), fullText,
    flags: classifyNewsContent(String(raw.title || '') + ' ' + String(raw.text || '')),
    imageUrl: newsHttpUrl(raw.image), paragraphs,
    contentHash: createHash('sha256').update(title + '\n' + String(raw.text || '')).digest('hex'),
  } };
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
      const candidates = data.news.slice(0, config.candidatesPerCategory);
      const diagnostics = newsProviderDiagnostics({ received: data.news.length, considered: candidates.length });
      const articles = [];
      for (const raw of candidates) {
        if (!raw || typeof raw !== 'object') { diagnostics.rejected.invalid++; continue; }
        if (String(raw.source_country || '').toLowerCase() !== 'us') { diagnostics.rejected.country++; continue; }
        const result = inspectWorldArticle(raw, { now, maxAgeMs: config.maxAgeMs });
        if (result.article) articles.push(result.article);
        else diagnostics.rejected[result.reason]++;
      }
      diagnostics.accepted = articles.length;
      return { articles, diagnostics, quotaLeft: response.headers.get('x-api-quota-left') };
    },
  };
}
