import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import https from 'node:https';
import dns from 'node:dns';
import { newsWordCount, renderNewsBriefing, validateNewsBriefing } from '@phoenix/contracts';
import { createDataService } from '../src/index.js';
import { CATEGORIES } from '../src/news.js';
import { newsBriefingConfig } from '../src/newsBriefings/config.js';
import { createNewsBriefingWorker } from '../src/newsBriefings/worker.js';
import { createBriefingGenerator, parseBriefingDraft } from '../src/newsBriefings/generate.js';
import { createWorldNewsProvider, normalizeWorldArticle, worldNewsQuery, boundedJson } from '../src/newsBriefings/worldNews.js';
import { newsSpeech, newsDraft, worldArticle, newsTime } from '../../contracts/test/fixtures/newsBriefing.js';

const article = (overrides = {}) => normalizeWorldArticle({ ...worldArticle, ...overrides }, { now: newsTime, maxAgeMs: 36 * 3600000 });
const env = { PHOENIX_NEWS_BRIEFINGS_ENABLED: 'true', WORLD_NEWS_API_KEY: 'fixture-world-key', ETCO_parser_decisionApiKey: 'fixture-router-key' };
const log = { warn() {} };
// Synthetic provider JSON; never read from the owner's account.
const lumenArticle = {
  title: worldArticle.title, source_link: worldArticle.url, language: 'en', country: 'US',
  full_content_sanitized: worldArticle.text, published_at: Date.parse('2026-10-02T10:00:00Z') / 1000,
  image_url: null, keywords: ['science'],
};

function fixture(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'phoenix-news-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = { ...newsBriefingConfig(env), file: join(directory, 'news.json'), ...overrides };
  const clock = { time: newsTime };
  const calls = { provider: 0, model: 0 };
  let articles = [article()];
  const provider = { id: 'worldnews', requestPoints: 1.1, async fetchCategory() { calls.provider++; return { articles }; } };
  const generate = async (source, category, { reserve, settle }) => {
    await reserve(0.004); calls.model++; await settle(0.001);
    return parseBriefingDraft(JSON.stringify(newsDraft), source, category);
  };
  const options = { config, provider, generate, now: () => clock.time, providerSpacingMs: 0, log, categories: { 42206: 'science', 42208: 'technology' } };
  const worker = createNewsBriefingWorker(options);
  t.after(() => worker.stop());
  return { config, clock, calls, worker, options, setArticles(value) { articles = value; } };
}

test('curated needs no publisher key and still reserves the existing AI generation budget', async t => {
  const f = fixture(t, { provider: 'curated', apiKey: '', dailyPoints: 0 });
  const worker = createNewsBriefingWorker({ ...f.options,
    provider: { ...f.options.provider, id: 'curated', requestPoints: 0 },
  });
  t.after(() => worker.stop());
  assert.equal(worker.status().reason, null);
  await worker.refresh();
  assert.equal(worker.items(42206).length, 1);
  assert.equal(worker.status().budget.points, 0);
  assert.equal(worker.status().budget.llmCalls, 1);
});

test('curated RSS and Atom carry real bodies, dates, alternate links and editorial tags into shared inspection', async () => {
  const { parseCuratedFeed, extractArticleText, createCuratedFeedsProvider } = await import('../src/newsBriefings/curatedFeeds.js');
  const body = [worldArticle.text, worldArticle.text].join(' ');
  const content = `<p>${body}</p><aside>unrelated recommendation</aside><script>tracking()</script>`;
  const rss = `<?xml version="1.0" encoding="UTF-8"?><!-- publisher feed --><rss><channel><language>en-US</language><item><title>A satellite &amp; coastal waters</title><link>${worldArticle.url}</link>
    <pubDate>Fri, 02 Oct 2026 10:00:00 GMT</pubDate><description>Short teaser only.</description>
    <content:encoded><![CDATA[${content}]]></content:encoded><category>Science</category></item></channel></rss>`;
  const feed = parseCuratedFeed(rss);
  assert.equal(feed.language, 'en-US');
  assert.equal(feed.items[0].title, 'A satellite & coastal waters');
  assert.equal(extractArticleText(feed.items[0].body), body);
  assert.deepEqual(feed.items[0].tags, ['Science']);
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en"><entry><title>Atom story</title>
    <link href="https://www.nasa.gov/feed" rel="self"/><link href="${worldArticle.url}" rel="alternate"/>
    <updated>2026-10-02T11:00:00Z</updated><published>2026-10-02T10:00:00Z</published>
    <content type="html">&lt;p&gt;${body}&lt;/p&gt;</content><category term="opinion"/></entry></feed>`;
  const parsed = parseCuratedFeed(atom);
  assert.equal(parsed.items[0].url, worldArticle.url);
  assert.equal(parsed.items[0].publishedAt, '2026-10-02T10:00:00Z');
  assert.deepEqual(parsed.items[0].tags, ['opinion']);
  let requests = 0;
  const provider = createCuratedFeedsProvider(newsBriefingConfig(env), {
    feeds: { science: [{ url: 'https://www.nasa.gov/rss', hosts: ['nasa.gov'] }] },
    get: async () => { requests++; return rss; },
  });
  const result = await provider.fetchCategory('science', { now: newsTime });
  assert.equal(provider.requestPoints, 0);
  assert.equal(result.articles[0].fullText, body, 'feed body, not its teaser, reaches existing inspection');
  assert.equal(result.articles[0].publisher, 'NASA');
  assert.equal(result.diagnostics.accepted, 1);
  assert.equal(requests, 1, 'a complete RSS body needs no article-page fetch');
  await assert.rejects(() => provider.fetchCategory('typo'), /category/i);
  assert.throws(() => parseCuratedFeed('<html>not a feed</html>'), /feed/i);
  assert.throws(() => parseCuratedFeed('<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss/>'), /feed/i);
});

// A synthetic HTTPS transport runs the real guarded DNS callback before responding.
function publisherTransport(reply, lookedUp = []) {
  return (url, options, respond) => {
    const request = new EventEmitter();
    request.destroy = error => { if (error) queueMicrotask(() => request.emit('error', error)); };
    request.end = () => options.lookup(url.hostname, { all: true }, (error, addresses) => {
      if (error) { request.emit('error', error); return; }
      lookedUp.push(addresses);
      const { body = '', status = 200, headers = {} } = reply(url, options);
      const response = Readable.from([Buffer.from(body)]);
      response.statusCode = status;
      response.headers = { 'content-type': 'text/html', ...headers };
      const destroy = response.destroy.bind(response);
      response.destroy = () => { response.emit('aborted'); return destroy(); };
      respond(response);
    });
    return request;
  };
}

test('curated transport refuses unsafe URLs and all nonpublic DNS results before a connection', async () => {
  const { createCuratedTextFetcher } = await import('../src/newsBriefings/curatedFeeds.js');
  let requests = 0;
  const get = createCuratedTextFetcher({ requestImpl: () => { requests++; assert.fail('unsafe URL reached transport'); } });
  for (const url of ['http://nasa.gov/story', 'https://user:pass@nasa.gov/story', 'https://localhost/story',
    'https://127.0.0.1/', 'https://2130706433/', 'https://[::1]/', 'https://nasa.gov:444/', 'https://news.local/story']) {
    await assert.rejects(() => get(url), /unsafe/i, url);
  }
  await assert.rejects(() => get('https://evil.nasa.gov.attacker.com/', { hosts: ['nasa.gov'] }), /unsafe/i);
  assert.equal(requests, 0);
  for (const address of ['0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1',
    '192.168.0.1', '192.0.2.1', '198.18.0.1', '224.0.0.1', '::1', '::2', '::127.0.0.1', 'fec0::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2001:db8::1']) {
    const fetchText = createCuratedTextFetcher({
      lookupImpl: (_host, _options, callback) => callback(null, [{ address: '93.184.216.34', family: 4 }, { address, family: address.includes(':') ? 6 : 4 }]),
      requestImpl: publisherTransport(() => assert.fail(`private DNS ${address} connected`)),
    });
    await assert.rejects(() => fetchText('https://nasa.gov/story'), /unsafe/i, address);
  }
  const addresses = [];
  const safe = createCuratedTextFetcher({
    lookupImpl: (_host, _options, callback) => callback(null, [{ address: '93.184.216.34', family: 4 }]),
    requestImpl: publisherTransport((_url, options) => {
      assert.equal(options.agent, false, 'no reused socket can bypass the guarded lookup');
      assert.equal(options.headers['Accept-Encoding'], 'identity');
      return { body: 'public publisher response' };
    }, addresses),
  });
  assert.equal(await safe('https://www.nasa.gov/story', { hosts: ['nasa.gov'] }), 'public publisher response');
  assert.deepEqual(addresses, [[{ address: '93.184.216.34', family: 4 }]], 'validated addresses are passed to the actual socket lookup');
});

test('curated transport bounds redirect hops, response bytes, content types and the entire request lifetime', async () => {
  const { createCuratedTextFetcher, CURATED_LIMITS } = await import('../src/newsBriefings/curatedFeeds.js');
  const lookupImpl = (_host, _options, callback) => callback(null, [{ address: '93.184.216.34', family: 4 }]);
  const make = reply => createCuratedTextFetcher({ lookupImpl, requestImpl: publisherTransport(reply) });
  await assert.rejects(() => make(() => ({ body: 'x'.repeat(33) }))('https://nasa.gov/story', { maxBytes: 32 }), /too large/i);
  await assert.rejects(() => make(() => ({ headers: { 'content-length': '33' } }))('https://nasa.gov/story', { maxBytes: 32 }), /too large/i);
  assert.equal(await make(() => ({ body: 'x'.repeat(32) }))('https://nasa.gov/story', { maxBytes: 32 }), 'x'.repeat(32));
  await assert.rejects(() => make(() => ({ headers: { 'content-encoding': 'gzip' } }))('https://nasa.gov/story'), /encoding/i);
  await assert.rejects(() => make(() => ({ headers: { 'content-type': 'image/jpeg' } }))('https://nasa.gov/story'), /content type/i);
  await assert.rejects(() => make(() => ({ body: '<html>not RSS</html>' }))('https://nasa.gov/feed', { kind: 'feed' }), /content type/i);
  for (const status of [403, 429, 503]) {
    await assert.rejects(() => make(() => ({ status, body: 'untrusted upstream message' }))('https://nasa.gov/story'), error => error.status === status);
  }
  let requests = 0;
  const redirectSignals = [];
  const redirect = make((url, options) => {
    requests++; redirectSignals.push(options.signal);
    return url.pathname === '/first' ? { status: 302, headers: { location: '/second' } } : { body: 'article' };
  });
  assert.equal(await redirect('https://nasa.gov/first'), 'article');
  assert.equal(requests, 2);
  assert.equal(redirectSignals[0], redirectSignals[1], 'redirects share the same absolute deadline signal');
  for (const location of ['http://nasa.gov/story', 'https://127.0.0.1/', 'https://attacker.com/story']) {
    await assert.rejects(() => make(() => ({ status: 302, headers: { location } }))('https://nasa.gov/first', { hosts: ['nasa.gov'] }), /unsafe/i);
  }
  requests = 0;
  await assert.rejects(() => make(() => { requests++; return { status: 302, headers: { location: '/forever' } }; })('https://nasa.gov/first'), /redirect/i);
  assert.equal(requests, CURATED_LIMITS.redirects + 1, 'initial request plus bounded redirect hops, never an unbounded loop');
  const stalled = createCuratedTextFetcher({ requestImpl: () => {
    const request = new EventEmitter(); request.end = () => {}; request.destroy = () => {};
    return request;
  } });
  await assert.rejects(() => stalled('https://nasa.gov/story', { timeoutMs: 20 }), /timeout/i);
  await assert.rejects(() => stalled('https://nasa.gov/story', { signal: AbortSignal.abort() }), { name: 'AbortError' });
});

test('curated extracts article paragraphs, skips unsafe or stale links without fetching, and isolates bad sources', async () => {
  const { createCuratedFeedsProvider, extractArticleText, CURATED_MIN_WORDS } = await import('../src/newsBriefings/curatedFeeds.js');
  const body = [worldArticle.text, worldArticle.text].join(' ');
  const html = `<html lang="en-US"><body><header><p>header boilerplate</p></header><main><nav>menu</nav><article>
    <h1>Headline is not body text</h1><p>${body}</p><script>injected instructions</script><style>hidden text</style>
    <aside><p>side story</p></aside><div class="newsletter"><p>Subscribe to this unrelated newsletter.</p></div>
    <div aria-hidden="true"><p>Hidden recommendation.</p></div><footer><p>copyright</p></footer></article></main><p>outside unrelated story</p></body></html>`;
  assert.equal(extractArticleText(html), body);
  assert.equal(extractArticleText(`<html><body><div>${'menu '.repeat(150)}</div></body></html>`), '', 'page chrome without article paragraphs is not a source body');
  const entry = (path, { date = '2026-10-02T10:00:00Z', title = 'Satellite report', content = 'A teaser.', tag = '' } = {}) =>
    `<item><title>${title}</title><link>${path}</link><pubDate>${date}</pubDate><description><![CDATA[${content}]]></description><category>${tag}</category></item>`;
  const rss = `<rss><channel><language>en</language>${[
    entry('https://www.nasa.gov/stale', { date: '2026-09-01T10:00:00Z' }),
    entry('https://www.nasa.gov/future', { date: '2026-10-04T10:00:00Z' }),
    entry('https://www.nasa.gov/date', { date: 'missing' }),
    entry('https://127.0.0.1/private'), entry('https://attacker.com/story'),
    entry('https://www.nasa.gov/opinion', { tag: 'opinion' }),
    entry('https://www.nasa.gov/broken'), entry('https://www.nasa.gov/too-short'),
    entry('https://www.nasa.gov/spanish'), entry('https://www.nasa.gov/paywall'),
    entry(worldArticle.url), entry(worldArticle.url),
  ].join('')}</channel></rss>`;
  const requests = [];
  const provider = createCuratedFeedsProvider(newsBriefingConfig(env), {
    feeds: { science: [{ url: 'https://www.nasa.gov/bad-rss', hosts: ['nasa.gov'] }, { url: 'https://www.nasa.gov/rss', hosts: ['nasa.gov'] }] },
    get: async (url, options) => {
      requests.push(String(url));
      if (String(url).endsWith('/bad-rss') || String(url).endsWith('/broken')) throw Object.assign(new Error('untrusted error body'), { status: 503 });
      if (String(url).endsWith('/rss')) return rss;
      assert.deepEqual(options.hosts, ['nasa.gov']);
      if (String(url).endsWith('/too-short')) return `<article><p>${'word '.repeat(CURATED_MIN_WORDS - 1)}</p></article>`;
      if (String(url).endsWith('/spanish')) return html.replace('lang="en-US"', 'lang="es"');
      if (String(url).endsWith('/paywall')) return html.replace('<body>', '<script type="application/ld+json">{"isAccessibleForFree":false}</script><body>');
      assert.equal(String(url), worldArticle.url, 'ineligible source URLs must not be fetched');
      return html;
    },
  });
  const result = await provider.fetchCategory('science', { now: newsTime });
  assert.equal(result.articles.length, 1);
  assert.equal(result.articles[0].fullText, body);
  assert.equal(result.diagnostics.rejected.fetch, 2, 'feed and article outages are counted, never exposed');
  for (const [reason, count] of Object.entries({ stale: 1, future: 1, date: 1, url: 2, opinion: 1, text: 2, language: 1 })) {
    assert.equal(result.diagnostics.rejected[reason], count, reason);
  }
  assert.equal(requests.filter(url => url === worldArticle.url).length, 1, 'duplicate links are fetched only once');
  assert.ok(!JSON.stringify(result.diagnostics).includes('untrusted error body'));
});

test('curated category deadline bounds the whole source sweep and caller cancellation makes no request', async () => {
  const { createCuratedFeedsProvider } = await import('../src/newsBriefings/curatedFeeds.js');
  let calls = 0;
  const provider = createCuratedFeedsProvider(newsBriefingConfig(env), {
    categoryTimeoutMs: 20, feeds: { science: [{ url: 'https://nasa.gov/rss', hosts: ['nasa.gov'] }] },
    get: (_url, { signal }) => new Promise((_resolve, reject) => {
      calls++;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  const controller = new AbortController();
  const containment = setTimeout(() => controller.abort(new Error('outer containment only')), 200);
  try {
    await assert.rejects(() => provider.fetchCategory('science', { now: newsTime, signal: controller.signal }), /Curated category timeout/);
  } finally { clearTimeout(containment); }
  assert.equal(calls, 1);
  await assert.rejects(() => provider.fetchCategory('science', { signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('curated default wiring sends full extracted paragraphs through the unchanged AI generator for all eleven categories', async t => {
  const { CURATED_FEEDS, CURATED_MIN_WORDS } = await import('../src/newsBriefings/curatedFeeds.js');
  assert.deepEqual(Object.keys(CURATED_FEEDS).sort(), Object.values(CATEGORIES).sort());
  const sources = new Map();
  for (const [category, feeds] of Object.entries(CURATED_FEEDS)) {
    assert.ok(feeds.length >= 2 && feeds.length <= 3, category);
    for (const source of feeds) { assert.equal(new URL(source.url).protocol, 'https:'); sources.set(source.url, source); }
  }
  const body = [worldArticle.text, worldArticle.text].join(' ');
  const modelCategories = [];
  const publisherRequests = [];
  t.mock.method(dns, 'lookup', (_host, _options, callback) => callback(null, [{ address: '93.184.216.34', family: 4 }]));
  t.mock.method(https, 'request', publisherTransport((url, options) => {
    publisherRequests.push(url.href);
    assert.ok(!JSON.stringify(options.headers).includes('fixture-world-key'));
    const source = sources.get(url.href);
    if (source) return { headers: { 'content-type': 'application/rss+xml' }, body: `<rss><channel><language>en-US</language><item>
      <title>${worldArticle.title}</title><link>https://${source.hosts[0]}/fixture-${encodeURIComponent(url.pathname)}</link>
      <pubDate>2026-10-02T10:00:00Z</pubDate><description>Short teaser.</description></item></channel></rss>` };
    return { body: `<html lang="en"><article><p>${body}</p></article></html>` };
  }));
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(new URL(url).origin, 'https://openrouter.ai', 'only the existing generator uses the model transport');
    const request = JSON.parse(options.body);
    const input = JSON.parse(request.messages[1].content);
    assert.ok(newsWordCount(input.paragraphs.map(p => p.text).join(' ')) >= CURATED_MIN_WORDS);
    assert.equal(input.paragraphs.map(p => p.text).join(' '), body, 'the model receives the article, not the RSS teaser');
    assert.equal(request.response_format.json_schema.strict, true);
    modelCategories.push(input.category);
    const draft = structuredClone(newsDraft);
    draft.sentences[0].text = draft.sentences[0].text.replace('NASA', input.publisher);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(draft) } }], usage: { cost: 0.001 } });
  });
  const f = fixture(t);
  const config = { ...newsBriefingConfig({ ...env, PHOENIX_NEWS_PROVIDER: 'curated', WORLD_NEWS_API_KEY: '' }),
    file: f.config.file, storiesPerCategory: 1, candidatesPerCategory: 1, dailyPoints: 0 };
  const worker = createNewsBriefingWorker({ ...f.options, config, provider: undefined, generate: undefined, categories: CATEGORIES });
  t.after(() => worker.stop());
  assert.equal(worker.status().reason, null);
  await worker.refresh();
  for (const [id, category] of Object.entries(CATEGORIES)) {
    assert.equal(worker.items(id).length, 1, category);
    validateNewsBriefing(worker.items(id)[0]);
    assert.equal(worker.status().categories[category].lastRun.provider.accepted, 1);
  }
  assert.deepEqual([...new Set(modelCategories)].sort(), Object.values(CATEGORIES).sort());
  assert.equal(worker.status().budget.points, 0);
  assert.equal(worker.status().budget.llmCalls, 11);
  assert.ok(publisherRequests.length >= 33, 'real default wiring requested section feeds and full article pages');
});

test('provider HTTP 5xx switches the rest of the sweep to curated without resetting spend or bypassing AI', async t => {
  const f = fixture(t);
  let primary = 0; let fallback = 0;
  let failing = true;
  const options = { ...f.options,
    provider: { ...f.options.provider, fetchCategory: async () => { primary++; if (failing) throw Object.assign(new Error('untrusted upstream message'), { status: 503 }); return { articles: [article()] }; } },
    fallbackProvider: { id: 'curated', requestPoints: 0, fetchCategory: async () => { fallback++; return { articles: [article()] }; } },
  };
  const worker = createNewsBriefingWorker(options);
  t.after(() => worker.stop());
  await worker.refresh();
  assert.equal(primary, 1, 'a failing paid provider is not retried for every category in one sweep');
  assert.equal(fallback, 2);
  assert.equal(worker.status().budget.points, 1.1, 'the uncertain primary request reservation survives free fallback');
  assert.equal(f.calls.model, 1, 'fallback still uses the existing generator and revision cache');
  assert.equal(worker.items(42206).length, 1);
  assert.equal(worker.items(42208).length, 1);
  await worker.stop();
  failing = false;
  f.clock.time += 12 * 3600000;
  const retry = createNewsBriefingWorker(options);
  t.after(() => retry.stop());
  await retry.refresh();
  assert.equal(primary, 3, 'the next scheduled sweep tries the selected primary again');
  assert.equal(fallback, 2);
  assert.ok(!readFileSync(f.config.file, 'utf8').includes('untrusted upstream message'));
});

test('curated can use an explicitly supplied fallback on empty feeds while auth failures and cancellation never fail over', async t => {
  const f = fixture(t);
  for (const [status, shouldFallback] of [[500, true], [599, true], [401, false], [402, false], [403, false], [429, false]]) {
    let fallback = 0;
    const worker = createNewsBriefingWorker({ ...f.options,
      provider: { ...f.options.provider, fetchCategory: async () => { throw Object.assign(new Error('provider unavailable'), { status }); } },
      fallbackProvider: { id: 'curated', requestPoints: 0, fetchCategory: async () => { fallback++; return { articles: [article()] }; } },
      config: { ...f.config, file: f.config.file + status },
    });
    t.after(() => worker.stop());
    await worker.refresh();
    assert.equal(fallback, shouldFallback ? 2 : 0, String(status));
    assert.equal(worker.items(42206).length, shouldFallback ? 1 : 0);
  }
  let calls = 0;
  const worker = createNewsBriefingWorker({ ...f.options, config: { ...f.config, provider: 'curated', apiKey: '', file: f.config.file + 'empty' },
    provider: { id: 'curated', requestPoints: 0, fetchCategory: async () => ({ articles: [] }) },
    fallbackProvider: { id: 'worldnews', requestPoints: 1.1, fetchCategory: async () => { calls++; return { articles: [article()] }; } },
  });
  t.after(() => worker.stop());
  await worker.refresh();
  assert.equal(calls, 2);
  assert.equal(worker.status().budget.points, 2.2, 'an explicitly supplied paid fallback also reserves its own cost');
  assert.equal(worker.items(42206).length, 1);
  let started;
  const pending = new Promise(resolve => { started = resolve; });
  const cancelled = createNewsBriefingWorker({ ...f.options,
    config: { ...f.config, file: f.config.file + 'cancelled' },
    provider: { ...f.options.provider, fetchCategory: (_category, { signal }) => {
      started();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () =>
        reject(Object.assign(new Error('cancelled provider'), { status: 503 })), { once: true }));
    } },
    fallbackProvider: { id: 'curated', requestPoints: 0, fetchCategory: async () => assert.fail('cancelled refresh must not fail over') },
  });
  const refreshing = cancelled.refresh();
  await pending;
  await cancelled.stop();
  await refreshing;
});

test('LumenFeed 503 automatically uses the default curated adapter with no paid key in publisher requests', async t => {
  const { CURATED_FEEDS } = await import('../src/newsBriefings/curatedFeeds.js');
  const sources = new Map(Object.values(CURATED_FEEDS).flat().map(source => [source.url, source]));
  const body = [worldArticle.text, worldArticle.text].join(' ');
  let paid = 0; let publicRequests = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url.origin, 'https://api.lumenfeed.com');
    assert.equal(options.headers['X-API-Key'], 'fixture-lumen');
    paid++;
    return new Response('upstream unavailable', { status: 503 });
  });
  t.mock.method(dns, 'lookup', (_host, _options, callback) => callback(null, [{ address: '93.184.216.34', family: 4 }]));
  t.mock.method(https, 'request', publisherTransport((url, options) => {
    publicRequests++;
    assert.ok(!JSON.stringify(options.headers).includes('fixture-lumen'));
    const source = sources.get(url.href);
    assert.ok(source, 'full RSS content needs no page request');
    return { headers: { 'content-type': 'application/rss+xml' }, body: `<rss><channel><language>en-US</language><item>
      <title>${worldArticle.title}</title><link>https://${source.hosts[0]}/fixture-${encodeURIComponent(url.pathname)}</link>
      <pubDate>2026-10-02T10:00:00Z</pubDate><content:encoded><![CDATA[<p>${body}</p>]]></content:encoded></item></channel></rss>` };
  }));
  const f = fixture(t);
  const config = { ...newsBriefingConfig({ ...env, PHOENIX_NEWS_PROVIDER: 'lumenfeed', LUMENFEED_API_KEY: 'fixture-lumen' }), file: f.config.file };
  const worker = createNewsBriefingWorker({ ...f.options, config, provider: undefined });
  t.after(() => worker.stop());
  await worker.refresh();
  assert.equal(paid, 1);
  assert.equal(publicRequests, 4);
  assert.equal(worker.status().budget.points, 1);
  assert.ok(f.calls.model >= 2);
  for (const id of Object.keys(f.options.categories)) assert.ok(worker.items(id).length >= 1);
});

test('World News queries all categories within a bounded date window; credentials only in headers', async () => {
  const config = newsBriefingConfig(env);
  for (const category of ['general', 'national', 'international', 'technology', 'business', 'sports', 'science', 'health', 'politics', 'strange', 'entertainment']) {
    const query = worldNewsQuery(category, config, newsTime);
    assert.equal(query.get('source-country'), 'us');
    assert.equal(query.get('entities'), 'LOC:USA');
  }
  assert.equal(worldNewsQuery('technology', config, newsTime).get('categories'), 'technology');
  assert.equal(worldNewsQuery('international', config, newsTime).has('text'), false);
  assert.match(worldNewsQuery('strange', config, newsTime).get('text'), /quirky/);
  assert.equal(worldNewsQuery('general', config, newsTime).has('categories'), false);
  const provider = createWorldNewsProvider(config, { fetchImpl: async (url, options) => {
    assert.equal(url.searchParams.get('number'), '10');
    assert.equal(url.searchParams.get('earliest-publish-date'), '2026-10-01 00:00:00');
    assert.ok(!url.href.includes('fixture-world-key'));
    assert.equal(options.headers['x-api-key'], env.WORLD_NEWS_API_KEY);
    assert.equal(options.redirect, 'error');
    return Response.json({ news: [worldArticle, null, { ...worldArticle, text: 'Just a headline.' },
      { ...worldArticle, source_country: 'in' }, { ...worldArticle, source_country: undefined }] });
  } });
  const result = await provider.fetchCategory('science', { now: newsTime });
  assert.equal(result.articles.length, 1);
  assert.equal(result.articles[0].publisher, 'NASA');
  assert.equal(result.articles[0].publishedAt, '2026-10-02T10:00:00.000Z');
  assert.equal(article({ url: 'javascript:alert(1)' }), null);
  assert.equal(article({ publish_date: '2020-01-01 00:00:00' }), null);
  assert.equal(article({ publish_date: '2026-10-02 14:00:00' }), null);
  assert.equal(article({ url: worldArticle.url + '?utm_source=fixture#one' }).id, article().id);
  assert.equal(article({ text: worldArticle.text + ' '.repeat(16000) + ' murder' }).flags.adult, true);
  const decimalSource = article({ text: 'The U.S. research team measured a change of 11.94 degrees. ' + worldArticle.text });
  assert.equal(decimalSource.paragraphs.map(p => p.text).join(' '), decimalSource.fullText,
    'paragraph segmentation must retain decimals, abbreviations and every surrounding fact');
  await assert.rejects(() => boundedJson(new Response('x'.repeat(1025)), 1024), /too large/);
});

test('LumenFeed queries all eleven categories using documented filters and normalizes full content', async () => {
  const { createLumenFeedProvider, lumenFeedQuery } = await import('../src/newsBriefings/lumenFeed.js');
  const config = newsBriefingConfig({ ...env, LUMENFEED_API_KEY: 'fixture-lumen-key' });
  const queries = {
    general: '*', national: '*', international: '*', technology: 'technology', science: 'science',
    business: 'business', health: 'health', sports: 'sports', politics: 'politics',
    entertainment: 'entertainment', strange: 'quirky',
  };
  let calls = 0;
  const provider = createLumenFeedProvider(config, { fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url.origin + url.pathname, 'https://api.lumenfeed.com/api/v1/articles');
    assert.equal(url.searchParams.get('full_content'), 'true');
    assert.equal(url.searchParams.get('per_page'), '10');
    assert.equal(url.searchParams.get('page'), '1');
    assert.equal(url.searchParams.get('sort_by'), 'date_desc');
    assert.equal(url.searchParams.get('query_by'), 'title,content_excerpt,keywords');
    assert.equal(url.searchParams.get('filter_by'), `language:=en && country:=US && published_at:>${(newsTime - config.maxAgeMs) / 1000} && published_at:<=${newsTime / 1000}`);
    assert.equal(options.headers['X-API-Key'], 'fixture-lumen-key');
    assert.equal(options.headers.Accept, 'application/json');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    assert.ok(!url.href.includes('fixture-lumen-key'));
    return Response.json({ meta: { total_hits: 1000 }, data: [lumenArticle] });
  } });
  assert.equal(provider.id, 'lumenfeed');
  assert.equal(provider.requestPoints, 1, 'LumenFeed counts requests, not World News result points');
  for (const [category, query] of Object.entries(queries)) {
    assert.equal(lumenFeedQuery(category, config, newsTime).get('q'), query, category);
    const result = await provider.fetchCategory(category, { now: newsTime });
    assert.deepEqual(result.articles, [article()], category);
    assert.equal(result.diagnostics.received, 1);
    assert.equal(result.diagnostics.considered, 1);
    assert.equal(result.diagnostics.accepted, 1);
  }
  assert.equal(calls, 11);
  await assert.rejects(() => provider.fetchCategory('not-a-category', { now: newsTime }), /category/i);
  assert.equal(calls, 11, 'unknown categories fail before HTTP');
});

test('LumenFeed rejects unusable sources before generation and counts each first rejection', async () => {
  const { createLumenFeedProvider, normalizeLumenArticle } = await import('../src/newsBriefings/lumenFeed.js');
  const config = newsBriefingConfig({ ...env, LUMENFEED_API_KEY: 'fixture-lumen-key' });
  const cases = [
    ['language', { ...lumenArticle, language: 'es' }],
    ['language', { ...lumenArticle, language: null }],
    ['opinion', { ...lumenArticle, keywords: ['science', 'opinion'] }],
    ['opinion', { ...lumenArticle, title: 'Opinion: A new direction' }],
    ['opinion', { ...lumenArticle, source_link: 'https://nasa.gov/opinion/fixture' }],
    ['opinion', { ...lumenArticle, category: 'commentary' }],
    ['invalid', null], ['invalid', []],
    ['country', { ...lumenArticle, country: 'GB' }],
    ['country', { ...lumenArticle, country: null }],
    ['url', { ...lumenArticle, source_link: 'javascript:alert(1)' }],
    ['title', { ...lumenArticle, title: '' }],
    ['text', { ...lumenArticle, full_content_sanitized: 'Headline only.' }],
    ['text', { ...lumenArticle, full_content_sanitized: null, content_excerpt: worldArticle.text, full_content_html: worldArticle.text }],
    ['text', { ...lumenArticle, full_content_sanitized: worldArticle.text.split(' ') }],
    ['date', { ...lumenArticle, published_at: '2026-10-02T10:00:00Z' }],
    ['date', { ...lumenArticle, published_at: null }],
    ['date', { ...lumenArticle, published_at: Number.MAX_SAFE_INTEGER }],
    ['stale', { ...lumenArticle, published_at: newsTime - config.maxAgeMs - 1 }],
    ['future', { ...lumenArticle, published_at: (newsTime + 300001) }],
  ];
  for (const [reason, raw] of cases) {
    assert.equal(normalizeLumenArticle(raw, { now: newsTime, maxAgeMs: config.maxAgeMs }), null, reason);
    const provider = createLumenFeedProvider(config, { fetchImpl: async () => Response.json({ data: [raw] }) });
    const { articles, diagnostics } = await provider.fetchCategory('health', { now: newsTime });
    assert.deepEqual(articles, []);
    assert.equal(diagnostics.received, 1);
    assert.equal(diagnostics.considered, 1);
    assert.equal(diagnostics.accepted, 0);
    assert.equal(diagnostics.rejected[reason], 1, reason);
    assert.equal(Object.values(diagnostics.rejected).reduce((sum, count) => sum + count, 0), 1);
  }
});

test('LumenFeed preserves timestamp, word-count, URL identity and bounded paragraph rules', async () => {
  const { normalizeLumenArticle } = await import('../src/newsBriefings/lumenFeed.js');
  const config = newsBriefingConfig(env);
  const normalize = overrides => normalizeLumenArticle({ ...lumenArticle, ...overrides }, { now: newsTime, maxAgeMs: config.maxAgeMs });
  assert.deepEqual(normalize({ published_at: lumenArticle.published_at * 1000 }), article());
  assert.equal(normalize({ source_link: worldArticle.url + '?utm_source=fixture#fragment' }).id, article().id);
  assert.equal(normalize({ full_content_sanitized: 'word '.repeat(79) }), null);
  assert.ok(normalize({ full_content_sanitized: 'word '.repeat(80) }));
  const decimal = normalize({ full_content_sanitized: 'The U.S. team measured a change of 11.94 degrees. ' + worldArticle.text });
  assert.equal(decimal.paragraphs.map(p => p.text).join(' '), decimal.fullText);
  const flattened = normalize({ full_content_sanitized: 'ordinary '.repeat(2000) });
  assert.equal(flattened.paragraphs.length, 1);
  assert.ok(flattened.paragraphs[0].text.length < 8500);
  assert.ok(flattened.fullText.startsWith(flattened.paragraphs[0].text));
  assert.equal(normalize({ full_content_sanitized: worldArticle.text + ' '.repeat(17000) + ' murder' }).flags.adult, true);
  assert.equal(normalize({ image_url: 'javascript:alert(1)' }).imageUrl, null);
});

test('LumenFeed bounds result count and JSON bytes, rejects malformed replies and cancels HTTP errors without reading bodies', async () => {
  const { createLumenFeedProvider } = await import('../src/newsBriefings/lumenFeed.js');
  const config = newsBriefingConfig({ ...env, LUMENFEED_API_KEY: 'fixture-lumen-key' });
  const result = await createLumenFeedProvider(config, { fetchImpl: async () => Response.json({ data: Array(11).fill(lumenArticle) }) })
    .fetchCategory('technology', { now: newsTime });
  assert.equal(result.articles.length, 10);
  assert.equal(result.diagnostics.received, 11);
  assert.equal(result.diagnostics.considered, 10);
  for (const data of [null, {}, { data: null }, { data: {} }, { news: [] }]) {
    await assert.rejects(() => createLumenFeedProvider(config, { fetchImpl: async () => Response.json(data) })
      .fetchCategory('health', { now: newsTime }), /Invalid LumenFeed response/);
  }
  await assert.rejects(() => createLumenFeedProvider(config, { fetchImpl: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)) })
    .fetchCategory('science', { now: newsTime }), /too large/);
  await assert.rejects(() => createLumenFeedProvider(config, { fetchImpl: async () => new Response('{') })
    .fetchCategory('science', { now: newsTime }), SyntaxError);
  for (const status of [401, 403, 429, 500, 503]) {
    let cancelled = false;
    const provider = createLumenFeedProvider(config, { fetchImpl: async () => new Response(new ReadableStream({
      cancel() { cancelled = true; },
    }), { status }) });
    await assert.rejects(() => provider.fetchCategory('health', { now: newsTime }), error => {
      assert.equal(error.status, status);
      assert.equal(error.message, `LumenFeed HTTP ${status}`);
      return true;
    });
    assert.equal(cancelled, true, 'untrusted error bodies are cancelled, not parsed or logged');
  }
  const signal = AbortSignal.abort();
  await assert.rejects(() => createLumenFeedProvider(config, { fetchImpl: async (_url, options) => {
    options.signal.throwIfAborted();
    assert.fail('aborted request reached the fixture response');
  } }).fetchCategory('science', { now: newsTime, signal }), { name: 'AbortError' });
});

test('news selects the matching provider key, preferring LumenFeed only when no provider is pinned', () => {
  const both = { ...env, LUMENFEED_API_KEY: 'fixture-lumen-key' };
  assert.equal(newsBriefingConfig(env).provider, 'worldnews');
  assert.equal(newsBriefingConfig(env).apiKey, env.WORLD_NEWS_API_KEY);
  assert.equal(newsBriefingConfig(both).provider, 'lumenfeed');
  assert.equal(newsBriefingConfig(both).apiKey, both.LUMENFEED_API_KEY);
  assert.equal(newsBriefingConfig({ ...both, PHOENIX_NEWS_PROVIDER: '' }).provider, 'lumenfeed');
  const pinned = newsBriefingConfig({ ...both, PHOENIX_NEWS_PROVIDER: 'worldnews' });
  assert.equal(pinned.provider, 'worldnews');
  assert.equal(pinned.apiKey, env.WORLD_NEWS_API_KEY);
  const missing = newsBriefingConfig({ ...env, PHOENIX_NEWS_PROVIDER: 'lumenfeed' });
  assert.equal(missing.provider, 'lumenfeed');
  assert.equal(missing.apiKey, '');
});

test('the default worker selects LumenFeed, publishes all categories and persists diagnostics without extra read or restart calls', async t => {
  const f = fixture(t);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url.origin, 'https://api.lumenfeed.com', 'all external traffic is intercepted and allowlisted');
    assert.equal(options.headers['X-API-Key'], 'fixture-lumen-key');
    requests.push(url.searchParams.get('q'));
    return Response.json({ data: [lumenArticle, { ...lumenArticle, language: 'es' }, { ...lumenArticle, keywords: ['opinion'] }] });
  });
  const config = { ...newsBriefingConfig({ ...env, LUMENFEED_API_KEY: 'fixture-lumen-key' }), file: f.config.file };
  const options = { ...f.options, config, provider: undefined, categories: CATEGORIES };
  const worker = createNewsBriefingWorker(options);
  t.after(() => worker.stop());
  await worker.refresh();
  assert.equal(worker.status().reason, null);
  assert.equal(worker.status().provider, 'lumenfeed');
  assert.equal(requests.length, 11);
  assert.equal(f.calls.model, 1, 'identical article revisions share one generated draft across providers/categories');
  for (const [id, category] of Object.entries(CATEGORIES)) {
    assert.equal(worker.items(id).length, 1, category);
    validateNewsBriefing(worker.items(id)[0]);
    const run = worker.status().categories[category].lastRun;
    assert.equal(run.provider.received, 3);
    assert.equal(run.provider.accepted, 1);
    assert.equal(run.provider.rejected.language, 1);
    assert.equal(run.provider.rejected.opinion, 1);
    assert.equal(run.published, 1);
  }
  assert.equal(worker.status().budget.points, 11);
  const disk = readFileSync(config.file, 'utf8');
  for (const secret of ['fixture-lumen-key', env.WORLD_NEWS_API_KEY, env.ETCO_parser_decisionApiKey, lumenArticle.full_content_sanitized]) {
    assert.ok(!disk.includes(secret));
  }
  await worker.stop();
  const restarted = createNewsBriefingWorker(options);
  t.after(() => restarted.stop());
  await restarted.refresh();
  assert.deepEqual(restarted.status(), worker.status());
  assert.equal(requests.length, 11, 'restart and snapshot reads preserve the refresh interval');
});

test('switching provider with the same key retries immediately without resetting spending or article reuse', async t => {
  const f = fixture(t);
  await f.worker.refresh();
  await f.worker.stop();
  const before = f.worker.status().budget;
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(url.origin, 'https://api.lumenfeed.com');
    requests++;
    return Response.json({ data: [lumenArticle] });
  });
  const switched = createNewsBriefingWorker({ ...f.options,
    config: { ...f.config, provider: 'lumenfeed' }, provider: undefined,
  });
  t.after(() => switched.stop());
  await switched.refresh();
  assert.equal(requests, 2);
  assert.equal(switched.status().budget.points, before.points + 2);
  assert.equal(switched.status().budget.llmCalls, before.llmCalls);
  assert.equal(switched.items(42206).length, 1);
  assert.equal(f.calls.model, 1, 'the same source revision can reuse its validated briefing');
});

test('LumenFeed missing keys and unknown providers fail closed without spending or a World News fallback', async t => {
  const f = fixture(t);
  t.mock.method(globalThis, 'fetch', async () => assert.fail('no network request is allowed'));
  for (const [provider, reason] of [['lumenfeed', 'missing-lumenfeed-key'], ['typo', 'unknown-provider']]) {
    const worker = createNewsBriefingWorker({ ...f.options,
      config: { ...newsBriefingConfig({ ...env, PHOENIX_NEWS_PROVIDER: provider }), file: f.config.file },
      provider: undefined,
    });
    t.after(() => worker.stop());
    await worker.refresh();
    assert.equal(worker.status().reason, reason);
    assert.equal(worker.status().budget.points, 0);
  }
});

test('LumenFeed auth and quota failures stop the sweep and keep reservations across restart', async t => {
  for (const status of [401, 429]) {
    const f = fixture(t);
    let requests = 0;
    const fetchMock = t.mock.method(globalThis, 'fetch', async url => {
      assert.equal(url.origin, 'https://api.lumenfeed.com', 'there is no World News fallback');
      requests++;
      return new Response('fixture error body never persisted', { status });
    });
    const options = { ...f.options, config: { ...f.config, provider: 'lumenfeed' }, provider: undefined };
    const worker = createNewsBriefingWorker(options);
    t.after(() => worker.stop());
    await worker.refresh();
    const view = worker.status();
    assert.equal(requests, 1);
    assert.equal(view.budget.points, 1);
    assert.equal(f.calls.model, 0);
    assert.ok(view.blockedUntil > newsTime);
    assert.equal(view.categories.technology.lastError, `News provider failed (HTTP ${status})`,
      'technology precedes science in the worker priority order');
    assert.ok(!readFileSync(f.config.file, 'utf8').includes('fixture error body'));
    await worker.stop();
    const restarted = createNewsBriefingWorker(options);
    t.after(() => restarted.stop());
    await restarted.refresh();
    assert.equal(requests, 1);
    assert.deepEqual(restarted.status().budget, view.budget);
    fetchMock.mock.restore();
  }
});

test('news pins its model independently and only reuses the decision key for OpenRouter', () => {
  const config = newsBriefingConfig({ ...env, PHOENIX_LLM_MODEL: 'expensive/chat', PHOENIX_LLM_URL: 'https://different.test' });
  assert.equal(config.llm.model, 'deepseek/deepseek-v4.1-flash');
  assert.equal(config.llm.apiKey, env.ETCO_parser_decisionApiKey);
  assert.equal(newsBriefingConfig({ ...env, ETCO_news_llmUrl: 'https://different.test/v1' }).llm.apiKey, '');
  assert.equal(newsBriefingConfig({ ...env, PHOENIX_NEWS_DAILY_POINTS: '1000' }).dailyPoints, 45);
});

test('opinion articles are removed before normalization or model spending, including a changed cached source', async t => {
  assert.equal(article({ title: 'Opinion: A new direction' }), null);
  assert.equal(article({ url: 'https://www.nasa.gov/opinion/fixture' }), null);
  assert.equal(article({ category: 'opinion' }), null);
  const f = fixture(t);
  await f.worker.refresh();
  assert.equal(f.calls.model, 1);
  f.clock.time += 12 * 3600000;
  f.setArticles([{ ...article(), title: 'Editorial: A new direction' }]);
  await f.worker.refresh();
  assert.equal(f.calls.model, 1, 'the generator never receives known opinion pieces');
  assert.deepEqual(f.worker.items(42206), []);
});

test('already cached opinion titles and sections stop playing without waiting for refresh', async t => {
  const f = fixture(t);
  await f.worker.refresh();
  const saved = JSON.parse(readFileSync(f.config.file));
  const original = saved.categories['42206'].items[0];
  saved.categories['42206'].items.push(
    { ...structuredClone(original), id: 'b'.repeat(64), title: 'The FCC Targeting Disney is Another Trump Attack on Press Freedom | Opinion' },
    { ...structuredClone(original), id: 'c'.repeat(64), url: 'https://fixture.test/opinion/untagged-title' },
  );
  writeFileSync(f.config.file, JSON.stringify(saved));
  const restarted = createNewsBriefingWorker(f.options);
  t.after(() => restarted.stop());
  assert.deepEqual(restarted.items(42206).map(item => item.id), [original.id]);
  assert.equal(restarted.status().categories.science.stories, 1);
  assert.deepEqual(restarted.status().budget, saved.budget);
  assert.equal(f.calls.model, 1, 'filtering stored snapshots does not call a model');
});

test('policy changes retain factual snapshots at the spending limit but drop reclassified sources', async t => {
  for (const atLimit of [true, false]) {
    const f = fixture(t, { maxLlmCalls: atLimit ? 1 : 220 });
    await f.worker.refresh();
    const worker = createNewsBriefingWorker({ ...f.options,
      config: { ...f.config, llm: { ...f.config.llm, model: 'replacement-model' } },
      ...(atLimit ? {} : { generate: async () => null }),
    });
    t.after(() => worker.stop());
    await worker.refresh();
    assert.equal(worker.items(42206).length, atLimit ? 1 : 0);
    assert.equal(worker.items(42208).length, atLimit ? 1 : 0);
    assert.equal(f.calls.model, 1);
  }
});

test('drafts enforce length, evidence, attribution and safe Jibo markup without inventing padding', () => {
  const source = article();
  const draft = parseBriefingDraft(JSON.stringify(newsDraft), source, 'science');
  assert.ok(newsWordCount(draft.speech.sentences.join(' ')) >= 50);
  assert.match(renderNewsBriefing(draft.speech), /^<style set="enthusiastic">/);
  assert.equal((renderNewsBriefing(draft.speech).match(/<break size="0.35"\/>/g) || []).length, 2);
  for (const change of [
    d => { d.sentences[0].text = '<anim path="evil"/>' + d.sentences[0].text; },
    d => { d.sentences[0].text = '${skill.secret} ' + d.sentences[0].text; },
    d => { d.sentences[0].evidence = [999]; },
    d => { d.sentences[0].text = 'A short title.'; },
    d => { d.sentences[1].text += ' More padding to make this much too long for the robot.'; },
  ]) {
    const invalid = structuredClone(newsDraft); change(invalid);
    assert.throws(() => parseBriefingDraft(JSON.stringify(invalid), source, 'science'));
  }
  const withoutAttribution = structuredClone(newsDraft);
  withoutAttribution.sentences[0].text = withoutAttribution.sentences[0].text.replace('NASA reports that a', 'A');
  assert.match(parseBriefingDraft(JSON.stringify(withoutAttribution), source, 'science').speech.sentences[0], /^NASA reports:/);
  assert.equal(parseBriefingDraft(JSON.stringify(newsDraft), source, 'health').speech.tone, 'neutral');
  const adult = article({ text: worldArticle.text + ' The study mentions murder.' });
  const filtered = parseBriefingDraft(JSON.stringify(newsDraft), adult, 'science');
  assert.equal(filtered.adult, true);
  assert.equal(filtered.speech.tone, 'neutral');
  assert.equal(parseBriefingDraft(JSON.stringify({ usable: false, tone: 'neutral', sentences: [] }), source, 'science'), null);
});

test('model uses strict schema, a price ceiling, and at most one paid repair', async () => {
  let requests = 0; let reservations = 0; let settlements = 0;
  const config = newsBriefingConfig(env);
  const generate = createBriefingGenerator(config, { fetchImpl: async (_url, options) => {
    requests++;
    const body = JSON.parse(options.body);
    assert.equal(body.response_format.json_schema.strict, true);
    assert.equal(body.provider.max_price.prompt, 0.5);
    assert.equal(body.provider.max_price.completion, 2);
    assert.equal(body.reasoning.enabled, false);
    assert.equal(body.max_tokens, 450);
    assert.equal(options.redirect, 'error');
    assert.equal(body.messages.length, requests === 1 ? 2 : 4);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: requests === 1 ? '{}' : JSON.stringify(newsDraft) } }], usage: { cost: 0.001 } });
  } });
  const result = await generate(article(), 'science', {
    signal: new AbortController().signal,
    reserve: async amount => { assert.ok(amount > 0.001 && amount < 0.02); reservations++; },
    settle: async cost => { assert.equal(cost, 0.001); settlements++; },
  });
  assert.deepEqual(result.speech, newsSpeech);
  assert.equal(requests, 2); assert.equal(reservations, 2); assert.equal(settlements, 2);
});

test('concurrent refreshes and different categories reuse one generation, including after restart', async t => {
  const { worker, calls, options, config, clock } = fixture(t);
  await Promise.all([worker.refresh(), worker.refresh(), worker.refresh()]);
  assert.deepEqual(calls, { provider: 2, model: 1 });
  validateNewsBriefing(worker.items(42206)[0]);
  assert.equal(worker.items(42208).length, 1);
  assert.equal(statSync(config.file).mode & 0o777, 0o600);
  const disk = readFileSync(config.file, 'utf8');
  assert.ok(!disk.includes('fixture-world-key') && !disk.includes('fixture-router-key'));
  const restarted = createNewsBriefingWorker(options);
  t.after(() => restarted.stop());
  await restarted.refresh();
  assert.deepEqual(calls, { provider: 2, model: 1 });
  assert.equal(restarted.status().budget.llmUsd, 0.001);
  clock.time += 12 * 3600000;
  await restarted.refresh();
  assert.deepEqual(calls, { provider: 4, model: 1 });
  assert.equal(restarted.status().budget.llmUsd, 0, 'UTC midnight resets the daily ledger');
});

test('known changed sources cannot fall back to their old generated version', async t => {
  const f = fixture(t);
  await f.worker.refresh();
  f.setArticles([article({ text: worldArticle.text + ' Updated source text.' })]);
  f.clock.time += 12 * 3600000;
  const worker = createNewsBriefingWorker({ ...f.options, generate: async () => null });
  t.after(() => worker.stop());
  await worker.refresh();
  assert.equal(worker.items(42206).length, 0);
  assert.equal(worker.items(42208).length, 0);
});

test('changing the shared edition drops worldwide snapshots without resetting paid usage', async t => {
  const f = fixture(t);
  await f.worker.refresh();
  const saved = JSON.parse(readFileSync(f.config.file));
  delete saved.edition; // pre-US release
  writeFileSync(f.config.file, JSON.stringify(saved));
  const restarted = createNewsBriefingWorker(f.options);
  t.after(() => restarted.stop());
  assert.deepEqual(restarted.items(42206), []);
  assert.deepEqual(restarted.status().budget, saved.budget);
  await restarted.refresh();
  assert.equal(restarted.items(42206).length, 1);
  assert.equal(f.calls.model, 1, 'the same now-US-selected article can reuse its validated draft');
  assert.equal(restarted.status().edition, 'us-national-v1');
});

test('failed refreshes retain good snapshots only until the original freshness deadline', async t => {
  const f = fixture(t);
  await f.worker.refresh();
  f.clock.time += 12 * 3600000;
  const worker = createNewsBriefingWorker({ ...f.options, provider: { ...f.options.provider, fetchCategory: async () => { throw new Error('Offline'); } } });
  t.after(() => worker.stop());
  await worker.refresh();
  assert.equal(worker.items(42206).length, 1);
  assert.match(worker.status().categories.science.lastError, /provider failed/);
  f.clock.time += 25 * 3600000;
  assert.equal(worker.items(42206).length, 0);
});

test('daily quota survives restart, resets on the next UTC day, and corrupt state fails closed', async t => {
  const f = fixture(t, { dailyPoints: 1.1 });
  await f.worker.refresh();
  assert.equal(f.calls.provider, 1);
  const restarted = createNewsBriefingWorker(f.options);
  t.after(() => restarted.stop());
  await restarted.refresh();
  assert.equal(f.calls.provider, 1);
  f.clock.time += 24 * 3600000;
  await restarted.refresh();
  assert.equal(f.calls.provider, 2);
  writeFileSync(f.config.file, '{bad');
  const broken = createNewsBriefingWorker(f.options);
  t.after(() => broken.stop());
  await broken.refresh();
  assert.equal(broken.status().reason, 'storage-unavailable');
  assert.equal(f.calls.provider, 2);
});

test('model reservations survive uncertain network failures and stop further paid requests', async t => {
  const f = fixture(t, { dailyLlmUsd: 0.005 });
  let calls = 0;
  const worker = createNewsBriefingWorker({ ...f.options, generate: async (_a, _c, { reserve }) => {
    await reserve(0.004); calls++; throw new Error('Socket closed after request');
  } });
  t.after(() => worker.stop());
  await worker.refresh();
  assert.equal(calls, 1);
  assert.equal(worker.status().budget.llmUsd, 0.004);
  assert.equal(JSON.parse(readFileSync(f.config.file)).budget.llmCalls, 1);
});

test('an invalid API key stops the category sweep; a missing key spends nothing', async t => {
  const f = fixture(t);
  let calls = 0;
  const worker = createNewsBriefingWorker({ ...f.options, provider: { ...f.options.provider, fetchCategory: async () => {
    calls++; throw Object.assign(new Error('Unauthorized'), { status: 401 });
  } } });
  t.after(() => worker.stop());
  await worker.refresh();
  assert.equal(calls, 1);
  const missing = createNewsBriefingWorker({ ...f.options, config: { ...f.config, apiKey: '' } });
  t.after(() => missing.stop());
  await missing.refresh();
  assert.equal(missing.status().reason, 'missing-world-news-key');
  assert.equal(f.calls.provider, 0);
});

test('GET and HEAD only serve snapshots; service startup and shutdown never wait for the model', async t => {
  const f = fixture(t);
  await f.worker.refresh();
  const service = createDataService({ newsBriefings: f.options });
  const server = await service.listen(0, '127.0.0.1');
  t.after(async () => { await service.newsBriefings.stop(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const responses = await Promise.all(Array.from({ length: 8 }, () => fetch(`${base}/v1/news_briefings?sourceID=42206`)));
  assert.ok(responses.every(response => response.status === 200));
  assert.equal((await responses[0].json()).relayData.items.length, 1);
  const head = await fetch(`${base}/v1/news_briefings?sourceID=42206`, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  assert.equal((await fetch(`${base}/v1/news_briefings?sourceID=unknown`)).status, 400);
  assert.equal((await fetch(`${base}/v1/news_briefings/status`)).status, 200);
  assert.deepEqual(f.calls, { provider: 2, model: 1 });
});

test('shutdown aborts a pending provider fetch and prevents further categories', async t => {
  const f = fixture(t);
  let started;
  const pending = new Promise(resolve => { started = resolve; });
  let calls = 0;
  const worker = createNewsBriefingWorker({ ...f.options, provider: {
    ...f.options.provider, fetchCategory: async (_category, { signal }) => {
      calls++; started();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  } });
  const refresh = worker.refresh();
  await pending;
  await worker.stop();
  await refresh;
  assert.equal(calls, 1);
  assert.equal(worker.status().refreshing, false);
});

test('fixing credentials allows a retry without resetting daily spending', async t => {
  const f = fixture(t);
  const broken = createNewsBriefingWorker({ ...f.options, provider: {
    ...f.options.provider, fetchCategory: async () => { throw Object.assign(new Error('No key'), { status: 401 }); },
  } });
  await broken.refresh();
  await broken.stop();
  assert.equal(broken.status().budget.points, 1.1);
  const fixed = createNewsBriefingWorker({ ...f.options, config: { ...f.config, apiKey: 'fixture-corrected-key' } });
  t.after(() => fixed.stop());
  await fixed.refresh();
  assert.equal(f.calls.provider, 2);
  assert.ok(fixed.status().budget.points > 3.2);
});

test('first stories become readable while later candidates are still generating, across categories', async t => {
  const f = fixture(t);
  let release; let reached;
  const paused = new Promise(resolve => { reached = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  const order = [];
  const worker = createNewsBriefingWorker({ ...f.options, provider: {
    ...f.options.provider, fetchCategory: async category => ({ articles: [
      article({ url: `https://nasa.gov/${category}-one` }), article({ url: `https://nasa.gov/${category}-two` }),
    ] }),
  }, generate: async (source, category, context) => {
    order.push(category);
    if (order.length === 3) { reached(); await barrier; }
    return f.options.generate(source, category, context);
  } });
  t.after(() => worker.stop());
  const refresh = worker.refresh();
  await paused;
  try {
    assert.notEqual(order[0], order[1], 'the first category cannot exhaust all its candidates first');
    assert.equal(worker.items(42206).length, 1);
    assert.equal(worker.items(42208).length, 1);
    const saved = JSON.parse(readFileSync(f.config.file));
    assert.equal(saved.categories[42206].items.length, 1, 'an interruption retains the first ready story');
  } finally { release(); await refresh; }
  assert.equal(worker.items(42206).length, 2);
  assert.equal(worker.items(42208).length, 2);
});
