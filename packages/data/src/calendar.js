// Calendar — Phoenix port of lasso google/outlook calendar handlers.
// GET/HEAD /v1/{google,outlook}_calendar : CalendarRequest -> relay envelope
// `{ relayData: { events: CalendarEvent[] }, lassoDataFromRedis }`
// (AbstractRelayRequestHandler.ts:17-23,48-134; the pinned expectation is
// `tests/relay/GoogleCalendar.test.ts:132-162`).
//
// D-01 built the request validation + CalendarEvent normalization; D-03 added the
// OAuth token lifecycle; D-04 makes the route answer the *common relay envelope*
// with a HEAD handler, the 60-second cache and credential invalidation, and ports
// the reference normalization (endDate defaults/validation, timezone/all-day
// handling, invalid-event filtering):
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
//     credential invalidates that key (GoogleCalendarHandler.ts:16,26-35,60-62);
//   * endDate is validated and defaults to the end of tomorrow
//     (DateTimeUtils.ts:9-23, GoogleCalendarHandler.ts:47-57);
//   * events are presented by GoogleCalendarUtils.presentEvent /
//     OutlookCalendarUtils.presentEvent, which drop invalid events (null) and
//     normalize full-day/all-day events in the calendar's timezone.
//
// The event fetch itself stays pluggable (the real Google/Outlook Calendar API
// clients are a separate task): `provider` is injected as before, and when a
// non-oauth provider is used the handler behaves exactly as the certified D-01
// version did (no credential/refresh step, default provider still 501).

import { sendText } from '@phoenix/common';
import { CredentialError } from './oauth.js';
import { TTLCache } from './cache.js';

// --- pinned constants -------------------------------------------------------

// interfaces/src/lasso.ts:30-38 — the scopes the handler looks the credential up by.
const CALENDAR_SCOPES = {
  google: ['https://www.googleapis.com/auth/calendar.readonly'],
  outlook: ['Calendars.Read', 'offline_access'],
};

const CALENDAR_NAME = { google: 'GoogleCalendar', outlook: 'OutlookCalendar' };
// GoogleCalendarHandler.ts:16 / OutlookCalendarHandler.ts:18.
const CACHE_TTL_SECONDS = 60;

/** DateTimeUtils.validateEndDate (pegasus packages/lasso/src/utils/DateTimeUtils.ts:9-14). */
export function validateEndDate(endDate) {
  if (Number.isNaN(Date.parse(endDate))) {
    throw new Error(`Invalid end date: ${endDate}`);
  }
}

/**
 * DateTimeUtils.buildDefaultEndDate(daysFromNow = 1) (DateTimeUtils.ts:19-23):
 * end of that day in the *server's* timezone, rendered ISO in UTC.
 */
export function buildDefaultEndDate(daysFromNow = 1) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}

/**
 * Reference validateAndExtractInputs (GoogleCalendarHandler.ts:37-58,
 * OutlookCalendarHandler.ts:39-59): skillId/accountId/calendar are required,
 * a supplied endDate must parse, and a missing endDate defaults to
 * buildDefaultEndDate(1). The message wording is the pinned one — the reference
 * tests compare it verbatim (tests/relay/GoogleCalendar.test.ts:59,69,79).
 */
export function validateCalendar(q, serviceName = 'google') {
  const label = serviceName === 'outlook' ? 'Outlook Calendar' : 'Google Calendar';
  const skillId = q.get('skillId');
  const accountId = q.get('accountId');
  const calendar = q.get('calendar');
  if (!skillId) throw new Error(`Missing skillId in ${label} request`);
  if (!accountId) throw new Error(`Missing accountId in ${label} request`);
  if (!calendar) throw new Error(`Missing calendar type in ${label} request`);
  const endDate = q.get('endDate');
  if (endDate) validateEndDate(endDate);
  return {
    skillId,
    accountId,
    calendar,
    endDate: endDate || buildDefaultEndDate(1),
  };
}

// --- timezone helpers (moment / moment-timezone equivalents) -----------------

/**
 * The Graph API reports Windows zone ids; moment-timezone ships the CLDR mapping
 * that turns them into IANA zones, Intl does not. Only the ids a North-American /
 * European calendar realistically returns are mapped here; anything Intl rejects
 * falls back to UTC (documented limitation, see the D-04 evidence notes).
 */
const WINDOWS_ZONE_ALIASES = {
  UTC: 'UTC',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Mountain Standard Time': 'America/Denver',
  'Central Standard Time': 'America/Chicago',
  'Eastern Standard Time': 'America/New_York',
  'GMT Standard Time': 'Europe/London',
  'W. Europe Standard Time': 'Europe/Berlin',
};

/** Offset in minutes east of UTC of `timeZone` at `epochMs`. */
function zoneOffsetMinutes(timeZone, epochMs) {
  const zone = timeZone ? (WINDOWS_ZONE_ALIASES[timeZone] || timeZone) : null;
  if (!zone || zone === 'UTC' || zone === 'Etc/UTC') return 0;
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(epochMs));
  } catch {
    return 0; // unknown zone id (no tzdata): moment would know it, Intl does not
  }
  const f = {};
  for (const p of parts) if (p.type !== 'literal') f[p.type] = p.value;
  const asUTC = Date.UTC(+f.year, +f.month - 1, +f.day, +f.hour % 24, +f.minute, +f.second);
  return Math.round((asUTC - epochMs) / 60000);
}

/**
 * moment's `format('YYYY-MM-DDTHH:mm:ssZ')` (EVENT_DATETIME_FORMAT,
 * interfaces/src/lasso.ts:27): the wall clock at `offsetMinutes` plus the ±HH:MM
 * designator — NOT a UTC conversion. `Z` renders '+00:00' for a zero offset.
 */
function formatAtOffset(epochMs, offsetMinutes) {
  const d = new Date(epochMs + offsetMinutes * 60000);
  const p = (n) => String(n).padStart(2, '0');
  const abs = Math.abs(offsetMinutes);
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
    + `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
    + `${offsetMinutes < 0 ? '-' : '+'}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}

/** moment.tz(dateOnly, timeZone).startOf('day').valueOf() for a 'YYYY-MM-DD' date. */
function startOfDayMs(dateOnly, timeZone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateOnly));
  if (!m) throw new Error('Event has invalid start date');
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  let ts = wall;
  // Two passes settle a DST boundary; the same instant always resolves to itself.
  for (let i = 0; i < 3; i += 1) {
    const next = wall - zoneOffsetMinutes(timeZone, ts) * 60000;
    if (next === ts) break;
    ts = next;
  }
  return ts;
}

/**
 * moment.tz(dateTime, timeZone).valueOf(): a dateTime that carries its own designator
 * is the instant it names; a wall clock without one is read in `timeZone`.
 * Graph returns '2018-04-25T15:00:00.0000000' with a separate `timeZone`.
 */
function zonedDateTimeMs(dateTime, timeZone) {
  const text = String(dateTime);
  if (/\d{2}:\d{2}/.test(text) && /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(text)) {
    return new Date(text).getTime();
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/.exec(text);
  if (!m) return Date.parse(text);
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  let ts = wall;
  for (let i = 0; i < 3; i += 1) {
    const next = wall - zoneOffsetMinutes(timeZone, ts) * 60000;
    if (next === ts) break;
    ts = next;
  }
  return ts;
}

/** moment.parseZone(endDate).utcOffset() — the offset written in endDate itself. */
export function endDateOffsetMinutes(endDate) {
  const m = /([+-])(\d{2}):?(\d{2})$/.exec(String(endDate));
  if (!m) return 0;
  const minutes = (+m[2]) * 60 + (+m[3]);
  return m[1] === '-' ? -minutes : minutes;
}

// --- event normalization ----------------------------------------------------

/**
 * GoogleCalendarUtils.presentEvent (utils/GoogleCalendarUtils.ts:16-62).
 * `calendarTimezone` comes from the calendar resource (getCalendarTimezone); when
 * the provider supplies none the full-day instant is midnight UTC, which is what
 * the pre-D-04 Phoenix normalization produced.
 * Returns null for an event without a usable start, so the handler can filter it.
 */
export function normalizeEvent(rawEvent, calendarTimezone) {
  try {
    const event = { summary: rawEvent.summary, fullDay: false };
    if (rawEvent.start && rawEvent.start.date) {
      const startMs = startOfDayMs(rawEvent.start.date, calendarTimezone);
      event.fullDay = true;
      event.start = {
        dateTime: formatAtOffset(startMs, zoneOffsetMinutes(calendarTimezone, startMs)),
        timestamp: startMs,
      };
    } else if (rawEvent.start && rawEvent.start.dateTime) {
      event.start = {
        dateTime: rawEvent.start.dateTime,
        timestamp: new Date(rawEvent.start.dateTime).getTime(),
      };
    } else {
      throw new Error('Event has invalid start date');
    }
    if (rawEvent.end && rawEvent.end.date) {
      const endMs = startOfDayMs(rawEvent.end.date, calendarTimezone);
      event.end = {
        dateTime: formatAtOffset(endMs, zoneOffsetMinutes(calendarTimezone, endMs)),
        timestamp: endMs,
      };
    } else if (rawEvent.end && rawEvent.end.dateTime) {
      event.end = {
        dateTime: rawEvent.end.dateTime,
        timestamp: new Date(rawEvent.end.dateTime).getTime(),
      };
    }
    return event;
  } catch {
    return null;
  }
}

/**
 * OutlookCalendarUtils.presentEvent (utils/OutlookCalendarUtils.ts:14-54).
 * `tzOffset` is the offset of the *request's* endDate: the presented dateTime
 * strings are rendered at that offset and an all-day event (whose Graph start is
 * midnight UTC) is shifted by it. Returns null when start.dateTime is missing.
 */
export function normalizeOutlookEvent(rawEvent, tzOffset = 0) {
  try {
    const event = { summary: rawEvent.subject, fullDay: !!rawEvent.isAllDay };
    if (rawEvent.start && rawEvent.start.dateTime) {
      const startMs = zonedDateTimeMs(rawEvent.start.dateTime, rawEvent.start.timeZone)
        - (rawEvent.isAllDay ? tzOffset * 60000 : 0);
      event.start = { timestamp: startMs, dateTime: formatAtOffset(startMs, tzOffset) };
    } else {
      throw new Error('Event start date is missing');
    }
    if (rawEvent.end && rawEvent.end.dateTime) {
      const endMs = zonedDateTimeMs(rawEvent.end.dateTime, rawEvent.end.timeZone)
        - (rawEvent.isAllDay ? tzOffset * 60000 : 0);
      event.end = { timestamp: endMs, dateTime: formatAtOffset(endMs, tzOffset) };
    }
    return event;
  } catch {
    return null;
  }
}

const defaultProvider = async (req) => {
  const e = new Error(`Calendar token exchange not configured (${req.calendar}); supply a provider`);
  e.status = 501;
  throw e;
};

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

/** Express `response.send()` with no argument: empty 200, no entity headers. */
function sendEmptyOk(res) {
  if (typeof res.status === 'function' && typeof res.send === 'function') return res.status(200).send();
  res.writeHead(200, { 'x-powered-by': 'Express' });
  res.end();
}

/**
 * The relay envelope (AbstractRelayRequestHandler.ts:112-131): the miss body is
 * `{ relayData, lassoDataFromRedis: false }` and the cached body adds
 * `lassoInsertedIntoRedisAt`.
 *
 * `events` is ALSO mirrored at the top level. The reference has no such key
 * (`tests/relay/GoogleCalendar.test.ts:132-162` deep-equals the two-key body), but
 * the certified D-02/D-03 Phoenix tests assert `body.events`
 * (packages/data/test/credential.test.js:98-103 and
 * packages/data/test/oauth.test.js:211-331), so D-04 keeps them green with a
 * documented superset. Dropping the mirror is a root decision, not a worker one.
 */
function relayEnvelope(events, fromCache) {
  const body = { relayData: { events }, lassoDataFromRedis: fromCache, events };
  if (fromCache) body.lassoInsertedIntoRedisAt = new Date().toISOString();
  return body;
}

/**
 * Build a GET/HEAD handler for a calendar route.
 * @param {{
 *   provider?: (req:object, ctx:object)=>Promise<any[]|{events:any[],calendarTimezone?:string}>,
 *   store?: import('./credentials.js').CredentialStore,
 *   serviceName?: 'google'|'outlook',
 *   oauth?: { refresh: Function } | null,
 *   cache?: TTLCache, label?: string,
 * }} opts
 */
export function createCalendarHandler({ provider = defaultProvider, store, serviceName = 'google', oauth, cache = new TTLCache(), label } = {}) {
  const name = label || CALENDAR_NAME[serviceName] || 'Calendar';
  const scopes = CALENDAR_SCOPES[serviceName] || [];
  const isOutlook = serviceName === 'outlook';

  /** AbstractRelayRequestHandler.relayRequest (lines 48-135). */
  const handler = async ({ req, res, url }) => {
    let input;
    try { input = validateCalendar(url.searchParams, serviceName); }
    catch (e) { sendText(res, 400, e.message); return undefined; }

    const key = calendarCacheKey(serviceName, input);
    const isHead = req.method === 'HEAD';
    // AbstractRelayRequestHandler.ts:69-73 — an empty 200, then carry on with the
    // async request below so the cache gets warmed (prefetch).
    if (isHead) sendEmptyOk(res);

    // AbstractRelayRequestHandler.ts:77-98 — skipCache is a truthiness test.
    if (!skipCacheRequested(url.searchParams)) {
      let cached = null;
      try { cached = cache.get(key); } catch { /* Redis GET error -> live fetch */ }
      if (cached) {
        // A hit is served with `response.send(<stored string>)`, i.e. text/html.
        if (!isHead) sendText(res, 200, typeof cached === 'string' ? cached : JSON.stringify(cached));
        return undefined;
      }
    }

    let credential = null;
    try {
      // 1. Credential lookup + token freshness (only when a provider is wired).
      if (oauth && store) {
        credential = store.find({
          accountId: input.accountId, skillId: input.skillId, serviceName,
          serviceAccountName: input.calendar, scopes,
        });
        if (!credential || !credential.oauth2) throw new Error(`No credentials for ${input.calendar}`);

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
        raw = await provider(input, { store, credential });
      } catch (err) {
        if (credential && err && typeof err.message === 'string') {
          if (isOutlook && /InvalidAuthenticationToken/.test(err.message)) {
            store.setInactive(credential, CredentialError.INVALID_TOKEN);
          } else if (!isOutlook && /expired or revoked/.test(err.message)) {
            store.setInactive(credential, CredentialError.REVOKED_ACCESS);
          }
        }
        throw err;
      }

      // fetchFromExternal returns { events }; presentEvent produces null for an
      // unusable event and the handler filters those out (GoogleCalendarHandler.ts:113-116).
      const rawEvents = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.events) ? raw.events : []);
      const calendarTimezone = Array.isArray(raw) ? undefined : raw && raw.calendarTimezone;
      const tzOffset = endDateOffsetMinutes(input.endDate);
      const events = rawEvents
        .map((ev) => (isOutlook ? normalizeOutlookEvent(ev, tzOffset) : normalizeEvent(ev, calendarTimezone)))
        .filter((ev) => ev !== null);

      // 6. Add to cache regardless of request type (AbstractRelayRequestHandler.ts:119-131).
      try {
        cache.set(key, relayEnvelope(events, true), CACHE_TTL_SECONDS);
      } catch { /* Redis SET error: the next request is a miss and refetches */ }

      // 5. Respond to GET requests.
      return isHead ? undefined : relayEnvelope(events, false);
    } catch (e) {
      // AbstractRelayRequestHandler.fetchData (lines 154-168): an upstream error
      // with a response keeps its status, otherwise the relay answers 502 with
      // `Error getting <Name> data: <err>` (String(err) -> "Error: <message>").
      const message = e && e.response
        ? `Error getting ${name} data: ${JSON.stringify(e.response.data)}`
        : `Error getting ${name} data: ${e}`;
      const status = e && e.response ? e.response.status : 502;
      if (!isHead && !res.writableEnded) sendText(res, status, message);
      return undefined;
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
