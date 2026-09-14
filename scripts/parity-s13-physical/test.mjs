#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleReceipt } from './assemble.mjs';
import { buildReceipt } from './test-fixture.mjs';
import { produceCandidate } from './produce.mjs';
import { addLocalDays, canonicalJson, canonicalSha256, sha256Bytes, resolveCommuteSchedule, validateMatrix, validateReceipt } from './validate.mjs';

const matrix = JSON.parse(fs.readFileSync(new URL('./matrix.json', import.meta.url), 'utf8'));

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function rewriteJsonArtifact(root, ref, value) {
  const bytes = Buffer.from(canonicalJson(value), 'utf8');
  fs.writeFileSync(path.join(root, ref.path), bytes);
  ref.sha256 = sha256Bytes(bytes);
  ref.bytes = bytes.length;
}

function withReceipt(mutator, expected = 'fail', options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-s13-receipt-'));
  try {
    const receipt = buildReceipt(matrix, root, options);
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
  assert.equal(matrix.cases.find((item) => item.id === 'commute-normal-combined').reference.caseId, 'single-driving-confirm-and-normal');
  assert.deepEqual(matrix.cases.find((item) => item.id === 'commute-normal-combined').expected.mimIds, ['CommuteConfirmSpeaker', 'CommuteDriveNormal', 'CommuteDepartTimeNormal']);
  assert.equal(matrix.cases.find((item) => item.id === 'calendar-four-card-field-matrix').reference.caseId, 'full-report-event-tomorrow');
  assert.equal(matrix.cases.find((item) => item.id === 'calendar-four-card-field-matrix').expected.mimIds[0], 'CalendarEventCountTomorrow');
  assert.deepEqual(matrix.cases.find((item) => item.id === 'calendar-concurrent-parallel').expected.viewIds, ['eventView', 'eventView']);
  assert.equal(matrix.cases.find((item) => item.id === 'calendar-tree-park-nature').blocked.reason, 'missing-source-asset:tree');
});

test('relative-date baseline binds every physical artifact and closes views before idle', () => {
  withReceipt(null, 'pass');
  withReceipt(null, 'pass', { selectedOperation: 'startLocalTurn' });
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

test('rehashed native/provider traces and private fixtures are still bound to the receipt', () => {
  withReceipt((receipt, root) => {
    const row = receipt.cases.find((item) => item.id === 'commute-normal-combined');
    const nativeRef = row.actual.artifacts.nativeReport;
    const native = JSON.parse(fs.readFileSync(path.join(root, nativeRef.path), 'utf8'));
    native.events[1].payload.projection.mimIds[0] = 'forged';
    rewriteJsonArtifact(root, nativeRef, native);
  });
  withReceipt((receipt, root) => {
    const row = receipt.cases.find((item) => item.id === 'commute-normal-combined');
    const fixtureRef = row.actual.artifacts.providerFixture;
    const fixture = JSON.parse(fs.readFileSync(path.join(root, fixtureRef.path), 'utf8'));
    fixture.fixture = 'forged';
    rewriteJsonArtifact(root, fixtureRef, fixture);
  });
});

test('PNG structure and symlinked artifact paths are fail-closed', () => {
  withReceipt((receipt, root) => {
    const shot = receipt.cases.find((item) => item.id === 'commute-normal-combined').actual.screenshots[0];
    const file = path.join(root, shot.path);
    const bytes = fs.readFileSync(file);
    bytes[0] = 0;
    fs.writeFileSync(file, bytes);
    shot.sha256 = sha256Bytes(bytes);
  });
  withReceipt((receipt, root) => {
    const shot = receipt.cases.find((item) => item.id === 'commute-normal-combined').actual.screenshots[0];
    const file = path.join(root, shot.path);
    const target = path.join(root, 'screenshot-target.png');
    fs.copyFileSync(file, target);
    fs.unlinkSync(file);
    fs.symlinkSync(target, file);
  });
  withReceipt((receipt, root) => {
    const shot = receipt.cases.find((item) => item.id === 'commute-normal-combined').actual.screenshots[0];
    const directory = path.dirname(path.join(root, shot.path));
    const moved = path.join(root, 'screenshot-directory');
    fs.renameSync(directory, moved);
    fs.symlinkSync(moved, directory, 'dir');
  });
});

test('linked no-view receipt bytes are opened, parsed, and bound', () => {
  withReceipt((receipt, root) => {
    const row = receipt.cases.find((item) => item.id === 'calendar-no-view-empty');
    const ref = row.actual.sourceReceipt;
    const linked = JSON.parse(fs.readFileSync(path.join(root, ref.path), 'utf8'));
    linked.result = 'fail';
    rewriteJsonArtifact(root, ref, linked);
  });
});

test('PM departure is safely conditional and a blocked source asset limits the claim', () => {
  withReceipt(null, 'pass');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-s13-pm-'));
  try {
    const receipt = buildReceipt(matrix, root, { pmDepartureAvailable: true });
    const report = validateReceipt(receipt, matrix, { root });
    assert.equal(report.result, 'pass', report.errors.slice(0, 5).join('; '));
    assert.equal(receipt.cases.find((item) => item.id === 'commute-pm-departure-combined').status, 'pass');
    assert.equal(receipt.decision, 'verified_bounded');
    assert.equal(receipt.cases.find((item) => item.id === 'calendar-tree-park-nature').claimed, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('receipt assembler supplies immutable matrix order from an unordered capture manifest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-s13-assemble-'));
  try {
    const produced = buildReceipt(matrix, root);
    const manifest = { ...produced, cases: [...produced.cases].reverse() };
    const assembled = assembleReceipt(matrix, manifest);
    assert.deepEqual(assembled.cases.map((row) => row.id), matrix.cases.map((row) => row.id));
    assert.equal(validateReceipt(assembled, matrix, { root }).result, 'pass');
    assert.throws(() => assembleReceipt(matrix, { ...manifest, cases: manifest.cases.slice(1) }), /missing case/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const privateRun = '/home/shell/.local/share/phoenix/moth/run/s13-final-7841016d4-20260913T233031Z';
test('raw-run producer binds separate source artifacts and rejects the known incomplete run', { skip: !fs.existsSync(privateRun) }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-s13-raw-producer-'));
  try {
    const produced = produceCandidate(matrix, privateRun, root);
    const report = validateReceipt(produced.manifest, matrix, { root });
    assert.equal(report.result, 'fail');
    assert.ok(report.errors.some((error) => error.includes('raw run fixture binding')));
    assert.ok(produced.manifest.cases.every((row) => row && typeof row.status === 'string'));
    const rawBundle = produced.manifest.provenance.sourceRun;
    assert.equal(fs.existsSync(path.join(root, rawBundle.path)), true);
    assert.equal(produced.receiptSha256.length, 64);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('raw-run producer accepts an explicit per-case bundle manifest and binds its bytes', { skip: !fs.existsSync(privateRun) }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-s13-bundle-producer-'));
  try {
    const manifestPath = path.join(root, 'bundle-manifest.json');
    const turns = {
      'commute-normal-combined': 'commute-normal-direct.json',
      'commute-bad-combined': 'commute-bad.json',
      'commute-terrible-combined': 'commute-terrible.json',
      'calendar-four-card-field-matrix': 'calendar-four-card.json',
      'calendar-concurrent-parallel': 'calendar-parallel.json'
    };
    const bundles = Object.fromEntries(Object.entries(turns).map(([id, turn]) => [id, {
      dir: privateRun,
      stack: 'stack.json',
      fixture: 'fixture.json',
      wire: 'wire-1789342243362.jsonl',
      turn
    }]));
    fs.writeFileSync(manifestPath, JSON.stringify({ schema: 'phoenix-s13-bundle-manifest-v1', cases: bundles }) + '\n');
    const produced = produceCandidate(matrix, privateRun, root, { bundles, bundleManifestPath: manifestPath });
    const report = validateReceipt(produced.manifest, matrix, { root });
    assert.equal(report.result, 'fail');
    const sourceRun = JSON.parse(fs.readFileSync(path.join(root, produced.manifest.provenance.sourceRun.path), 'utf8'));
    assert.ok(sourceRun.bundleManifest);
    assert.equal(sourceRun.bundles['commute-normal-combined'].sourceNames.turn, turns['commute-normal-combined']);
    assert.ok(!report.errors.some((error) => error.includes('bundle manifest cases do not bind source bundles')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
