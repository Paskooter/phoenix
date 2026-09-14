#!/usr/bin/env node

// S-13 flow-shape contract.
//
// The original report graph decides the identity flow in
// packages/report-skill/src/subgraphs/userid/UserIDFactory.ts.  `checkSpeakerID`
// computes `haveSpeaker = !!data.runtime.perception.speaker` and
// `needSpeaker = singleSkill is neither weather nor news`, and the
// 'Is User IDed?' node transitions True when `haveSpeaker || !needSpeaker`.
// Commute and calendar single-skill reports always need a speaker, so:
//
//   speaker present -> True  -> UserID Done directly.  PrefetchWeatherNode, the
//                              WhoIsThis QN mim and SetLooperIDNode are
//                              unreachable, so there is no whoIsThisMenu
//                              prelude and no local follow-up turn: one stage.
//   speaker absent  -> False -> WhoIsThis QN mim runs, emitting the prelude and
//                              opening one local turn: two stages.
//
// Both edges converge on the same Done transition, so the view payloads are
// produced by identical downstream code.  These tests pin that the receipt
// shape is DERIVED from the raw CONTEXT rather than chosen, in both directions.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { produceCandidate } from './produce.mjs';
import { canonicalJson, sha256Bytes, validateReceipt } from './validate.mjs';

const matrix = JSON.parse(fs.readFileSync(new URL('./matrix.json', import.meta.url), 'utf8'));
const freshRun = '/home/shell/.local/share/phoenix/moth/run/s13-fresh-nimbus-fcfe0fe-20260914T044620Z';
const hasRun = fs.existsSync(freshRun);

const EXPECTED_SHAPES = {
  'commute-normal-combined': 'two-stage',
  'commute-bad-combined': 'one-stage',
  'commute-terrible-combined': 'two-stage',
  'calendar-four-card-field-matrix': 'one-stage',
  'calendar-concurrent-parallel': 'two-stage'
};

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function produceInto(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-s13-shape-'));
  const bundleManifestPath = path.join(run, 'bundle-manifest.json');
  const bundles = JSON.parse(fs.readFileSync(bundleManifestPath, 'utf8')).cases;
  const produced = produceCandidate(matrix, run, root, { bundles, bundleManifestPath });
  return { root, produced, receipt: produced.manifest };
}

// Re-validate a receipt after a mutation and return the errors that mention the
// named case, so a control proves the specific row was rejected.
function errorsForCase(receipt, root, caseId) {
  const report = validateReceipt(receipt, matrix, { root });
  return report.errors.filter((message) => message.includes(caseId));
}

function rowOf(receipt, caseId) {
  return receipt.cases.find((item) => item.id === caseId);
}

// Rewrite a JSONL artifact in place and re-bind its recorded digest, so a
// control tests the contract rather than the (separately enforced) hash seal.
function rewriteJsonl(root, ref, rows) {
  const bytes = Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n'), 'utf8');
  fs.writeFileSync(path.join(root, ref.path), bytes);
  ref.sha256 = sha256Bytes(bytes);
  ref.bytes = bytes.length;
}

function readJsonl(root, ref) {
  return fs.readFileSync(path.join(root, ref.path), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

function rewriteJson(root, ref, value) {
  const bytes = Buffer.from(canonicalJson(value), 'utf8');
  fs.writeFileSync(path.join(root, ref.path), bytes);
  ref.sha256 = sha256Bytes(bytes);
  ref.bytes = bytes.length;
}


// Copy the private run into a scratch directory so a control can mutate one
// input without touching the real captured evidence.  Screenshot references in
// the raw turns are absolute, so they are re-rooted; nothing else is rewritten.
function copyRun() {
  const run = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-s13-run-'));
  fs.cpSync(freshRun, run, { recursive: true, filter: (src) => !path.basename(src).startsWith('candidate') });
  const bundleManifestPath = path.join(run, 'bundle-manifest.json');
  const bundles = JSON.parse(fs.readFileSync(bundleManifestPath, 'utf8')).cases;
  for (const bundle of Object.values(bundles)) {
    const turnPath = path.join(run, bundle.bundle, bundle.turn);
    const text = fs.readFileSync(turnPath, 'utf8');
    fs.writeFileSync(turnPath, text.split(freshRun).join(run));
  }
  // The visual review names the run it was taken against, so the copy has to
  // carry the copied root or the producer rejects it before reaching the
  // behaviour a control is trying to exercise.
  for (const name of ['visual-review-v2.json', 'visual-review-v2-session-bound.json']) {
    const reviewPath = path.join(run, name);
    if (!fs.existsSync(reviewPath)) continue;
    const review = JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
    review.captureRoot = run;
    fs.writeFileSync(reviewPath, JSON.stringify(review));
  }
  return { run, bundles, bundleManifestPath };
}

test('every captured lane declares the shape its raw CONTEXT speaker state requires', { skip: !hasRun }, () => {
  const { root, produced } = produceInto(freshRun);
  try {
    const receipt = produced.manifest;
    for (const [caseId, expected] of Object.entries(EXPECTED_SHAPES)) {
      const row = rowOf(receipt, caseId);
      assert.ok(row, `${caseId} is missing from the receipt`);
      const flow = row.actual.wireFlow;
      assert.equal(flow.shape, expected, `${caseId} shape`);
      assert.equal(flow.schema, `phoenix.s13.${expected}-wire-flow.v1`, `${caseId} schema`);
      assert.equal(flow.speakerState.derivedShape, expected, `${caseId} derived shape`);
      assert.equal(flow.speakerState.identified, expected === 'one-stage', `${caseId} identified flag`);

      const stages = flow.stages.map((stage) => stage.stage);
      assert.deepEqual(stages, expected === 'one-stage' ? ['Tg'] : ['Tg', 'Tl'], `${caseId} stages`);
      assert.equal(flow.excludedPrelude.count, expected === 'one-stage' ? 0 : 1, `${caseId} excluded prelude`);

      // The staged wire has one context/request/action per declared stage and
      // never selects a raw source line twice.
      const wire = readJsonl(root, row.actual.artifacts.wireTrace);
      assert.equal(wire.length, expected === 'one-stage' ? 3 : 6, `${caseId} staged wire rows`);
      const lines = wire.map((record) => record.source.line);
      assert.equal(new Set(lines).size, lines.length, `${caseId} reuses a raw source line`);
      assert.deepEqual([...new Set(wire.map((record) => record.stage))].sort(),
        expected === 'one-stage' ? ['Tg'] : ['Tg', 'Tl'], `${caseId} wire stages`);

      // The speaker identifier itself never reaches the receipt.
      assert.equal(JSON.stringify(flow.speakerState).includes('perception'), true);
      assert.match(flow.speakerState.field, /^data\.runtime\.perception\.speaker$/);
    }
    // Both shapes really do occur in this capture, so the contract is exercised
    // in both directions rather than being vacuously satisfied.
    const observed = new Set(Object.values(EXPECTED_SHAPES));
    assert.deepEqual([...observed].sort(), ['one-stage', 'two-stage']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a one-stage lane is rejected when its receipt claims the two-stage shape', { skip: !hasRun }, () => {
  const { root, produced } = produceInto(freshRun);
  try {
    const receipt = clone(produced.manifest);
    const row = rowOf(receipt, 'commute-bad-combined');
    row.actual.wireFlow.shape = 'two-stage';
    row.actual.wireFlow.schema = 'phoenix.s13.two-stage-wire-flow.v1';
    row.actual.wireFlow.speakerState.derivedShape = 'two-stage';
    row.actual.wireFlow.speakerState.identified = false;
    const errors = errorsForCase(receipt, root, 'commute-bad-combined');
    assert.ok(errors.some((message) => /wireFlow\.shape \(two-stage\) disagrees with the raw CONTEXT speaker state \(one-stage\)/.test(message)),
      errors.slice(0, 5).join('; '));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a two-stage lane is rejected when its receipt claims the one-stage shape', { skip: !hasRun }, () => {
  const { root, produced } = produceInto(freshRun);
  try {
    const receipt = clone(produced.manifest);
    const row = rowOf(receipt, 'commute-normal-combined');
    row.actual.wireFlow.shape = 'one-stage';
    row.actual.wireFlow.schema = 'phoenix.s13.one-stage-wire-flow.v1';
    row.actual.wireFlow.speakerState.derivedShape = 'one-stage';
    row.actual.wireFlow.speakerState.identified = true;
    const errors = errorsForCase(receipt, root, 'commute-normal-combined');
    assert.ok(errors.some((message) => /wireFlow\.shape \(one-stage\) disagrees with the raw CONTEXT speaker state \(two-stage\)/.test(message)),
      errors.slice(0, 5).join('; '));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a one-stage lane may not invent a second stage that repeats the global transaction', { skip: !hasRun }, () => {
  const { root, produced } = produceInto(freshRun);
  try {
    const receipt = clone(produced.manifest);
    const row = rowOf(receipt, 'commute-bad-combined');
    const flow = row.actual.wireFlow;
    // This is exactly the degenerate shape the previous producer emitted: a Tl
    // stage that is really the Tg transaction under another name.
    flow.stages.push({ ...clone(flow.stages[0]), stage: 'Tl', kind: 'local-followup' });
    const errors = errorsForCase(receipt, root, 'commute-bad-combined');
    assert.ok(errors.some((message) => /may not declare a Tl stage/.test(message)), errors.slice(0, 5).join('; '));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a one-stage lane may not claim an excluded whoIsThisMenu prelude', { skip: !hasRun }, () => {
  const { root, produced } = produceInto(freshRun);
  try {
    const receipt = clone(produced.manifest);
    const row = rowOf(receipt, 'commute-bad-combined');
    row.actual.wireFlow.excludedPrelude = { count: 1, viewId: 'whoIsThisMenu', eventIndex: 0 };
    const errors = errorsForCase(receipt, root, 'commute-bad-combined');
    assert.ok(errors.some((message) => /excludedPrelude\.count must be 0/.test(message)), errors.slice(0, 5).join('; '));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a one-stage lane is rejected when its raw turn carries a whoIsThisMenu display', { skip: !hasRun }, () => {
  const { root, produced } = produceInto(freshRun);
  try {
    const receipt = clone(produced.manifest);
    const row = rowOf(receipt, 'commute-bad-combined');
    const rawTurn = JSON.parse(fs.readFileSync(path.join(root, row.actual.artifacts.rawTurn.path), 'utf8'));
    rawTurn.displayActions = [...(rawTurn.displayActions || []), { viewId: 'whoIsThisMenu', captureStatus: 'skipped' }];
    rewriteJson(root, row.actual.artifacts.rawTurn, rawTurn);
    const errors = errorsForCase(receipt, root, 'commute-bad-combined');
    assert.ok(errors.some((message) => /may not contain any whoIsThisMenu display on the one-stage path/.test(message)),
      errors.slice(0, 5).join('; '));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('speakerState must cite the raw CONTEXT line the shape was derived from', { skip: !hasRun }, () => {
  const { root, produced } = produceInto(freshRun);
  try {
    const receipt = clone(produced.manifest);
    const row = rowOf(receipt, 'calendar-four-card-field-matrix');
    row.actual.wireFlow.speakerState.sourceLine += 1;
    const errors = errorsForCase(receipt, root, 'calendar-four-card-field-matrix');
    assert.ok(errors.some((message) => /speakerState\.sourceLine does not bind the raw Tg CONTEXT line/.test(message)),
      errors.slice(0, 5).join('; '));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('speakerState may not copy the raw looper identifier into the receipt', { skip: !hasRun }, () => {
  const { root, produced } = produceInto(freshRun);
  try {
    const receipt = clone(produced.manifest);
    const row = rowOf(receipt, 'commute-bad-combined');
    const raw = readJsonl(root, row.actual.artifacts.rawWire);
    const context = raw.find((record) => record?.kind === 'client-message' && record.json?.type === 'CONTEXT');
    const speaker = context.json.data.runtime.perception.speaker;
    assert.ok(speaker, 'the one-stage lane must have a recognized speaker in raw evidence');
    row.actual.wireFlow.speakerState.speaker = speaker;
    const errors = errorsForCase(receipt, root, 'commute-bad-combined');
    assert.ok(errors.some((message) => /speakerState may not copy the raw speaker identifier/.test(message)),
      errors.slice(0, 5).join('; '));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a one-stage staged wire may not carry Tl rows', { skip: !hasRun }, () => {
  const { root, produced } = produceInto(freshRun);
  try {
    const receipt = clone(produced.manifest);
    const row = rowOf(receipt, 'calendar-four-card-field-matrix');
    const wire = readJsonl(root, row.actual.artifacts.wireTrace);
    rewriteJsonl(root, row.actual.artifacts.wireTrace, [...wire, { ...clone(wire[2]), stage: 'Tl' }]);
    const errors = errorsForCase(receipt, root, 'calendar-four-card-field-matrix');
    assert.ok(errors.some((message) => /must contain exactly 3 staged records/.test(message)), errors.slice(0, 5).join('; '));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the producer refuses a one-stage turn whose raw CONTEXT has no recognized speaker', { skip: !hasRun }, () => {
  const { run, bundles, bundleManifestPath } = copyRun();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-s13-out-'));
  try {
    // Strip the recognized speaker from the one-stage lane's raw CONTEXT.  The
    // source graph would then have opened a WhoIsThis question, so a one-stage
    // turn is no longer a lawful observation of this wire.
    const wirePath = path.join(run, bundles['commute-bad-combined'].bundle, bundles['commute-bad-combined'].wire);
    const rows = fs.readFileSync(wirePath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    let patched = 0;
    for (const record of rows) {
      if (record?.kind === 'client-message' && record.json?.type === 'CONTEXT' && record.json?.data?.runtime?.perception) {
        record.json.data.runtime.perception.speaker = null;
        patched += 1;
      }
    }
    assert.equal(patched, 1, 'the one-stage lane must have exactly one raw CONTEXT');
    fs.writeFileSync(wirePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
    assert.throws(() => produceCandidate(matrix, run, root, { bundles, bundleManifestPath }),
      /one-stage capture has no recognized speaker in its raw CONTEXT/);
  } finally {
    fs.rmSync(run, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the producer refuses a two-stage turn whose raw CONTEXT already had a speaker', { skip: !hasRun }, () => {
  const { run, bundles, bundleManifestPath } = copyRun();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-s13-out-'));
  try {
    const wirePath = path.join(run, bundles['commute-normal-combined'].bundle, bundles['commute-normal-combined'].wire);
    const rows = fs.readFileSync(wirePath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const contexts = rows.filter((record) => record?.kind === 'client-message' && record.json?.type === 'CONTEXT');
    assert.equal(contexts.length, 2, 'the two-stage lane must have one CONTEXT per stage');
    contexts[0].json.data.runtime.perception.speaker = 'synthetic-looper-id';
    fs.writeFileSync(wirePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
    assert.throws(() => produceCandidate(matrix, run, root, { bundles, bundleManifestPath }),
      /two-stage capture already had a recognized speaker in its raw CONTEXT/);
  } finally {
    fs.rmSync(run, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the producer refuses a one-stage turn that still records a local follow-up', { skip: !hasRun }, () => {
  const { run, bundles, bundleManifestPath } = copyRun();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-s13-out-'));
  try {
    const turnPath = path.join(run, bundles['commute-bad-combined'].bundle, bundles['commute-bad-combined'].turn);
    const turn = JSON.parse(fs.readFileSync(turnPath, 'utf8'));
    turn.followup = { used: true, calls: [{ requestID: 'synthetic', text: 'synthetic', updateCompleted: true }] };
    fs.writeFileSync(turnPath, JSON.stringify(turn));
    assert.throws(() => produceCandidate(matrix, run, root, { bundles, bundleManifestPath }),
      /one-stage capture records a local follow-up turn/);
  } finally {
    fs.rmSync(run, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the producer binds the WhoIsThis answer to its raw CLIENT_ASR line instead of a pinned name', { skip: !hasRun }, () => {
  const { run, bundles, bundleManifestPath } = copyRun();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-s13-out-'));
  try {
    const turnPath = path.join(run, bundles['commute-normal-combined'].bundle, bundles['commute-normal-combined'].turn);
    const turn = JSON.parse(fs.readFileSync(turnPath, 'utf8'));
    turn.followup.calls[0].text = `${turn.followup.calls[0].text}-tampered`;
    fs.writeFileSync(turnPath, JSON.stringify(turn));
    assert.throws(() => produceCandidate(matrix, run, root, { bundles, bundleManifestPath }),
      /followup SDK update text does not bind the raw followup CLIENT_ASR line/);
  } finally {
    fs.rmSync(run, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// These two guards were written for the two-stage flow only and silently
// disqualified an otherwise complete capture once a one-stage lane existed:
// `preflightProven` looked for `correlation.stages.initial.sdkAck` and
// `stages.followup.handle`, and `noBypass` demanded exactly one excluded
// whoIsThisMenu prelude.  A recognized speaker has neither, so both went false
// for the whole receipt.  They are shape-derived now.
test('a mixed-shape capture still proves its preflight and claims every row', { skip: !hasRun }, () => {
  const { root, produced } = produceInto(freshRun);
  try {
    const receipt = produced.manifest;
    assert.equal(receipt.preflight.proven, true, 'preflight must be proven across both shapes');
    assert.equal(receipt.preflight.contextSource, 'fixture-scoped-runtime');
    const shapes = new Set();
    for (const caseId of Object.keys(EXPECTED_SHAPES)) {
      const row = rowOf(receipt, caseId);
      shapes.add(row.actual.wireFlow.shape);
      assert.equal(row.status, 'pass', `${caseId} status`);
      assert.equal(row.claimed, true, `${caseId} claimed`);
      assert.equal(row.actual.noBypass, true, `${caseId} noBypass`);
    }
    // The guards are only meaningfully exercised when both shapes are present.
    assert.deepEqual([...shapes].sort(), ['one-stage', 'two-stage']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a one-stage lane that smuggles in an excluded prelude loses its noBypass claim', { skip: !hasRun }, () => {
  const { run, bundles, bundleManifestPath } = copyRun();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-s13-out-'));
  try {
    const turnPath = path.join(run, bundles['commute-bad-combined'].bundle, bundles['commute-bad-combined'].turn);
    const turn = JSON.parse(fs.readFileSync(turnPath, 'utf8'));
    turn.excludedDisplayActions = [{ viewId: 'whoIsThisMenu', captureStatus: 'excluded-prelude', eventIndex: 0 }];
    fs.writeFileSync(turnPath, JSON.stringify(turn));
    assert.throws(() => produceCandidate(matrix, run, root, { bundles, bundleManifestPath }),
      /one-stage capture carries 1 excluded prelude display actions/);
  } finally {
    fs.rmSync(run, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The Tl stage copies the SDK update record verbatim. Until this binding
// existed the local-turn body contract was unfalsifiable: the receipt could
// restate the local turn's rules or its answer text, or bolt on an extra
// field, and the validator never compared it to the raw follow-up call.
test('a two-stage lane is rejected when its Tl handle drifts from the raw follow-up call', { skip: !hasRun }, () => {
  const { root, produced } = produceInto(freshRun);
  try {
    for (const mutate of [
      (handle) => { handle.rules = ['forged']; },
      (handle) => { handle.text = `${handle.text}-forged`; },
      (handle) => { handle.nluRules = ['forged']; }
    ]) {
      const receipt = clone(produced.manifest);
      const row = rowOf(receipt, 'commute-normal-combined');
      const tl = row.actual.wireFlow.stages.find((stage) => stage.stage === 'Tl');
      assert.ok(tl?.handle, 'the two-stage lane must record a Tl handle');
      mutate(tl.handle);
      const errors = errorsForCase(receipt, root, 'commute-normal-combined');
      assert.ok(errors.some((message) => /wireFlow Tl handle does not bind the raw follow-up call/.test(message)),
        errors.slice(0, 5).join('; '));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
