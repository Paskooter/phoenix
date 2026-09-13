import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = path.resolve(process.argv[2] || path.dirname(new URL(import.meta.url).pathname));
const compare = path.join(dir, 'compare.mjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 's07-falsify-'));
for (const name of ['matrix-spec.json', 'source-runtime.json', 'candidate-runtime.json']) {
  fs.copyFileSync(path.join(dir, name), path.join(temp, name));
}

function run(label, mutate) {
  const candidatePath = path.join(temp, 'candidate-runtime.json');
  const candidate = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  mutate(candidate);
  fs.writeFileSync(candidatePath, JSON.stringify(candidate) + '\n');
  const result = spawnSync(process.execPath, [compare, temp], { encoding: 'utf8' });
  if (result.status === 0) throw new Error(`${label}: comparator unexpectedly passed`);
  console.log(JSON.stringify({ label, rejected: true, status: result.status }));
}

run('prompt-id mutation', candidate => {
  const row = candidate.rows.find(item => item.id === 'ra-flipcoin-heads');
  row.value.prompts[0].prompt_id = 'FORGED_PROMPT_ID';
});

const originalCandidate = JSON.parse(fs.readFileSync(path.join(dir, 'candidate-runtime.json'), 'utf8'));
const originalSource = JSON.parse(fs.readFileSync(path.join(dir, 'source-runtime.json'), 'utf8'));
fs.writeFileSync(path.join(temp, 'candidate-runtime.json'), JSON.stringify(originalCandidate) + '\n');
run('paired row omission', candidate => {
  const id = 'fallback-weighted-seed-one';
  candidate.rows = candidate.rows.filter(row => row.id !== id);
  const sourcePath = path.join(temp, 'source-runtime.json');
  const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  source.rows = source.rows.filter(row => row.id !== id);
  fs.writeFileSync(sourcePath, JSON.stringify(source) + '\n');
});

fs.writeFileSync(path.join(temp, 'source-runtime.json'), JSON.stringify(originalSource) + '\n');
fs.writeFileSync(path.join(temp, 'candidate-runtime.json'), JSON.stringify(originalCandidate) + '\n');
run('semantic value mutation', candidate => {
  const row = candidate.rows.find(item => item.id === 'ra-flipcoin-heads');
  row.value.prompts[0].esml = `${row.value.prompts[0].esml} forged`;
});

console.log(JSON.stringify({ result: 'pass', cases: 3 }));
