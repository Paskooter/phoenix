import { randomUUID } from 'node:crypto';
import { sendJson } from '@phoenix/common';
import { getSession } from './sessions.js';
import { getSettingsData } from './settingsData.js';
import {
  accountTimeZone,
  calendarEventsForWindow,
  fetchAndParseIcal,
  listSubscriptions,
  publicSubscription,
  saveSubscriptions,
  verifySubscription,
} from './icalSubscriptions.js';

function owner(store, req) {
  const session = getSession(store, req);
  // Calendar contents are private account data. Deliberately reject admin sessions:
  // an admin may manage robots, but must not read another account's calendar.
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
} = {}) {
  async function verifyAndPersist(accountId, subscriptions, target, timeZone) {
    const verified = await verifySubscription(target, { timeZone, fetcher, fetchOptions });
    const next = subscriptions.map((item) => item.id === verified.id ? verified : item);
    saveSubscriptions(store, accountId, next);
    return verified;
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
      const target = {
        id: randomUUID(), label: bodyLabel(body), url, enabled: body?.enabled !== false,
        verification: { status: 'unknown', eventCount: 0, lastChecked: null, lastError: null }, events: [],
      };
      // Persist before verification. A bad/unreachable source must remain editable rather
      // than turning a save into a failed request.
      saveSubscriptions(store, account._id, [...existing, target]);
      const verified = await verifyAndPersist(
        account._id,
        [...existing, target],
        target,
        accountTimeZone(getSettingsData(store, account._id)),
      );
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
        ...(urlChanged ? { url: bodyUrl(body), events: [], verification: { status: 'unknown', eventCount: 0, lastChecked: null, lastError: null } } : {}),
        ...(typeof body?.enabled === 'boolean' ? { enabled: body.enabled } : {}),
      };
      if (urlChanged && !next.url) return sendJson(res, 400, { error: 'calendar URL is required' });
      const staged = subscriptions.map((item) => item.id === id ? next : item);
      saveSubscriptions(store, account._id, staged);
      const updated = urlChanged
        ? await verifyAndPersist(account._id, staged, next, accountTimeZone(getSettingsData(store, account._id)))
        : next;
      if (!urlChanged) saveSubscriptions(store, account._id, staged);
      return subscriptionResponse(updated);
    },

    'DELETE /api/calendar/subscriptions/:id': ({ req, res }) => {
      const account = owner(store, req);
      if (!account) return sendJson(res, 401, { error: 'not logged in' });
      const id = subscriptionId(req);
      const subscriptions = listSubscriptions(store, account._id);
      if (!subscriptions.some((item) => item.id === id)) return sendJson(res, 404, { error: 'calendar subscription not found' });
      saveSubscriptions(store, account._id, subscriptions.filter((item) => item.id !== id));
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
        account._id, subscriptions, target, accountTimeZone(getSettingsData(store, account._id)),
      );
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
