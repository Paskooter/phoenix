#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../..', import.meta.url));
const sourcePath = join(root, 'packages/skills/src/gqaAnswerSkill.js');
const testPath = join(root, 'packages/skills/test/q01GqaCompositeReplay.test.js');
const testPattern = 'Q-01 composite both-useful first-group replay';

const sourcePlan = `const SOURCE_PROVIDER_PLAN = Object.freeze([
  Object.freeze([
    ['Bing', 'Bing'],
    ['Wikipedia', 'Wikipedia'],
  ]),
  Object.freeze([
    ['Wolfram Alpha', 'Wolfram Alpha'],
  ]),
]);`;
const reversedSourcePlan = `const SOURCE_PROVIDER_PLAN = Object.freeze([
  Object.freeze([
    ['Wikipedia', 'Wikipedia'],
    ['Bing', 'Bing'],
  ]),
  Object.freeze([
    ['Wolfram Alpha', 'Wolfram Alpha'],
  ]),
]);`;

function runFocusedCase() {
  return spawnSync(process.execPath, [
    '--test',
    '--test-name-pattern',
    testPattern,
    testPath,
  ], {
    cwd: root,
    encoding: 'utf8',
  });
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

const original = readFileSync(sourcePath);
const originalHash = sha256(original);
if (original.toString().split(sourcePlan).length - 1 !== 1) {
  throw new Error('expected exactly one SOURCE_PROVIDER_PLAN source block');
}

let reversedResult;
let restoredByteIdentical = false;
try {
  writeFileSync(sourcePath, original.toString().replace(sourcePlan, reversedSourcePlan));
  reversedResult = runFocusedCase();
} finally {
  writeFileSync(sourcePath, original);
  restoredByteIdentical = sha256(readFileSync(sourcePath)) === originalHash;
}

const reversedOutput = `${reversedResult?.stdout || ''}\n${reversedResult?.stderr || ''}`;
const falsified = Boolean(
  reversedResult
  && reversedResult.status !== 0
  && /not ok .*Q-01 composite both-useful first-group replay/.test(reversedOutput)
  && reversedOutput.includes('actual - expected'),
);
if (!falsified) {
  throw new Error(`reversed SOURCE_PROVIDER_PLAN did not falsify the named case (status ${reversedResult?.status})`);
}
if (!restoredByteIdentical) throw new Error('SOURCE_PROVIDER_PLAN source was not restored byte-identically');

const restoredResult = runFocusedCase();
if (restoredResult.status !== 0) {
  throw new Error(`focused case did not return green after restore (status ${restoredResult.status})`);
}

console.log(JSON.stringify({
  sourcePath,
  testPattern,
  reversedPlan: 'Wikipedia before Bing within the first provider group',
  reversedRun: { status: reversedResult.status, falsified },
  restoredByteIdentical,
  restoredRun: { status: restoredResult.status, passed: true },
}, null, 2));
