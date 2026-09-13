// Private, deterministic provider inputs for the real diagnostic robot stack.
//
// This module is deliberately inert unless stack.mjs is started with a fixture
// path. It does not replace NLU, Gateway, Skills, Report or Data: it supplies
// the provider boundaries those real services already use. The file is read on
// every Settings/Data request, so an operator can atomically replace the case
// selector between robot turns without restarting the process.

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const S13_FIXTURE_SCHEMA = 'phoenix-s13-robot-fixture-v1';
export const S13_FIXTURE_MAX_BYTES = 16 * 1024 * 1024;
// This value is deliberately recognizable as a diagnostic-only identity. It is
// supplied only for the calendar Lasso/Data request when the selected loop user
// has no accountId; it is never persisted, authenticated, or used by a live
// provider. Keeping it constant makes the physical fixture request reproducible.
export const S13_FIXTURE_CALENDAR_ACCOUNT_ID = 'phoenix-s13-fixture-calendar-account-v1';

const HASH = /^[0-9a-f]{64}$/i;
const CASE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function dateInZone(iso, timeZone) {
  const instant = new Date(iso);
  if (!Number.isFinite(instant.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hourCycle: 'h23',
    }).formatToParts(instant);
    const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    return null;
  }
}

function wallPartsAt(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(instant));
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return {
    year: Number(values.year), month: Number(values.month), day: Number(values.day),
    hour: Number(values.hour), min: Number(values.minute),
  };
}

function offsetMinutesAt(instant, timeZone) {
  const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(new Date(instant)).find((entry) => entry.type === 'timeZoneName')?.value || 'GMT';
  if (part === 'GMT' || part === 'UTC') return 0;
  const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(part);
  if (!match) reject(`cannot resolve timezone offset '${part}' for ${timeZone}`);
  const minutes = Number(match[2]) * 60 + Number(match[3] || 0);
  return match[1] === '-' ? -minutes : minutes;
}

/**
 * Resolve the offset for a local wall-clock timestamp. Probing `Date.UTC` as
 * if it were already an instant samples whichever DST side happens to contain
 * that UTC value; it is wrong for local timestamps near a transition. Instead,
 * collect offsets around the wall value, project each candidate back through
 * Intl, and choose the exact match. For a spring gap choose the first valid
 * post-gap offset; for a fall overlap choose the earlier instant.
 */
export function resolveLocalOffset(dateText, hour, min, timeZone) {
  if (typeof dateText !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateText)
    || !Number.isInteger(hour) || !Number.isInteger(min) || hour < 0 || hour > 23 || min < 0 || min > 59) {
    reject('local wall timestamp is invalid');
  }
  const [year, month, day] = dateText.split('-').map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, min);
  const offsets = new Set();
  const span = 3 * 86400000;
  for (let delta = -span; delta <= span; delta += 6 * 3600000) {
    offsets.add(offsetMinutesAt(wall + delta, timeZone));
  }
  const projections = [...offsets].map((offset) => {
    const instant = wall - offset * 60000;
    const local = wallPartsAt(instant, timeZone);
    const projected = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.min);
    return { offset, actualOffset: offsetMinutesAt(instant, timeZone), instant, delta: projected - wall };
  });
  const exact = projections.filter((candidate) => candidate.delta === 0).sort((a, b) => a.instant - b.instant);
  if (exact.length) return formatOffset(exact[0].offset);
  const forward = projections.filter((candidate) => candidate.delta > 0).sort((a, b) => a.delta - b.delta);
  if (forward.length) return formatOffset(forward[0].actualOffset);
  const backward = projections.sort((a, b) => b.delta - a.delta);
  if (backward.length) return formatOffset(backward[0].actualOffset);
  reject(`cannot resolve timezone offset for ${dateText} ${hour}:${min} in ${timeZone}`);
}

function formatOffset(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const absolute = Math.abs(minutes);
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
}

function reject(message) {
  throw new Error(`S13 fixture rejected: ${message}`);
}

function calendarIdentityMetadata() {
  return {
    enabled: true,
    accountId: S13_FIXTURE_CALENDAR_ACCOUNT_ID,
    fill: 'missing-only',
    scope: 'LassoClient.fetchCalendarEvents -> fixture Data calendar provider',
    credentials: 'none',
  };
}

/**
 * Make the source LassoClient calendar call usable with a physical WhoIsThis
 * result whose loop user has an id but no accountId. The report data object is
 * shallow-cloned so the graph's real runtime context is never mutated. Any
 * malformed or ambiguous speaker context rejects before the original method is
 * called; there is no fallback account and no fixture provider bypass here.
 */
function calendarDataWithFixtureIdentity(data) {
  if (!isRecord(data)) reject('calendar identity bridge requires report data');
  const runtime = data.runtime;
  if (!isRecord(runtime)) reject('calendar identity bridge requires runtime data');
  const perception = runtime.perception;
  const speaker = perception && perception.speaker;
  if (typeof speaker !== 'string' || !speaker) {
    reject('calendar identity bridge requires a selected speaker');
  }
  const loop = runtime.loop;
  if (!isRecord(loop) || !Array.isArray(loop.users)) {
    reject('calendar identity bridge requires loop.users');
  }
  const matches = loop.users.filter((user) => isRecord(user) && user.id === speaker);
  if (matches.length !== 1) {
    reject(`calendar identity bridge requires exactly one loop user for speaker '${speaker}'`);
  }
  const selected = matches[0];
  const existing = selected.accountId;
  const missing = existing === undefined || existing === null || existing === '';
  if (!missing) {
    if (typeof existing !== 'string' || !existing.trim()) {
      reject(`calendar identity bridge found an invalid accountId for speaker '${speaker}'`);
    }
    return data;
  }

  const users = loop.users.map((user) => user === selected
    ? { ...user, accountId: S13_FIXTURE_CALENDAR_ACCOUNT_ID }
    : user);
  return {
    ...data,
    runtime: {
      ...runtime,
      loop: { ...loop, users },
    },
  };
}

/**
 * Install the S13-only identity bridge on the already imported LassoClient.
 * The original implementation remains responsible for constructing the
 * request, headers, URL, and response handling; this wrapper changes only the
 * cloned loop context passed to that call.
 */
export function installCalendarIdentityBridge(lassoClient) {
  if (!lassoClient || typeof lassoClient.fetchCalendarEvents !== 'function') {
    reject('calendar identity bridge requires LassoClient.fetchCalendarEvents');
  }
  const original = lassoClient.fetchCalendarEvents;
  const wrapped = function fixtureCalendarFetch(data, ...args) {
    return original.call(this, calendarDataWithFixtureIdentity(data), ...args);
  };
  lassoClient.fetchCalendarEvents = wrapped;
  let restored = false;
  return () => {
    if (restored) return;
    if (lassoClient.fetchCalendarEvents !== wrapped && lassoClient.fetchCalendarEvents !== original) {
      reject('calendar identity bridge was replaced before restoration');
    }
    if (lassoClient.fetchCalendarEvents === wrapped) lassoClient.fetchCalendarEvents = original;
    restored = true;
  };
}

function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// The integrity digest intentionally covers only `cases`. This lets the root
// switch `caseId` between turns without having to rewrite a self-referential
// file hash. Stable ordering makes the digest independent of JSON key order.
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) reject('non-finite JSON number');
  return JSON.stringify(value);
}

export function casesSha256(cases) {
  return hashBytes(Buffer.from(stableJson(cases), 'utf8'));
}

function normalizeHash(value, name) {
  if (typeof value !== 'string') reject(`${name} must be a lowercase or uppercase SHA-256 hex string`);
  const digest = value.startsWith('sha256:') ? value.slice('sha256:'.length) : value;
  if (!HASH.test(digest)) reject(`${name} must be a SHA-256 hex string`);
  return digest.toLowerCase();
}

function selectedCalendarSource(service, calendar) {
  if (service === undefined) return undefined;
  if (isRecord(service) && own(service, calendar)) service = service[calendar];
  else if (isRecord(service) && own(service, 'default')) service = service.default;
  if (isRecord(service) && own(service, 'relayData')) service = service.relayData;
  return service;
}

function calendarEventsFor(service, calendar, serviceName) {
  const selected = selectedCalendarSource(service, calendar);
  let events;
  if (Array.isArray(selected)) events = selected;
  else if (isRecord(selected)) {
    events = serviceName === 'google'
      ? selected.items
      : selected.value;
    if (!Array.isArray(events) && Array.isArray(selected.events)) events = selected.events;
  }
  if (!Array.isArray(events)) reject(`calendar ${serviceName}/${calendar} must contain source items/value/events`);
  return events;
}

function sourceEventTimestamp(event, serviceName, field) {
  if (!isRecord(event)) reject(`calendar ${serviceName} event must be an object`);
  const point = event[field];
  if (!isRecord(point)) reject(`calendar ${serviceName} event is missing ${field}`);
  const value = serviceName === 'google'
    ? (point.dateTime ?? point.date)
    : point.dateTime;
  if (typeof value !== 'string' || !value) reject(`calendar ${serviceName} event ${field} timestamp is required`);
  return value;
}

function calendarEventTimestamps(calendarData) {
  const bindings = [];
  for (const serviceName of ['google', 'outlook']) {
    const service = calendarData[serviceName];
    if (service === undefined) reject(`calendar provider '${serviceName}' is missing`);
    for (const calendar of ['personalCalendar', 'workCalendar']) {
      const events = calendarEventsFor(service, calendar, serviceName);
      events.forEach((event, index) => {
        const entry = {
          service: serviceName,
          calendar,
          index,
          start: sourceEventTimestamp(event, serviceName, 'start'),
        };
        if (event.end !== undefined) entry.end = sourceEventTimestamp(event, serviceName, 'end');
        bindings.push(entry);
      });
    }
  }
  return bindings;
}

function validateCaseMetadata(selected, caseId, calendarData) {
  if (!isRecord(selected.meta)) reject(`case '${caseId}' is missing meta binding data`);
  const meta = selected.meta;
  if (typeof meta.date !== 'string' || !DATE.test(meta.date)) {
    reject(`case '${caseId}' meta.date must be YYYY-MM-DD`);
  }
  const dateCheck = new Date(`${meta.date}T00:00:00Z`);
  if (!Number.isFinite(dateCheck.getTime()) || dateCheck.toISOString().slice(0, 10) !== meta.date) {
    reject(`case '${caseId}' meta.date is invalid`);
  }
  if (typeof meta.timeZone !== 'string' || !meta.timeZone) reject(`case '${caseId}' meta.timeZone is required`);
  try { new Intl.DateTimeFormat('en-US', { timeZone: meta.timeZone }).format(dateCheck); }
  catch { reject(`case '${caseId}' meta.timeZone is unknown`); }
  if (!isRecord(meta.workTime)
    || !Number.isInteger(meta.workTime.hour) || meta.workTime.hour < 0 || meta.workTime.hour > 23
    || !Number.isInteger(meta.workTime.min) || meta.workTime.min < 0 || meta.workTime.min > 59) {
    reject(`case '${caseId}' meta.workTime must contain an hour/minute`);
  }
  if (!Array.isArray(meta.eventTimestamps)) reject(`case '${caseId}' meta.eventTimestamps must be an array`);
  const expectedEvents = calendarEventTimestamps(calendarData);
  if (stableJson(meta.eventTimestamps) !== stableJson(expectedEvents)) {
    reject(`case '${caseId}' meta.eventTimestamps do not match source calendar data`);
  }
  return {
    date: meta.date,
    timeZone: meta.timeZone,
    workTime: { hour: meta.workTime.hour, min: meta.workTime.min },
    eventTimestamps: clone(meta.eventTimestamps),
    ...(typeof meta.calendarPhrase === 'string' ? { calendarPhrase: meta.calendarPhrase } : {}),
  };
}

function prefsWorkTime(caseData, SettingsClient) {
  const direct = own(caseData, 'userPrefs') ? caseData.userPrefs : own(caseData, 'prefs') ? caseData.prefs : undefined;
  if (direct !== undefined) return direct && direct.commute && direct.commute.workTime;
  // Source settings are converted only when SettingsClient is available. The
  // runtime validates that conversion against meta.workTime on the request.
  if (SettingsClient && own(caseData, 'settings')) {
    try { return settingsPayload(caseData, SettingsClient).commute?.workTime; } catch { return undefined; }
  }
  return undefined;
}

function validateWorkTimeBinding(selected, metadata, SettingsClient, caseId = selected._caseId || 'selected') {
  const workTime = prefsWorkTime(selected, SettingsClient);
  if (workTime !== undefined
    && (!isRecord(workTime) || workTime.hour !== metadata.workTime.hour || workTime.min !== metadata.workTime.min)) {
    reject(`case '${caseId}' meta.workTime does not match user preferences`);
  }
}

function validateMapSource(payload, caseId, label = 'maps') {
  if (isRecord(payload) && own(payload, 'relayData')) return validateMapSource(payload.relayData, caseId, label);
  if (!isRecord(payload)) reject(`case '${caseId}' ${label} must be an object`);
  // A mode matrix is allowed, but every selected mode must independently be a
  // complete Google Maps response. This prevents a missing/default mode from
  // silently falling through to a live external fetch.
  if (!own(payload, 'routes') && !own(payload, 'status')) {
    const keys = Object.keys(payload).filter((key) => key !== 'meta');
    if (!keys.length) reject(`case '${caseId}' ${label} has no response or mode entries`);
    for (const key of keys) validateMapSource(payload[key], caseId, `${label}.${key}`);
    return;
  }
  if (typeof payload.status !== 'string') reject(`case '${caseId}' ${label}.status must be a string`);
  if (!Array.isArray(payload.routes)) reject(`case '${caseId}' ${label}.routes must be an array`);
  if (!payload.routes.length) return;
  const leg = payload.routes[0] && payload.routes[0].legs && payload.routes[0].legs[0];
  if (!isRecord(leg) || !isRecord(leg.duration) || !Number.isFinite(leg.duration.value) || leg.duration.value < 0) {
    reject(`case '${caseId}' ${label} route must include numeric duration`);
  }
  if (!isRecord(leg.duration_in_traffic) || !Number.isFinite(leg.duration_in_traffic.value)
    || leg.duration_in_traffic.value < 0) {
    reject(`case '${caseId}' ${label} route must include numeric duration_in_traffic`);
  }
}

function privateFixtureFile(filePath) {
  if (!filePath || typeof filePath !== 'string') reject('fixture path is required');
  const absolute = resolve(filePath);
  let stat;
  try { stat = lstatSync(absolute); } catch (error) { reject(`cannot stat fixture file: ${error.message}`); }
  if (!stat.isFile() || stat.isSymbolicLink()) reject('fixture path must be a private regular file, not a symlink');
  if ((stat.mode & 0o777) !== 0o600) reject('fixture file must have mode 0600');
  if (stat.size > S13_FIXTURE_MAX_BYTES) reject(`fixture file exceeds ${S13_FIXTURE_MAX_BYTES} bytes`);
  return { absolute, stat };
}

function stableRead(filePath) {
  // A fixture edit must be an atomic rename. If an in-place write races the
  // read, retry once; a second unstable read fails closed rather than mixing
  // two cases into one turn.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = privateFixtureFile(filePath);
    const bytes = readFileSync(before.absolute);
    const after = privateFixtureFile(filePath);
    if (before.stat.dev === after.stat.dev && before.stat.ino === after.stat.ino
      && before.stat.size === after.stat.size && before.stat.mtimeMs === after.stat.mtimeMs
      && bytes.length === after.stat.size) return { ...before, bytes };
  }
  reject('fixture changed while it was being read; update it with an atomic rename');
}

function validateRoot(document) {
  if (!isRecord(document)) reject('top level must be an object');
  if (document.schema !== S13_FIXTURE_SCHEMA) {
    reject(`schema must be exactly ${S13_FIXTURE_SCHEMA}`);
  }
  if (!isRecord(document.cases) || !Object.keys(document.cases).length) reject('cases must be a non-empty object');

  const caseId = own(document, 'caseId') ? document.caseId : document.activeCase;
  if (own(document, 'caseId') && own(document, 'activeCase') && document.caseId !== document.activeCase) {
    reject('caseId and activeCase disagree');
  }
  if (typeof caseId !== 'string' || !CASE_ID.test(caseId)) reject('caseId must be an exact, bounded case identifier');
  if (!own(document.cases, caseId)) reject(`caseId '${caseId}' is not present in cases`);

  if (own(document, 'integrity') && !isRecord(document.integrity)) reject('integrity must be an object');
  if (isRecord(document.integrity) && !own(document.integrity, 'casesSha256')) {
    reject('integrity.casesSha256 is required when integrity is present');
  }
  if (isRecord(document.integrity) && own(document, 'casesSha256')
    && document.casesSha256 !== document.integrity.casesSha256) {
    reject('integrity.casesSha256 and casesSha256 disagree');
  }
  const declared = isRecord(document.integrity) ? document.integrity.casesSha256 : document.casesSha256;
  if (!declared) reject('integrity.casesSha256 is required');
  const digest = casesSha256(document.cases);
  if (normalizeHash(declared, 'integrity.casesSha256') !== digest) {
    reject(`cases SHA-256 mismatch (expected ${normalizeHash(declared, 'integrity.casesSha256')}, got ${digest})`);
  }
  const selected = document.cases[caseId];
  if (!isRecord(selected)) reject(`case '${caseId}' must be an object`);
  if (!isRecord(selected.maps)) reject(`case '${caseId}' is missing source-shaped maps data`);
  if (!isRecord(selected.calendar)) reject(`case '${caseId}' is missing calendar provider data`);
  if (!own(selected, 'userPrefs') && !own(selected, 'prefs') && !own(selected, 'settings')) {
    reject(`case '${caseId}' is missing userPrefs, prefs, or settings`);
  }
  const metadata = validateCaseMetadata(selected, caseId, selected.calendar);
  validateMapSource(selected.maps, caseId);
  return { caseId, selected: { ...selected, _caseId: caseId }, metadata, casesDigest: digest };
}

/**
 * Read and validate one fixture snapshot.
 *
 * `expectedFileSha256` is an optional immutable file guard. The per-case
 * editable guard is `expectedCasesSha256` (or the fixture's required
 * `integrity.casesSha256`). Both are checked when supplied.
 */
export function readS13Fixture(filePath, {
  expectedFileSha256,
  expectedCasesSha256,
  onRead,
} = {}) {
  const { absolute, bytes } = stableRead(filePath);
  const fileDigest = hashBytes(bytes);
  if (expectedFileSha256 !== undefined && normalizeHash(expectedFileSha256, 'expected fixture SHA-256') !== fileDigest) {
    reject(`fixture SHA-256 mismatch (expected ${normalizeHash(expectedFileSha256, 'expected fixture SHA-256')}, got ${fileDigest})`);
  }

  let document;
  try { document = JSON.parse(bytes.toString('utf8')); }
  catch (error) { reject(`invalid JSON: ${error.message}`); }
  const { caseId, selected, metadata: caseMetadata, casesDigest } = validateRoot(document);
  if (expectedCasesSha256 !== undefined && normalizeHash(expectedCasesSha256, 'expected cases SHA-256') !== casesDigest) {
    reject(`cases SHA-256 mismatch (expected ${normalizeHash(expectedCasesSha256, 'expected cases SHA-256')}, got ${casesDigest})`);
  }
  const metadata = {
    path: absolute,
    sha256: fileDigest,
    casesSha256: casesDigest,
    caseId,
    ...caseMetadata,
  };
  onRead?.(metadata);
  return { document, case: selected, metadata };
}

class NoopCache {
  get() { return null; }
  set() { return undefined; }
  del() { return undefined; }
}

function sourcePayload(payload, name) {
  if (isRecord(payload) && own(payload, 'relayData')) payload = payload.relayData;
  if (!isRecord(payload)) reject(`${name} provider data must be an object`);
  return payload;
}

function mapPayload(caseData, input) {
  let payload = caseData.maps;
  if (isRecord(payload) && own(payload, 'relayData')) payload = payload.relayData;
  // A case may supply one map response per travel mode, with `default` as a
  // fallback. A source-shaped Maps object itself always has `routes` or
  // `status`, so it is distinguishable from that mode map.
  if (isRecord(payload) && !own(payload, 'routes') && !own(payload, 'status')) {
    payload = own(payload, input.mode) ? payload[input.mode] : payload.default;
  }
  payload = sourcePayload(payload, 'maps');
  if (!Array.isArray(payload.routes)) reject('maps response routes must be an array');
  if (payload.routes.length) {
    const leg = payload.routes[0] && payload.routes[0].legs && payload.routes[0].legs[0];
    if (!isRecord(leg) || !isRecord(leg.duration)) reject('maps route must include a source-shaped duration object');
    if (own(leg, 'duration_in_traffic') && !isRecord(leg.duration_in_traffic)) {
      reject('maps duration_in_traffic must be an object when present');
    }
  }
  return clone(payload);
}

function calendarPayload(caseData, serviceName, calendar) {
  const service = caseData.calendar[serviceName];
  if (service === undefined) reject(`calendar provider '${serviceName}' is missing`);
  const selected = selectedCalendarSource(service, calendar);
  let events;
  let calendarTimezone;
  if (Array.isArray(selected)) events = selected;
  else if (isRecord(selected)) {
    events = Array.isArray(selected.items) ? selected.items
      : Array.isArray(selected.value) ? selected.value
        : Array.isArray(selected.events) ? selected.events : undefined;
    calendarTimezone = selected.calendarTimezone || selected.timeZone;
  }
  if (!Array.isArray(events)) reject(`calendar ${serviceName}/${calendar} must contain source items/value/events`);
  return { events: clone(events), ...(calendarTimezone ? { calendarTimezone } : {}) };
}

function settingsPayload(caseData, SettingsClient, log) {
  const direct = own(caseData, 'userPrefs') ? caseData.userPrefs : own(caseData, 'prefs') ? caseData.prefs : undefined;
  if (direct !== undefined) {
    if (!isRecord(direct)) reject('userPrefs/prefs must be an object');
    for (const category of ['weather', 'calendar', 'commute', 'news']) {
      if (!isRecord(direct[category])) reject(`userPrefs.${category} must be an object`);
    }
    if (!isRecord(direct.commute.workTime)) reject('userPrefs.commute.workTime must be an object');
    return clone(direct);
  }
  let settings = caseData.settings;
  if (Array.isArray(settings)) settings = settings.find((item) => item && item.skillId === 'report-skill')?.data;
  if (isRecord(settings) && own(settings, 'report-skill')) settings = settings['report-skill'];
  if (isRecord(settings) && isRecord(settings.data) && own(settings, 'skillId')) settings = settings.data;
  if (!isRecord(settings)) reject('settings must be a source-shaped object or report-skill array entry');
  // Accepting an already converted `settings: {weather,calendar,...}` keeps
  // the file ergonomic while the normal source-shaped path still exercises
  // SettingsClient.convertSettingsToPrefs.
  if (own(settings, 'weather') || own(settings, 'commute') || own(settings, 'calendar')) {
    for (const category of ['weather', 'calendar', 'commute', 'news']) {
      if (!isRecord(settings[category])) reject(`settings.${category} must be an object`);
    }
    if (!isRecord(settings.commute.workTime)) reject('settings.commute.workTime must be an object');
    return clone(settings);
  }
  if (!SettingsClient || typeof SettingsClient.convertSettingsToPrefs !== 'function') reject('SettingsClient conversion is unavailable');
  try { return SettingsClient.convertSettingsToPrefs(settings); }
  catch (error) { reject(`settings conversion failed: ${error.message}`); }
}

function directOptional(caseData, name, input) {
  if (!own(caseData, name)) reject(`case is missing ${name} provider data`);
  let value = caseData[name];
  if (isRecord(value) && own(value, 'relayData')) value = value.relayData;
  if (isRecord(value) && own(value, input?.sourceID)) value = value[input.sourceID];
  if (isRecord(value) && own(value, String(input?.sourceID))) value = value[String(input.sourceID)];
  if (isRecord(value) && own(value, 'default')) value = value.default;
  if (value === undefined || value === null) reject(`${name} provider data is empty`);
  return clone(value);
}

/**
 * Build the hooks consumed by `scripts/parity-robot/stack.mjs`.
 * `SettingsClient` is passed at install time to avoid importing product report
 * code when fixture mode is absent.
 */
export function createS13FixtureRuntime({
  filePath,
  expectedFileSha256,
  expectedCasesSha256,
  onRead,
  onProvider,
} = {}) {
  if (!filePath) reject('fixture path is required');
  let last;
  const turnCases = new Map();
  const read = () => {
    last = readS13Fixture(filePath, {
      expectedFileSha256,
      expectedCasesSha256,
      onRead: (metadata) => onRead?.({ ...metadata, calendarIdentity: calendarIdentityMetadata() }),
    });
    last = { ...last, metadata: { ...last.metadata, calendarIdentity: calendarIdentityMetadata() } };
    return last;
  };
  const notifyProvider = (service, input, snapshot) => {
    onProvider?.({ service, caseId: snapshot.metadata.caseId, input: clone(input) });
  };
  const requestTransID = (input, context) => {
    const headers = context?.req?.headers || {};
    return headers['x-jibo-transid'] || headers['x-jibo-trans-id'] || input?.transID || input?.transId || null;
  };
  const bindTurn = (snapshot, input, context, { reset = false } = {}) => {
    const transID = requestTransID(input, context);
    if (!transID) return;
    if (reset) {
      // Settings is the first provider boundary in a report turn. Resetting
      // here permits an implementation that reuses a transaction id only
      // after its prior turn is idle, while all subsequent Data calls in the
      // same turn must observe the same case.
      turnCases.set(transID, snapshot.metadata.caseId);
      return;
    }
    const prior = turnCases.get(transID);
    if (prior && prior !== snapshot.metadata.caseId) {
      reject(`case changed during transaction '${transID}' (${prior} -> ${snapshot.metadata.caseId})`);
    }
    if (!prior) turnCases.set(transID, snapshot.metadata.caseId);
  };
  let restoreSettings = () => {};
  let restoreCalendarIdentity = () => {};
  return {
    read,
    metadata() {
      if (!last) read();
      return { ...last.metadata };
    },
    getUserPrefs(SettingsClient, data, looperID) {
      const snapshot = read();
      bindTurn(snapshot, { transID: data?.req?.jibo?.transID || null }, null, { reset: true });
      notifyProvider('settings', { looperID, transID: data?.req?.jibo?.transID || null }, snapshot);
      const prefs = settingsPayload(snapshot.case, SettingsClient, data?.log);
      validateWorkTimeBinding(snapshot.case, snapshot.metadata, SettingsClient, snapshot.metadata.caseId);
      const requestISO = data?.runtime?.location?.iso;
      if (requestISO && typeof requestISO === 'string'
        && dateInZone(requestISO, snapshot.metadata.timeZone) !== snapshot.metadata.date) {
        reject(`case '${snapshot.metadata.caseId}' date does not match request runtime date`);
      }
      return prefs;
    },
    mapsProvider(input, context) {
      const snapshot = read();
      bindTurn(snapshot, input, context);
      notifyProvider('maps', input, snapshot);
      return mapPayload(snapshot.case, input);
    },
    googleCalendarProvider(input, context) {
      const snapshot = read();
      bindTurn(snapshot, input, context);
      notifyProvider('google-calendar', input, snapshot);
      return calendarPayload(snapshot.case, 'google', input.calendar);
    },
    outlookCalendarProvider(input, context) {
      const snapshot = read();
      bindTurn(snapshot, input, context);
      notifyProvider('outlook-calendar', input, snapshot);
      return calendarPayload(snapshot.case, 'outlook', input.calendar);
    },
    weatherProvider(input, context) {
      const snapshot = read();
      bindTurn(snapshot, input, context);
      notifyProvider('weather', input, snapshot);
      return directOptional(snapshot.case, 'weather', input);
    },
    newsProvider(input, context) {
      const snapshot = read();
      bindTurn(snapshot, input, context);
      notifyProvider('news', input, snapshot);
      return directOptional(snapshot.case, 'news', input);
    },
    dataOptions() {
      // Disabling only this fixture stack's cache is what makes a case edit
      // visible on the very next turn. Product Data keeps its normal cache.
      return {
        cache: new NoopCache(),
        calendarCache: new NoopCache(),
        mapsProvider: (input, context) => this.mapsProvider(input, context),
        googleCalendarProvider: (input, context) => this.googleCalendarProvider(input, context),
        outlookCalendarProvider: (input, context) => this.outlookCalendarProvider(input, context),
        weatherProvider: (input, context) => this.weatherProvider(input, context),
        newsProvider: (input, context) => this.newsProvider(input, context),
      };
    },
    installSettingsClient(SettingsClient) {
      if (!SettingsClient || typeof SettingsClient.getUserPrefs !== 'function') reject('SettingsClient.getUserPrefs is unavailable');
      const original = SettingsClient.getUserPrefs;
      SettingsClient.getUserPrefs = async (data, looperID) => this.getUserPrefs(SettingsClient, data, looperID);
      restoreSettings = () => { SettingsClient.getUserPrefs = original; };
      return restoreSettings;
    },
    installCalendarIdentityBridge(lassoClient) {
      restoreCalendarIdentity = installCalendarIdentityBridge(lassoClient);
      return restoreCalendarIdentity;
    },
    restore() {
      restoreCalendarIdentity();
      restoreSettings();
    },
  };
}
