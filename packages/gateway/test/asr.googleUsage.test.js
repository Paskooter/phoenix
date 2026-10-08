// The Google speech budget guard (googleUsage.js).
//
// Google offers no spend cap for Speech-to-Text, so this ledger is the hard
// stop: monthly and daily limits in billed seconds, reservations that make
// concurrent requests unable to overshoot, persistence across restarts, and
// refusal (not a silent reset) whenever the ledger cannot be trusted.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoogleUsageMeter, googleUsageFile, initializeGoogleUsageFile } from '../src/asr/googleUsage.js';

function tempFile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'phx-google-usage-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'asr', 'google-stt-usage.json');
  initializeGoogleUsageFile(file);
  return file;
}

const clock = (iso) => {
  let now = Date.parse(iso);
  const fn = () => now;
  fn.set = (next) => { now = Date.parse(next); };
  return fn;
};

test('the usage file defaults beside Phoenix data and is required', () => {
  assert.equal(googleUsageFile({ PHOENIX_GOOGLE_STT_USAGE_FILE: '/x/usage.json', PHOENIX_DATA_DIR: '/d' }), '/x/usage.json');
  assert.equal(googleUsageFile({ PHOENIX_DATA_DIR: '/d' }), '/d/asr/google-stt-usage.json');
  assert.equal(googleUsageFile({}), null);
  const meter = new GoogleUsageMeter({ file: null, monthlyLimitSeconds: 600 });
  assert.equal(meter.reserve(5), null, 'without a ledger on disk Google is refused');
  assert.equal(meter.status().problem, 'no-usage-file');
});

test('reservations count against the limit until committed, so concurrent turns cannot overshoot', (t) => {
  const meter = new GoogleUsageMeter({ file: tempFile(t), monthlyLimitSeconds: 60 });
  const a = meter.reserve(31);
  assert.ok(a);
  assert.equal(meter.reserve(31), null, 'a second 31 s reservation would exceed 60 s');
  meter.commit(a, 4);
  assert.equal(meter.status().usedSeconds, 4);
  assert.equal(meter.status().reservedSeconds, 0);
  const b = meter.reserve(31);
  assert.ok(b, 'the unused part of the first reservation was released');
  meter.commit(b, 0);
  meter.commit(b, 30); // a second commit of the same reservation is ignored
  assert.equal(meter.status().usedSeconds, 4);
});

test('billed seconds round up per request', (t) => {
  const meter = new GoogleUsageMeter({ file: tempFile(t), monthlyLimitSeconds: 600 });
  meter.commit(meter.reserve(31), 2.1);
  meter.commit(meter.reserve(31), 0.2);
  assert.equal(meter.status().usedSeconds, 4);
  assert.equal(meter.status().requests, 2);
});

test('the monthly limit stops Google, and the next month (Pacific time) starts again', (t) => {
  const now = clock('2026-10-31T23:30:00-07:00');
  const meter = new GoogleUsageMeter({ file: tempFile(t), monthlyLimitSeconds: 60, now });
  meter.commit(meter.reserve(60), 60);
  assert.equal(meter.status().exhausted, 'month');
  assert.equal(meter.refusal(1), 'monthly-limit');
  assert.equal(meter.reserve(1), null);
  // 00:30 UTC on Nov 1 is still October in Pacific time.
  now.set('2026-11-01T00:30:00Z');
  assert.equal(meter.reserve(1), null, 'still October in Pacific time');
  now.set('2026-11-01T00:01:00-07:00');
  const fresh = meter.reserve(31);
  assert.ok(fresh, 'November starts with a fresh budget');
  assert.equal(meter.status().month, '2026-11');
  assert.equal(meter.status().usedSeconds, 0);
});

test('the daily limit stops one runaway day from spending the month', (t) => {
  const now = clock('2026-10-08T10:00:00-07:00');
  const meter = new GoogleUsageMeter({ file: tempFile(t), monthlyLimitSeconds: 6000, dailyLimitSeconds: 40, now });
  meter.commit(meter.reserve(31), 31);
  assert.equal(meter.reserve(31), null, 'today has 9 s left');
  assert.equal(meter.refusal(31), 'daily-limit');
  now.set('2026-10-09T08:00:00-07:00');
  assert.ok(meter.reserve(31), 'tomorrow is a new day');
  assert.equal(meter.status().usedSeconds, 31, 'the month keeps counting');
});

test('a limit of 0 turns Google off', (t) => {
  const meter = new GoogleUsageMeter({ file: tempFile(t), monthlyLimitSeconds: 0 });
  assert.equal(meter.refusal(), 'disabled');
  assert.equal(meter.reserve(1), null);
});

test('usage persists atomically, privately, and survives a restart', (t) => {
  const file = tempFile(t);
  const now = clock('2026-10-08T10:00:00-07:00');
  const meter = new GoogleUsageMeter({ file, monthlyLimitSeconds: 600, now });
  meter.commit(meter.reserve(31), 7);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.version, 2);
  assert.equal(saved.month, '2026-10');
  assert.equal(saved.monthSeconds, 7);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const again = new GoogleUsageMeter({ file, monthlyLimitSeconds: 600, now });
  assert.equal(again.status().usedSeconds, 7);
});

test('an unreadable or invalid ledger refuses Google instead of starting from zero', (t) => {
  const file = tempFile(t);
  const meter = new GoogleUsageMeter({ file, monthlyLimitSeconds: 600 });
  meter.commit(meter.reserve(31), 5);
  writeFileSync(file, '{ not json');
  const broken = new GoogleUsageMeter({ file, monthlyLimitSeconds: 600 });
  assert.equal(broken.reserve(1), null);
  assert.equal(broken.status().problem, 'usage-file-invalid');
  writeFileSync(file, JSON.stringify({ version: 99 }));
  assert.equal(new GoogleUsageMeter({ file, monthlyLimitSeconds: 600 }).status().problem, 'usage-file-invalid');
});

test('a ledger that cannot be written stops Google', (t) => {
  const failing = {
    ...fs,
    writeFileSync() { const e = new Error('read-only'); e.code = 'EROFS'; throw e; },
  };
  const file = tempFile(t);
  const meter = new GoogleUsageMeter({ file, monthlyLimitSeconds: 600, fsImpl: failing });
  assert.equal(meter.reserve(31), null, 'no request may start without durable reservation');
  assert.equal(meter.status().problem, 'usage-file-unwritable');
  assert.equal(meter.reserve(1), null);
});

test('a missing ledger fails closed; initialization cannot erase existing usage', (t) => {
  const file = tempFile(t);
  assert.throws(() => initializeGoogleUsageFile(file), { code: 'EEXIST' });
  unlinkSync(file);
  const meter = new GoogleUsageMeter({ file, monthlyLimitSeconds: 600 });
  assert.equal(meter.reserve(31), null);
  assert.equal(meter.status().problem, 'usage-file-missing');
});

test('a crash retains the full durable reservation and cannot reopen the budget', (t) => {
  const file = tempFile(t);
  const meter = new GoogleUsageMeter({ file, monthlyLimitSeconds: 60 });
  assert.ok(meter.reserve(31));
  const reloaded = new GoogleUsageMeter({ file, monthlyLimitSeconds: 60 });
  assert.equal(reloaded.status().reservedSeconds, 31);
  assert.equal(reloaded.reserve(31), null);
  assert.equal(JSON.parse(readFileSync(file)).monthSeconds, 31);
});

test('independent meters serialize their reservations against the same file', (t) => {
  const file = tempFile(t);
  const a = new GoogleUsageMeter({ file, monthlyLimitSeconds: 60 });
  const b = new GoogleUsageMeter({ file, monthlyLimitSeconds: 60 });
  const reservation = a.reserve(31);
  assert.ok(reservation);
  assert.equal(b.reserve(31), null);
  a.commit(reservation, 2);
  assert.ok(b.reserve(31), 'the second meter reloads the first meter’s committed usage');
  assert.equal(a.status().usedSeconds, 2);
});

test('in-flight requests keep their reservation across the Pacific month and day boundary', (t) => {
  const file = tempFile(t);
  const now = clock('2026-10-31T23:59:59-07:00');
  const meter = new GoogleUsageMeter({ file, monthlyLimitSeconds: 60, dailyLimitSeconds: 60, now });
  const reservation = meter.reserve(31);
  now.set('2026-11-01T00:00:01-07:00');
  assert.equal(meter.reserve(31), null, 'November includes the request still in flight');
  meter.commit(reservation, 5);
  assert.equal(meter.status().usedSeconds, 5);
  assert.equal(meter.status().dayUsedSeconds, 5);
});

test('damaged counters fail closed instead of being interpreted as zero', (t) => {
  const file = tempFile(t);
  const saved = JSON.parse(readFileSync(file));
  for (const value of [-1, '100', null, 1.5]) {
    writeFileSync(file, JSON.stringify({ ...saved, monthSeconds: value }));
    assert.equal(new GoogleUsageMeter({ file, monthlyLimitSeconds: 600 }).reserve(31), null);
  }
});

test('a stale transaction lock refuses Google without changing usage', (t) => {
  const file = tempFile(t);
  writeFileSync(`${file}.lock`, 'synthetic stale lock', { mode: 0o600 });
  const meter = new GoogleUsageMeter({ file, monthlyLimitSeconds: 600 });
  assert.equal(meter.reserve(31), null);
  assert.equal(meter.status().problem, 'usage-file-busy');
  assert.equal(JSON.parse(readFileSync(file)).monthSeconds, 0);
});

test('a backward clock correction never clears a previously spent period', (t) => {
  const file = tempFile(t);
  const now = clock('2026-10-31T10:00:00-07:00');
  const meter = new GoogleUsageMeter({ file, monthlyLimitSeconds: 12, now });
  meter.commit(meter.reserve(12), 12);
  now.set('2026-11-01T10:00:00-07:00');
  meter.commit(meter.reserve(12), 12);
  now.set('2026-10-31T10:00:00-07:00');
  assert.equal(meter.reserve(12), null);
  assert.equal(meter.status().problem, 'usage-clock-backwards');
  assert.equal(JSON.parse(readFileSync(file)).month, '2026-11');
  assert.equal(JSON.parse(readFileSync(file)).monthSeconds, 12);
});

test('50%, 80% and 100% of the month are logged once each', (t) => {
  const lines = [];
  const log = { warn: (m, f) => lines.push(['warn', m, f]), error: (m, f) => lines.push(['error', m, f]) };
  const meter = new GoogleUsageMeter({ file: tempFile(t), monthlyLimitSeconds: 100, log });
  meter.commit(meter.reserve(31), 30);
  assert.equal(lines.length, 0);
  meter.commit(meter.reserve(31), 25); // 55%
  meter.commit(meter.reserve(31), 1);  // still 56%: no repeat
  meter.commit(meter.reserve(31), 30); // 86%
  meter.commit(meter.reserve(14), 14); // 100%
  assert.deepEqual(lines.map(([level, message]) => [level, message]), [
    ['warn', 'Google speech has used 50% of its monthly limit'],
    ['warn', 'Google speech has used 80% of its monthly limit'],
    ['error', 'Google speech monthly limit reached; Google is off until next month'],
  ]);
  assert.deepEqual(Object.keys(lines[0][2]).sort(), ['limitMinutes', 'month', 'usedMinutes'], 'numbers only, no identities');
});
