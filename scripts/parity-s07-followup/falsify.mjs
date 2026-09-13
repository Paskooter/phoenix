#!/usr/bin/env node

// Comparator controls: each mutation must be rejected, including paired row
// omission and omission of a required action/session/effect field.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const sourceDir = path.resolve(process.argv[2] || '.');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 's07-followup-falsify-'));
for (const name of ['matrix-spec.json', 'source-runtime.json', 'candidate-runtime.json', 'inventory.json']) fs.copyFileSync(path.join(sourceDir, name), path.join(temp, name));
const compare = path.join(sourceDir, 'compare.mjs');
const original = () => JSON.parse(fs.readFileSync(path.join(sourceDir, 'candidate-runtime.json'), 'utf8'));
const source = () => JSON.parse(fs.readFileSync(path.join(sourceDir, 'source-runtime.json'), 'utf8'));
const run = (label, mutate) => {
  fs.writeFileSync(path.join(temp, 'candidate-runtime.json'), JSON.stringify(original()));
  fs.writeFileSync(path.join(temp, 'source-runtime.json'), JSON.stringify(source()));
  const candidate = JSON.parse(fs.readFileSync(path.join(temp, 'candidate-runtime.json'), 'utf8'));
  mutate(candidate);
  fs.writeFileSync(path.join(temp, 'candidate-runtime.json'), `${JSON.stringify(candidate)}\n`);
  const result = spawnSync(process.execPath, [compare, temp], { encoding: 'utf8' });
  if (result.status === 0) throw new Error(`${label}: comparator unexpectedly passed`);
  console.log(JSON.stringify({ label, rejected: true, status: result.status }));
};
const runPaired = (label, mutate) => {
  const candidate = original();
  const paired = source();
  mutate(candidate, paired);
  fs.writeFileSync(path.join(temp, 'candidate-runtime.json'), `${JSON.stringify(candidate)}\n`);
  fs.writeFileSync(path.join(temp, 'source-runtime.json'), `${JSON.stringify(paired)}\n`);
  const result = spawnSync(process.execPath, [compare, temp], { encoding: 'utf8' });
  if (result.status === 0) throw new Error(`${label}: comparator unexpectedly passed`);
  console.log(JSON.stringify({ label, rejected: true, status: result.status }));
};

run('paired-row-omission', (candidate) => { candidate.rows = candidate.rows.slice(0, -1); const paired = source(); paired.rows = paired.rows.slice(0, -1); fs.writeFileSync(path.join(temp, 'source-runtime.json'), `${JSON.stringify(paired)}\n`); });
run('launch-action-omission', (candidate) => { candidate.rows[0].launch.action = null; });
run('update-trace-omission', (candidate) => { delete candidate.rows[1].update.trace; });
run('launch-effects-omission', (candidate) => { delete candidate.rows[2].launch.effects; });
run('esml-mutation', (candidate) => { candidate.rows[3].launch.mim[0].esml += ' forged'; });
runPaired('paired-mim-transition-corruption', (candidate, paired) => {
  for (const receipt of [candidate, paired]) {
    receipt.rows[0].launch.mim[0].mim = 'FORGED_MIM';
    receipt.rows[0].launch.transitions[1] = 'FORGED_TRANSITION';
  }
});
console.log(JSON.stringify({ result: 'pass', cases: 6 }));
