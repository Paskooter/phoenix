#!/usr/bin/env node

// Execute the pinned compiled Pegasus report-skill under the archived runtime.
// The fixture provider is deliberately in-process: this runner compares the
// report's source data/parse/MIM/action behavior over identical calendar rows.

const fs = require('fs');

const [referenceRoot, matrixPath, outputPath] = process.argv.slice(2);
if (!referenceRoot || !matrixPath || !outputPath) {
  throw new Error('usage: run-source.cjs <reference-root> <matrix.json> <output.json>');
}

const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
if (matrix.schema !== 's12-calendar-matrix-v1') throw new Error('unsupported matrix schema');

// Keep weighted prompt choices deterministic. Dynamic graph/action IDs are
// stripped below, while prompt IDs and ESML remain compared exactly.
Math.random = () => 0;

const main = require(`${referenceRoot}/packages/report-skill/lib/index.js`);
const baseskill = require(`${referenceRoot}/packages/baseskill/lib/baseskill.js`);
const testUtils = require(`${referenceRoot}/packages/test-utils/lib/test-utils.js`);
const { logging } = require(`${referenceRoot}/node_modules/@jibo/utils`);
const { PersonalReport, SettingsClient, LassoClient, subskills } = main;
const { SkillConversation } = testUtils.skill_test;

const sourceRevision = 'jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c';

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
    const copy = JSON.parse(JSON.stringify(event));
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
    // Keep the receipt at the calendar consumer boundary. The source
    // DateTime exposes additional month-name/seconds fields that Phoenix's
    // lean DateTime does not expose, while calendar prompts use these fields.
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

// Action ID inventory from all 21 source/candidate rows. These four paths are
// graph-generated IDs; component asset/view IDs are stable consumer fields and
// remain compared. No nodeID path was observed.
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

function sourceEndDate(iso) {
  const moment = require(`${referenceRoot}/node_modules/moment-timezone`);
  return moment.parseZone(iso).add(1, 'day').endOf('day').format();
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
    return {
      events: decorateEvents(eventsFor(vector, service, calendar)),
    };
  };

  const skill = new PersonalReport();
  const conversation = new SkillConversation(new baseskill.SkillService(skill));
  await conversation.init();
  conversation.atISOTime(vector.locationISO);
  await conversation.launch(vector.intent || 'requestCalendar', {}, {
    nlu: { entities: vector.entities || {} },
  });

  const parsedData = {
    skill: { session: { data: { _personalReport: { nlu: { entities: vector.entities || {} } } } } },
    runtime: { location: { iso: vector.locationISO } },
    local: { userPrefs: prefs },
    result: { nlu: { entities: vector.entities || {} } },
  };
  const parsed = vector.failureService ? null : subskills.calendar.calendarParse(mergedEvents(vector), parsedData);
  const out = {
    id: vector.id,
    semantic: {
      sourceRevision,
      endDate: sourceEndDate(vector.locationISO),
      requests,
      parsed: parsedSummary(parsed),
    },
    action: actionSummary(conversation.response),
  };
  await conversation.close();
  return out;
}

(async () => {
  const rows = [];
  for (const vector of matrix.cases) rows.push(await runCase(vector));
fs.writeFileSync(outputPath, `${JSON.stringify({
  schema: 's12-calendar-receipt-v1',
  runtime: 'pegasus-node8-compatible',
  actionIdPaths: GENERATED_ACTION_ID_PATHS,
  rows,
}, null, 2)}\n`);
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
