// Calendar — Phoenix port of lasso google/outlook calendar handlers.
// GET /v1/{google,outlook}_calendar : CalendarRequest -> { events: CalendarEvent[] }.
//
// D-01 built the request validation + CalendarEvent normalization. D-03 adds the
// OAuth token lifecycle the reference handlers own:
//   * credentials are looked up for the (accountId, skillId, service, calendar, scopes)
//     slot (Credentials.find, GoogleCalendarHandler.ts:71-82);
//   * an expired access token is refreshed against the provider and stored back
//     (GoogleCalendarHandler.ts:91-103, updateTokens → refreshedAt);
//   * a failed refresh marks the credential inactive REFRESH_FAILED and the route
//     answers 502 (GoogleCalendarHandler.ts:97-102 + AbstractRelayRequestHandler.ts:154-168);
//   * a provider "expired or revoked" reply marks it inactive REVOKED_ACCESS, and an
//     Outlook InvalidAuthenticationToken marks it INVALID_TOKEN
//     (GoogleCalendarHandler.ts:118-125, OutlookCalendarHandler.ts:117-124);
//   * results are cached for 60s under the reference redis key and a newly arrived
//     credential invalidates that key (GoogleCalendarHandler.ts:16,26-35,60-62).
//
// The event fetch itself stays pluggable (the real Google/Outlook Calendar API
// clients are a separate task): `provider` is injected as before, and when a
// non-oauth provider is used the handler behaves exactly as the certified D-01
// version did (no credential/refresh step, default provider still 501).

import { CredentialError } from './oauth.js';
import { TTLCache } from './cache.js';

export function validateCalendar(q) {
  const skillId = q.get('skillId');
  const accountId = q.get('accountId');
  const calendar = q.get('calendar');
  if (!skillId) throw new Error('skillId required');
  if (!accountId) throw new Error('accountId required');
  if (!calendar) throw new Error('calendar required');
  return { skillId, accountId, calendar, endDate: q.get('endDate') || undefined };
}

/** Format to interfaces/lasso.ts EVENT_DATETIME_FORMAT ('YYYY-MM-DDTHH:mm:ssZ', UTC). */
function formatDateTime(iso) {
  return new Date(iso).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Normalize a provider event ({summary, start:{dateTime|date}, end?}) into a CalendarEvent. */
export function normalizeEvent(ev) {
  const startRaw = ev.start || {};
  const fullDay = !!(startRaw.date && !startRaw.dateTime);
  const toDate = (d) => {
    const iso = d.dateTime || d.date;
    return { timestamp: new Date(iso).getTime(), dateTime: formatDateTime(iso) };
  };
  const out = { summary: ev.summary || '', fullDay, start: toDate(startRaw) };
  if (ev.end) out.end = toDate(ev.end);
  return out;
}

const defaultProvider = async (req) => {
  const e = new Error(`Calendar token exchange not configured (${req.calendar}); supply a provider`);
  e.status = 501;
  throw e;
};

// interfaces/src/lasso.ts:30-38 — the scopes the handler looks the credential up by.
const CALENDAR_SCOPES = {
  google: ['https://www.googleapis.com/auth/calendar.readonly'],
  outlook: ['Calendars.Read', 'offline_access'],
};
const CALENDAR_NAME = { google: 'GoogleCalendar', outlook: 'OutlookCalendar' };
// GoogleCalendarHandler.ts:16 / OutlookCalendarHandler.ts:18.
const CACHE_TTL_SECONDS = 60;

/** GoogleCalendarHandler.ts:60-62 / OutlookCalendarHandler.ts:61-63 createRedisKey. */
export function calendarCacheKey(serviceName, { skillId, accountId, calendar }) {
  return `${serviceName}_calendar:${skillId}:${accountId}:${calendar}`;
}

/** TTLCache has get/set/clear; delete via the public map when no del() is present. */
function cacheDel(cache, key) {
  if (typeof cache.del === 'function') return cache.del(key);
  if (cache && cache.m && typeof cache.m.delete === 'function') return cache.m.delete(key);
  return undefined;
}

/**
 * Express/q s truthiness of `request.query.skipCache` (AbstractRelayRequestHandler.ts:77).
 * A bare `skipCache=` is falsy; `skipCache=false` is the *string* "false" (truthy);
 * a bracketed or repeated key is an Array (truthy even when empty). Same rule the
 * relay layer uses (packages/data/src/relay.js).
 */
function skipCacheRequested(searchParams) {
  let occurrences = 0;
  let single = '';
  for (const [key, value] of searchParams) {
    if (key === 'skipCache') { occurrences += 1; single = value; }
    else if (key.startsWith('skipCache[')) occurrences += 2;
  }
  if (occurrences === 0) return false;
  return occurrences > 1 ? true : !!single;
}

/**
 * Build a GET handler for a calendar route.
 * @param {{
 *   provider?: (req:object, ctx:object)=>Promise<any[]>,
 *   store?: import('./credentials.js').CredentialStore,
 *   serviceName?: 'google'|'outlook',
 *   oauth?: { refresh: Function } | null,
 *   cache?: TTLCache, label?: string,
 * }} opts
 */
export function createCalendarHandler({ provider = defaultProvider, store, serviceName = 'google', oauth, cache = new TTLCache(), label } = {}) {
  const name = label || CALENDAR_NAME[serviceName] || 'Calendar';
  const scopes = CALENDAR_SCOPES[serviceName] || [];

  const handler = async ({ url, res }) => {
    let req;
    try { req = validateCalendar(url.searchParams); }
    catch (e) { res.writeHead(400, { 'content-type': 'text/plain' }); res.end(e.message); return undefined; }

    const key = calendarCacheKey(serviceName, req);
    const cached = skipCacheRequested(url.searchParams) ? null : cache.get(key);
    if (cached) return { events: cached };

    let credential = null;
    try {
      // 1. Credential lookup + token freshness (only when a provider is wired).
      if (oauth && store) {
        credential = store.find({
          accountId: req.accountId, skillId: req.skillId, serviceName,
          serviceAccountName: req.calendar, scopes,
        });
        if (!credential || !credential.oauth2) throw new Error(`No credentials for ${req.calendar}`);

        if (Date.now() > credential.oauth2.expiresAt) {
          try {
            const tokens = await oauth.refresh(serviceName, {
              clientId: credential.oauth2.clientId,
              redirectUri: credential.oauth2.redirectUri,
              refreshToken: credential.oauth2.refreshToken,
              scopes: credential.scopes,
            });
            store.updateTokens(credential, tokens);
          } catch (err) {
            store.setInactive(credential, CredentialError.REFRESH_FAILED);
            throw err;
          }
        }
      }

      // 2. Fetch events, invalidating the credential on a revoked/invalid reply.
      let raw;
      try {
        raw = await provider(req, { store, credential });
      } catch (err) {
        if (credential && err && typeof err.message === 'string') {
          if (serviceName === 'outlook' && /InvalidAuthenticationToken/.test(err.message)) {
            store.setInactive(credential, CredentialError.INVALID_TOKEN);
          } else if (serviceName === 'google' && /expired or revoked/.test(err.message)) {
            store.setInactive(credential, CredentialError.REVOKED_ACCESS);
          }
        }
        throw err;
      }
      const events = (raw || []).map(normalizeEvent);
      cache.set(key, events, CACHE_TTL_SECONDS);
      return { events };
    } catch (e) {
      // AbstractRelayRequestHandler.fetchData (lines 154-168): an upstream error
      // with a response keeps its status, otherwise the relay answers 502 with
      // `Error getting <Name> data: <err>` (String(err) -> "Error: <message>").
      const message = e && e.response
        ? `Error getting ${name} data: ${JSON.stringify(e.response.data)}`
        : `Error getting ${name} data: ${e}`;
      const status = e && e.response ? e.response.status : 502;
      res.writeHead(status, { 'content-type': 'text/plain' }); res.end(message); return undefined;
    }
  };

  /** GoogleCalendarHandler.ts:26-35 onNewCredentialArrived — drop the cached payload. */
  handler.invalidate = (credential) => {
    if (!credential || credential.serviceName !== serviceName) return;
    cacheDel(cache, calendarCacheKey(serviceName, {
      skillId: credential.skillId, accountId: credential.accountId, calendar: credential.serviceAccountName,
    }));
  };
  handler.cacheKey = (req) => calendarCacheKey(serviceName, req);
  handler.cache = cache;
  return handler;
}
