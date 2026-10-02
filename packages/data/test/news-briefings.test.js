import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newsWordCount, renderNewsBriefing, validateNewsBriefing } from '@phoenix/contracts';
import { createDataService } from '../src/index.js';
import { newsBriefingConfig } from '../src/newsBriefings/config.js';
import { createNewsBriefingWorker } from '../src/newsBriefings/worker.js';
import { createBriefingGenerator, parseBriefingDraft } from '../src/newsBriefings/generate.js';
import { createWorldNewsProvider, normalizeWorldArticle, worldNewsQuery, boundedJson } from '../src/newsBriefings/worldNews.js';
import { newsSpeech, newsDraft, worldArticle, newsTime } from '../../contracts/test/fixtures/newsBriefing.js';

const article = (overrides = {}) => normalizeWorldArticle({ ...worldArticle, ...overrides }, { now: newsTime, maxAgeMs: 36 * 3600000 });
const env = { PHOENIX_NEWS_BRIEFINGS_ENABLED: 'true', WORLD_NEWS_API_KEY: 'fixture-world-key', ETCO_parser_decisionApiKey: 'fixture-router-key' };
const log = { warn() {} };
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

test('World News queries all categories within a bounded date window; credentials only in headers', async () => {
  const config = newsBriefingConfig(env);
  assert.equal(worldNewsQuery('national', config, newsTime).get('source-countries'), 'us');
  assert.equal(worldNewsQuery('technology', config, newsTime).get('categories'), 'technology');
  assert.match(worldNewsQuery('international', config, newsTime).get('text'), /diplomacy/);
  assert.match(worldNewsQuery('strange', config, newsTime).get('text'), /quirky/);
  assert.equal(worldNewsQuery('general', config, newsTime).has('categories'), false);
  const provider = createWorldNewsProvider(config, { fetchImpl: async (url, options) => {
    assert.equal(url.searchParams.get('number'), '10');
    assert.equal(url.searchParams.get('earliest-publish-date'), '2026-10-01 00:00:00');
    assert.ok(!url.href.includes('fixture-world-key'));
    assert.equal(options.headers['x-api-key'], env.WORLD_NEWS_API_KEY);
    assert.equal(options.redirect, 'error');
    return Response.json({ news: [worldArticle, null, { ...worldArticle, text: 'Just a headline.' }] });
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

test('news pins its model independently and only reuses the decision key for OpenRouter', () => {
  const config = newsBriefingConfig({ ...env, PHOENIX_LLM_MODEL: 'expensive/chat', PHOENIX_LLM_URL: 'https://different.test' });
  assert.equal(config.llm.model, 'deepseek/deepseek-v4.1-flash');
  assert.equal(config.llm.apiKey, env.ETCO_parser_decisionApiKey);
  assert.equal(newsBriefingConfig({ ...env, ETCO_news_llmUrl: 'https://different.test/v1' }).llm.apiKey, '');
  assert.equal(newsBriefingConfig({ ...env, PHOENIX_NEWS_DAILY_POINTS: '1000' }).dailyPoints, 45);
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
