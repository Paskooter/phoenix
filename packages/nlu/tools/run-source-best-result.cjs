'use strict';
const fs = require('fs');
const inputPath = process.argv[2];
if (!inputPath) throw new Error('usage: run-source-best-result.cjs INPUT.json');
const sourceModule = process.env.N08_SOURCE_MODULE || '/reference/packages/parser/lib/robustparser/RobustParserClient.js';
const source = require(sourceModule);
const matrix = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const cases = (matrix.cases || []).map(item => {
  const winner = source.getBestResult(item.responses);
  return { id: item.id, winner };
});
process.stdout.write(JSON.stringify({
  node: process.version,
  sourceModule,
  cases,
}) + '\n');
