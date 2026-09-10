#!/usr/bin/env node
// A-10 production-path falsification.
//
// Replaces ONE complete source line (matched with its leading newline and
// indentation, so a comment quoting the line cannot match), asserts the anchor
// is unique, runs the focused control, records the failure, restores the file
// byte-for-byte and re-runs. Every corruption is verified present before the
// run and byte-identical after restore.
//
//   node docs/parity/evidence/2026-09-10/a10-notification-lifecycle/falsify-production.mjs
//
// Writes falsification-production.json next to this file.

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();
const HERE = dirname(fileURLToPath(import.meta.url));

const CASES = [
  {
    name: 'ack: the send callback no longer removes the delivered row (queue 1 -> 0 / isolation claims)',
    file: 'packages/classic/src/notification.js',
    find: '\n            this.store.removeNotification(notification._id);',
    replace: '\n            void notification._id;',
    tests: ['packages/classic/test/notificationProductionPath.test.js'],
    why: 'without the durable delete the row is replayed, so the queue never reaches 0',
  },
  {
    name: 'region: the default serving-certificate region is no longer the robot  (region-names claim)',
    file: 'scripts/ensure-tls-certs.mjs',
    find: "\n  const raw = env.PHOENIX_TLS_REGIONS || 'api';",
    replace: "\n  const raw = env.PHOENIX_TLS_REGIONS || 'phx';",
    tests: ['packages/classic/test/notificationProductionPath.test.js'],
    why: 'the default cert stops covering api.jibo.com / api-socket.jibo.com',
  },
];

const count = (haystack, needle) => haystack.split(needle).length - 1;

function runTests(tests) {
  let output = '';
  try {
    output = execFileSync('node', ['--test', ...tests], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    output = `${error.stdout || ''}${error.stderr || ''}`;
  }
  const failing = output.split('\n').filter((line) => line.startsWith('not ok ')).map((line) => line.replace(/^not ok \d+ - /, '').trim());
  const summary = (key) => {
    const match = output.match(new RegExp(`^# ${key} (\\d+)$`, 'm'));
    return match ? Number(match[1]) : null;
  };
  return {
    passed: summary('pass'),
    failed: summary('fail'),
    skipped: summary('skipped'),
    cancelled: summary('cancelled'),
    failing,
  };
}

const report = { cases: [] };
for (const testCase of CASES) {
  const path = join(ROOT, testCase.file);
  const original = readFileSync(path, 'utf8');
  if (count(original, testCase.find) !== 1) {
    report.cases.push({ name: testCase.name, result: 'ERROR', detail: 'anchor is not unique', occurrences: count(original, testCase.find) });
    continue;
  }
  const corrupted = original.replace(testCase.find, testCase.replace);
  writeFileSync(path, corrupted);
  const broken = runTests(testCase.tests);
  writeFileSync(path, original);
  const restored = readFileSync(path, 'utf8');
  const restoredRun = runTests(testCase.tests);
  report.cases.push({
    name: testCase.name,
    file: testCase.file,
    anchorReplaced: testCase.find.slice(1),
    replacedWith: testCase.replace.slice(1),
    why: testCase.why,
    codeLineChanged: corrupted !== original,
    restoredByteIdentical: restored === original,
    brokenRun: broken,
    restoredRun,
    result: broken.failed > 0 && restoredRun.failed === 0 ? 'CAUGHT' : 'MISS',
  });
}
report.allCaught = report.cases.every((entry) => entry.result === 'CAUGHT');
writeFileSync(join(HERE, 'falsification-production.json'), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(report.allCaught ? 0 : 1);
