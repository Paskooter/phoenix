// Maps upstream deadline regressions, re-ported from the September week review
// (fix/week-review-hardening bbe5dfbb/34cc9064). Every account, credential, token
// and URL below is synthetic test data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultTomTomGet, fetchMaps } from '../src/maps.js';

const isDeadline = (error) => error?.name === 'TimeoutError' || error?.name === 'AbortError';

function abortableHang(_url, { signal }) {
  return new Promise((_, reject) => {
    const onAbort = () => reject(signal.reason || new DOMException('aborted', 'AbortError'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

test('maps (TomTom) upstream fetch is bounded and receives a cancellable signal', async () => {
  let seenSignal;
  const input = { origin: { lat: 1, lon: 2 }, destination: { lat: 3, lon: 4 }, mode: 'driving' };
  await assert.rejects(
    () => defaultTomTomGet(input, 'synthetic-key', {
      timeoutMs: 15,
      fetchImpl: (url, options) => { seenSignal = options.signal; return abortableHang(url, options); },
    }),
    isDeadline,
  );
  assert.ok(seenSignal?.aborted, 'timeout aborts the request signal');
});

test('fetchMaps bounds an injected provider that ignores its signal', async () => {
  const input = { origin: { lat: 1, lon: 2 }, destination: { lat: 3, lon: 4 }, mode: 'driving' };
  await assert.rejects(
    () => fetchMaps(input, { timeoutMs: 15, get: () => new Promise(() => {}) }),
    isDeadline,
  );
});
