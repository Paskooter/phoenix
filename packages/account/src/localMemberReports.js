// Personal-report preferences for an adult who is in a loop but has no login.
//
// A linked adult keeps report settings on their own account (settings record
// `<accountId>`), edited on the Account → Personal report page. Someone the
// owner added without an account has no such page, and the report skill could
// only ask Settings for an account ID, so their report failed or fell back to
// defaults. BEacon lets the household manage these switches for any adult.
//
// This is the one adapter for that case. Identity is the stable loop ID plus
// member ID — never a name — stored as `loopmember:<loopId>:<memberId>` beside
// the existing `loop:<loopId>` / `lasso:<accountId>` settings records, in the
// same report-skill wire shape, so the iCal helpers and the report's
// SettingsClient conversion work unchanged. Only the loop owner edits it, only
// for a live, accountless adult. Children keep the report's default
// behaviour; linked adults keep theirs on their own account.

import { isMemberStatus, MEMBER_STATUS } from './model.js';
import { dataToFriendly, defaultSettingsData, friendlyToData } from './settingsData.js';
import { subscriptionsFromData, validTimeZone } from './icalSubscriptions.js';

export const LOCAL_MEMBER_SETTINGS_PREFIX = 'loopmember:';

const COMMUTE_MODES = ['driving', 'walking', 'bicycling', 'transit'];
const NEWS_CATS = ['technology', 'sports', 'business', 'science', 'entertainment', 'strange',
  'health', 'international', 'national', 'politics'];
const CREDENTIAL_KEYS = ['google:personalCalendar:readonly', 'google:workCalendar:readonly',
  'outlook:personalCalendar:readonly', 'outlook:workCalendar:readonly'];

export class LocalReportError extends Error {
  constructor(message, statusCode = 400, code = 'INVALID_REPORT_SETTINGS') {
    super(message);
    this.name = 'LocalReportError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const idsEqual = (a, b) => a != null && b != null && String(a) === String(b);
const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/** The settings record key for one person in one loop. */
export function localMemberSettingsKey(loopId, memberId) {
  return `${LOCAL_MEMBER_SETTINGS_PREFIX}${loopId}:${memberId}`;
}

/** Every local-member settings key that belongs to `loopId`. */
export function localMemberSettingsKeysForLoop(store, loopId) {
  const prefix = `${LOCAL_MEMBER_SETTINGS_PREFIX}${loopId}:`;
  return [...(store.settings?.keys?.() || [])].filter((key) => String(key).startsWith(prefix));
}

/** Remove one person's local report settings (they left, or now have an account). */
export function deleteLocalMemberSettings(store, loopId, memberId) {
  const key = localMemberSettingsKey(loopId, memberId);
  if (!store.settings?.has?.(key)) return false;
  store.settings.delete(key);
  store.flush();
  return true;
}

/**
 * A live adult with no account whose profile the loop owner manages: the
 * same "locally managed" rule as local birthdays, minus children.
 */
export function isLocalAdultMember(loop, member) {
  // Same local-person rule as the accepted adapter's birthday dependency;
  // keep it here because that separate feature is not on this source line.
  return !!member && !isMemberStatus(member.status, MEMBER_STATUS.REMOVED)
    && !isMemberStatus(member.status, MEMBER_STATUS.DECLINED)
    && !member.accountId && !member.memberProperties?.email
    && member.memberProperties?.isChild !== true;
}

/** Whether `accountId` may manage this person's personal report from the console. */
export function canManageLocalReport(loop, member, accountId) {
  if (!loop || loop.isDeleted === true || loop.isSuspended) return false;
  return idsEqual(loop.owner, accountId) && isLocalAdultMember(loop, member);
}

/**
 * Resolve a report subject strictly inside its own loop. Returns null for an
 * unknown or deleted loop, a member of another loop, a removed/declined row,
 * anyone with an account, a pending email invitation, or a child.
 */
export function resolveLocalReportSubject(store, loopId, memberId) {
  if (typeof loopId !== 'string' || !loopId || typeof memberId !== 'string' || !memberId) return null;
  const loop = store.loops.get(loopId);
  if (!loop || loop.isDeleted === true) return null;
  const member = (loop.members || []).find((item) => idsEqual(item._id, memberId)) || null;
  if (!isLocalAdultMember(loop, member)) return null;
  return { loop, member, key: localMemberSettingsKey(loop._id, member._id) };
}

/** True when a `loopmember:` settings key still names a live local adult. */
export function isLiveLocalMemberSettingsKey(store, key) {
  const text = String(key || '');
  if (!text.startsWith(LOCAL_MEMBER_SETTINGS_PREFIX)) return false;
  const rest = text.slice(LOCAL_MEMBER_SETTINGS_PREFIX.length);
  const split = rest.indexOf(':');
  if (split <= 0) return false;
  const subject = resolveLocalReportSubject(store, rest.slice(0, split), rest.slice(split + 1));
  return !!subject && subject.key === text;
}

/** Stored wire data for a subject (the report defaults until the owner saves). */
export function readLocalReportData(store, subject) {
  const record = store.settings.get(subject.key);
  return (record && record.data) || defaultSettingsData();
}

export function writeLocalReportData(store, subject, data) {
  store.settings.set(subject.key, { _id: subject.key, data, updated: Date.now() });
  store.flush();
  return data;
}

/** What the owner's editor shows: the report switches this adapter manages. */
export function localReportView(data) {
  const friendly = dataToFriendly(data);
  return {
    news: friendly.news,
    commute: friendly.commute,
    calendar: {
      active: friendly.calendar.active,
      timeZone: friendly.calendar.timeZone,
    },
    // The private feed address stays on the server; the owner sees the host.
    subscriptions: subscriptionsFromData(data).map((item) => ({
      id: item.id,
      label: item.label,
      host: feedHost(item.url),
      enabled: item.enabled !== false,
      verification: {
        status: item.verification?.status || 'unknown',
        eventCount: item.verification?.eventCount || 0,
        lastChecked: item.verification?.lastChecked ?? null,
        lastSuccess: item.verification?.lastSuccess ?? null,
        lastError: item.verification?.lastError ?? null,
      },
    })),
  };
}

function feedHost(url) {
  try {
    return new URL(String(url).replace(/^webcal:/i, 'https:')).hostname || null;
  } catch {
    return null;
  }
}

function bool(value, field) {
  if (typeof value !== 'boolean') throw new LocalReportError(`${field} must be true or false`);
  return value;
}

function onlyKeys(object, allowed, field) {
  if (!isPlainObject(object)) throw new LocalReportError(`${field} must be an object`);
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      throw new LocalReportError(`${field}.${key} can’t be changed for someone without an account`);
    }
  }
}

function point(value, field) {
  onlyKeys(value, ['lat', 'lng'], field);
  const { lat = null, lng = null } = value;
  if (lat === null && lng === null) return { lat: null, lng: null };
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new LocalReportError(`${field}.lat must be a latitude`);
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) throw new LocalReportError(`${field}.lng must be a longitude`);
  return { lat, lng };
}

/**
 * Validate the owner's edit and merge it over the stored data. Only Calendar,
 * Commute and News (and their own options) are accepted; account-only items —
 * calendar provider links, weather, offering the report — are refused rather
 * than silently stored. Calendar feeds go through the subscription routes.
 */
export function applyLocalReportEdit(settings, base) {
  onlyKeys(settings, ['news', 'commute', 'calendar'], 'settings');
  const friendly = {};
  if (own(settings, 'news')) {
    const news = settings.news;
    onlyKeys(news, ['active', 'categories'], 'news');
    friendly.news = {};
    if (own(news, 'active')) friendly.news.active = bool(news.active, 'news.active');
    if (own(news, 'categories')) {
      onlyKeys(news.categories, NEWS_CATS, 'news.categories');
      friendly.news.categories = {};
      for (const [cat, on] of Object.entries(news.categories)) {
        friendly.news.categories[cat] = bool(on, `news.categories.${cat}`);
      }
    }
  }
  if (own(settings, 'commute')) {
    const commute = settings.commute;
    onlyKeys(commute, ['active', 'mode', 'time', 'home', 'work'], 'commute');
    friendly.commute = {};
    if (own(commute, 'active')) friendly.commute.active = bool(commute.active, 'commute.active');
    if (own(commute, 'mode')) {
      if (!COMMUTE_MODES.includes(commute.mode)) throw new LocalReportError(`commute.mode must be one of ${COMMUTE_MODES.join(', ')}`);
      friendly.commute.mode = commute.mode;
    }
    if (own(commute, 'time')) {
      onlyKeys(commute.time, ['hour', 'min'], 'commute.time');
      const { hour, min } = commute.time;
      if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(min) || min < 0 || min > 59) {
        throw new LocalReportError('commute.time must be a time of day');
      }
      friendly.commute.time = { hour, min };
    }
    if (own(commute, 'home')) friendly.commute.home = point(commute.home, 'commute.home');
    if (own(commute, 'work')) friendly.commute.work = point(commute.work, 'commute.work');
  }
  if (own(settings, 'calendar')) {
    const calendar = settings.calendar;
    onlyKeys(calendar, ['active', 'timeZone'], 'calendar');
    friendly.calendar = {};
    if (own(calendar, 'active')) friendly.calendar.active = bool(calendar.active, 'calendar.active');
    if (own(calendar, 'timeZone')) {
      const zone = typeof calendar.timeZone === 'string' ? calendar.timeZone.trim() : '';
      if (!zone || validTimeZone(zone) !== zone) throw new LocalReportError('calendar.timeZone must be an IANA time zone');
      friendly.calendar.timeZone = zone;
    }
  }
  const data = friendlyToData(friendly, base);
  // Nobody without an account has a linked calendar provider.
  for (const key of CREDENTIAL_KEYS) data[key] = { credentialExists: false };
  return data;
}

/**
 * The report-skill GetSettings `data` for a local adult: the stored wire
 * values, provider links forced off, and cached iCal events without the
 * private feed address — the same projection a linked speaker receives.
 */
export function localReportSettingsData(data) {
  const out = {};
  for (const [key, value] of Object.entries(data || {})) {
    if (key === 'icalSubscriptions') continue;
    out[key] = value;
  }
  if (!own(out, 'offerProactively')) out.offerProactively = { value: true };
  for (const key of CREDENTIAL_KEYS) out[key] = { credentialExists: false };
  const subscriptions = data?.icalSubscriptions?.subscriptions;
  if (Array.isArray(subscriptions)) {
    out.icalSubscriptions = {
      subscriptions: subscriptions.filter((item) => item && typeof item === 'object').map((item) => ({
        id: item.id,
        label: item.label,
        enabled: item.enabled !== false,
        verification: item.verification,
        events: Array.isArray(item.events) ? item.events : [],
      })),
    };
  }
  return out;
}
