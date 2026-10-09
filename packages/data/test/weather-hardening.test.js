// Weather upstream deadline, cancellation and timezone handling regressions, re-ported from the September week review
// (fix/week-review-hardening bbe5dfbb/34cc9064). Every account, credential, token
// and URL below is synthetic test data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMeteoGet, openMeteoToDarkSky } from '../src/weather.js';
import { createDataService } from '../src/index.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isDeadline = (error) => error?.name === 'TimeoutError' || error?.name === 'AbortError';

function abortableHang(_url, { signal }) {
  return new Promise((_, reject) => {
    const onAbort = () => reject(signal.reason || new DOMException('aborted', 'AbortError'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

test('weather upstream fetch is bounded and receives a cancellable signal', async () => {
  let seenSignal;
  await assert.rejects(
    () => openMeteoGet(1, 2, {
      timeoutMs: 15,
      fetchImpl: (url, options) => { seenSignal = options.signal; return abortableHang(url, options); },
    }),
    isDeadline,
  );
  assert.ok(seenSignal?.aborted, 'timeout aborts the request signal');
});

test('caller cancellation reaches the weather upstream signal before its deadline', async () => {
  const controller = new AbortController();
  let seenSignal;
  const pending = openMeteoGet(1, 2, {
    signal: controller.signal,
    timeoutMs: 1000,
    fetchImpl: (url, options) => { seenSignal = options.signal; return abortableHang(url, options); },
  });
  await delay(5);
  controller.abort();
  await assert.rejects(pending, (error) => error?.name === 'AbortError');
  assert.ok(seenSignal?.aborted, 'caller aborts the child request signal');
});

test('a disconnected relay client aborts the in-flight provider request', async () => {
  let seenSignal;
  let started;
  const providerStarted = new Promise((resolve) => { started = resolve; });
  const svc = createDataService({
    weatherProvider: (_input, { signal }) => {
      seenSignal = signal;
      started();
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  });
  const server = await svc.listen(0);
  try {
    const controller = new AbortController();
    const pending = fetch(`http://127.0.0.1:${server.address().port}/v1/dark_sky?lat=1&lon=2&skipCache=1`, { signal: controller.signal })
      .catch((error) => error);
    await providerStarted;
    controller.abort();
    await pending;
    for (let i = 0; i < 50 && !seenSignal.aborted; i += 1) await delay(5);
    assert.ok(seenSignal.aborted, 'client disconnect cancels upstream work');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Open-Meteo local timestamps use the response timezone, including DST-aware sunrise', () => {
  const result = openMeteoToDarkSky({
    timezone: 'America/New_York',
    daily: {
      time: ['2026-07-04'],
      temperature_2m_max: [80], temperature_2m_min: [60], weathercode: [0],
      sunrise: ['2026-07-04T05:30'], sunset: ['2026-07-04T20:30'],
      precipitation_sum: [0], precipitation_probability_max: [0],
    },
    current_weather: { time: '2026-07-04T12:00', temperature: 75, weathercode: 0 },
  }, { lat: 1, lon: 2 });
  assert.equal(result.daily.data[0].time, Date.parse('2026-07-04T04:00:00Z') / 1000);
  assert.equal(result.daily.data[0].sunriseTime, Date.parse('2026-07-04T09:30:00Z') / 1000);
  assert.equal(result.daily.data[0].sunsetTime, Date.parse('2026-07-05T00:30:00Z') / 1000);
  assert.equal(result.currently.time, Date.parse('2026-07-04T16:00:00Z') / 1000);
});

test('a historical request late in the local evening selects that local day', () => {
  // 22:00 New York on 2026-06-07 is 02:00Z on 2026-06-08.
  const requested = Date.parse('2026-06-08T02:00:00Z') / 1000;
  const result = openMeteoToDarkSky({
    timezone: 'America/New_York',
    daily: {
      time: ['2026-06-07', '2026-06-08'],
      temperature_2m_max: [70, 75], temperature_2m_min: [50, 55], weathercode: [0, 3],
    },
  }, { lat: 1, lon: 2, secondsSinceEpoch: String(requested) });
  assert.equal(result.daily.data[0].temperatureHigh, 70);
});
