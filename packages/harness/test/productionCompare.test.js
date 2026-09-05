import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compareProduction } from '../src/productionCompare.js';
import { makeSuite } from '../../../scripts/parity-production/fixtures.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const golden = new URL('../resources/goldens/production-smoke/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('source.json', golden), 'utf8'));
const read = (name, zipped = false) => { const raw = readFileSync(new URL(name, golden)); return JSON.parse(zipped ? gunzipSync(raw) : raw); };
const reference = read('reference.json.gz', true), suite = read('suite.json');
const control = JSON.parse(gunzipSync(readFileSync(join(root, 'docs/parity/evidence/2026-09-05/production/stream-writer-control/candidate.json.gz'))));
const run = candidate => compareProduction(reference, candidate, suite);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function encode(wire) {
  wire.rawBody = JSON.stringify(wire.body.value);
  if (wire.headers['content-length'] !== undefined) wire.headers['content-length'] = String(Buffer.byteLength(wire.rawBody));
  if (wire.headers.etag !== undefined) wire.headers.etag = `${wire.headers.etag.startsWith('W/') ? 'W/' : ''}"${Buffer.byteLength(wire.rawBody).toString(16)}-${createHash('sha1').update(wire.rawBody).digest('base64').slice(0, 27)}"`;
}
function change(id, callback) {
  const candidate = structuredClone(control), c = candidate.cases.find(c => c.id === id);
  assert.ok(c, id); callback(c); return run(candidate);
}

test('production goldens retain reviewed source hashes and agree across two original runtime captures', () => {
  for (const [name, expected] of Object.entries(manifest.files)) assert.equal(sha(readFileSync(new URL(name, golden))), expected);
  assert.equal(manifest.driverSha256, sha(readFileSync(join(root, 'scripts/parity-production/driver.cjs'))));
  for (const [path, hash] of Object.entries(manifest.originalCaptureTools)) assert.equal(sha(readFileSync(join(root, path))), hash);
  assert.equal(manifest.originalControlArtifactSha256, sha(readFileSync(join(root, manifest.originalControlArtifact))));
  const result = run(control);
  assert.equal(result.pass, true, JSON.stringify(result.invariants));
  assert.equal(result.cases, 43);
  assert.deepEqual(result.differences, []);
});

test('complete report corpus control retains its uncovered external action and cannot become a passing gate', () => {
  const path = join(root, 'docs/parity/evidence/2026-09-05/production/stream-writer-report-control');
  const fixture = JSON.parse(readFileSync(join(path, 'suite.json'), 'utf8'));
  const original = JSON.parse(gunzipSync(readFileSync(join(path, 'reference.json.gz'))));
  const repeated = JSON.parse(gunzipSync(readFileSync(join(path, 'candidate.json.gz'))));
  const result = compareProduction(original, repeated, fixture);
  assert.equal(result.cases, 73);
  assert.equal(result.measuredAgreement, true);
  assert.equal(result.pass, false);
  assert.equal(result.dimensions.action.compared, 72);
  assert.equal(result.groups['report:base'].actionCoverageGaps, 1);
  assert.deepEqual(result.coverageGaps.map(g => [g.side, g.id, g.skillID]), [
    ['reference', 'report:5:0:base', 'answer'], ['candidate', 'report:5:0:base', 'answer'],
  ]);
});

test('complete fixture generation retains all corpus occurrences and conditional variants', () => {
  const full = makeSuite({ selection: 'all' });
  assert.equal(full.cases.filter(c => c.group === 'corpus').length, 20507);
  assert.equal(full.cases.filter(c => c.group === 'corpus' && c.variant === 'base').length, 17137);
  assert.equal(full.denominators.reduce((n, c) => n + c.conditionalOccurrences, 0), 3370);
  assert.equal(new Set(full.cases.map(c => c.id)).size, full.cases.length);
  const condition = full.cases.find(c => c.context === 'identified');
  assert.equal(full.contexts[condition.context].runtime.perception.speaker, 'uid0001');
  assert.ok(full.cases.some(c => c.clock.startsWith('2018-12-25')));
  assert.throws(() => makeSuite({ selection: 'unknown' }));
  assert.throws(() => makeSuite({ offset: -1 }));
  assert.throws(() => makeSuite({ selection: 'smoke', limit: 1 }));
  assert.throws(() => makeSuite({ selection: 'corpus' }));
});

test('production grade rejects changed entities, winning rules and null-versus-empty no-match results', () => {
  for (const mutate of [
    body => { body.data.entities.JiboContent = 'Song'; },
    body => { body.data.rules = ['chitchat/launch']; },
    body => { body.data.entities = null; },
  ]) {
    const result = change('boundary:launch', c => { mutate(c.parser.response.body.value); encode(c.parser.response); });
    assert.equal(result.pass, false);
    assert.ok(result.differences.some(d => d.path.includes('/parser/response/body/value/data')));
  }
  const result = change('boundary:no-match', c => { c.parser.response.body.value.data.entities = {}; encode(c.parser.response); });
  assert.equal(result.pass, false);
});

test('production grade rejects incomplete parser requests and changed routing memo types', () => {
  const request = change('boundary:launch', c => { delete c.parser.input.body.value.data.rules; encode(c.parser.input); });
  assert.equal(request.pass, false);
  assert.ok(request.invariants.some(i => i.message.includes('Full parser fixture request')));
  const memo = change('report:0:0:base', c => { c.routing.decision.memo = { entry: c.routing.decision.memo }; });
  assert.equal(memo.pass, false);
  assert.ok(memo.differences.some(d => d.path.endsWith('/routing/decision/memo')));
});

test('production requests use the real builder and retain dialog-reference injection as a compared output', () => {
  const c = reference.cases.find(c => c.id === 'boundary:loop-full-name');
  assert.equal(c.turns[0].preparation.input.context.runtime.dialog.referent, null);
  assert.equal(c.turns[0].input.body.value.data.runtime.dialog.referent, 'test-looper-id-3');
  const changed = change(c.id, copy => { copy.turns[0].input.body.value.data.runtime.dialog.referent = null; encode(copy.turns[0].input); });
  assert.equal(changed.pass, false);
  assert.ok(changed.differences.some(d => d.path.endsWith('/input/body/value/data/runtime/dialog/referent')));
  const omitted = change(c.id, copy => { delete copy.turns[0].preparation.input.nlu.entities.loopMemberReferent; });
  assert.ok(omitted.invariants.some(d => d.path.endsWith('/preparation')));
});

test('production grade retains action ESML, display IDs, analytics and complete continuation state', () => {
  const esml = change('skill:chitchat-joke', c => { c.turns[0].response.body.value.data.action.config.jcp.config.play.esml += ' changed'; encode(c.turns[0].response); });
  assert.equal(esml.pass, false);
  assert.ok(esml.differences.some(d => d.path.endsWith('/esml')));
  const display = change('skill:report-unknown', c => { c.turns[0].response.body.value.data.action.config.jcp.config.display.view.context.data.viewConfig.id = 'differentView'; encode(c.turns[0].response); });
  assert.equal(display.pass, false);
  assert.ok(display.differences.some(d => d.path.endsWith('/viewConfig/id')));
  const session = change('skill:report-identification-continuation', c => { c.turns[1].input.body.value.data.skill.session.nodeID++; encode(c.turns[1].input); });
  assert.equal(session.pass, false);
  assert.ok(session.invariants.some(i => i.message.includes('continuation session')));
  const analytics = change('skill:chitchat-joke', c => { c.turns[0].response.body.value.data.analytics = {}; encode(c.turns[0].response); });
  assert.equal(analytics.pass, false);
});

test('production grade independently rejects incomplete captures, bad bytes, timestamps and generated IDs', () => {
  for (const mutate of [
    c => { c.parser.response.rawBody = '{}'; },
    c => { c.parser.response.body.value.ts++; encode(c.parser.response); },
    c => { c.parser.response.body.value.msgID = 'not-a-generated-uuid'; encode(c.parser.response); },
    c => { c.durationMs = suite.caseTimeoutMs + 1; },
  ]) {
    const result = change('boundary:launch', mutate);
    assert.equal(result.pass, false); assert.ok(result.invariants.length > 0);
  }
  const candidate = structuredClone(control); candidate.cases.pop();
  assert.equal(run(candidate).pass, false);
  const oldSchema = structuredClone(control); oldSchema.schemaVersion = 1;
  assert.ok(run(oldSchema).invariants.some(i => i.message.includes('superseded')));
  const collision = change('boundary:launch', c => { c.parser.response.body.value.msgID = control.cases[1].parser.response.body.value.msgID; encode(c.parser.response); });
  assert.equal(collision.pass, false, 'Distinct original IDs must not collapse to one candidate ID');
});

test('production compare CLI exits zero for the original control and nonzero for a behavioral mismatch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-production-grade-'));
  try {
    const candidate = structuredClone(control);
    const file = join(dir, 'candidate.json'), output = join(dir, 'comparison.json');
    const command = [join(root, 'scripts/parity-production/compare.mjs'), '--reference', fileURLToPath(new URL('reference.json.gz', golden)), '--candidate', file,
      '--suite', fileURLToPath(new URL('suite.json', golden)), '--out', output];
    writeFileSync(file, JSON.stringify(candidate));
    const good = spawnSync(process.execPath, command, { encoding: 'utf8' });
    assert.equal(good.status, 0, good.stderr);
    candidate.cases[0].parser.response.body.value.data.intent = 'wrongIntent'; encode(candidate.cases[0].parser.response);
    writeFileSync(file, JSON.stringify(candidate));
    const bad = spawnSync(process.execPath, command, { encoding: 'utf8' });
    assert.equal(bad.status, 1, bad.stderr);
    assert.equal(JSON.parse(readFileSync(output, 'utf8')).pass, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
