#!/usr/bin/env node

import fs from 'node:fs';
import { SkillRequestType } from '../../packages/contracts/src/index.js';
import { reportSkill } from '../../packages/skills/src/reportSkill.js';
import { SettingsClient } from '../../packages/skills/src/report/settingsClient.js';
import { LassoClient } from '../../packages/skills/src/report/lassoClient.js';
import { calendarParse, endOfTomorrowISO } from '../../packages/skills/src/report/calendar.js';

const [matrixPath, outputPath] = process.argv.slice(2);
if (!matrixPath || !outputPath) throw new Error('usage: run-candidate.mjs <matrix.json> <output.json>');
const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
if (matrix.schema !== 's12-calendar-matrix-v1') throw new Error('unsupported matrix schema');

Math.random = () => 0;
const candidateRevision = 'phoenix-w21/s12-calendar';

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

function decorateEvents(events) {
  return (events || []).map((event) => {
    const copy = structuredClone(event);
    if (copy.fullDay === undefined) copy.fullDay = false;
    if (copy.start && copy.start.dateTime && copy.start.timestamp === undefined) {
      copy.start.timestamp = Date.parse(copy.start.dateTime);
    }
    if (copy.end && copy.end.dateTime && copy.end.timestamp === undefined) {
      copy.end.timestamp = Date.parse(copy.end.dateTime);
    }
    return copy;
  });
}

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

function mergedEvents(vector) {
  const events = [];
  for (const calendar of ['personalCalendar', 'workCalendar']) {
    const service = selectedService(vector, calendar);
    if (service) events.push(...eventsFor(vector, service, calendar));
  }
  return decorateEvents(events)
    .sort((a, b) => a.start.timestamp - b.start.timestamp);
}

function dateTimeSummary(value) {
  if (!value) return null;
  const local = value.getLocalTime();
  return {
    utc: value.utc,
    local: {
      year: local.year,
      monthNum: local.monthNum,
      date: local.date,
      hour: local.hour,
      minute: local.minute,
    },
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

// Keep the exact source/candidate ID-path inventory. Component asset/view IDs
// are stable consumer fields; only these graph-generated IDs are omitted.
const GENERATED_ACTION_ID_PATHS = Object.freeze([
  'config.jcp.id',
  'config.jcp.children[*].id',
  'config.jcp.children[*].config.play.id',
  'config.jcp.children[*].config.display.id',
]);

function normalizeAction(value, path = '') {
  if (Array.isArray(value)) return value.map((child, index) => normalizeAction(child, `${path}[${index}]`));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    const childPath = path ? `${path}.${key}` : key;
    const wildcardPath = childPath.replace(/children\[\d+\]/g, 'children[*]');
    if (key === 'id' && GENERATED_ACTION_ID_PATHS.includes(wildcardPath)) continue;
    out[key] = normalizeAction(value[key], childPath);
  }
  return out;
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

function launch(vector) {
  return {
    type: SkillRequestType.LISTEN_LAUNCH,
    msgID: 's12-matrix-message',
    ts: 1,
    data: {
      general: { accountID: 'account-s12', robotID: 'robot-s12', lang: 'en-US' },
      runtime: {
        dialog: { referent: null },
        perception: { speaker: 'u1' },
        loop: { loopId: 'loop-s12', users: [{
          id: 'u1', name: 'Alice Smith', phoneticName: 'Jane', firstName: 'Jane', lastName: 'Jetson',
          accountId: 'account-s12', birthdate: '1990-01-01', gender: 'female',
        }] },
        character: { emotion: { name: 'NEUTRAL', valence: 0, confidence: 1 } },
        location: { lat: 42.36, lng: -71.06, iso: vector.locationISO },
      },
      skill: { id: 'report-skill' },
      result: {
        nlu: { intent: vector.intent || 'requestCalendar', entities: vector.entities || {}, rules: [] },
        asr: { text: '', confidence: 1 },
        memo: 'Reactive',
      },
    },
  };
}

function requestContext() {
  return { req: { jibo: { toHeader: () => ({
    'x-jibo-transid': 's12-transid',
    'x-jibo-robotid': 'robot-s12',
    'x-jibo-logging-config': '{}',
  }) } } };
}

async function runCase(vector) {
  const now = Date.parse(vector.nowISO);
  Date.now = () => now;
  const prefs = prefsFor(vector);
  const requests = [];

  SettingsClient.getUserPrefs = async () => prefs;
  LassoClient.fetchCalendarEvents = async (data, service, calendar, endDate) => {
    requests.push({ service, calendar, endDate });
    if (vector.failureService === service) throw new Error(`${service} credentials expired`);
    return { events: decorateEvents(eventsFor(vector, service, calendar)) };
  };

  const response = await reportSkill(launch(vector), requestContext());
  const parsedData = {
    skill: { session: { data: { _personalReport: { nlu: { entities: vector.entities || {} } } } } },
    runtime: { location: { iso: vector.locationISO } },
    local: { userPrefs: prefs },
    result: { nlu: { entities: vector.entities || {} } },
  };
  const parsed = vector.failureService ? null : calendarParse(mergedEvents(vector), parsedData);
  return {
    id: vector.id,
    semantic: {
      candidateRevision,
      endDate: endOfTomorrowISO(vector.locationISO),
      requests,
      parsed: parsedSummary(parsed),
    },
    action: actionSummary(response),
  };
}

const rows = [];
for (const vector of matrix.cases) rows.push(await runCase(vector));
fs.writeFileSync(outputPath, `${JSON.stringify({
  schema: 's12-calendar-receipt-v1',
  runtime: `phoenix-node-${process.versions.node}`,
  actionIdPaths: GENERATED_ACTION_ID_PATHS,
  rows,
}, null, 2)}\n`);
