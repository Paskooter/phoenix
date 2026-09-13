import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const [sourcePath, candidatePath] = process.argv.slice(2).map(value => path.resolve(value));
if (!sourcePath || !candidatePath) throw new Error('usage: falsify-order.mjs SOURCE.json CANDIDATE.json');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 's07-order-falsify-'));
const sourceCopy = path.join(temp, 'source.json');
const candidateCopy = path.join(temp, 'candidate.json');
const receipt = path.join(temp, 'receipt.json');
fs.copyFileSync(sourcePath, sourceCopy);
fs.copyFileSync(candidatePath, candidateCopy);
const analyzer = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'analyze-order.mjs');

function run(label, mutate) {
  const candidate = JSON.parse(fs.readFileSync(candidateCopy, 'utf8'));
  mutate(candidate);
  fs.writeFileSync(candidateCopy, `${JSON.stringify(candidate)}\n`);
  const result = spawnSync(process.execPath, [analyzer, sourceCopy, candidateCopy, receipt], { encoding: 'utf8' });
  if (result.status === 0) throw new Error(`${label}: analyzer unexpectedly passed`);
  console.log(JSON.stringify({ label, rejected: true, status: result.status }));
}

run('removed-overlap-category-from-one-of-8186-lists', candidate => {
  const lists = candidate.perValueMatchLists.RI_JBO_HasOpinionAbout_SS;
  lists.Ginger = lists.Ginger.filter(category => category !== 'Vegetable');
});

const baseline = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
fs.writeFileSync(candidateCopy, `${JSON.stringify(baseline)}\n`);
run('multi-entity-order-corruption', candidate => {
  const row = candidate.multiProbes.find(item => item.id === 'likes-australia-then-coke');
  row.possibleCategories = row.possibleCategories.slice().reverse();
});

console.log(JSON.stringify({ result: 'pass', cases: 2 }));
