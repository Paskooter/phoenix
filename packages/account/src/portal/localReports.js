// Portal REST: the loop owner manages the personal report of an adult in the
// loop who has no login (Loop → Manage → Personal report).
//
//   GET  /api/loop/members/report?loopId&id        -> their report switches and calendars
//   PUT  /api/loop/members/report                  -> {loopId, id, settings}
//   POST /api/loop/members/report/calendars        -> {loopId, id, url, label?}
//   POST /api/loop/members/report/calendars/remove -> {loopId, id, subscriptionId}
//
// Session-cookie auth, loop owner only, and only for a live accountless adult
// (localMemberReports.js). A linked adult edits their own Account → Personal
// report; nobody else can read or change it here. Children keep the report
// defaults, as before. Calendar feeds reuse the account iCal path: the same
// URL checks and private-address refusal, the same cap and the same daily
// refresh, with the feed address kept on the server.

import { randomUUID } from 'node:crypto';
import { sendJson } from '@phoenix/common';
import {
  accountTimeZone,
  fetchAndParseIcal,
  ICAL_MAX_SUBSCRIPTIONS_PER_ACCOUNT,
  subscriptionsFromData,
  setSubscriptionsInData,
  verifySubscription,
} from '../icalSubscriptions.js';
import {
  applyLocalReportEdit,
  isLocalAdultMember,
  LocalReportError,
  localReportView,
  readLocalReportData,
  resolveLocalReportSubject,
  writeLocalReportData,
} from '../localMemberReports.js';
import { requireUser } from './session.js';

const idsEqual = (a, b) => a != null && b != null && String(a) === String(b);
const LIVE = (member) => member && !['removed', 'declined'].includes(String(member.status || '').toLowerCase());

function refuse(res, status, code, error) {
  return sendJson(res, status, { error, code });
}

/**
 * Authorize and resolve. Order matters: a caller who does not own the loop
 * learns nothing about its members.
 */
function ownedLocalAdult(store, req, res, { loopId, id }, { write = false } = {}) {
  const account = requireUser(store, req, res);
  if (!account) return null;
  if (typeof loopId !== 'string' || !loopId || typeof id !== 'string' || !id) {
    sendJson(res, 400, { error: 'loopId and id are required' });
    return null;
  }
  const loop = store.loops.get(loopId);
  if (!loop || loop.isDeleted === true) {
    refuse(res, 404, 'LOOP_NOT_FOUND', 'Loop does not exist');
    return null;
  }
  if (!idsEqual(loop.owner, account._id)) {
    refuse(res, 403, 'CAN_BE_ACCESSED_BY_OWNER', 'Only owner can manipulate this loop');
    return null;
  }
  if (write && loop.isSuspended) {
    refuse(res, 403, 'LOOP_SUSPENDED', 'Loop is suspended and cannot be modified');
    return null;
  }
  const member = (loop.members || []).find((item) => idsEqual(item._id, id));
  if (!LIVE(member)) {
    refuse(res, 404, 'MEMBER_NOT_FOUND', 'Member not found');
    return null;
  }
  if (!isLocalAdultMember(loop, member)) {
    refuse(res, 403, 'MEMBER_NOT_LOCAL_ADULT', member.memberProperties?.isChild === true
      ? 'Children get Jibo’s standard report'
      : 'This person manages their report on their own account');
    return null;
  }
  return { account, ...resolveLocalReportSubject(store, loop._id, member._id) };
}

function view(store, subject) {
  const data = readLocalReportData(store, subject);
  return { loopId: subject.loop._id, id: subject.member._id, settings: localReportView(data) };
}

function bodyLabel(body) {
  return typeof body?.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 120) : 'Calendar';
}

export function localReportPortalRoutes(store, {
  fetcher = fetchAndParseIcal,
  fetchOptions = {},
  onSubscriptionsChanged = () => {},
} = {}) {
  // Same race rule as the Account calendar routes: verification is async, so
  // re-read the record before writing, and drop the result if the feed was
  // removed or the person stopped being a local adult meanwhile.
  async function verifyAndPersist(loopId, memberId, target) {
    const subject = resolveLocalReportSubject(store, loopId, memberId);
    if (!subject) return null;
    const starting = subscriptionsFromData(readLocalReportData(store, subject)).find((item) => item.id === target.id);
    if (!starting || starting.url !== target.url) return starting || null;
    const timeZone = accountTimeZone(readLocalReportData(store, subject));
    const verified = await verifySubscription(starting, { timeZone, fetcher, fetchOptions, preserveOnError: true });
    const current = resolveLocalReportSubject(store, loopId, memberId);
    if (!current) return null;
    const data = readLocalReportData(store, current);
    const list = subscriptionsFromData(data);
    const latest = list.find((item) => item.id === target.id);
    if (!latest) return null;
    if (latest.url !== target.url || JSON.stringify(latest.verification) !== JSON.stringify(starting.verification)
      || accountTimeZone(data) !== timeZone) return latest;
    const saved = { ...verified, label: latest.label, enabled: latest.enabled };
    writeLocalReportData(store, current, setSubscriptionsInData(data, list.map((item) => item.id === saved.id ? saved : item)));
    onSubscriptionsChanged();
    return saved;
  }

  return {
    'GET /api/loop/members/report': ({ req, res, url }) => {
      const subject = ownedLocalAdult(store, req, res, {
        loopId: url.searchParams.get('loopId'), id: url.searchParams.get('id'),
      });
      if (!subject) return;
      return view(store, subject);
    },

    'PUT /api/loop/members/report': ({ req, res, body }) => {
      const input = body && typeof body === 'object' ? body : {};
      const subject = ownedLocalAdult(store, req, res, input, { write: true });
      if (!subject) return;
      const before = readLocalReportData(store, subject);
      let data;
      try {
        data = applyLocalReportEdit(input.settings, before);
      } catch (error) {
        if (error instanceof LocalReportError) return sendJson(res, error.statusCode, { error: error.message, code: error.code });
        throw error;
      }
      writeLocalReportData(store, subject, data);
      if (data.calendarTimeZone?.value !== before.calendarTimeZone?.value) onSubscriptionsChanged();
      return view(store, subject);
    },

    'POST /api/loop/members/report/calendars': async ({ req, res, body }) => {
      const input = body && typeof body === 'object' ? body : {};
      const subject = ownedLocalAdult(store, req, res, input, { write: true });
      if (!subject) return;
      const url = typeof input.url === 'string' ? input.url.trim() : '';
      if (!url) return sendJson(res, 400, { error: 'calendar URL is required' });
      const data = readLocalReportData(store, subject);
      const existing = subscriptionsFromData(data);
      if (existing.length >= ICAL_MAX_SUBSCRIPTIONS_PER_ACCOUNT) {
        return sendJson(res, 400, { error: `Limit of ${ICAL_MAX_SUBSCRIPTIONS_PER_ACCOUNT} calendars reached` });
      }
      const target = {
        id: randomUUID(), label: bodyLabel(input), url, enabled: true,
        verification: { status: 'unknown', eventCount: 0, lastChecked: null, lastError: null }, events: [],
      };
      // Saved before checking, like the Account page: an unreachable feed
      // stays listed with its error rather than failing the save.
      writeLocalReportData(store, subject, setSubscriptionsInData(data, [...existing, target]));
      const verified = await verifyAndPersist(subject.loop._id, subject.member._id, target);
      if (!verified) return sendJson(res, 409, { error: 'calendar subscription was removed while checking' });
      const current = resolveLocalReportSubject(store, subject.loop._id, subject.member._id);
      return sendJson(res, 201, current ? view(store, current) : { settings: null });
    },

    'POST /api/loop/members/report/calendars/remove': ({ req, res, body }) => {
      const input = body && typeof body === 'object' ? body : {};
      const subject = ownedLocalAdult(store, req, res, input, { write: true });
      if (!subject) return;
      const data = readLocalReportData(store, subject);
      const existing = subscriptionsFromData(data);
      if (!existing.some((item) => item.id === input.subscriptionId)) {
        return sendJson(res, 404, { error: 'calendar subscription not found' });
      }
      writeLocalReportData(store, subject, setSubscriptionsInData(data, existing.filter((item) => item.id !== input.subscriptionId)));
      onSubscriptionsChanged();
      return view(store, subject);
    },
  };
}
