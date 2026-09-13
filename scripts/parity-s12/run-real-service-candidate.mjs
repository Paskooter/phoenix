#!/usr/bin/env node

// Run the Phoenix report graph over the real HTTP data service. The calendar
// providers below are fixture-only upstreams: the report still performs the
// actual Lasso HTTP request, relay envelope, cache, and event normalization.

import fs from 'node:fs';
import { SkillRequestType } from '../../packages/contracts/src/index.js';
import { createDataService } from '../../packages/data/src/index.js';
import { reportSkill } from '../../packages/skills/src/reportSkill.js';
import { SettingsClient } from '../../packages/skills/src/report/settingsClient.js';
import { clearReportEnvCache } from '../../packages/skills/src/report/env.js';
import { calendarParse, endOfTomorrowISO } from '../../packages/skills/src/report/calendar.js';

const [matrixPath, outputPath] = process.argv.slice(2);
if (!matrixPath || !outputPath) throw new Error('usage: run-real-service-candidate.mjs <matrix.json> <output.json>');
const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
if (matrix.schema !== 's12-calendar-matrix-v1') throw new Error('unsupported matrix schema');

Math.random = () => 0;
const candidateRevision = 'phoenix-w21/s12-calendar-real-http';
const actionIdPaths = Object.freeze([
  'config.jcp.id',
  'config.jcp.children[*].id',
  'config.jcp.children[*].config.play.id',
  'config.jcp.children[*].config.display.id',
]);

function prefsFor(vector) {
  const c = vector.credentials || {};
  return {
    weather: { active: false, useCelsius: false },
    calendar: {
      active: true,
      googlePersonalCreds: !!c.googlePersonal,
      googleWorkCreds: !!c.googleWork,
      outlookPersonalCreds: !!c.outlookPersonal,
      outlookWorkCreds: !!c.outlookWork,
    },
    commute: {
      active: false,
      workTime: vector.workTime || { hour: 9, min: 0 },
      origin: { lat: null, lng: null },
      destination: { lat: null, lng: null },
      mode: null,
      complete: false,
    },
    news: { active: false, activeNewsCategories: {} },
  };
}

function dateOnly(value) { return value && value.dateTime ? value.dateTime.slice(0, 10) : undefined; }

function selectedService(vector, calendar) {
  const c = vector.credentials || {};
  if (calendar === 'personalCalendar') return c.googlePersonal ? 'google' : (c.outlookPersonal ? 'outlook' : null);
  return c.googleWork ? 'google' : (c.outlookWork ? 'outlook' : null);
}

function eventsFor(vector, service, calendar) {
  const slot = calendar === 'personalCalendar' ? 'Personal' : 'Work';
  const specific = vector[`${service}${slot}Events`];
  if (specific !== undefined) return specific;
  return calendar === 'personalCalendar' ? (vector.personalEvents || []) : (vector.workEvents || []);
}

function expectedRequests(vector) {
  return ['personalCalendar', 'workCalendar']
    .map((calendar) => ({ calendar, service: selectedService(vector, calendar) }))
    .filter((request) => request.service);
}

function rawEvents(vector, service, calendar) {
  const events = eventsFor(vector, service, calendar);
  return (events || []).map((event) => {
    if (service === 'google') {
      if (event.fullDay) {
        return {
          summary: event.summary,
          start: { date: dateOnly(event.start) },
          ...(event.end ? { end: { date: dateOnly(event.end) } } : {}),
        };
      }
      return {
        summary: event.summary,
        ...(event.start ? { start: { dateTime: event.start.dateTime } } : {}),
        ...(event.end ? { end: { dateTime: event.end.dateTime } } : {}),
      };
    }
    if (event.fullDay) {
      return {
        subject: event.summary,
        isAllDay: true,
        start: { dateTime: `${dateOnly(event.start)}T00:00:00.0000000`, timeZone: 'UTC' },
        ...(event.end ? { end: { dateTime: `${dateOnly(event.end)}T00:00:00.0000000`, timeZone: 'UTC' } } : {}),
      };
    }
    return {
      subject: event.summary,
      isAllDay: false,
      ...(event.start ? { start: { dateTime: event.start.dateTime, timeZone: 'UTC' } } : {}),
      ...(event.end ? { end: { dateTime: event.end.dateTime, timeZone: 'UTC' } } : {}),
    };
  });
}

function actionPathIsGenerated(path) {
  return actionIdPaths.includes(path.replace(/children\[\d+\]/g, 'children[*]'));
}

function normalizeAction(value, path = '') {
  if (Array.isArray(value)) return value.map((child, index) => normalizeAction(child, `${path}[${index}]`));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    const childPath = path ? `${path}.${key}` : key;
    if (key === 'id' && actionPathIsGenerated(childPath)) continue;
    out[key] = normalizeAction(value[key], childPath);
  }
  return out;
}

function dateTimeSummary(value) {
  if (!value) return null;
  const local = value.getLocalTime();
  return {
    utc: value.utc,
    local: { year: local.year, monthNum: local.monthNum, date: local.date, hour: local.hour, minute: local.minute },
    timeOnly: value.toString({ timeOnly: true }),
    onAt: value.toString({ prefixOnAt: true }),
  };
}

function parsedSummary(parsed) {
  if (!parsed) return null;
  return {
    numEventsToday: parsed.numEventsToday,
    numEventsTomorrow: parsed.numEventsTomorrow,
    workArrivalDT: dateTimeSummary(parsed.workArrivalDT),
    events: parsed.events.map((event) => ({
      summary: event.summary,
      fullDay: event.fullDay,
      isEarly: event.isEarly,
      dateTime: dateTimeSummary(event.dateTime),
    })),
  };
}

function actionSummary(response) {
  const data = response && response.data;
  const trace = data && data.skill && data.skill.session && data.skill.session.trace;
  return {
    responseType: response && response.type,
    final: data && data.final,
    action: normalizeAction(data && data.action),
    analytics: normalizeAction(data && data.analytics),
    transitions: Array.isArray(trace) ? trace.map((entry) => entry.transition) : [],
  };
}

function launch(vector, accountID) {
  return {
    type: SkillRequestType.LISTEN_LAUNCH,
    msgID: 's12-real-http-message',
    ts: 1,
    data: {
      general: { accountID, robotID: 'robot-s12', lang: 'en-US' },
      runtime: {
        dialog: { referent: null },
        perception: { speaker: 'u1' },
        loop: { loopId: `loop-${vector.id}`, users: [{
          id: 'u1', name: 'Alice Smith', phoneticName: 'Jane', firstName: 'Jane', lastName: 'Jetson',
          accountId: accountID, birthdate: '1990-01-01', gender: 'female',
        }] },
        character: { emotion: { name: 'NEUTRAL', valence: 0, confidence: 1 } },
        location: { lat: 42.36, lng: -71.06, iso: vector.locationISO },
      },
      skill: { id: 'report-skill' },
      result: { nlu: { intent: vector.intent || 'requestCalendar', entities: vector.entities || {}, rules: [] }, asr: { text: '', confidence: 1 }, memo: 'Reactive' },
    },
  };
}

function requestContext() {
  return { req: { jibo: { toHeader: () => ({
    'x-jibo-transid': 's12-real-http-transid',
    'x-jibo-robotid': 'robot-s12',
    'x-jibo-logging-config': '{}',
  }) } } };
}

async function probeRoute(base, service, calendar, accountID, endDate) {
  const path = service === 'google' ? 'google_calendar' : 'outlook_calendar';
  const query = new URLSearchParams({ skillId: 'report-skill', accountId: accountID, calendar, endDate });
  const response = await fetch(`${base}/v1/${path}?${query}`);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return {
    service, calendar, status: response.status,
    envelope: body && typeof body === 'object' ? {
      keys: Object.keys(body).sort(),
      lassoDataFromRedis: body.lassoDataFromRedis,
      events: body.relayData && body.relayData.events,
    } : null,
    bodyText: typeof body === 'string' ? body : null,
  };
}

const state = { vector: null, providerCalls: [] };
const provider = (service) => async (input) => {
  const vector = state.vector;
  state.providerCalls.push({ service, calendar: input.calendar, endDate: input.endDate });
  // Let both concurrently selected slots enter the real HTTP handler before
  // the failing fixture rejects. CalendarData uses Promise.all: the source
  // still returns all-or-nothing, while this keeps the initiation count
  // observable for the mixed-provider control.
  if (vector.failureService === service) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    throw new Error(`${service} fixture expired`);
  }
  return {
    events: rawEvents(vector, service, input.calendar),
    ...(service === 'google' ? { calendarTimezone: 'America/New_York' } : {}),
  };
};

const originalPrefs = SettingsClient.getUserPrefs;
delete process.env.NET_lasso;
const dataService = await createDataService({
  googleCalendarProvider: provider('google'),
  outlookCalendarProvider: provider('outlook'),
  newsPolling: { enabled: false },
}).listen(0);
const base = `http://localhost:${dataService.address().port}`;
process.env.NET_data = `localhost:${dataService.address().port}`;
clearReportEnvCache();

const rows = [];
const serviceTrace = [];
try {
  for (const vector of matrix.cases) {
    state.vector = vector;
    state.providerCalls = [];
    Date.now = () => Date.parse(vector.nowISO);
    const accountID = `account-s12-${vector.id}`;
    const prefs = prefsFor(vector);
    SettingsClient.getUserPrefs = async () => prefs;
    const response = await reportSkill(launch(vector, accountID), requestContext());
    const endDate = endOfTomorrowISO(vector.locationISO);
    const reportCalls = [...state.providerCalls];
    const expected = expectedRequests(vector);
    const expectedCalls = expected.length;
    if (reportCalls.length !== expectedCalls) {
      throw new Error(`${vector.id}: report provider calls ${reportCalls.length} != expected credential calls ${expectedCalls}`);
    }
    const unmatched = [...expected];
    for (const request of reportCalls) {
      const match = unmatched.findIndex((expectedRequest) => request.service === expectedRequest.service && request.calendar === expectedRequest.calendar);
      if (match < 0) throw new Error(`${vector.id}: provider request ${JSON.stringify(request)} is not a selected source slot`);
      unmatched.splice(match, 1);
    }
    if (unmatched.length) throw new Error(`${vector.id}: selected source slots were not requested: ${JSON.stringify(unmatched)}`);
    // HTTP arrival order is scheduler-dependent; the source semantic receipt
    // uses CalendarData's personal-then-work construction order.
    const canonicalReportCalls = expected.map((expectedRequest) => reportCalls.find((request) => request.service === expectedRequest.service && request.calendar === expectedRequest.calendar));
    const probes = [];
    // Snapshot report calls first: a failed route is deliberately uncached, so
    // probing it invokes the fixture provider again and must not extend this loop.
    for (const request of reportCalls) probes.push(await probeRoute(base, request.service, request.calendar, accountID, request.endDate));
    for (const probe of probes) {
      const failed = vector.failureService === probe.service;
      if (failed) {
        if (probe.status !== 502 || probe.bodyText === null) throw new Error(`${vector.id}: expected ${probe.service} fixture failure to be HTTP 502 text`);
      } else if (probe.status !== 200 || !probe.envelope || probe.envelope.lassoDataFromRedis !== true || !Array.isArray(probe.envelope.events)) {
        throw new Error(`${vector.id}: expected cached relay envelope for ${probe.service}/${probe.calendar}`);
      }
    }
    const failedReportCalls = reportCalls.filter((request) => request.service === vector.failureService).length;
    const expectedPostProbeCalls = reportCalls.length + failedReportCalls;
    if (state.providerCalls.length !== expectedPostProbeCalls) {
      throw new Error(`${vector.id}: provider calls after probes ${state.providerCalls.length} != ${expectedPostProbeCalls}`);
    }
    serviceTrace.push({ id: vector.id, providerCalls: reportCalls, postProbeProviderCalls: state.providerCalls, probes });
    const events = probes.flatMap((probe) => (probe.envelope && probe.envelope.events) || [])
      .sort((a, b) => a.start.timestamp - b.start.timestamp);
    const parsed = vector.failureService ? null : calendarParse(events, {
      skill: { session: { data: { _personalReport: { nlu: { entities: vector.entities || {} } } } } },
      runtime: { location: { iso: vector.locationISO } },
      local: { userPrefs: prefs },
      result: { nlu: { entities: vector.entities || {} } },
    });
    rows.push({ id: vector.id, semantic: {
      candidateRevision,
      endDate,
      requests: canonicalReportCalls,
      parsed: parsedSummary(parsed),
    }, action: actionSummary(response) });
  }
} finally {
  SettingsClient.getUserPrefs = originalPrefs;
  await dataService.close();
  delete process.env.NET_data;
  clearReportEnvCache();
}

fs.writeFileSync(outputPath, `${JSON.stringify({
  schema: 's12-calendar-receipt-v1',
  runtime: `phoenix-node-${process.versions.node}`,
  actionIdPaths,
  // The actual listener uses an ephemeral port; keep the receipt hash stable
  // while retaining the fact that every row traversed the HTTP service.
  service: { base: 'http://localhost:<ephemeral>', rows: serviceTrace },
  rows,
}, null, 2)}\n`);
