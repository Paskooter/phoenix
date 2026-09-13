#!/usr/bin/env node

import fs from 'node:fs';
import { endOfTomorrowISO } from '../../packages/skills/src/report/calendar.js';

const [matrixPath, outputPath] = process.argv.slice(2);
if (!matrixPath || !outputPath) throw new Error('usage: run-end-date-candidate.mjs <matrix.json> <output.json>');
const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
if (matrix.schema !== 's12-calendar-end-date-matrix-v1') throw new Error('unsupported matrix schema');
const rows = matrix.cases.map((vector) => ({
  id: vector.id,
  iso: vector.iso,
  endDate: endOfTomorrowISO(vector.iso),
}));
fs.writeFileSync(outputPath, `${JSON.stringify({
  schema: 's12-calendar-end-date-receipt-v1',
  candidateRevision: 'phoenix-w21/s12-calendar',
  runtime: `phoenix-node-${process.versions.node}`,
  rows,
}, null, 2)}\n`);
