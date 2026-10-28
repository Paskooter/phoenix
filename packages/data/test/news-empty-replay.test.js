import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
    return Response.json(modelResponse ? modelResponse(category, request) : completion(draft(category)));
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
