// D-05 runtime probe: coordinate validation (D05a) and the secondsSinceEpoch key segment.
// Run: node docs/parity/evidence/2026-09-10/d05-weather/probe.mjs
import { createDataService } from '../../../../../packages/data/src/index.js';

const FEED = {
  daily: { time: ['2026-06-06','2026-06-07','2026-06-08'],
           temperature_2m_max: [70,75,80], temperature_2m_min: [50,55,60],
           weathercode: [0,1,2], sunrise: ['2026-06-06T05:00'], sunset: ['2026-06-06T20:00'] },
  current_weather: { temperature: 63.5, weathercode: 0, windspeed: 5 },
  timezone: 'America/New_York',
};
let upstream = 0;
const cache = new Map();
const svc = createDataService({
  weatherGet: async () => { upstream++; return FEED; },
  cache: { get: (k) => cache.get(k), set: (k, v) => cache.set(k, v), m: cache },
});
const server = await svc.listen(0); const port = server.address().port;
const get = (qs) => fetch(`http://127.0.0.1:${port}/v1/dark_sky?${qs}`);
const out = { generated: new Date().toISOString(), cases: [] };

for (const [label, qs] of [
  ['no coordinates at all', ''],
  ['non-numeric latitude', 'lat=abc&lon=2'],
  ['latitude out of range', 'lat=-555&lon=1.1'],
  ['longitude non-numeric', 'lat=1&lon=asdf'],
  ['bad timestamp', 'lat=1&lon=2&secondsSinceEpoch=' + encodeURIComponent('very much not a number!')],
]) {
  const before = upstream, cacheBefore = cache.size;
  const res = await get(qs);
  out.cases.push({ label, query: qs, status: res.status, body: (await res.text()).slice(0, 80),
    upstreamCalls: upstream - before, cacheWrites: cache.size - cacheBefore });
}
const ok = await get('lat=1&lon=2');
out.validForecast = { status: ok.status, upstreamCalls: upstream };
out.cacheKeys = [...cache.keys()].sort();
await new Promise((r) => server.close(r));
console.log(JSON.stringify(out, null, 2));
