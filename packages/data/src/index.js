// Data-relay service (Pegasus lasso equivalent). Milestone M4.
//
// Implemented: weather (/v1/dark_sky, Open-Meteo), news (/v1/ap_news, RSS→AP), maps
// (/v1/google_maps, ORS) — all via the relay framework with the {relayData,lassoDataFromRedis}
// envelope + cache; credential CRUD (/v1/credential); calendar (/v1/{google,outlook}_calendar,
// OAuth token exchange/refresh/invalidation + pluggable events provider). Reference:
// docs/atlas/packages/lasso.md, message-protocol.md §9.

import { createService, parseServiceArgs, serviceCliPort, serviceHelp, runService } from '@phoenix/common';
import { DefaultPort } from '@phoenix/contracts';
import { TTLCache } from './cache.js';
import { createRelay } from './relay.js';
import { validateWeather, weatherKey, fetchWeather } from './weather.js';
import { validateNews, newsKey, fetchNews, NEWS_CACHE_TTL_SECONDS, installNewsPolling } from './news.js';
import { validateMaps, mapsKey, fetchMaps } from './maps.js';
import { CredentialStore, credentialHandlers } from './credentials.js';
import { createCalendarHandler } from './calendar.js';
import { createOAuthProvider } from './oauth.js';

/**
 * Build the OAuth provider from a secrets directory when one is configured.
 * Mirrors OAuth2Secrets.init() loading <resources>/{google,outlook}/client_*.json;
 * returns null when no directory is configured so the default stays provider-less.
 * ETCO_lasso_{google,outlook}TokenUrl optionally redirects a provider's token
 * endpoint (ops/test override — e.g. a corporate token proxy or a recorded fixture).
 */
function oauthFromEnv(oauthSecretsDir) {
  const dir = oauthSecretsDir || process.env.ETCO_lasso_oauthSecretsDir || process.env.ETCO_data_oauthSecretsDir;
  if (!dir) return null;
  const endpoints = {};
  if (process.env.ETCO_lasso_googleTokenUrl) endpoints.google = { tokenUrl: process.env.ETCO_lasso_googleTokenUrl };
  if (process.env.ETCO_lasso_outlookTokenUrl) endpoints.outlook = { tokenUrl: process.env.ETCO_lasso_outlookTokenUrl };
  return createOAuthProvider({ secretsDir: dir, endpoints });
}

/**
 * @param {{ cache?: TTLCache, weatherGet?: Function, newsGet?: Function, mapsGet?: Function,
 *           credentialStore?: CredentialStore, googleCalendarProvider?: Function,
 *           outlookCalendarProvider?: Function, oauth?: object, oauthSecretsDir?: string,
 *           newsPolling?: { enabled?: boolean, intervalMS?: number } }} [opts]
 *   *Get/*Provider override the live upstream calls (used by tests).
 *   oauth is a configurable provider from oauth.js (createOAuthProvider); when it
 *   is absent the credential POST keeps the certified D-02 behaviour (no live
 *   exchange, 501) and the calendar routes stay provider-only.
 *   oauthSecretsDir loads client_*.json from <dir>/{google,outlook} like the
 *   reference resources/ tree; the ETCO_lasso_oauthSecretsDir env is the default.
 *   newsPolling mirrors the source APNewsConfig (LassoService.ts:28-32); when it is
 *   omitted the ETCO_lasso_apNews* environment wins, and polling stays off by default.
 */
export function createDataService({ cache = new TTLCache(), weatherGet, newsGet, mapsGet, credentialStore, oauth, oauthSecretsDir, googleCalendarProvider, outlookCalendarProvider, newsPolling } = {}) {
  const oauthProvider = oauth || oauthFromEnv(oauthSecretsDir) || null;
  const store = credentialStore || new CredentialStore({ oauth: oauthProvider });
  if (oauthProvider) store.oauth = oauthProvider;
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
    ttlSeconds: NEWS_CACHE_TTL_SECONDS,
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

  const googleCal = createCalendarHandler({ provider: googleCalendarProvider, store, oauth: oauthProvider, serviceName: 'google', label: 'GoogleCalendar' });
  const outlookCal = createCalendarHandler({ provider: outlookCalendarProvider, store, oauth: oauthProvider, serviceName: 'outlook', label: 'OutlookCalendar' });
  // LassoService.ts:86-95 — a new credential notifies the calendar handlers, which
  // drop the cached payload for that (skillId, accountId, calendar) key.
  const cred = credentialHandlers(store, {
    onNewCredential: (credential) => { googleCal.invalidate(credential); outlookCal.invalidate(credential); },
  });

  const service = createService({
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

  // APNewsHandler.init()/close(): the poller warms every category key under the *same*
  // relay cache+TTL as a live request, starts on the first listen(), and is cleared when
  // that server closes. `service.newsPoller` is the handle to poll/stop it explicitly.
  installNewsPolling(service, { cache, get: newsGet, ...(newsPolling || {}) });

  return service;
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
export * as oauth from './oauth.js';

// Executable boundary: source Lasso scripts/run-service.js resolves the port from
// argv/ETCO_server_port. Its help branch is a plain `return`, so the starter hands
// run-service a non-thenable and the source reports "Service didn't return promise".
if (import.meta.url === `file://${process.argv[1]}`) {
  runService('Lasso', () => {
    const argv = parseServiceArgs();
    if (argv.h || argv.help) {
      console.log(serviceHelp(process.argv[1]));
      return;
    }
    return start(serviceCliPort({ fallback: DefaultPort.data }));
  });
}
