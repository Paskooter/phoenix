import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('voice timing metadata survives a new process, expires after a day, and rejects content fields', t => {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-voice-persistence-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'timings.json');
  const module = new URL('../src/voiceTurnObservability.js', import.meta.url).href;
  const run = code => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import * as v from ${JSON.stringify(module)}; v.initializeVoiceTurnStorage(); ${code}`], {
      encoding: 'utf8', env: { PATH: process.env.PATH, PHOENIX_VOICE_TURN_FILE: file },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim());
  };
  const id = '1b8f4684-4b94-4b6c-a251-d48c1a9fab44';
  run(`const trace = { turnId: '${id}', transId: 'private-fixture-transaction' };
    const log = { info() { throw new Error('timings must not be copied to week-long logs'); } };
    const start = Date.now() - 20;
    v.recordVoiceTurnStart(trace, start);
    v.logVoiceTurnSpan(log, trace, 'asr', start, 'ok');
    v.recordVoiceTurnAsrBreakdown(trace, { audioMs: 1000, silenceWaitMs: 200, recognizeMs: 50, transcript: 'private-fixture-speech', audio: 'private-fixture-audio' });
    v.logVoiceTurnComplete(log, trace, start, 'skill');
    await v.flushVoiceTurns(); console.log(JSON.stringify(v.recentVoiceTurns()));`);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.doesNotMatch(readFileSync(file, 'utf8'), /private-fixture/);
  const page = run(`const page = v.recentVoiceTurns(); await v.flushVoiceTurns(); console.log(JSON.stringify(page));`);
  assert.equal(page.retentionMs, 86400_000);
  assert.equal(page.turns.length, 1);
  assert.equal(page.turns[0].turnId, id);
  assert.equal(page.turns[0].stages[0].stage, 'asr');
  assert.deepEqual(page.turns[0].asr, { audioMs: 1000, silenceWaitMs: 200, recognizeMs: 50 });

  const saved = JSON.parse(readFileSync(file, 'utf8'));
  saved.turns[0].robotId = 'private-fixture-robot';
  saved.turns[0].asr.transcript = 'private-fixture-transcript';
  saved.turns.push({ ...saved.turns[0], turnId: '95ad7609-211a-450d-9a65-ced5c15e00c8', startedAt: Date.now() - 86400_001 });
  writeFileSync(file, JSON.stringify(saved));
  const pruned = run(`const page = v.recentVoiceTurns(); await v.flushVoiceTurns(); console.log(JSON.stringify(page));`);
  assert.equal(pruned.turns.length, 1);
  assert.doesNotMatch(readFileSync(file, 'utf8'), /private-fixture|95ad7609/);
});
