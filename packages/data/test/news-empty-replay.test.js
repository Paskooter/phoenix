import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CATEGORIES } from '../src/news.js';
import { newsBriefingConfig } from '../src/newsBriefings/config.js';
import { createNewsBriefingWorker } from '../src/newsBriefings/worker.js';
import { createWorldNewsProvider } from '../src/newsBriefings/worldNews.js';
import { createBriefingGenerator } from '../src/newsBriefings/generate.js';
import { emptyCategoryFeed, completion, newsDraft, skippedDraft, invalidDraft, newsTime, source } from './fixtures/news-empty.js';

function replay(t, { categories = CATEGORIES, feed = emptyCategoryFeed, draft = category => (
  category === 'technology' ? skippedDraft : newsDraft
), modelResponse } = {}) {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Replay attempted live network access'); });
  const directory = mkdtempSync(join(tmpdir(), 'phoenix-news-replay-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = newsBriefingConfig({
    PHOENIX_NEWS_BRIEFINGS_ENABLED: 'true', WORLD_NEWS_API_KEY: 'offline-world-key',
    ETCO_parser_decisionApiKey: 'offline-model-key',
    PHOENIX_NEWS_BRIEFINGS_FILE: join(directory, 'briefings.json'),
  });
  const calls = { provider: [], model: [] };
  const clock = { time: newsTime };
  // general, national and international intentionally share the same query.
  const pendingCategories = Object.values(categories).sort((a, b) => [
    'general', 'national', 'international', 'technology', 'science', 'business',
    'health', 'sports', 'politics', 'entertainment', 'strange',
  ].indexOf(a) - [
    'general', 'national', 'international', 'technology', 'science', 'business',
    'health', 'sports', 'politics', 'entertainment', 'strange',
  ].indexOf(b));
  const provider = createWorldNewsProvider(config, { fetchImpl: async url => {
    const category = pendingCategories[calls.provider.length % pendingCategories.length];
    assert.equal(url.hostname, 'api.worldnewsapi.com');
    assert.equal(url.searchParams.get('source-country'), 'us');
    assert.equal(url.searchParams.get('entities'), 'LOC:USA');
    assert.equal(url.searchParams.get('language'), 'en');
    assert.equal(url.searchParams.get('number'), '10');
    if (!['general', 'national', 'international', 'strange'].includes(category)) {
      assert.equal(url.searchParams.get('categories'), category);
    }
    calls.provider.push(category);
    return Response.json(feed(category));
  } });
  const generate = createBriefingGenerator(config, { fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body);
    const category = JSON.parse(request.messages[1].content).category;
    calls.model.push(category);
    const response = modelResponse ? modelResponse(category, request) : completion(draft(category));
    return response instanceof Response ? response : Response.json(response);
  } });
  const options = { config, provider, generate, now: () => clock.time,
    providerSpacingMs: 0, log: { warn() {} }, categories };
  const worker = createNewsBriefingWorker(options);
  t.after(() => worker.stop());
  return { worker, config, options, calls, clock };
}

function snapshot(worker, id) {
  const res = { writeHead(status) { this.statusCode = status; }, end(body) { this.body = body ? JSON.parse(body) : null; } };
  worker.handle({ req: { method: 'GET' }, res, url: new URL(`http://offline.test/v1/news_briefings?sourceID=${id}`) });
  return res;
}

test('offline replay distinguishes three empty stages while eight categories publish', async t => {
  const f = replay(t);
  await f.worker.refresh();
  const status = f.worker.status();
  for (const [id, category] of Object.entries(CATEGORIES)) {
    const empty = ['health', 'science', 'technology'].includes(category);
    assert.equal(status.categories[category].stories, empty ? 0 : 5, category);
    assert.equal(status.categories[category].lastError, empty ? 'No usable articles' : null, category);
    assert.equal(snapshot(f.worker, id).statusCode, empty ? 503 : 200, category);
    assert.equal(status.categories[category].nextFetchAt, newsTime + f.config.intervalMs);
  }
  assert.equal(f.calls.provider.length, 11);
  assert.equal(f.calls.model.length, 41);
  assert.equal(status.blockedUntil, null);
  assert.equal(status.refreshing, false);
  assert.ok(status.budget.points < status.limits.dailyPoints);
  assert.ok(status.budget.llmUsd < status.limits.dailyLlmUsd);
  // These three paths used to be indistinguishable in the operator status.
  const health = status.categories.health.lastRun;
  assert.ok(health, 'status must identify the stage producing an empty edition');
  assert.equal(health.provider.received, 0);
  assert.equal(health.candidates, 0);
  assert.equal(health.generated, 0);
  const science = status.categories.science.lastRun;
  assert.equal(science.provider.received, 2);
  assert.equal(science.provider.rejected.country, 1);
  assert.equal(science.provider.rejected.text, 1);
  assert.equal(science.candidates, 0);
  const technology = status.categories.technology.lastRun;
  assert.equal(technology.provider.accepted, 1);
  assert.equal(technology.generated, 1);
  assert.equal(technology.modelSkipped, 1);
  assert.equal(technology.published, 0);
  assert.equal(technology.startedAt, newsTime);
  assert.equal(technology.completedAt, newsTime);
  const before = structuredClone(f.calls);
  f.worker.status(); snapshot(f.worker, '42208');
  await f.worker.refresh();
  assert.deepEqual(f.calls, before, 'snapshot reads and an early refresh spend nothing');
});

test('offline replay retains the partial-draft error for invalid evidence with zero or some published stories', async t => {
  for (const usable of [false, true]) {
    const f = replay(t, {
      categories: { 42208: 'technology' },
      feed: category => ({ news: [source(category), source(category, 1)] }),
      modelResponse: (_category, request) => completion(usable && JSON.parse(request.messages[1].content).title.endsWith(' 0') ? newsDraft : invalidDraft),
    });
    await f.worker.refresh();
    const technology = f.worker.status().categories.technology;
    assert.equal(technology.stories, usable ? 1 : 0);
    assert.equal(snapshot(f.worker, '42208').statusCode, usable ? 200 : 503);
    assert.equal(technology.lastError, 'Some drafts failed validation or generation');
    assert.equal(technology.nextFetchAt, newsTime + f.config.intervalMs);
    assert.equal(f.calls.model.length, usable ? 3 : 4, 'at most the existing single repair per draft');
    assert.equal(technology.lastRun.failures['draft-evidence'], usable ? 1 : 2);
    assert.equal(technology.lastRun.published, usable ? 1 : 0);
    assert.equal(technology.lastRun.modelSkipped, 0);
    const restarted = createNewsBriefingWorker(f.options);
    t.after(() => restarted.stop());
    assert.deepEqual(restarted.status().categories.technology.lastRun, technology.lastRun);
  }
});

test('draft and transport failures expose bounded reasons without model text', async t => {
  const changed = change => { const draft = structuredClone(newsDraft); change(draft); return completion(draft); };
  const cases = [
    ['draft-json', () => completion(null, { message: { content: 'private invalid JSON' } }), 2],
    ['draft-shape', () => completion({ ...newsDraft, unexpected: 'private text' }), 2],
    ['draft-sentence', () => changed(d => { d.sentences[0].text = '3 ' + d.sentences[0].text; }), 2],
    ['draft-evidence', () => completion(invalidDraft), 2],
    ['draft-speech', () => changed(d => { d.sentences[0].text = 'Too short.'; }), 2],
    ['draft-content', () => changed(d => { d.sentences[0].text = d.sentences[0].text.replace('new', 'shit'); }), 2],
    ['model-incomplete', () => completion(newsDraft, { finish_reason: 'length' }), 1],
    ['model-http', () => new Response('private upstream body', { status: 500 }), 1],
    ['generation', () => { throw new Error('private transport exception'); }, 1],
  ];
  for (const [reason, modelResponse, requests] of cases) {
    const f = replay(t, { categories: { 42208: 'technology' },
      feed: category => ({ news: [source(category)] }), modelResponse });
    await f.worker.refresh();
    const status = f.worker.status();
    assert.equal(status.categories.technology.lastRun.failures[reason], 1, reason);
    assert.equal(status.categories.technology.stories, 0, reason);
    assert.equal(f.calls.model.length, requests, reason);
    assert.doesNotMatch(JSON.stringify(status), /private|offline-world-key|offline-model-key|nasa\.gov|fixture-technology/);
  }
});

test('valid text-part completions publish without a paid repair', async t => {
  const content = JSON.stringify(newsDraft);
  const f = replay(t, { categories: { 42208: 'technology' },
    feed: category => ({ news: [source(category)] }),
    modelResponse: () => completion(null, { message: { content: [
      { type: 'text', text: content.slice(0, 37) }, { type: 'text', text: content.slice(37) },
    ] } }),
  });
  await f.worker.refresh();
  const technology = f.worker.status().categories.technology;
  assert.equal(technology.stories, 1, 'a valid draft in text parts must not become a partial-draft error');
  assert.equal(technology.lastError, null);
  assert.equal(f.calls.model.length, 1);
  assert.deepEqual(f.worker.items('42208')[0].speech, {
    tone: newsDraft.tone, sentences: newsDraft.sentences.map(sentence => sentence.text),
  });
});

test('text-part support never accepts refusals, non-text parts or invalid evidence', async t => {
  const content = JSON.stringify(newsDraft);
  for (const parts of [[], [content], [{ type: 'image_url', text: content }],
    [{ type: 'text', text: content }, { type: 'refusal', refusal: 'private refusal' }],
    [{ type: 'text', text: 42 }], [{ type: 'text', text: JSON.stringify(invalidDraft) }]]) {
    const f = replay(t, { categories: { 42208: 'technology' },
      feed: category => ({ news: [source(category)] }),
      modelResponse: () => completion(null, { message: { content: parts } }),
    });
    await f.worker.refresh();
    assert.equal(f.worker.items('42208').length, 0);
    assert.equal(f.worker.status().categories.technology.lastError, 'Some drafts failed validation or generation');
    assert.ok(f.calls.model.length <= 2);
  }
});

test('long unpunctuated source leads remain eligible in health science and technology', async t => {
  const text = (newsDraft.sentences.map(sentence => sentence.text).join(' ').replace(/[.!?]/g, '') + ' ').repeat(40).trim();
  assert.ok(text.length > 8500);
  const f = replay(t, { categories: { 42203: 'health', 42206: 'science', 42208: 'technology' },
    feed: category => ({ news: [source(category, 0, { text })] }),
    modelResponse: (_category, request) => {
      const paragraphs = JSON.parse(request.messages[1].content).paragraphs;
      const excerpt = paragraphs.map(paragraph => paragraph.text).join(' ');
      assert.ok(excerpt.length <= 8500);
      assert.ok(text.startsWith(excerpt), 'the excerpt is an unchanged source prefix, not synthesized reporting');
      assert.equal(text[excerpt.length], ' ', 'never cut a source word');
      return completion({ ...newsDraft, sentences: newsDraft.sentences.map(sentence => ({ ...sentence, evidence: [1] })) });
    },
  });
  await f.worker.refresh();
  const status = f.worker.status();
  for (const category of ['health', 'science', 'technology']) {
    assert.equal(status.categories[category].stories, 1, `${category} must not discard the whole source at the excerpt boundary`);
    assert.equal(status.categories[category].lastError, null);
    assert.equal(status.categories[category].lastRun.provider.accepted, 1);
  }
  assert.equal(f.calls.model.length, 3);
});

test('provider rejection counts preserve country freshness content and metadata filters', async t => {
  const cases = [
    ['invalid', null],
    ['country', source('health', 0, { source_country: 'gb' })],
    ['opinion', source('health', 0, { title: 'Opinion: synthetic source' })],
    ['url', source('health', 0, { url: 'javascript:alert(1)' })],
    ['title', source('health', 0, { title: '' })],
    ['text', source('health', 0, { text: 'Short source.' })],
    ['date', source('health', 0, { publish_date: 'not a date' })],
    ['future', source('health', 0, { publish_date: '2026-10-02 12:06:00' })],
    ['stale', source('health', 0, { publish_date: '2026-09-30 00:00:00' })],
    ['publisher', source('health', 0, { url: `https://${'a'.repeat(60)}.${'b'.repeat(60)}.test/source` })],
    ['excerpt', source('health', 0, { text: 'x'.repeat(9000) + ' ' + source('health').text })],
  ];
  for (const [reason, raw] of cases) {
    const f = replay(t, { categories: { 42203: 'health' }, feed: () => ({ news: [raw] }) });
    await f.worker.refresh();
    const run = f.worker.status().categories.health.lastRun;
    assert.equal(run.provider.received, 1, reason);
    assert.equal(run.provider.considered, 1, reason);
    assert.equal(run.provider.rejected[reason], 1, reason);
    assert.equal(Object.values(run.provider.rejected).reduce((sum, value) => sum + value, 0), 1, reason);
    assert.equal(run.provider.accepted, 0, reason);
    assert.equal(f.calls.model.length, 0, reason);
  }
});

test('replay separates duplicate excluded generated-skip and cached-skip counts across normal cycles', async t => {
  const f = replay(t, { categories: { 42206: 'science' }, feed: category => ({ news: [
    source(category), source(category), source(category, 1, { title: 'Correction: old source' }),
    source(category, 2, { text: source(category).text.repeat(100) + ' shit' }),
    source(category, 3, { title: 'Synthetic skipped source' }),
  ] }), modelResponse: (_category, request) => completion(
    JSON.parse(request.messages[1].content).title.includes('skipped') ? skippedDraft : newsDraft
  ) });
  await f.worker.refresh();
  let run = f.worker.status().categories.science.lastRun;
  assert.equal(run.candidates, 5);
  assert.equal(run.examined, 5);
  assert.equal(run.duplicates, 1);
  assert.deepEqual(run.excluded, { banned: 1, opinion: 0, correction: 1 });
  assert.equal(run.generated, 2);
  assert.equal(run.modelSkipped, 1);
  assert.equal(run.cached, 0);
  assert.equal(run.published, 1);
  f.clock.time += f.config.intervalMs;
  await f.worker.refresh();
  run = f.worker.status().categories.science.lastRun;
  assert.equal(run.generated, 0);
  assert.equal(run.modelSkipped, 0);
  assert.equal(run.cached, 2);
  assert.equal(run.cachedSkipped, 1);
  assert.equal(run.published, 1);
  assert.equal(f.calls.model.length, 2, 'cached skips do not create additional paid calls');
});

test('status projects only numeric allowlisted diagnostics and accepts old snapshots', async t => {
  const f = replay(t, { categories: { 42203: 'health' } });
  await f.worker.refresh();
  const saved = JSON.parse(readFileSync(f.config.file));
  const run = saved.categories['42203'].lastRun;
  run.rawBody = 'private provider text';
  run.generated = 'private model text';
  run.failures.unexpected = 'private error';
  run.provider.rejected.country = -10;
  run.provider.token = 'private secret';
  writeFileSync(f.config.file, JSON.stringify(saved));
  const restarted = createNewsBriefingWorker(f.options);
  t.after(() => restarted.stop());
  const status = restarted.status();
  assert.doesNotMatch(JSON.stringify(status), /private|rawBody|unexpected|token/);
  assert.equal(status.categories.health.lastRun.generated, 0);
  assert.equal(status.categories.health.lastRun.provider.rejected.country, 0);
  status.categories.health.lastRun.provider.received = 99;
  assert.equal(restarted.status().categories.health.lastRun.provider.received, 0, 'status does not expose mutable worker state');
  delete saved.categories['42203'].lastRun;
  writeFileSync(f.config.file, JSON.stringify(saved));
  const legacy = createNewsBriefingWorker(f.options);
  t.after(() => legacy.stop());
  assert.equal(legacy.status().categories.health.lastRun, null);
  await legacy.refresh();
  assert.deepEqual(f.calls, { provider: ['health'], model: [] }, 'loading old state must not force a paid refresh');
});
