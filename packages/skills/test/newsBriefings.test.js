import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { newsParse, NewsMimLogic } from '../src/report/news.js';
import { newsViews } from '../src/report/newsViews.js';
import { LassoClient } from '../src/report/lassoClient.js';
import { clearReportEnvCache } from '../src/report/env.js';
import { newsBriefing } from '../../contracts/test/fixtures/newsBriefing.js';

const raw = (name, items) => ({ category: { name }, briefings: items });
const reportData = news => ({
  local: { news, views: {} },
  runtime: { perception: { speaker: 'u1' }, loop: { users: [{ id: 'u1', birthdate: '2020-01-01' }] }, location: { iso: '2026-10-02T12:00:00Z' } },
  skill: { session: { data: { _personalReport: { singleSkill: 'news' } } } },
});

test('briefings keep the first story without images, retain child filters, and use their own speech template', async () => {
  const second = { ...structuredClone(newsBriefing), id: 'b'.repeat(64), adult: true };
  const parsed = newsParse([raw('science', [newsBriefing, second])]);
  assert.equal(parsed.science.length, 2);
  assert.match(parsed.science[0].headline, /^<style set="enthusiastic">NASA/);
  const data = reportData(parsed);
  await new NewsMimLogic('News Logic').exit(data);
  assert.equal(data.local.news.headlines.length, 1, 'adult source stays filtered even when generated text is harmless');
  assert.deepEqual(data.local.mimPaths.map(path => path.split('/').at(-1)), ['NewsBriefingIntro.mim', 'NewsBriefing.mim', 'NewsOutro.mim']);
  const intro = JSON.parse(readFileSync(data.local.mimPaths[0]));
  assert.ok(!JSON.stringify(intro).toLowerCase().includes('associated press'));
  const mim = JSON.parse(readFileSync(data.local.mimPaths[1]));
  assert.equal(mim.es_auto_tagging.voice, false);
  assert.ok(!mim.prompts[0].prompt.includes('<pitch'));
  assert.ok(mim.prompts[0].prompt.includes('${skill.news.headlines.shift()}'));
});

test('story identity dedupes selected briefings across categories without dropping other candidates', async () => {
  const second = { ...structuredClone(newsBriefing), id: 'b'.repeat(64) };
  const third = { ...structuredClone(newsBriefing), id: 'c'.repeat(64) };
  const data = reportData(newsParse([raw('science', [newsBriefing]), raw('technology', [newsBriefing, second, third])]));
  await new NewsMimLogic('News Logic').exit(data);
  assert.equal(data.local.news.headlines.length, 3);
});

test('briefing cards show headline, source, category and close the last card', async () => {
  const items = newsParse([raw('science', [newsBriefing])]).science;
  const [view] = await newsViews(items);
  assert.equal(view.componentConfigs.find(c => c.id === 'briefingTitle').text, newsBriefing.title);
  assert.equal(view.componentConfigs.find(c => c.id === 'briefingPublisher').text, 'NASA');
  assert.equal(view.componentConfigs.find(c => c.id === 'categoryText').text, 'Science');
  assert.ok(!view.componentConfigs.some(c => c.id === 'headlineClip'));
  assert.equal(view.defaultSelect.removeAll, true);
});

test('Lasso reads shared briefings first, falls back on unavailable or malformed snapshots, and preserves opt-out behavior', async t => {
  const prior = { NET_lasso: process.env.NET_lasso, PHOENIX_NEWS_BRIEFINGS_ENABLED: process.env.PHOENIX_NEWS_BRIEFINGS_ENABLED };
  let mode = 'ready';
  const calls = [];
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://fixture').pathname;
    calls.push(path);
    assert.equal(req.headers['x-jibo-robotid'], 'robot-test');
    res.setHeader('content-type', 'application/json');
    if (path === '/v1/news_briefings') {
      if (mode === 'unavailable') { res.statusCode = 503; res.end('{}'); return; }
      res.end(JSON.stringify({ relayData: { version: 1, category: 'science', items: mode === 'invalid' ? [{}] : [newsBriefing] } }));
    } else res.end(JSON.stringify({ relayData: '<feed><entry><summary>A legacy story</summary></entry></feed>' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    clearReportEnvCache();
    await new Promise(resolve => server.close(resolve));
  });
  process.env.NET_lasso = `127.0.0.1:${server.address().port}`;
  process.env.PHOENIX_NEWS_BRIEFINGS_ENABLED = 'true';
  clearReportEnvCache();
  const log = { createChild: () => log, info() {}, debug() {}, warn() {}, error() {} };
  const data = { log, req: { jibo: { toHeader: () => ({ 'x-jibo-robotid': 'robot-test' }) } } };
  const prefs = { activeNewsCategories: { science: true } };
  assert.equal((await LassoClient.fetchAPNews(data, prefs))[0].briefings[0].id, newsBriefing.id);
  assert.deepEqual(calls.splice(0), ['/v1/news_briefings']);
  for (mode of ['unavailable', 'invalid']) {
    const [item] = await LassoClient.fetchAPNews(data, prefs);
    assert.ok(item.data.feed.entry);
    assert.deepEqual(calls.splice(0), ['/v1/news_briefings', '/v1/ap_news']);
  }
  process.env.PHOENIX_NEWS_BRIEFINGS_ENABLED = 'false';
  await LassoClient.fetchAPNews(data, prefs);
  assert.deepEqual(calls, ['/v1/ap_news']);
});
