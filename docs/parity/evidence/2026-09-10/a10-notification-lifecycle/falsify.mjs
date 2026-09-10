#!/usr/bin/env node
// A-10 falsification harness.
//
// Each entry corrupts ONE full source code line (anchored with its leading newline
// and indentation so a comment quoting the line cannot match), runs the focused test
// file that is supposed to catch it, records the failure, restores the file and
// re-runs to prove the tree is green again. Nothing here is simulated: the test
// process really runs against the corrupted file.
//
// Run from the worktree root:
//   node docs/parity/evidence/2026-09-10/a10-notification-lifecycle/falsify.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = process.cwd();
const out = { generatedAt: new Date().toISOString(), revision: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(), cases: [] };

const CASES = [
  {
    name: 'declared operation GetStatus is not dispatched (served-at-runtime claim)',
    file: 'packages/classic/src/notification.js',
    from: "\n      case 'getstatus':",
    to: "\n      case 'getstatus-renamed':",
    tests: [
      'packages/classic/test/notificationSourceContract.test.js',
      'packages/classic/test/notificationLifecycle.test.js',
    ],
    expectFailuresIn: 'both files: GetStatus no longer answers, so every GetStatus assertion fails',
  },
  {
    name: 'acknowledged row is not removed, so a reconnect replays it (ack/exactly-once claim)',
    file: 'packages/classic/src/notification.js',
    from: "\n            this.store.removeNotification(notification._id);",
    to: "\n            void notification._id;",
    tests: ['packages/classic/test/notificationLifecycle.test.js'],
    expectFailuresIn: 'notificationLifecycle.test.js: acked row is replayed and the pending count is wrong',
  },
  {
    name: 'the serving certificate stops covering the socket hostname (TLS/SNI claim)',
    file: 'scripts/ensure-tls-certs.mjs',
    from: "    dns.push(`${region}.jibo.com`, `${region}-socket.jibo.com`);",
    to: "    dns.push(`${region}.jibo.com`);",
    tests: ['packages/classic/test/notificationSourceContract.test.js'],
    expectFailuresIn: 'notificationSourceContract.test.js: the SAN assertion for <region>-socket.jibo.com fails',
  },
];

function runTests(files) {
  const child = spawnSync(process.execPath, ['--test', ...files], { cwd: root, encoding: 'utf8', timeout: 180_000 });
  const text = `${child.stdout || ''}${child.stderr || ''}`;
  const failing = [...text.matchAll(/^not ok \d+ - (.+)$/gm)].map((match) => match[1]);
  const passed = Number((text.match(/^# pass (\d+)$/m) || [])[1] ?? -1);
  const failed = Number((text.match(/^# fail (\d+)$/m) || [])[1] ?? -1);
  return { status: child.status, passed, failed, failing, tail: text.split('\n').slice(-25).join('\n') };
}

for (const entry of CASES) {
  const path = join(root, entry.file);
  const original = readFileSync(path, 'utf8');
  const occurrences = original.split(entry.from).length - 1;
  const record = { name: entry.name, file: entry.file, anchor: entry.from, occurrences, expected: entry.expectFailuresIn };
  if (occurrences !== 1) {
    record.result = `ANCHOR NOT UNIQUE (${occurrences} matches) - aborting this case`;
    out.cases.push(record);
    continue;
  }
  try {
    writeFileSync(path, original.replace(entry.from, entry.to));
    const corrupted = readFileSync(path, 'utf8');
    record.codeLineChanged = corrupted.includes(entry.to) && !corrupted.includes(entry.from);
    record.brokenRun = runTests(entry.tests);
  } finally {
    writeFileSync(path, original);
  }
  record.restoredByteIdentical = readFileSync(path, 'utf8') === original;
  record.restoredRun = runTests(entry.tests);
  record.result = record.codeLineChanged && record.brokenRun.failed > 0 && record.restoredRun.failed === 0
    ? 'CAUGHT' : 'NOT CAUGHT';
  out.cases.push(record);
}

out.allCaught = out.cases.every((entry) => entry.result === 'CAUGHT');
writeFileSync(join('docs/parity/evidence/2026-09-10/a10-notification-lifecycle/falsification.json'), `${JSON.stringify(out, null, 2)}\n`);
for (const entry of out.cases) {
  process.stdout.write(`${entry.result}  ${entry.name}\n`);
  process.stdout.write(`        broken: exit=${entry.brokenRun?.status} pass=${entry.brokenRun?.passed} fail=${entry.brokenRun?.failed} ${JSON.stringify(entry.brokenRun?.failing)}\n`);
  process.stdout.write(`        restored: exit=${entry.restoredRun?.status} pass=${entry.restoredRun?.passed} fail=${entry.restoredRun?.failed}\n`);
}
process.stdout.write(`allCaught=${out.allCaught}\n`);
