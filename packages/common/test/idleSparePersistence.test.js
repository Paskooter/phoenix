import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('idle-spare completion survives persistence and the outcome query without creating a response stage', t => {
  const directory = mkdtempSync(join(tmpdir(), 'idle-spare-persistence-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const module = new URL('../src/voiceTurnObservability.js', import.meta.url).href;
  const run = body => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import * as v from ${JSON.stringify(module)}; v.initializeVoiceTurnStorage(); ${body}`], {
      encoding: 'utf8', env: { PATH: process.env.PATH, PHOENIX_VOICE_TURN_FILE: join(directory, 'turns.json') },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim());
  };
  run(`const trace = { turnId: '0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d' };
    const start = Date.now() - 10000;
    v.recordVoiceTurnStart(trace, start);
    v.logVoiceTurnComplete(null, trace, start, 'idle_spare');
    await v.flushVoiceTurns(); console.log('{}');`);
  const page = run(`const query = v.parseVoiceTurnQuery(new URLSearchParams({outcome:'idle_spare'}));
    console.log(JSON.stringify(v.recentVoiceTurns(query)));`);
  assert.equal(page.turns.length, 1);
  assert.equal(page.turns[0].outcome, 'idle_spare');
  assert.deepEqual(page.turns[0].stages, []);
  assert.ok(page.turns[0].totalMs >= 10000);
  assert.ok(page.turns[0].completedAt > page.turns[0].startedAt);
});
