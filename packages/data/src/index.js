// Data-relay service (Pegasus lasso equivalent). Milestone M4.
//
// Implemented: GET/HEAD /v1/dark_sky (weather via Open-Meteo, {relayData,lassoDataFromRedis}
// envelope + 15m cache). Pending chunks: /v1/ap_news (RSS), /v1/google_maps (ORS),
// calendar + credential CRUD. Reference: docs/atlas/packages/lasso.md, message-protocol.md §9.

import { createService } from '@phoenix/common';
import { errorResponse, HubErrorCode, DefaultPort } from '@phoenix/contracts';
import { TTLCache } from './cache.js';
import { createRelay } from './relay.js';
import { validateWeather, weatherKey, fetchWeather } from './weather.js';
import { validateNews, newsKey, fetchNews } from './news.js';

const notImpl = (what) => () => errorResponse(`${what} not implemented (milestone M4)`, HubErrorCode.NOT_IMPLEMENTED);

/**
 * @param {{ cache?: TTLCache, weatherGet?: Function, newsGet?: Function }} [opts]
 *   weatherGet/newsGet override the live upstream calls (used by tests).
 */
export function createDataService({ cache = new TTLCache(), weatherGet, newsGet } = {}) {
  const weather = createRelay({
    name: 'DarkSky',
    ttlSeconds: 15 * 60,
    cache,
    validate: validateWeather,
    key: weatherKey,
    fetchExternal: (input) => fetchWeather(input, weatherGet ? { get: weatherGet } : {}),
  });
  const news = createRelay({
    name: 'APNews',
    ttlSeconds: 65 * 60,
    cache,
    validate: validateNews,
    key: newsKey,
    fetchExternal: (input) => fetchNews(input, newsGet ? { get: newsGet } : {}),
  });

  return createService({
    name: 'data',
    routes: {
      'GET /v1/dark_sky': weather,
      'HEAD /v1/dark_sky': weather,
      'GET /v1/ap_news': news,
      'HEAD /v1/ap_news': news,
      'GET /v1/google_maps': notImpl('commute relay'),
      'GET /v1/google_calendar': notImpl('google calendar'),
      'GET /v1/outlook_calendar': notImpl('outlook calendar'),
      'POST /v1/credential': notImpl('credential store'),
    },
  });
}

export function start(port = Number(process.env.PORT) || DefaultPort.data, opts = {}) {
  return createDataService(opts).listen(port);
}

export { TTLCache } from './cache.js';
export { createRelay } from './relay.js';
export * as weather from './weather.js';
export * as news from './news.js';

if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch((e) => { console.error(e); process.exit(1); });
}
