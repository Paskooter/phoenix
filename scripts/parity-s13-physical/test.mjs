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
  withReceipt((receipt, root) => {
    const row = receipt.cases.find((item) => item.id === 'commute-normal-combined');
    const reviewRef = row.actual.artifacts.visualReview;
    const review = JSON.parse(fs.readFileSync(path.join(root, reviewRef.path), 'utf8'));
    review.screenshots[0].sha256 = '0'.repeat(64);
    rewriteJsonArtifact(root, reviewRef, review);
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

const recaptureRun = '/home/shell/.local/share/phoenix/moth/run/s13-recapture-6afe114-20260914T000704Z';
test('v2 recapture keeps fixture work time, two-stage identity, raw wire gaps, and external review binding', { skip: !fs.existsSync(recaptureRun) }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-s13-v2-producer-'));
  try {
    const bundleManifestPath = path.join(recaptureRun, 'bundle-manifest-toolkit-v2.json');
    const bundles = JSON.parse(fs.readFileSync(bundleManifestPath, 'utf8')).cases;
    const produced = produceCandidate(matrix, recaptureRun, root, { bundles, bundleManifestPath });
    const receipt = produced.manifest;
    assert.equal(receipt.runtime.fixtureGenerator, 'private-fixture-work-time');
    assert.equal(receipt.runtime.captureISO, receipt.preflight.context.runtimeLocationISO);
    assert.equal(receipt.preflight.proven, true);
    const sourceRun = JSON.parse(fs.readFileSync(path.join(root, receipt.provenance.sourceRun.path), 'utf8'));
    assert.equal(sourceRun.bundleManifest.path, 'raw/bundle-manifest-toolkit-v2.json');
    assert.equal(sourceRun.visualReview.path, 'raw/visual-review-v2.json');
    for (const id of ['commute-normal-combined', 'commute-bad-combined', 'commute-terrible-combined']) {
      const row = receipt.cases.find((item) => item.id === id);
      const fixtureCase = id === 'commute-normal-combined' ? 'Normal' : id === 'commute-bad-combined' ? 'Bad' : 'Terrible';
      assert.equal(row.status, 'pass');
      assert.equal(row.actual.request.locationMode, 'private-fixture-work-time');
      assert.equal(row.actual.request.prefsResolution.schedule, 'private-fixture-work-time');
      assert.equal(row.actual.request.prefsResolution.generatedFrom, 'private-fixture-work-time');
      assert.equal(row.actual.request.prefs.workDateISO, '2026-09-13');
      assert.equal(row.actual.request.prefsResolution.fixtureSha256, row.actual.artifacts.rawFixture.sha256);
      assert.deepEqual(row.actual.request.prefsResolution.sourceFixture, {
        path: row.actual.artifacts.rawFixture.path,
        sha256: row.actual.artifacts.rawFixture.sha256,
        caseKey: fixtureCase
      });
      assert.deepEqual(row.actual.request.prefsResolution.workTime, {
        dateISO: row.actual.request.prefs.workDateISO,
        timeZone: 'America/New_York',
        hour: row.actual.request.prefs.workHour,
        min: row.actual.request.prefs.workMin
      });
      const providerFixture = JSON.parse(fs.readFileSync(path.join(root, row.actual.artifacts.providerFixture.path), 'utf8'));
      assert.deepEqual(providerFixture.workTime, {
        source: 'private-fixture-work-time',
        dateISO: row.actual.request.prefs.workDateISO,
        timeZone: 'America/New_York',
        hour: row.actual.request.prefs.workHour,
        min: row.actual.request.prefs.workMin
      });
    }
    const normal = receipt.cases.find((item) => item.id === 'commute-normal-combined');
    const identity = normal.actual.correlation;
    assert.equal(identity.stages.initial.sdkAck.requestID, identity.stages.initial.requestID);
    assert.equal(identity.stages.followup.requestID, identity.requestID);
    assert.equal(identity.stages.initial.connectionId, 'wire-connection-1');
    assert.equal(identity.stages.followup.connectionId, 'wire-connection-2');
    assert.equal(normal.actual.wireFlow.stages[0].rawConnectionId, 1);
    assert.equal(normal.actual.wireFlow.stages[1].rawConnectionId, 2);
    assert.deepEqual(normal.actual.action.payload.wire, normal.actual.action.payload.native);
    assert.equal(normal.actual.action.wireEqualsNative, true);
    assert.equal(normal.actual.action.payload.wire.rawActionSha256, normal.actual.action.sourceAction.rawActionSha256);
    assert.equal(normal.actual.action.payload.wire.rawWireActionSha256, normal.actual.action.sourceAction.rawWireActionSha256);
    assert.equal(identity.stages.initial.prelude.rawWireHasRequestID, false);
    assert.equal(identity.stages.followup.action.rawWireHasTransID, false);
    assert.equal(identity.wireAck.present, false);
    assert.deepEqual(normal.actual.wireFlow.stages.map((stage) => [stage.stage, stage.requestID, stage.connectionId]), [
      ['Tg', identity.stages.initial.requestID, 'wire-connection-1'],
      ['Tl', identity.stages.followup.requestID, 'wire-connection-2']
    ]);
    assert.equal(normal.actual.wireFlow.excludedPrelude.count, 1);
    assert.equal(normal.actual.wireFlow.stages[0].ackRequestID, identity.stages.initial.sdkAck.requestID);
    assert.equal(normal.actual.wireFlow.stages[1].body.clientASR, 'George');
    assert.deepEqual(normal.actual.request.followup.body, { clientASR: 'George' });
    const wire = fs.readFileSync(path.join(root, normal.actual.artifacts.wireTrace.path), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(wire.map((record) => [record.stage, record.type]), [
      ['Tg', 'request'], ['Tg', 'context'], ['Tg', 'action'],
      ['Tl', 'context'], ['Tl', 'request'], ['Tl', 'action']
    ]);
    assert.equal(wire.some((record) => record.type === 'ack'), false);
    assert.equal(wire.some((record) => record.type === 'idle'), false);
    assert.equal(wire.at(-1).messageId, identity.stages.followup.action.sourceMessageId);
    assert.equal(wire.at(-1).source.messageType, 'SKILL_ACTION');
    assert.equal(wire.at(-1).source.rawTransID, null);
    const provider = fs.readFileSync(path.join(root, normal.actual.artifacts.providerTrace.path), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(provider.every((record) => record.type === 'provider-call'), true);
    assert.equal(provider.some((record) => record.type === 'provider-return' || record.type === 'idle'), false);
    assert.deepEqual(provider.map((record) => record.service), ['settings', 'maps']);
    assert.equal(provider.every((record) => Number.isInteger(record.source.line) && record.source.traceSha256 === normal.actual.artifacts.rawWire.sha256), true);
    assert.deepEqual(provider[0].input, provider[0].sourceInput.input);
    assert.deepEqual(provider[1].input, provider[1].sourceInput.input);
    assert.equal(Object.hasOwn(provider[0], 'transID'), true);
    assert.equal(Object.hasOwn(provider[1], 'transID'), false);
    assert.equal(normal.actual.screenshots[0].captureKey, 'commute-normal-combined:view:0:trafficView');
    assert.equal(normal.actual.screenshots[1].captureKey, 'commute-normal-combined:view:1:departTimeView');
    assert.equal(normal.actual.screenshots.every((shot) => shot.visuallyInspected === true), true);
    const native = JSON.parse(fs.readFileSync(path.join(root, normal.actual.artifacts.nativeReport.path), 'utf8'));
    const rawTurn = JSON.parse(fs.readFileSync(path.join(root, normal.actual.artifacts.rawTurn.path), 'utf8'));
    assert.deepEqual(native.events.at(-1).sourceSnapshot, {
      snapshotIndex: rawTurn.snapshots.length - 1,
      rawTurnSha256: normal.actual.artifacts.rawTurn.sha256
    });
    assert.equal(normal.actual.artifacts.visualReview.path, 'raw/visual-review-v2.json');
    for (const row of receipt.cases.filter((item) => item.actual?.screenshots?.length)) {
      for (const shot of row.actual.screenshots) {
        assert.equal(path.isAbsolute(shot.sourceScreenshot.filename), true);
        assert.equal(path.relative(recaptureRun, shot.sourceScreenshot.filename).startsWith('..'), false);
      }
    }
    const parallel = receipt.cases.find((item) => item.id === 'calendar-concurrent-parallel');
    if (parallel.actual.action.phoenixMatchesMatrix) {
      assert.equal(parallel.status, 'pass');
      assert.equal(parallel.claimed, true);
    } else {
      assert.equal(parallel.status, 'observed');
      assert.equal(parallel.claimed, false);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('v2 producer rejects bundle directories outside the private run root', { skip: !fs.existsSync(recaptureRun) }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-s13-v2-confinement-'));
  try {
    const manifestPath = path.join(recaptureRun, 'bundle-manifest-toolkit-v2.json');
    const bundles = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).cases;
    bundles['commute-normal-combined'] = { ...bundles['commute-normal-combined'], dir: '/tmp' };
    assert.throws(() => produceCandidate(matrix, recaptureRun, root, { bundles, bundleManifestPath: manifestPath }), /bundle directory escapes run root/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('v2 producer leaves noBypass unclaimed when the external review is absent', { skip: !fs.existsSync(recaptureRun) }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-s13-v2-no-review-'));
  try {
    const bundleManifestPath = path.join(recaptureRun, 'bundle-manifest-toolkit-v2.json');
    const bundles = JSON.parse(fs.readFileSync(bundleManifestPath, 'utf8')).cases;
    const produced = produceCandidate(matrix, recaptureRun, root, {
      bundles,
      bundleManifestPath,
      visualReviewPath: path.join(root, 'review-not-supplied.json')
    });
    const physical = produced.manifest.cases.filter((row) => row.actual?.request?.operation);
    assert.equal(physical.length, 5);
    assert.equal(physical.every((row) => row.actual.noBypass === false), true);
    assert.equal(physical.every((row) => row.claimed === false), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
