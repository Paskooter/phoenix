import https from 'node:https';
import dns from 'node:dns';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { parseDocument, DomUtils } from 'htmlparser2';
import { newsWordCount, plainNewsText, isOpinionNews } from '@phoenix/contracts';
import { inspectWorldArticle } from './worldNews.js';
import { newsProviderDiagnostics } from './diagnostics.js';

export const CURATED_MIN_WORDS = 120;
export const CURATED_LIMITS = Object.freeze({
  requestTimeoutMs: 10000, categoryTimeoutMs: 60000,
  articleBytes: 3 * 1024 * 1024, feedBytes: 1024 * 1024,
  redirects: 3, feedItems: 80, candidates: 30,
});

const feed = (url, ...hosts) => Object.freeze({ url, hosts: Object.freeze(hosts) });
// English-language US publisher editions, not a claim that every event happens in the US.
// Category-specific sources also act as independent fallbacks; never fill a missing topic
// with an unrelated top-stories feed. No subscription or paid news API is required.
export const CURATED_FEEDS = Object.freeze(Object.fromEntries(Object.entries({
  general: [feed('https://www.cbsnews.com/latest/rss/main', 'cbsnews.com'), feed('https://feeds.npr.org/1001/rss.xml', 'npr.org'), feed('https://www.pbs.org/newshour/feeds/rss/headlines', 'pbs.org')],
  national: [feed('https://www.cbsnews.com/latest/rss/us', 'cbsnews.com'), feed('https://feeds.npr.org/1003/rss.xml', 'npr.org')],
  international: [feed('https://www.cbsnews.com/latest/rss/world', 'cbsnews.com'), feed('https://feeds.npr.org/1004/rss.xml', 'npr.org')],
  business: [feed('https://www.cnbc.com/id/10001147/device/rss/rss.html', 'cnbc.com'), feed('https://www.cbsnews.com/latest/rss/moneywatch', 'cbsnews.com'), feed('https://feeds.npr.org/1006/rss.xml', 'npr.org')],
  entertainment: [feed('https://variety.com/feed/', 'variety.com'), feed('https://www.hollywoodreporter.com/feed/', 'hollywoodreporter.com')],
  health: [feed('https://medicalxpress.com/rss-feed/', 'medicalxpress.com'), feed('https://www.sciencedaily.com/rss/health_medicine.xml', 'sciencedaily.com'), feed('https://www.cbsnews.com/latest/rss/health', 'cbsnews.com')],
  strange: [feed('https://rss.upi.com/news/odd_news.rss', 'upi.com'), feed('https://www.huffpost.com/section/weird-news/feed', 'huffpost.com')],
  politics: [feed('https://www.cbsnews.com/latest/rss/politics', 'cbsnews.com'), feed('https://feeds.npr.org/1014/rss.xml', 'npr.org'), feed('https://www.pbs.org/newshour/feeds/rss/politics', 'pbs.org')],
  science: [feed('https://www.sciencedaily.com/rss/top.xml', 'sciencedaily.com'), feed('https://feeds.arstechnica.com/arstechnica/science', 'arstechnica.com')],
  sports: [feed('https://www.espn.com/espn/rss/news', 'espn.com'), feed('https://www.cbssports.com/rss/headlines/', 'cbssports.com')],
  technology: [feed('https://arstechnica.com/feed/', 'arstechnica.com'), feed('https://www.cbsnews.com/latest/rss/technology', 'cbsnews.com')],
}).map(([category, feeds]) => [category, Object.freeze(feeds)])));

function publicUrl(value, hosts) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Unsafe curated URL'); }
  const host = url.hostname;
  if (url.href.length > 2048 || url.protocol !== 'https:' || url.username || url.password || url.port
      || isIP(host.replace(/^\[|\]$/g, '')) || !host.includes('.') || host.endsWith('.')
      || /\.(?:local|localhost|internal|lan|home|onion|test|invalid)$/i.test(host)
      || (hosts && !hosts.some(domain => host === domain || host.endsWith('.' + domain)))) {
    throw new Error('Unsafe curated URL');
  }
  return url;
}

function publicAddress(address) {
  try {
    const parsed = ipaddr.parse(address);
    // range() labels deprecated site-local and IPv4-compatible IPv6 as unicast.
    return parsed.range() === 'unicast' && (parsed.kind() === 'ipv4' || parsed.match(ipaddr.parse('2000::'), 3));
  } catch { return false; }
}

/** Validate the addresses in the actual socket lookup, not in a racy preflight DNS query. */
export function createCuratedTextFetcher({ requestImpl = https.request, lookupImpl = dns.lookup } = {}) {
  return async function get(value, { signal, hosts, kind = 'article', maxBytes = CURATED_LIMITS.articleBytes, timeoutMs = CURATED_LIMITS.requestTimeoutMs } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Curated request timeout')), Math.min(timeoutMs, CURATED_LIMITS.requestTimeoutMs));
    const boundedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const byteLimit = Math.min(maxBytes, CURATED_LIMITS.articleBytes);
    try {
      let next = value;
      for (let hop = 0; hop <= CURATED_LIMITS.redirects; hop++) {
        const url = publicUrl(next, hosts);
        boundedSignal.throwIfAborted();
        const result = await new Promise((resolve, reject) => {
          let request;
          let settled = false;
          const finish = (error, result) => {
            if (settled) return;
            settled = true;
            boundedSignal.removeEventListener('abort', abort);
            if (error) reject(error); else resolve(result);
          };
          const abort = () => { request?.destroy(); finish(boundedSignal.reason); };
          boundedSignal.addEventListener('abort', abort, { once: true });
          try {
            request = requestImpl(url, {
              agent: false, signal: boundedSignal,
              headers: {
                'User-Agent': 'PhoenixNews/1.0 (+https://jibo.io)', 'Accept-Encoding': 'identity',
                Accept: kind === 'feed' ? 'application/rss+xml,application/atom+xml,application/xml,text/xml' : 'text/html,application/xhtml+xml',
              },
              lookup(host, options, callback) {
                lookupImpl(host, { all: true }, (error, addresses) => {
                  if (error) { callback(error); return; }
                  if (!addresses?.length || addresses.some(record => !publicAddress(record.address))) {
                    callback(new Error('Unsafe curated DNS address')); return;
                  }
                  // These exact addresses go to net.connect; there is no second DNS resolution.
                  if (options.all) callback(null, addresses);
                  else callback(null, addresses[0].address, addresses[0].family);
                });
              },
            }, response => {
              response.once('error', error => finish(error));
              response.once('aborted', () => finish(new Error('Incomplete curated response')));
              const fail = error => { finish(error); response.destroy(); };
              if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
                const location = response.headers.location;
                finish(location ? null : new Error('Invalid curated redirect'), { location });
                response.destroy();
                return;
              }
              if (response.statusCode < 200 || response.statusCode >= 300) {
                fail(Object.assign(new Error(`Curated publisher HTTP ${response.statusCode}`), { status: response.statusCode })); return;
              }
              if (Number(response.headers['content-length']) > byteLimit) { fail(new Error('Curated response too large')); return; }
              if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
                fail(new Error('Unsupported curated content encoding')); return;
              }
              const type = (response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
              const allowed = kind === 'feed' ? ['application/rss+xml', 'application/atom+xml', 'application/xml', 'text/xml']
                : ['text/html', 'application/xhtml+xml'];
              if (!allowed.includes(type)) { fail(new Error('Invalid curated content type')); return; }
              const chunks = [];
              let bytes = 0;
              response.on('data', chunk => {
                bytes += chunk.length;
                if (bytes > byteLimit) { fail(new Error('Curated response too large')); return; }
                chunks.push(Buffer.from(chunk));
              });
              response.once('end', () => finish(null, { text: Buffer.concat(chunks).toString('utf8') }));
            });
            request.once('error', error => finish(error));
            request.end();
          } catch (error) { request?.destroy(); finish(error); }
        });
        if (!result.location) return result.text;
        next = new URL(result.location, url).href;
      }
      throw new Error('Too many curated redirects');
    } finally { clearTimeout(timer); }
  };
}

const name = node => (node.name || '').toLowerCase();
const children = node => (node.children || []).filter(child => child.name && child.type !== 'directive');
const child = (node, tag) => children(node).find(node => name(node) === tag);
const text = node => node ? DomUtils.textContent(node).trim() : '';
const inner = node => node ? (node.children?.some(node => node.name)
  ? DomUtils.getInnerHTML(node) : DomUtils.textContent(node)) : '';

/** RSS/Atom only: no DTD, external entities, HTML landing pages or unbounded item lists. */
export function parseCuratedFeed(xml) {
  if (typeof xml !== 'string' || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Invalid curated feed');
  const document = parseDocument(xml, { xmlMode: true, decodeEntities: true });
  const root = children(document)[0];
  if (!root || !['rss', 'feed', 'rdf:rdf'].includes(name(root))) throw new Error('Invalid curated feed');
  const channel = child(root, 'channel') || root;
  const entries = DomUtils.findAll(node => ['item', 'entry'].includes(name(node)), root.children || []).slice(0, CURATED_LIMITS.feedItems);
  return {
    language: text(child(channel, 'language')) || root.attribs?.['xml:lang'] || '',
    items: entries.map(entry => {
      const atom = name(entry) === 'entry';
      const links = children(entry).filter(node => name(node) === 'link');
      const link = atom ? links.find(node => !node.attribs.rel || node.attribs.rel === 'alternate') : links[0];
      return {
        title: text(child(entry, 'title')),
        url: atom ? link?.attribs.href || '' : text(link),
        publishedAt: text(child(entry, 'pubdate') || child(entry, 'published') || child(entry, 'dc:date') || child(entry, 'updated')),
        body: inner(child(entry, 'content:encoded') || child(entry, 'content') || child(entry, 'description') || child(entry, 'summary')),
        language: entry.attribs?.['xml:lang'] || '',
        tags: children(entry).filter(node => name(node) === 'category').map(node => node.attribs.term || text(node)),
      };
    }),
  };
}

const OMIT = new Set(['script', 'style', 'nav', 'header', 'footer', 'aside', 'form', 'button', 'figure', 'figcaption', 'noscript', 'template']);
const BOILERPLATE = /(?:^|[\s_-])(?:ad|ads|advert\w*|newsletter\w*|subscribe\w*|social|share|sharing|related|recommend\w*|cookie\w*|consent)(?:$|[\s_-])/i;

/** Prefer article/main paragraphs, never scripts, menus, captions or recommendation panels. */
export function extractArticleText(html) {
  const document = parseDocument(String(html), { decodeEntities: true });
  // A visible preview is not a substitute for the publisher's unavailable full article.
  if (/"isAccessibleForFree"\s*:\s*(?:false|"false")/i.test(String(html))) return '';
  function clean(node) {
    for (const item of [...(node.children || [])]) {
      const marker = `${item.attribs?.id || ''} ${item.attribs?.class || ''}`;
      if (OMIT.has(name(item)) || BOILERPLATE.test(marker) || item.attribs?.['aria-hidden'] === 'true' || item.attribs?.hidden !== undefined) {
        DomUtils.removeElement(item);
      } else clean(item);
    }
  }
  clean(document);
  const articles = DomUtils.findAll(node => name(node) === 'article', document.children);
  const mains = DomUtils.findAll(node => name(node) === 'main', document.children);
  const scopes = articles.length ? articles : mains.length ? mains : [document];
  const paragraphs = scopes.flatMap(scope => DomUtils.findAll(node => name(node) === 'p', scope.children || []))
    .map(node => plainNewsText(text(node))).filter(Boolean);
  // Full-content RSS can carry plain text rather than HTML paragraphs.
  return paragraphs.length ? paragraphs.join(' ')
    : /<[a-z][\s\S]*>/i.test(String(html)) ? '' : plainNewsText(text(scopes[0]));
}

export function createCuratedFeedsProvider(config, {
  feeds = CURATED_FEEDS, get = createCuratedTextFetcher(), categoryTimeoutMs = CURATED_LIMITS.categoryTimeoutMs,
} = {}) {
  async function fetchCategory(category, { now, signal }) {
    if (!Object.hasOwn(feeds, category)) throw new Error('Invalid news category');
    signal?.throwIfAborted();
    const diagnostics = newsProviderDiagnostics({});
    const candidates = [];
    let fetched = 0;
    let lastError;
    for (const source of feeds[category]) {
      try {
        const url = publicUrl(source.url);
        const feed = parseCuratedFeed(await get(url.href, { signal, kind: 'feed', maxBytes: CURATED_LIMITS.feedBytes }));
        fetched++;
        diagnostics.received += feed.items.length;
        for (const item of feed.items) candidates.push({ ...item, source, language: item.language || feed.language });
      } catch (error) {
        signal?.throwIfAborted();
        diagnostics.rejected.fetch++;
        lastError = error;
      }
    }
    if (!fetched) throw Object.assign(new Error('Curated feeds unavailable'), { status: lastError?.status });
    const articles = [];
    const seen = new Set();
    const limit = Math.min(CURATED_LIMITS.candidates, config.candidatesPerCategory * 3);
    for (const item of candidates.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))) {
      signal?.throwIfAborted();
      if (diagnostics.considered >= limit || articles.length >= config.candidatesPerCategory) break;
      let url;
      try { url = publicUrl(item.url, item.source.hosts).href; }
      catch { diagnostics.considered++; diagnostics.rejected.url++; continue; }
      if (seen.has(url)) continue;
      seen.add(url);
      diagnostics.considered++;
      const date = Date.parse(item.publishedAt);
      let reason = item.language && !/^en(?:[-_]|$)/i.test(item.language) ? 'language'
        : isOpinionNews(item) ? 'opinion'
          : !item.title ? 'title'
            : !Number.isFinite(date) ? 'date'
              : date > now + 300000 ? 'future' : now - date > config.maxAgeMs ? 'stale' : null;
      let body = '';
      if (!reason) {
        try {
          body = extractArticleText(item.body);
          if (newsWordCount(body) < CURATED_MIN_WORDS) {
            const html = await get(url, { signal, hosts: item.source.hosts, kind: 'article' });
            const page = parseDocument(html);
            const language = DomUtils.findOne(node => name(node) === 'html', page.children)?.attribs.lang;
            if (language && !/^en(?:[-_]|$)/i.test(language)) reason = 'language';
            else body = extractArticleText(html);
          }
        } catch {
          signal?.throwIfAborted();
          reason = 'fetch';
        }
      }
      if (!reason && newsWordCount(body) < CURATED_MIN_WORDS) reason = 'text';
      const result = reason ? { reason } : inspectWorldArticle({
        title: item.title, url, publish_date: item.publishedAt, text: body, tags: item.tags,
      }, { now, maxAgeMs: config.maxAgeMs });
      if (result.article) articles.push(result.article);
      else diagnostics.rejected[result.reason]++;
    }
    diagnostics.accepted = articles.length;
    return { articles, diagnostics };
  }
  return {
    id: 'curated', requestPoints: 0,
    async fetchCategory(category, { now = Date.now(), signal } = {}) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('Curated category timeout')), Math.min(categoryTimeoutMs, CURATED_LIMITS.categoryTimeoutMs));
      const boundedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      try { return await fetchCategory(category, { now, signal: boundedSignal }); }
      finally { clearTimeout(timer); }
    },
  };
}
