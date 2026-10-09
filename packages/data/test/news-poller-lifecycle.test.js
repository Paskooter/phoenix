// News poller start/stop lifecycle regressions, re-ported from the September week review
// (fix/week-review-hardening bbe5dfbb/34cc9064). Every account, credential, token
// and URL below is synthetic test data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TTLCache } from '../src/cache.js';
import { createNewsPoller } from '../src/news.js';

const FEED = '<rss><channel><title>Synthetic headlines</title><item><title>Synthetic story</title><description>Synthetic text</description></item></channel></rss>';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('news stop wins a start/stop race while the initial poll is still in flight', async () => {
  const cache = new TTLCache();
  const intervals = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let fetches = 0;
  const poller = createNewsPoller({
    cache,
    pollingEnabled: true,
    get: async () => { fetches += 1; await gate; return FEED; },
    timers: { setInterval: (fn, ms) => { intervals.push({ fn, ms }); return 0; }, clearInterval: () => {} },
  });
  const starting = poller.start();
  while (fetches < 11) await delay(1);
  poller.stop();
  release();
  assert.equal(await starting, false, 'a stopped start does not arm a timer');
  assert.equal(intervals.length, 0);
  assert.equal(poller.isPolling(), false);
});
