#!/usr/bin/env node

const fs = require('fs');

const [referenceRoot, matrixPath, outputPath] = process.argv.slice(2);
if (!referenceRoot || !matrixPath || !outputPath) {
  throw new Error('usage: run-end-date-source.cjs <reference-root> <matrix.json> <output.json>');
}
const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
if (matrix.schema !== 's12-calendar-end-date-matrix-v1') throw new Error('unsupported matrix schema');
const moment = require(`${referenceRoot}/node_modules/moment-timezone`);
const rows = matrix.cases.map((vector) => ({
  id: vector.id,
  iso: vector.iso,
  endDate: moment.parseZone(vector.iso).add(1, 'day').endOf('day').format(),
}));
fs.writeFileSync(outputPath, `${JSON.stringify({
  schema: 's12-calendar-end-date-receipt-v1',
  sourceRevision: 'jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c',
  runtime: 'pegasus-node8-compatible',
  rows,
}, null, 2)}\n`);
