#!/usr/bin/env node

import fs from 'node:fs';
import { calendarParse } from '../../packages/skills/src/report/calendar.js';

const [matrixPath, outputPath] = process.argv.slice(2);
if (!matrixPath || !outputPath) throw new Error('usage: run-parse-candidate.mjs <parse-matrix.json> <output.json>');
const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
if (matrix.schema !== 's12-calendar-parse-matrix-v1') throw new Error('unsupported parse matrix schema');
const candidateRevision = 'phoenix-w21/s12-calendar';

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
  const parsed = calendarParse(vector.rawEvents, dataFor(vector));
  rows.push({ id: vector.id, candidateRevision, parsed: parsedSummary(parsed) });
}
fs.writeFileSync(outputPath, `${JSON.stringify({
  schema: 's12-calendar-parse-receipt-v1',
  runtime: `phoenix-node-${process.versions.node}`,
  rows,
}, null, 2)}\n`);
