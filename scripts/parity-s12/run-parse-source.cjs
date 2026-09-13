#!/usr/bin/env node

const fs = require('fs');

const [referenceRoot, matrixPath, outputPath] = process.argv.slice(2);
if (!referenceRoot || !matrixPath || !outputPath) {
  throw new Error('usage: run-parse-source.cjs <reference-root> <parse-matrix.json> <output.json>');
}
const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
if (matrix.schema !== 's12-calendar-parse-matrix-v1') throw new Error('unsupported parse matrix schema');

const main = require(`${referenceRoot}/packages/report-skill/lib/index.js`);
const { subskills } = main;
const sourceRevision = 'jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c';

function dataFor(vector) {
  const entities = vector.entities || {};
  return {
    skill: { session: { data: { _personalReport: { nlu: { entities } } } } },
    runtime: { location: { iso: vector.locationISO } },
    local: { userPrefs: { commute: { workTime: vector.workTime || { hour: 9, min: 0 } } } },
    result: { nlu: { entities } },
  };
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

const rows = [];
for (const vector of matrix.cases) {
  Date.now = () => Date.parse(vector.nowISO);
  const parsed = subskills.calendar.calendarParse(vector.rawEvents, dataFor(vector));
  rows.push({ id: vector.id, sourceRevision, parsed: parsedSummary(parsed) });
}
fs.writeFileSync(outputPath, `${JSON.stringify({
  schema: 's12-calendar-parse-receipt-v1',
  runtime: 'pegasus-node8-compatible',
  rows,
}, null, 2)}\n`);
