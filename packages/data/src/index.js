// Data-relay service (Pegasus lasso equivalent). Milestone M4.
//
// Implemented: weather (/v1/dark_sky, Open-Meteo), news (/v1/ap_news, RSS→AP), maps
// (/v1/google_maps, ORS) — all via the relay framework with the {relayData,lassoDataFromRedis}
// envelope + cache; credential CRUD (/v1/credential); calendar (/v1/{google,outlook}_calendar,
// pluggable provider). Reference: docs/atlas/packages/lasso.md, message-protocol.md §9.

import { createService } from '@phoenix/common';
import { DefaultPort } from '@phoenix/contracts';
import { TTLCache } from './cache.js';
import { createRelay } from './relay.js';
import { validateWeather, weatherKey, fetchWeather } from './weather.js';
import { validateNews, newsKey, fetchNews } from './news.js';
import { validateMaps, mapsKey, fetchMaps } from './maps.js';
import { CredentialStore, credentialHandlers } from './credentials.js';
import { createCalendarHandler } from './calendar.js';

/**
 * @param {{ cache?: TTLCache, weatherGet?: Function, newsGet?: Function, mapsGet?: Function,
 *           credentialStore?: CredentialStore, googleCalendarProvider?: Function,
 *           outlookCalendarProvider?: Function }} [opts]
 *   *Get/*Provider override the live upstream calls (used by tests).
 */
export function createDataService({ cache = new TTLCache(), weatherGet, newsGet, mapsGet, credentialStore = new CredentialStore(), googleCalendarProvider, outlookCalendarProvider } = {}) {
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
  const maps = createRelay({
    name: 'GoogleMaps',
    ttlSeconds: 15 * 60,
    cache,
    validate: validateMaps,
    key: mapsKey,
    fetchExternal: (input) => fetchMaps(input, mapsGet ? { get: mapsGet } : {}),
  });

  const cred = credentialHandlers(credentialStore);
  const googleCal = createCalendarHandler({ provider: googleCalendarProvider, store: credentialStore });
  const outlookCal = createCalendarHandler({ provider: outlookCalendarProvider, store: credentialStore });

  return createService({
    name: 'data',
    routes: {
      'GET /v1/dark_sky': weather,
      'HEAD /v1/dark_sky': weather,
      'GET /v1/ap_news': news,
      'HEAD /v1/ap_news': news,
      'GET /v1/google_maps': maps,
      'HEAD /v1/google_maps': maps,
      'GET /v1/google_calendar': googleCal,
      'GET /v1/outlook_calendar': outlookCal,
      'POST /v1/credential': cred.post,
      'GET /v1/credential': cred.get,
      'DELETE /v1/credential': cred.del,
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
export * as maps from './maps.js';
export { CredentialStore } from './credentials.js';
export * as calendar from './calendar.js';

if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch((e) => { console.error(e); process.exit(1); });
}
