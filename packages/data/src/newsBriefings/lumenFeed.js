import { boundedJson, inspectWorldArticle } from './worldNews.js';
import { newsProviderDiagnostics } from './diagnostics.js';

// Official contract: https://lumenefeed.stoplight.io/docs/lumenfeed/1876padnrm45w-search-articles
export const LUMENFEED_ENDPOINT = 'https://api.lumenfeed.com/api/v1/articles';
// The public API documents topic_id but no topic-name/ID catalogue or category
// parameter. Use its documented keyword search, not invented category IDs or OR
// syntax. Legacy general/world/national categories share the US selection.
const CATEGORY_QUERIES = Object.freeze({
  general: '*', national: '*', international: '*', business: 'business',
  entertainment: 'entertainment', health: 'health', strange: 'quirky', politics: 'politics',
  science: 'science', sports: 'sports', technology: 'technology',
});

export function lumenFeedQuery(category, config, now) {
  if (!Object.hasOwn(CATEGORY_QUERIES, category)) throw new Error('Invalid news category');
  return new URLSearchParams({
    q: CATEGORY_QUERIES[category], query_by: 'title,content_excerpt,keywords',
    filter_by: `language:=en && country:=US && published_at:>${Math.floor((now - config.maxAgeMs) / 1000)} && published_at:<=${Math.floor(now / 1000)}`,
    full_content: 'true', page: '1', per_page: String(config.candidatesPerCategory), sort_by: 'date_desc',
  });
}

export function normalizeLumenArticle(raw, options) {
  return inspectLumenArticle(raw, options).article || null;
}

function inspectLumenArticle(raw, options) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { reason: 'invalid' };
  if (String(raw.country || '').toUpperCase() !== 'US') return { reason: 'country' };
  if (String(raw.language || '').toLowerCase() !== 'en') return { reason: 'language' };
  const publishedMs = Number.isSafeInteger(raw.published_at) && raw.published_at > 0
    ? (raw.published_at < 1e12 ? raw.published_at * 1000 : raw.published_at) : NaN;
  return inspectWorldArticle({
    ...raw, url: raw.source_link,
    // Never summarize a search excerpt or provider HTML in place of full text.
    text: typeof raw.full_content_sanitized === 'string' ? raw.full_content_sanitized : '',
    tags: [raw.tags, raw.keywords].flat(),
    publish_date: Number.isFinite(publishedMs) && publishedMs <= 8640000000000000
      ? new Date(publishedMs).toISOString() : '',
    image: raw.image_url,
  }, options);
}

export function createLumenFeedProvider(config, { fetchImpl = fetch } = {}) {
  return {
    id: 'lumenfeed', requestPoints: 1,
    async fetchCategory(category, { now = Date.now(), signal } = {}) {
      const url = new URL(LUMENFEED_ENDPOINT);
      url.search = lumenFeedQuery(category, config, now).toString();
      const response = await fetchImpl(url, {
        headers: { 'X-API-Key': config.apiKey, Accept: 'application/json' },
        signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(15000)]),
        redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw Object.assign(new Error(`LumenFeed HTTP ${response.status}`), { status: response.status });
      }
      const data = await boundedJson(response);
      if (!Array.isArray(data?.data)) throw new Error('Invalid LumenFeed response');
      const candidates = data.data.slice(0, config.candidatesPerCategory);
      const diagnostics = newsProviderDiagnostics({ received: data.data.length, considered: candidates.length });
      const articles = [];
      for (const raw of candidates) {
        const result = inspectLumenArticle(raw, { now, maxAgeMs: config.maxAgeMs });
        if (result.article) articles.push(result.article);
        else diagnostics.rejected[result.reason]++;
      }
      diagnostics.accepted = articles.length;
      return { articles, diagnostics };
    },
  };
}
