import { randomUUID } from 'node:crypto';
import { sendJson } from '@phoenix/common';
import { getSession } from './sessions.js';
import { getSettingsData } from './settingsData.js';
import {
  accountTimeZone,
  calendarEventsForWindow,
  fetchAndParseIcal,
  ICAL_MAX_SUBSCRIPTIONS_PER_ACCOUNT,
  listSubscriptions,
  publicSubscription,
  saveSubscriptions,
  verifySubscription,
} from './icalSubscriptions.js';

function owner(store, req) {
  const session = getSession(store, req);
  // Calendar contents are private account data, so this resolves the account from
  // the session and nothing else: there is no account id in the request to pass,
  // and every route below is scoped to whatever this returns.
  //
  // Note on administrators: since admin became a flag on an ordinary account
  // (portalApi.js isAdmin), an administrator who signs in IS a `kind: 'user'`
  // session — so being an admin grants nothing here, because the routes are
  // owner-scoped rather than role-checked. A legacy `kind: 'admin'` session,
  // which nothing mints any more, falls through to null and is refused.
  return session?.kind === 'user' ? store.accounts.get(session.accountId) || null : null;
}

function subscriptionId(req) {
  return typeof req.params?.id === 'string' ? req.params.id : '';
}

function bodyLabel(body) {
  return typeof body?.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 120) : 'Calendar';
}

function bodyUrl(body) {
  return typeof body?.url === 'string' ? body.url.trim() : '';
}

function timeWindow(url) {
  const now = Date.now();
  const start = url.searchParams.get('start');
  const end = url.searchParams.get('end');
  const startMs = start ? Date.parse(start) : now - 31 * 24 * 60 * 60 * 1000;
  const endMs = end ? Date.parse(end) : now + 62 * 24 * 60 * 60 * 1000;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  return { startMs, endMs };
}

function subscriptionResponse(subscription) {
  return { subscription: publicSubscription(subscription) };
}

export function calendarPortalRoutes(store, {
  fetcher = fetchAndParseIcal,
  fetchOptions = {},
  onSubscriptionsChanged = () => {},
} = {}) {
  async function verifyAndPersist(accountId, target, timeZone) {
    const starting = listSubscriptions(store, accountId).find((item) => item.id === target.id);
    if (!starting || starting.url !== target.url) return starting || null;
    const verified = await verifySubscription(starting, {
      timeZone, fetcher, fetchOptions, preserveOnError: true,
    });
    // Fetches are asynchronous. Re-read the account before writing: otherwise
    // a concurrent remove/edit could be undone by this old subscriptions array.
    const current = listSubscriptions(store, accountId);
    const latest = current.find((item) => item.id === target.id);
    if (!latest) return null;
    if (!store.accounts.get(accountId) || store.accounts.get(accountId).isDeleted === true) return null;
    if (latest.url !== target.url
      || JSON.stringify(latest.verification) !== JSON.stringify(starting.verification)
      || accountTimeZone(getSettingsData(store, accountId)) !== timeZone) return latest;
    const saved = { ...verified, label: latest.label, enabled: latest.enabled };
    saveSubscriptions(store, accountId, current.map((item) => item.id === saved.id ? saved : item));
    onSubscriptionsChanged();
    return saved;
  }

  return {
    'GET /api/calendar/subscriptions': ({ req, res }) => {
      const account = owner(store, req);
      if (!account) return sendJson(res, 401, { error: 'not logged in' });
      const data = getSettingsData(store, account._id);
      return {
        timeZone: accountTimeZone(data),
        subscriptions: listSubscriptions(store, account._id).map(publicSubscription),
      };
    },

    'POST /api/calendar/subscriptions': async ({ req, res, body }) => {
      const account = owner(store, req);
      if (!account) return sendJson(res, 401, { error: 'not logged in' });
      const url = bodyUrl(body);
      if (!url) return sendJson(res, 400, { error: 'calendar URL is required' });
      const existing = listSubscriptions(store, account._id);
      if (existing.length >= ICAL_MAX_SUBSCRIPTIONS_PER_ACCOUNT) {
        return sendJson(res, 400, { error: `Limit of ${ICAL_MAX_SUBSCRIPTIONS_PER_ACCOUNT} calendars reached` });
      }
      const target = {
        id: randomUUID(), label: bodyLabel(body), url, enabled: body?.enabled !== false,
        verification: { status: 'unknown', eventCount: 0, lastChecked: null, lastError: null }, events: [],
      };
      // Persist before verification. A bad/unreachable source must remain editable rather
      // than turning a save into a failed request.
      saveSubscriptions(store, account._id, [...existing, target]);
      const verified = await verifyAndPersist(
        account._id,
        target,
        accountTimeZone(getSettingsData(store, account._id)),
      );
      if (!verified) return sendJson(res, 409, { error: 'calendar subscription was removed while checking' });
      return sendJson(res, 201, subscriptionResponse(verified));
    },

    'PUT /api/calendar/subscriptions/:id': async ({ req, res, body }) => {
      const account = owner(store, req);
      if (!account) return sendJson(res, 401, { error: 'not logged in' });
      const id = subscriptionId(req);
      const subscriptions = listSubscriptions(store, account._id);
      const current = subscriptions.find((item) => item.id === id);
      if (!current) return sendJson(res, 404, { error: 'calendar subscription not found' });
      const urlChanged = body && Object.prototype.hasOwnProperty.call(body, 'url');
      const next = {
        ...current,
        ...(body && typeof body.label === 'string' ? { label: body.label.trim().slice(0, 120) || current.label } : {}),
        ...(urlChanged ? {
          url: bodyUrl(body), events: [], checkedTimeZone: null,
          verification: { status: 'unknown', eventCount: 0, lastChecked: null, lastSuccess: null, lastError: null },
        } : {}),
        ...(typeof body?.enabled === 'boolean' ? { enabled: body.enabled } : {}),
      };
      if (urlChanged && !next.url) return sendJson(res, 400, { error: 'calendar URL is required' });
      const staged = subscriptions.map((item) => item.id === id ? next : item);
      saveSubscriptions(store, account._id, staged);
      const updated = urlChanged
        ? await verifyAndPersist(account._id, next, accountTimeZone(getSettingsData(store, account._id)))
        : next;
      if (!updated) return sendJson(res, 409, { error: 'calendar subscription was removed while checking' });
      if (!urlChanged) onSubscriptionsChanged();
      return subscriptionResponse(updated);
    },

    'DELETE /api/calendar/subscriptions/:id': ({ req, res }) => {
      const account = owner(store, req);
      if (!account) return sendJson(res, 401, { error: 'not logged in' });
      const id = subscriptionId(req);
      const subscriptions = listSubscriptions(store, account._id);
      if (!subscriptions.some((item) => item.id === id)) return sendJson(res, 404, { error: 'calendar subscription not found' });
      saveSubscriptions(store, account._id, subscriptions.filter((item) => item.id !== id));
      onSubscriptionsChanged();
      return { removed: id };
    },

    'POST /api/calendar/subscriptions/:id/verify': async ({ req, res }) => {
      const account = owner(store, req);
      if (!account) return sendJson(res, 401, { error: 'not logged in' });
      const id = subscriptionId(req);
      const subscriptions = listSubscriptions(store, account._id);
      const target = subscriptions.find((item) => item.id === id);
      if (!target) return sendJson(res, 404, { error: 'calendar subscription not found' });
      const verified = await verifyAndPersist(
        account._id, target, accountTimeZone(getSettingsData(store, account._id)),
      );
      if (!verified) return sendJson(res, 409, { error: 'calendar subscription was removed while checking' });
      return subscriptionResponse(verified);
    },

    'GET /api/calendar/events': ({ req, res, url }) => {
      const account = owner(store, req);
      if (!account) return sendJson(res, 401, { error: 'not logged in' });
      const window = timeWindow(url);
      if (!window) return sendJson(res, 400, { error: 'start and end must be valid with end after start' });
      let subscriptions = listSubscriptions(store, account._id);
      const requestedId = url.searchParams.get('subscriptionId');
      if (requestedId) subscriptions = subscriptions.filter((item) => item.id === requestedId);
      const events = calendarEventsForWindow(subscriptions, window.startMs, window.endMs);
      return {
        timeZone: accountTimeZone(getSettingsData(store, account._id)),
        start: new Date(window.startMs).toISOString(),
        end: new Date(window.endMs).toISOString(),
        events,
      };
    },
  };
}

export { owner as calendarOwner };
