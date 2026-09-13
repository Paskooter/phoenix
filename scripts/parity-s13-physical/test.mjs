#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReceipt } from './test-fixture.mjs';
import { addLocalDays, canonicalSha256, resolveCommuteSchedule, validateMatrix, validateReceipt } from './validate.mjs';

const matrix = JSON.parse(fs.readFileSync(new URL('./matrix.json', import.meta.url), 'utf8'));

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function withReceipt(mutator, expected = 'fail') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-s13-receipt-'));
  try {
    const receipt = buildReceipt(matrix, root);
    if (mutator) mutator(receipt, root);
    const report = validateReceipt(receipt, matrix, { root });
    assert.equal(report.result, expected, report.errors.slice(0, 5).join('; '));
    return report;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('S-13 matrix is pinned, ordered, and internally hashed', () => {
  const report = validateMatrix(matrix);
  assert.equal(report.result, 'pass', report.errors.join('; '));
  assert.equal(matrix.cases.length, 17);
  assert.deepEqual(matrix.cases.slice(0, 4).map((item) => item.id), [
    'commute-normal-combined', 'commute-bad-combined', 'commute-terrible-combined', 'commute-pm-departure-combined'
  ]);
  assert.equal(matrix.cases.find((item) => item.id === 'calendar-four-card-field-matrix').expected.viewIds.length, 4);
  assert.deepEqual(matrix.cases.find((item) => item.id === 'calendar-concurrent-parallel').expected.viewIds, ['eventView', 'eventView']);
  assert.equal(matrix.cases.find((item) => item.id === 'calendar-tree-park-nature').blocked.reason, 'missing-source-asset:tree');
});

test('relative-date baseline binds every physical artifact and closes views before idle', () => {
  withReceipt(null, 'pass');
});

test('relative fixture arithmetic preserves local dates across DST boundaries', () => {
  assert.deepEqual(resolveCommuteSchedule('2026-03-08T06:30:00.000Z', 'capture-plus-60-minutes'), { dateISO: '2026-03-08', hour: 3, minute: 30 });
  assert.equal(addLocalDays('2026-03-08', 1, 'America/New_York'), '2026-03-09');
  assert.equal(addLocalDays('2026-11-01', 1, 'America/New_York'), '2026-11-02');
});

test('row omission and row reorder are rejected even when the source matrix is unchanged', () => {
  withReceipt((receipt) => receipt.cases.pop());
  withReceipt((receipt) => [receipt.cases[0], receipt.cases[1]] = [receipt.cases[1], receipt.cases[0]]);
});

test('stale Phoenix revision and missing runtime package version are rejected', () => {
  withReceipt((receipt) => { receipt.phoenixRevision = '0'.repeat(40); }, 'fail');
  withReceipt((receipt) => { delete receipt.provenance.client.version; }, 'fail');
});

test('request, action, and view contract mutations are rejected after attempted rehashing', () => {
  withReceipt((receipt) => {
    const row = receipt.cases.find((item) => item.id === 'commute-bad-combined');
    row.actual.request.prefs.trafficSeconds = 600;
    row.actual.request.prefsResolution.sha256 = canonicalSha256(row.actual.request.prefs);
  });
  withReceipt((receipt) => {
    const row = receipt.cases.find((item) => item.id === 'calendar-four-card-field-matrix');
    row.actual.action.projection.viewContracts[1].labels.summary = 'forged summary';
    for (const stream of ['phoenix', 'native', 'wire']) {
      row.actual.action.payload[stream].projection = row.actual.action.projection;
      row.actual.action[`${stream}CanonicalSha256`] = canonicalSha256(row.actual.action.payload[stream]);
    }
    row.actual.action.payloadSha256 = canonicalSha256(row.actual.action.payload);
  });
});

test('wire correlation, screenshot bytes/order, and idle closure are mandatory', () => {
  withReceipt((receipt, root) => {
    const row = receipt.cases.find((item) => item.id === 'commute-normal-combined');
    row.actual.correlation.transID = 'different-trans-id';
  });
  withReceipt((receipt) => {
    const row = receipt.cases.find((item) => item.id === 'calendar-concurrent-parallel');
    [row.actual.screenshots[0], row.actual.screenshots[1]] = [row.actual.screenshots[1], row.actual.screenshots[0]];
  });
  withReceipt((receipt, root) => {
    const row = receipt.cases.find((item) => item.id === 'commute-normal-combined');
    fs.appendFileSync(path.join(root, row.actual.screenshots[0].path), 'mutated');
  });
  withReceipt((receipt) => {
    const row = receipt.cases.find((item) => item.id === 'commute-normal-combined');
    delete row.actual.timeline.idle;
  });
});

test('no-view assertions cannot acquire screenshots and the missing tree asset cannot be claimed', () => {
  withReceipt((receipt) => {
    const row = receipt.cases.find((item) => item.id === 'calendar-no-view-empty');
    row.actual.screenshots.push({ ordinal: 0, viewId: 'eventView' });
  });
  withReceipt((receipt) => {
    const row = receipt.cases.find((item) => item.id === 'calendar-tree-park-nature');
    row.status = 'pass';
    row.claimed = true;
  });
});

test('falsification receipt requires every named negative control and its hash', () => {
  withReceipt((receipt) => receipt.falsification.controls.shift());
  withReceipt((receipt) => { receipt.falsification.controls[0].status = 'pass'; });
});
