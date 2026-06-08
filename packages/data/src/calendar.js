// Calendar — Phoenix port of lasso google/outlook calendar handlers (lean).
// GET /v1/{google,outlook}_calendar : CalendarRequest -> { events: CalendarEvent[] }.
// The real handler exchanges stored OAuth tokens with Google/Outlook; that token exchange is out
// of scope here, so the provider is pluggable (default 501). This module owns the request
// validation + the CalendarEvent normalization (interfaces/lasso.ts CalendarEvent shape).

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

/**
 * Build a GET handler for a calendar route.
 * @param {{ provider?: (req:object, store?:object)=>Promise<any[]>, store?: object }} opts
 *   provider returns raw events; the handler normalizes them.
 */
export function createCalendarHandler({ provider = defaultProvider, store } = {}) {
  return async ({ url, res }) => {
    let req;
    try { req = validateCalendar(url.searchParams); }
    catch (e) { res.writeHead(400, { 'content-type': 'text/plain' }); res.end(e.message); return undefined; }
    try {
      const raw = await provider(req, store);
      return { events: (raw || []).map(normalizeEvent) };
    } catch (e) {
      res.writeHead(e.status || 502, { 'content-type': 'text/plain' }); res.end(e.message); return undefined;
    }
  };
}
