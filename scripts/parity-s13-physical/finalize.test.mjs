import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReceipt } from './test-fixture.mjs';
import { compareSnapshotFiles, collect } from '../parity-s13-provenance/collect.mjs';
import { prepareFinalization } from './finalize.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const matrix = JSON.parse(fs.readFileSync(path.join(here, 'matrix.json'), 'utf8'));
const remoteFixture = JSON.parse(fs.readFileSync(path.join(here, '../parity-s13-provenance/fixtures/remote-complete.json'), 'utf8'));

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); }
function artifact(root, relative) { const bytes = fs.readFileSync(path.join(root, relative)); return { path: relative, sha256: sha256(bytes), bytes: bytes.length }; }
function command(directory, argv) {
  const result = childProcess.spawnSync(argv[0], argv.slice(1), { cwd: directory, encoding: 'utf8' });
  assert.equal(result.status, 0, `${argv.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

async function collectorPair(root) {
  const frame = path.join(root, 'remote-frame.txt');
  fs.writeFileSync(frame, `S13P1\t${JSON.stringify(remoteFixture)}\n`, { mode: 0o600 });
  const ssh = path.join(root, 'fake-ssh');
  fs.writeFileSync(ssh, `#!/bin/sh\ncat '${frame}'\n`, { mode: 0o700 });
  fs.chmodSync(ssh, 0o700);
  const before = path.join(root, 'before.json');
  const after = path.join(root, 'after.json');
  await collect({ host: 'fixture-host', slot: 'fixture-slot', out: before, sshBin: ssh });
  await collect({ host: 'fixture-host', slot: 'fixture-slot', out: after, sshBin: ssh });
  return { before, after, comparison: path.join(root, 'comparison.json') };
}

function writeSourceManifest(sourceRoot, revision, target) {
  const files = command(sourceRoot, ['git', 'ls-files']).trim().split('\n').filter(Boolean).map((relative) => {
    const bytes = fs.readFileSync(path.join(sourceRoot, relative));
    return { path: relative, bytes: bytes.length, sha256: sha256(bytes) };
  });
  const manifest = { schema: 'phoenix-s13-source-manifest-v1', revision, files, treeSha256: sha256(Buffer.from(JSON.stringify(files))) };
  writeJson(target, manifest);
}

function candidateWithRawRun(root, revision) {
  const receipt = buildReceipt(matrix, root, { revision });
  const raw = { schema: 'phoenix-s13-raw-run-manifest-v1', fixtureBinding: { matches: true, mismatches: [] } };
  writeJson(path.join(root, 'raw/run-manifest.json'), raw);
  const rawRef = artifact(root, 'raw/run-manifest.json');
  receipt.provenance.sourceRun = rawRef;
  receipt.decision = 'open';
  receipt.taskStatus = 'open';
  receipt.complete = false;
  receipt.falsification = { result: 'not-run', controls: [], controlsSha256: sha256(Buffer.from('[]')) };
  writeJson(path.join(root, 'receipt.json'), receipt);
  return { receipt, sourceRunRef: rawRef, receiptSha256: sha256(fs.readFileSync(path.join(root, 'receipt.json'))) };
}

function reviewFor(receipt, session) {
  const reviews = [];
  for (const row of receipt.cases) {
    if (row.status !== 'pass' || !matrix.cases.find((item) => item.id === row.id && item.kind === 'physical')) continue;
    for (const shot of row.actual.screenshots) reviews.push({ caseId: row.id, captureOrdinal: shot.viewOrdinal, path: shot.path, sha256: shot.pixelSha256, viewId: shot.viewId, bytes: shot.bytes, verdict: 'pass' });
  }
  return { schema: 'phoenix-s13-visual-review-v2', reviewer: 'independent-fixture-reviewer', independentReviewer: true, reviewedAt: receipt.runtime.captureISO, allPassed: true, targetCount: reviews.length, session, reviews };
}

function controlRecord(receipt, session) {
  return {
    schema: 'phoenix-s13-real-receipt-falsification-v1', task: 'S-13', result: 'pass', provisional: false,
    target: { phoenixRevision: receipt.phoenixRevision, ...session }, codeRevision: receipt.phoenixRevision,
    codeSha256: sha256(fs.readFileSync(path.join(here, 'falsify.mjs'))), startedAtISO: receipt.runtime.captureISO, endedAtISO: new Date(Date.parse(receipt.runtime.captureISO) + 1000).toISOString(),
    controls: matrix.falsificationControls.map((id) => ({ id, status: 'rejected', exitCode: 1, evidence: `fixture ${id} rejected` }))
  };
}

test('finalizer stages only exact bound inputs and calculates a session-bound independent-anchor request', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-s13-finalize-'));
  try {
    const source = path.join(root, 'source');
    fs.mkdirSync(source);
    command(source, ['git', 'init', '-q']);
    command(source, ['git', 'config', 'user.email', 'fixture@example.test']);
    command(source, ['git', 'config', 'user.name', 'Fixture']);
    fs.writeFileSync(path.join(source, 'index.js'), 'export default 13;\n');
    command(source, ['git', 'add', 'index.js']);
    command(source, ['git', 'commit', '-qm', 'fixture']);
    const revision = command(source, ['git', 'rev-parse', 'HEAD']).trim();
    const candidateRoot = path.join(root, 'candidate');
    const candidate = candidateWithRawRun(candidateRoot, revision);
    const snapshots = await collectorPair(root);
    const started = Date.parse(candidate.receipt.runtime.captureISO);
    const before = JSON.parse(fs.readFileSync(snapshots.before, 'utf8'));
    const after = JSON.parse(fs.readFileSync(snapshots.after, 'utf8'));
    before.capturedAt.utcStarted = new Date(started - 3000).toISOString();
    before.capturedAt.utcEnded = new Date(started - 1000).toISOString();
    after.capturedAt.utcStarted = new Date(started + 4000).toISOString();
    after.capturedAt.utcEnded = new Date(started + 6000).toISOString();
    writeJson(snapshots.before, before);
    writeJson(snapshots.after, after);
    compareSnapshotFiles(snapshots.before, snapshots.after, snapshots.comparison);
    const sourceManifest = path.join(root, 'source-manifest.json');
    writeSourceManifest(source, revision, sourceManifest);
    const session = { candidateReceiptSha256: candidate.receiptSha256, sourceRunSha256: candidate.sourceRunRef.sha256 };
    const review = path.join(root, 'independent-review.json');
    writeJson(review, reviewFor(candidate.receipt, session));
    const falsification = path.join(root, 'real-falsification.json');
    writeJson(falsification, controlRecord(candidate.receipt, session));
    const preview = path.join(root, 'preview');
    const prepared = prepareFinalization({ candidateRoot, out: preview, before: snapshots.before, after: snapshots.after, comparison: snapshots.comparison, sourceManifest, sourceRoot: source, visualReview: review, falsification });
    assert.equal(prepared.receipt.complete, true);
    assert.deepEqual(prepared.expectedExternalAnchors.session, session);
    assert.equal(prepared.expectedExternalAnchors.visualReviewSha256, sha256(fs.readFileSync(review)));
    assert.equal(prepared.receipt.provenance.collector.before.sha256, sha256(fs.readFileSync(snapshots.before)));
    assert.equal(prepared.receipt.provenance.phoenix.sourceManifestSha256, sha256(fs.readFileSync(sourceManifest)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('finalizer refuses self-authored review and mismatched raw-run session evidence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-s13-finalize-negative-'));
  try {
    const source = path.join(root, 'source'); fs.mkdirSync(source);
    command(source, ['git', 'init', '-q']); command(source, ['git', 'config', 'user.email', 'fixture@example.test']); command(source, ['git', 'config', 'user.name', 'Fixture']);
    fs.writeFileSync(path.join(source, 'index.js'), 'export default 13;\n'); command(source, ['git', 'add', 'index.js']); command(source, ['git', 'commit', '-qm', 'fixture']);
    const revision = command(source, ['git', 'rev-parse', 'HEAD']).trim();
    const candidateRoot = path.join(root, 'candidate'); const candidate = candidateWithRawRun(candidateRoot, revision);
    const snapshots = await collectorPair(root); compareSnapshotFiles(snapshots.before, snapshots.after, snapshots.comparison);
    const sourceManifest = path.join(root, 'source-manifest.json'); writeSourceManifest(source, revision, sourceManifest);
    const session = { candidateReceiptSha256: candidate.receiptSha256, sourceRunSha256: candidate.sourceRunRef.sha256 };
    const review = path.join(root, 'review.json'); const bad = reviewFor(candidate.receipt, session); bad.reviewer = 'root-agent-direct-visual-inspection'; writeJson(review, bad);
    const falsification = path.join(root, 'falsification.json'); writeJson(falsification, controlRecord(candidate.receipt, session));
    assert.throws(() => prepareFinalization({ candidateRoot, out: path.join(root, 'out'), before: snapshots.before, after: snapshots.after, comparison: snapshots.comparison, sourceManifest, sourceRoot: source, visualReview: review, falsification }), /independent reviewer/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('real falsifier plan is explicitly provisional and binds the open candidate session', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-s13-falsifier-plan-'));
  try {
    const candidateRoot = path.join(root, 'candidate');
    const candidate = candidateWithRawRun(candidateRoot, matrix.baseRevision);
    const out = path.join(root, 'provisional.json');
    const result = childProcess.spawnSync(process.execPath, [path.join(here, 'falsify.mjs'), '--plan', '--candidate-root', candidateRoot, '--out', out], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const record = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(record.provisional, true);
    assert.equal(record.target.candidateReceiptSha256, candidate.receiptSha256);
    assert.equal(record.target.sourceRunSha256, candidate.sourceRunRef.sha256);
    assert.deepEqual(record.controls.map((item) => item.id), matrix.falsificationControls);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
