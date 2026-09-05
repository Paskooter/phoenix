import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { compareProduction } from '../../packages/harness/src/productionCompare.js';
const args = process.argv.slice(2);
const arg = name => { const index = args.indexOf('--' + name); if (index < 0 || !args[index + 1]) throw new Error('Missing --' + name); return args[index + 1]; };
const read = file => JSON.parse(file.endsWith('.gz') ? gunzipSync(readFileSync(file)) : readFileSync(file, 'utf8'));
try {
  const result = compareProduction(read(arg('reference')), read(arg('candidate')), read(arg('suite')));
  writeFileSync(arg('out'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ pass: result.pass, cases: result.cases, groups: result.groups, differences: result.differences.length, invariants: result.invariants.length, coverageGaps: result.coverageGaps.length }));
  process.exitCode = result.pass ? 0 : 1;
} catch (error) { console.error(error.stack); process.exitCode = 2; }
