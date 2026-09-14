#!/usr/bin/env node

// Run isolated mutations against the checked-in S-13 contract.  Every
// mutation must be rejected by the same pure validator used for a real run.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildReceipt } from './test-fixture.mjs';
import { canonicalJson, canonicalSha256, falsificationAnchorSha256, matrixSha256, matrixInventory, provenanceAnchorSha256, sha256Bytes, validateReceipt } from './validate.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const matrixPath = path.join(here, 'matrix.json');
const baselineMatrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function writeJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
function rewriteJsonArtifact(root, ref, value) {
  const bytes = Buffer.from(canonicalJson(value), 'utf8');
  fs.writeFileSync(path.join(root, ref.path), bytes);
  ref.sha256 = sha256Bytes(bytes);
  ref.bytes = bytes.length;
}
function rewriteJsonlArtifact(root, ref, values) {
  const bytes = Buffer.from(`${values.map((value) => canonicalJson(value)).join('\n')}\n`, 'utf8');
  fs.writeFileSync(path.join(root, ref.path), bytes);
  ref.sha256 = sha256Bytes(bytes);
  ref.bytes = bytes.length;
}
function recomputeSelfReports(matrix) {
  matrix.integrity.matrixSha256 = matrixSha256(matrix);
  matrix.integrity.caseInventorySha256 = canonicalSha256(matrixInventory(matrix));
}

function realFail(message) { throw new Error(`S13 real falsifier: ${message}`); }
function realClone(value) { return JSON.parse(JSON.stringify(value)); }
function realReadJson(file, label) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { realFail(`${label} cannot be opened: ${error.code || error.message}`); }
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(file) !== path.resolve(file)) realFail(`${label} must be a regular non-symlink JSON file`);
  try { return { value: JSON.parse(fs.readFileSync(file, 'utf8')), bytes: fs.readFileSync(file) }; }
  catch (error) { realFail(`${label} is not JSON: ${error.message}`); }
}
function realArtifactPath(root, ref, label) {
  if (!ref || typeof ref.path !== 'string') realFail(`${label} reference is absent`);
  const target = path.resolve(root, ref.path);
  if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) realFail(`${label} escapes root`);
  return target;
}
function realWriteJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
function realSession(receipt) {
  const candidate = receipt?.provenance?.candidateReceipt;
  const sourceRun = receipt?.provenance?.sourceRun;
  if (!candidate || !/^[a-f0-9]{64}$/.test(candidate.sha256) || !sourceRun || !/^[a-f0-9]{64}$/.test(sourceRun.sha256)) realFail('receipt does not bind the open candidate and raw run');
  return { candidateReceiptSha256: candidate.sha256, sourceRunSha256: sourceRun.sha256 };
}
function realParseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--plan' || token === '--real-receipt') { args.mode = token.slice(2); continue; }
    if (token === '--candidate-root' || token === '--root' || token === '--receipt' || token === '--out') args[token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = path.resolve(argv[++index]);
    else if (token === '--capture-window') { args.captureWindow = { startISO: argv[++index], endISO: argv[++index] }; }
    else if (token === '--help' || token === '-h') args.help = true;
    else realFail(`unknown option ${token}`);
  }
  return args;
}
function realUsage() {
  return 'Usage: falsify.mjs --plan --candidate-root CANDIDATE --out PROVISIONAL.json\n       falsify.mjs --real-receipt --root RECEIPT_ROOT --receipt RECEIPT.json --capture-window START_ISO END_ISO --out REAL.json';
}
function realPlan(args) {
  if (!args.candidateRoot || !args.out) realFail('--plan needs --candidate-root and --out');
  const candidatePath = path.join(args.candidateRoot, 'receipt.json');
  const candidate = realReadJson(candidatePath, 'open candidate').value;
  if (candidate.decision !== 'open' || candidate.taskStatus !== 'open' || candidate.complete !== false || candidate.falsification?.result !== 'not-run') realFail('plan input must be the open raw producer candidate');
  const sourceRun = candidate?.provenance?.sourceRun;
  if (!sourceRun || !/^[a-f0-9]{64}$/.test(sourceRun.sha256)) realFail('open candidate must bind raw/run-manifest.json');
  const candidateBytes = fs.readFileSync(candidatePath);
  const controls = baselineMatrix.falsificationControls.map((id) => ({ id, status: 'rejected', exitCode: 1, evidence: `provisional control placeholder for ${id}; replaced by --real-receipt output before acceptance` }));
  const record = {
    schema: 'phoenix-s13-real-receipt-falsification-v1', task: 'S-13', result: 'pass', provisional: true,
    target: { phoenixRevision: candidate.phoenixRevision, candidateReceiptSha256: sha256Bytes(candidateBytes), sourceRunSha256: sourceRun.sha256 },
    codeRevision: candidate.phoenixRevision, codeSha256: sha256Bytes(fs.readFileSync(path.join(here, 'falsify.mjs'))),
    startedAtISO: new Date().toISOString(), endedAtISO: new Date().toISOString(), controls
  };
  fs.mkdirSync(path.dirname(args.out), { recursive: true, mode: 0o700 });
  realWriteJson(args.out, record);
  console.log(JSON.stringify({ result: 'provisional', out: args.out, controls: controls.length }));
}
function realAnchor(receipt, window) {
  const review = receipt.visualReview || receipt.provenance?.visualReview;
  if (!review || !/^[a-f0-9]{64}$/.test(review.sha256)) realFail('receipt is missing its global visual review');
  const falsification = receipt.falsification;
  falsification.receiptSha256 = falsificationAnchorSha256(falsification);
  return {
    schema: 'phoenix.parity.s13.external-validation-anchors.v1', visualReviewSha256: review.sha256,
    provenanceSha256: provenanceAnchorSha256(receipt), captureWindow: window,
    falsifierReceiptSha256: falsificationAnchorSha256(falsification)
  };
}
function realPhysicalRows(receipt) {
  return receipt.cases.filter((row) => row.status === 'pass' && row.actual?.screenshots?.length);
}
function realFirstPhysical(receipt) {
  const row = realPhysicalRows(receipt)[0];
  if (!row) realFail('receipt has no captured physical row');
  return row;
}
function realArtifactJson(root, ref, label) {
  const target = realArtifactPath(root, ref, label);
  return { target, value: JSON.parse(fs.readFileSync(target, 'utf8')) };
}
function realRunControl({ id, mutate, root, receiptPath, receipt, window }) {
  const trial = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-s13-real-falsify-'));
  try {
    fs.cpSync(root, trial, { recursive: true, dereference: false, errorOnExist: true });
    const cloned = realClone(receipt);
    const matrix = realClone(baselineMatrix);
    mutate(cloned, trial, matrix);
    if (cloned.falsification) cloned.falsification.receiptSha256 = falsificationAnchorSha256(cloned.falsification);
    realWriteJson(path.join(trial, path.relative(root, receiptPath)), cloned);
    const report = validateReceipt(cloned, matrix, { root: trial, externalAnchors: realAnchor(cloned, window) });
    return { id, status: report.result === 'fail' ? 'rejected' : 'accepted', exitCode: report.result === 'fail' ? 1 : 0, evidence: report.errors.slice(0, 3).join('; ') || 'validator accepted mutation' };
  } finally { fs.rmSync(trial, { recursive: true, force: true }); }
}
function realControls(root, receiptPath, receipt, window) {
  const noView = () => receipt.cases.find((row) => row.id === 'calendar-no-view-empty');
  const blocked = () => receipt.cases.find((row) => row.id === 'calendar-tree-park-nature');
  const specifications = [
    ['matrix-case-omission', (_r, _trial, matrix) => matrix.cases.pop()],
    ['matrix-case-reorder', (_r, _trial, matrix) => [matrix.cases[0], matrix.cases[1]] = [matrix.cases[1], matrix.cases[0]]],
    ['receipt-case-omission', (r) => r.cases.pop()],
    ['receipt-case-reorder', (r) => [r.cases[0], r.cases[1]] = [r.cases[1], r.cases[0]]],
    ['stale-phoenix-revision', (r) => { r.phoenixRevision = '0'.repeat(40); }],
    ['provenance-version-omission', (r) => { delete r.provenance.client.version; }],
    ['input-payload-mutation', (r) => { const row = realFirstPhysical(r); row.actual.request.phrase = 'forged input'; }],
    ['action-payload-mutation', (r) => { const row = realFirstPhysical(r); row.actual.action.mimIds[0] = 'ForgedMim'; }],
    ['view-contract-mutation', (r) => { const row = realFirstPhysical(r); row.actual.action.viewIds[0] = 'forgedView'; }],
    ['correlation-mismatch', (r) => { const row = realFirstPhysical(r); row.actual.correlation.transID = 'forged'; }],
    ['wire-trace-hash-mismatch', (r, trial) => { const row = realFirstPhysical(r); fs.appendFileSync(realArtifactPath(trial, row.actual.artifacts.rawWire || row.actual.artifacts.wireTrace, 'wire'), 'forged\n'); }],
    ['screenshot-order-mutation', (r) => { const row = r.cases.find((item) => item.actual?.screenshots?.length > 1); [row.actual.screenshots[0], row.actual.screenshots[1]] = [row.actual.screenshots[1], row.actual.screenshots[0]]; }],
    ['screenshot-bytes-mutation', (r, trial) => { const shot = realFirstPhysical(r).actual.screenshots[0]; const file = realArtifactPath(trial, shot, 'screenshot'); const bytes = fs.readFileSync(file); bytes[0] ^= 0xff; fs.writeFileSync(file, bytes); }],
    ['idle-closure-omission', (r) => { delete realFirstPhysical(r).actual.timeline.idle; }],
    ['no-view-screenshot-injection', (r) => { const row = noView(); row.actual.screenshots.push({ ordinal: 0, viewId: 'eventView' }); }],
    ['blocked-tree-claim', (r) => { const row = blocked(); row.status = 'pass'; row.claimed = true; }],
    ['falsification-control-omission', (r) => { r.falsification.controls.shift(); }],
    ['screenshot-identity-swap', (r) => { const rows = r.cases.filter((row) => row.actual?.screenshots?.length); const first = rows[0].actual.screenshots[0]; rows[1].actual.screenshots[0] = { ...first, path: rows[1].actual.screenshots[0].path }; }],
    ['png-chunk-corruption', (r, trial) => { const shot = realFirstPhysical(r).actual.screenshots[0]; const file = realArtifactPath(trial, shot, 'screenshot'); const bytes = fs.readFileSync(file); bytes.writeUInt32BE(0xffffffff, 8); fs.writeFileSync(file, bytes); }],
    ['local-turn-body-contract-mutation', (r) => { const row = realFirstPhysical(r); const handle = row.actual.correlation?.stages?.Tl?.handle; if (!handle) realFail('Tl local followup is absent'); handle.nluRules = ['forged']; }],
    ['pm-availability-contradiction', (r) => { r.runtime.captureConditions.pmDepartureAvailable = false; const row = r.cases.find((item) => item.id === 'commute-pm-departure-combined'); row.status = 'pass'; delete row.skipReason; }],
    ['revalidation-date-mutation', (r, trial) => { const row = r.cases.find((item) => item.id === 'weather-revalidation'); const linked = realArtifactJson(trial, row.actual.sourceReceipt, 'weather source receipt'); linked.value.date = '2000-01-01'; realWriteJson(linked.target, linked.value); }],
    ['native-request-omission', (r) => { delete realFirstPhysical(r).actual.artifacts.rawTurn; }],
    ['wire-request-omission', (r) => { delete realFirstPhysical(r).actual.artifacts.rawWire; }],
    ['ack-payload-mutation', (r, trial) => { const row = realFirstPhysical(r); const raw = realArtifactJson(trial, row.actual.artifacts.rawTurn, 'raw turn'); raw.value.ack.requestID = 'forged'; realWriteJson(raw.target, raw.value); }],
    ['timeline-order-mutation', (r) => { const row = realFirstPhysical(r); row.actual.timeline.views[0].openedAtISO = row.actual.timeline.idle.observedAtISO; }],
    ['falsification-execution-metadata-mutation', (r) => { r.falsification.execution.command = 'node forged.mjs'; }],
    ['provenance-anchor-mutation', (r, trial) => { const ref = r.provenance.anchors.validator; fs.appendFileSync(realArtifactPath(trial, ref, 'validator anchor'), 'forged'); }],
    ['context-anchor-omission', (r) => { delete realFirstPhysical(r).actual.artifacts.contextAnchor; }],
  ];
  if (specifications.length !== baselineMatrix.falsificationControls.length || specifications.some(([id], index) => id !== baselineMatrix.falsificationControls[index])) realFail('real falsifier control map diverges from the matrix');
  return specifications.map(([id, mutate]) => realRunControl({ id, mutate, root, receiptPath, receipt, window }));
}
function realReceipt(args) {
  if (!args.root || !args.receipt || !args.out || !args.captureWindow?.startISO || !args.captureWindow?.endISO) realFail('--real-receipt needs --root --receipt --capture-window START END --out');
  const root = path.resolve(args.root);
  const receiptInput = realReadJson(args.receipt, 'terminal receipt');
  const receipt = receiptInput.value;
  const session = realSession(receipt);
  const initialAnchors = realAnchor(receipt, args.captureWindow);
  const baseline = validateReceipt(receipt, baselineMatrix, { root, externalAnchors: initialAnchors });
  if (baseline.result !== 'pass') realFail(`terminal baseline is rejected: ${baseline.errors.slice(0, 5).join('; ')}`);
  const controls = realControls(root, path.resolve(args.receipt), receipt, args.captureWindow);
  const record = {
    schema: 'phoenix-s13-real-receipt-falsification-v1', task: 'S-13', result: controls.every((control) => control.status === 'rejected') ? 'pass' : 'fail', provisional: false,
    target: { phoenixRevision: receipt.phoenixRevision, ...session }, codeRevision: receipt.phoenixRevision,
    codeSha256: sha256Bytes(fs.readFileSync(path.join(here, 'falsify.mjs'))), startedAtISO: new Date().toISOString(), endedAtISO: new Date().toISOString(), controls
  };
  fs.mkdirSync(path.dirname(args.out), { recursive: true, mode: 0o700 });
  realWriteJson(args.out, record);
  console.log(JSON.stringify({ result: record.result, out: args.out, controls: controls.map(({ id, status }) => ({ id, status })) }));
  if (record.result !== 'pass') process.exitCode = 1;
}

const realArgs = realParseArgs(process.argv.slice(2));
if (realArgs.help) {
  console.log(realUsage());
} else if (realArgs.mode === 'plan') {
  try { realPlan(realArgs); } catch (error) { console.error(error.message || error); process.exitCode = 1; }
} else if (realArgs.mode === 'real-receipt') {
  try { realReceipt(realArgs); } catch (error) { console.error(error.message || error); process.exitCode = 1; }
} else {

function runReceiptMutation(name, mutate, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-s13-falsify-'));
  try {
    const receipt = buildReceipt(baselineMatrix, root, options);
    mutate(receipt, root);
    const report = validateReceipt(receipt, baselineMatrix, { root });
    return { name, expected: 'fail', actual: report.result, rejected: report.result === 'fail', errors: report.errors.slice(0, 3) };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function runMatrixMutation(name, mutate) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-s13-matrix-falsify-'));
  try {
    const matrix = clone(baselineMatrix);
    mutate(matrix);
    // An attacker may rewrite the self-reported hashes; the validator's code
    // pins the immutable values and must still reject the changed contract.
    recomputeSelfReports(matrix);
    const receipt = buildReceipt(matrix, root);
    const report = validateReceipt(receipt, matrix, { root });
    return { name, expected: 'fail', actual: report.result, rejected: report.result === 'fail', errors: report.errors.slice(0, 3) };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const baselineRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-s13-baseline-'));
let baseline;
try {
  baseline = validateReceipt(buildReceipt(baselineMatrix, baselineRoot), baselineMatrix, { root: baselineRoot });
} finally {
  fs.rmSync(baselineRoot, { recursive: true, force: true });
}
if (baseline.result !== 'pass') throw new Error(`baseline receipt does not pass: ${baseline.errors.slice(0, 5).join('; ')}`);

const checks = [
  runMatrixMutation('rehashed matrix case omission', (matrix) => matrix.cases.pop()),
  runMatrixMutation('rehashed matrix case reorder', (matrix) => [matrix.cases[0], matrix.cases[1]] = [matrix.cases[1], matrix.cases[0]]),
  runMatrixMutation('rehashed matrix action mutation', (matrix) => { matrix.cases[0].expected.mimIds[0] = 'ForgedMim'; }),
  runReceiptMutation('receipt case omission', (receipt) => receipt.cases.pop()),
  runReceiptMutation('receipt case reorder', (receipt) => [receipt.cases[0], receipt.cases[1]] = [receipt.cases[1], receipt.cases[0]]),
  runReceiptMutation('stale Phoenix revision', (receipt) => { receipt.phoenixRevision = '0'.repeat(40); }),
  runReceiptMutation('preflight operation changed', (receipt) => { receipt.preflight.operation = 'unprovenOperation'; }),
  runReceiptMutation('runtime client version omitted', (receipt) => { delete receipt.provenance.client.version; }),
  runReceiptMutation('request mutation with attempted prefs rehash', (receipt) => {
    const row = receipt.cases.find((item) => item.id === 'commute-bad-combined');
    row.actual.request.prefs.trafficSeconds = 600;
    row.actual.request.prefsResolution.sha256 = canonicalSha256(row.actual.request.prefs);
  }),
  runReceiptMutation('action view mutation with attempted payload rehash', (receipt) => {
    const row = receipt.cases.find((item) => item.id === 'calendar-four-card-field-matrix');
    row.actual.action.projection.viewContracts[1].labels.summary = 'forged';
    for (const stream of ['phoenix', 'native', 'wire']) {
      row.actual.action.payload[stream].projection = row.actual.action.projection;
      row.actual.action[`${stream}CanonicalSha256`] = canonicalSha256(row.actual.action.payload[stream]);
    }
    row.actual.action.payloadSha256 = canonicalSha256(row.actual.action.payload);
  }),
  runReceiptMutation('correlation mismatch', (receipt) => { receipt.cases[0].actual.correlation.transID = 'wrong-trans'; }),
  runReceiptMutation('wire trace bytes changed', (receipt, root) => {
    const file = receipt.cases[0].actual.artifacts.wireTrace.path;
    fs.appendFileSync(path.join(root, file), 'forged');
  }),
  runReceiptMutation('native trace action content changed with rehashed artifact', (receipt, root) => {
    const row = receipt.cases.find((item) => item.id === 'commute-normal-combined');
    const ref = row.actual.artifacts.nativeReport;
    const report = JSON.parse(fs.readFileSync(path.join(root, ref.path), 'utf8'));
    report.events[1].payload.projection.mimIds[0] = 'ForgedMim';
    rewriteJsonArtifact(root, ref, report);
  }),
  runReceiptMutation('provider trace content changed with rehashed artifact', (receipt, root) => {
    const row = receipt.cases.find((item) => item.id === 'commute-normal-combined');
    const ref = row.actual.artifacts.providerTrace;
    const records = fs.readFileSync(path.join(root, ref.path), 'utf8').trim().split(/\n/).map((line) => JSON.parse(line));
    records[0].provider.trafficSeconds = 1;
    rewriteJsonlArtifact(root, ref, records);
  }),
  runReceiptMutation('private provider fixture content changed with rehashed artifact', (receipt, root) => {
    const row = receipt.cases.find((item) => item.id === 'commute-normal-combined');
    const fixtureRef = row.actual.artifacts.providerFixture;
    const fixture = JSON.parse(fs.readFileSync(path.join(root, fixtureRef.path), 'utf8'));
    fixture.fixture = 'forged-fixture';
    rewriteJsonArtifact(root, fixtureRef, fixture);
    row.actual.provider.fixtureSha256 = fixtureRef.sha256;
    const traceRef = row.actual.artifacts.providerTrace;
    const records = fs.readFileSync(path.join(root, traceRef.path), 'utf8').trim().split(/\n/).map((line) => JSON.parse(line));
    records.forEach((record) => {
      if (record.type === 'provider-call' || record.type === 'provider-return') {
        record.fixtureSha256 = fixtureRef.sha256;
        record.provider.fixtureSha256 = fixtureRef.sha256;
      }
    });
    rewriteJsonlArtifact(root, traceRef, records);
  }),
  runReceiptMutation('capture timestamp moved outside artifact trace range', (receipt) => {
    receipt.runtime.captureISO = '1970-01-01T00:00:00.000Z';
    receipt.preflight.context.runtimeLocationISO = receipt.runtime.captureISO;
    receipt.preflight.contextSha256 = canonicalSha256(receipt.preflight.context);
  }),
  runReceiptMutation('PNG signature changed with rehashed screenshot', (receipt, root) => {
    const row = receipt.cases.find((item) => item.id === 'commute-normal-combined');
    const shot = row.actual.screenshots[0];
    const file = path.join(root, shot.path);
    const bytes = fs.readFileSync(file);
    bytes[0] = 0;
    fs.writeFileSync(file, bytes);
    shot.sha256 = sha256Bytes(bytes);
    shot.bytes = bytes.length;
  }),
  runReceiptMutation('final screenshot symlink substituted', (receipt, root) => {
    const row = receipt.cases.find((item) => item.id === 'commute-normal-combined');
    const shot = row.actual.screenshots[0];
    const file = path.join(root, shot.path);
    const target = path.join(root, 'symlink-target.png');
    fs.copyFileSync(file, target);
    fs.unlinkSync(file);
    fs.symlinkSync(target, file);
  }),
  runReceiptMutation('screenshot symlinked ancestor substituted', (receipt, root) => {
    const row = receipt.cases.find((item) => item.id === 'commute-normal-combined');
    const screenshotDir = path.dirname(path.join(root, row.actual.screenshots[0].path));
    const movedDir = path.join(root, 'moved-screenshot-dir');
    fs.renameSync(screenshotDir, movedDir);
    fs.symlinkSync(movedDir, screenshotDir, 'dir');
  }),
  runReceiptMutation('linked no-view receipt content changed with rehashed artifact', (receipt, root) => {
    const row = receipt.cases.find((item) => item.id === 'calendar-no-view-empty');
    const ref = row.actual.sourceReceipt;
    const source = JSON.parse(fs.readFileSync(path.join(root, ref.path), 'utf8'));
    source.result = 'fail';
    rewriteJsonArtifact(root, ref, source);
  }),
  runReceiptMutation('same-ID screenshot reorder', (receipt) => {
    const row = receipt.cases.find((item) => item.id === 'calendar-concurrent-parallel');
    [row.actual.screenshots[0], row.actual.screenshots[1]] = [row.actual.screenshots[1], row.actual.screenshots[0]];
  }),
  runReceiptMutation('idle closure omitted', (receipt) => { delete receipt.cases[0].actual.timeline.idle; }),
  runReceiptMutation('no-view screenshot injected', (receipt) => { receipt.cases.find((item) => item.id === 'calendar-no-view-empty').actual.screenshots.push({ ordinal: 0, viewId: 'eventView' }); }),
  runReceiptMutation('blocked tree case claimed', (receipt) => {
    const row = receipt.cases.find((item) => item.id === 'calendar-tree-park-nature');
    row.status = 'pass';
    row.claimed = true;
  }),
  runReceiptMutation('falsification control omitted', (receipt) => receipt.falsification.controls.shift())
  ,runReceiptMutation('screenshot identity swapped across cases', (receipt) => {
    const first = receipt.cases.find((item) => item.id === 'commute-normal-combined');
    const second = receipt.cases.find((item) => item.id === 'commute-bad-combined');
    const source = first.actual.screenshots[0];
    first.actual.screenshots[0] = { ...second.actual.screenshots[0], path: source.path, sha256: source.sha256, bytes: source.bytes, pixelSha256: source.pixelSha256, artifactIdentity: source.artifactIdentity };
  }),
  runReceiptMutation('PNG chunk framing or CRC changed with rehash', (receipt, root) => {
    const shot = receipt.cases[0].actual.screenshots[0];
    const file = path.join(root, shot.path);
    const bytes = fs.readFileSync(file);
    bytes.writeUInt32BE(0xffffffff, 8);
    fs.writeFileSync(file, bytes);
    shot.sha256 = sha256Bytes(bytes);
    shot.pixelSha256 = shot.sha256;
    shot.artifactIdentity = canonicalSha256({ caseId: receipt.cases[0].id, caseOrdinal: receipt.cases[0].ordinal, viewOrdinal: shot.viewOrdinal, viewId: shot.viewId, pixelSha256: shot.pixelSha256 });
  }),
  runReceiptMutation('local-turn body contract changed after rehash', (receipt) => {
    const row = receipt.cases.find((item) => item.id === 'commute-normal-combined');
    row.actual.request.body.nluRules = ['forged'];
    row.actual.request.bodySha256 = canonicalSha256(row.actual.request.body);
  }, { selectedOperation: 'startLocalTurn' }),
  runReceiptMutation('PM availability false with a pass row', (receipt) => {
    const row = receipt.cases.find((item) => item.id === 'commute-pm-departure-combined');
    row.status = 'pass';
    row.skipReason = undefined;
  }),
  runReceiptMutation('revalidation prior date changed', (receipt, root) => {
    const row = receipt.cases.find((item) => item.id === 'weather-revalidation');
    const ref = row.actual.sourceReceipt;
    const prior = JSON.parse(fs.readFileSync(path.join(root, ref.path), 'utf8'));
    prior.date = '2000-01-01';
    rewriteJsonArtifact(root, ref, prior);
  }),
  runReceiptMutation('native request record omitted', (receipt, root) => {
    const row = receipt.cases[0];
    const ref = row.actual.artifacts.nativeReport;
    const report = JSON.parse(fs.readFileSync(path.join(root, ref.path), 'utf8'));
    report.events = report.events.filter((event) => event.type !== 'request');
    rewriteJsonArtifact(root, ref, report);
  }),
  runReceiptMutation('wire request record omitted', (receipt, root) => {
    const row = receipt.cases[0];
    const ref = row.actual.artifacts.wireTrace;
    const records = fs.readFileSync(path.join(root, ref.path), 'utf8').trim().split(/\n/).map((line) => JSON.parse(line)).filter((record) => record.type !== 'request');
    rewriteJsonlArtifact(root, ref, records);
  }),
  runReceiptMutation('ACK payload changed with rehash', (receipt, root) => {
    const row = receipt.cases[0];
    const ref = row.actual.artifacts.wireTrace;
    const records = fs.readFileSync(path.join(root, ref.path), 'utf8').trim().split(/\n/).map((line) => JSON.parse(line));
    const ack = records.find((record) => record.type === 'ack');
    ack.payload.caseId = 'forged';
    ack.payloadSha256 = canonicalSha256(ack.payload);
    rewriteJsonlArtifact(root, ref, records);
  }),
  runReceiptMutation('timeline action/open/idle order changed', (receipt) => {
    const row = receipt.cases[0];
    row.actual.timeline.views[0].openedAtISO = row.actual.timeline.idle.observedAtISO;
  }),
  runReceiptMutation('falsification execution metadata changed', (receipt, root) => {
    receipt.falsification.execution.command = 'node forged.mjs';
    const ref = receipt.falsification.executionArtifact;
    const document = JSON.parse(fs.readFileSync(path.join(root, ref.path), 'utf8'));
    document.command = receipt.falsification.execution.command;
    rewriteJsonArtifact(root, ref, document);
  }),
  runReceiptMutation('provenance anchor changed with rehash', (receipt, root) => {
    const ref = receipt.provenance.anchors.validator;
    const bytes = Buffer.from(`${fs.readFileSync(path.join(root, ref.path), 'utf8')}\nforged`, 'utf8');
    fs.writeFileSync(path.join(root, ref.path), bytes);
    ref.sha256 = sha256Bytes(bytes);
    ref.bytes = bytes.length;
  })
  ,runReceiptMutation('context anchor omitted', (receipt) => {
    const row = receipt.cases.find((item) => item.id === 'commute-normal-combined');
    delete row.actual.artifacts.contextAnchor;
  })
];

const summary = {
  schema: 'phoenix.parity.s13.physical-capture-falsification.v1', task: 'S-13', baseline: 'pass',
  checks, result: checks.every((check) => check.rejected) ? 'pass' : 'fail'
};
const outPath = process.env.S13_FALSIFICATION_OUT ? path.resolve(process.env.S13_FALSIFICATION_OUT) : null;
if (outPath) { fs.mkdirSync(path.dirname(outPath), { recursive: true }); writeJson(outPath, summary); }
console.log(JSON.stringify({ result: summary.result, checks: checks.map(({ name, actual, rejected }) => ({ name, actual, rejected })), out: outPath }));
if (summary.result !== 'pass') process.exitCode = 1;
}
