import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, renameSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createFileLogReader } from '../src/admin/fileLogs.js';

test('retained logs include other services and compressed history, survive cursor resets and rotation, and expire', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-retained-logs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let now = Date.now();
  const row = (msg, age = 0, fields = {}) => JSON.stringify({ t: new Date(now - age).toISOString(), ns: 'gateway', level: 'error', msg, ...fields }) + '\n';
  const day = 86400_000;
  writeFileSync(join(dir, 'phx-compose-hub.log.1.gz'), gzipSync(row('six days old', 6 * day) + row('expired', 8 * day)
    + row('expired voice timing', 2 * day, { event: 'voice_turn_span' })));
  const active = join(dir, 'phx-compose-hub.log');
  writeFileSync(active, row('current error') + row('current info', 0, { level: 'info' }));
  writeFileSync(join(dir, 'phx-compose-classic.log'), row('classic failure', 0, { ns: 'classic' }) + 'TypeError: synthetic startup failure\n    at fixture (example.js:1:1)\n');
  writeFileSync(join(dir, 'private.json'), row('must not read'));
  symlinkSync(join(dir, 'private.json'), join(dir, 'phx-compose-secret.log'));
  const read = createFileLogReader(dir, { now: () => now });
  const initial = await read({ level: 'error', limit: 100 });
  assert.equal(initial.scope, 'server-files');
  const messages = initial.events.map(e => e.msg);
  assert.ok(messages.includes('six days old') && messages.includes('classic failure'));
  assert.ok(messages.includes('TypeError: synthetic startup failure'));
  assert.ok(!messages.some(m => /expired|must not read|current info/.test(m)));
  assert.equal((await read({ since: initial.cursor })).events.length, 0);

  renameSync(active, active + '.1');
  writeFileSync(active, row('after rotation'));
  now += 1000;
  const rotated = await read({ since: initial.cursor });
  assert.deepEqual(rotated.events.map(e => e.msg), ['after rotation']);
  appendFileSync(active, '{"t":'); // concurrent partial write must not appear as a fake error
  now += 1000;
  assert.equal((await read({ since: rotated.cursor })).events.length, 0);

  const restarted = await createFileLogReader(dir, { now: () => now })({ since: rotated.cursor, ns: 'gateway' });
  assert.equal(restarted.reset, true);
  assert.ok(restarted.events.some(e => e.msg === 'six days old'));
  assert.ok(restarted.events.every(e => e.ns === 'gateway'));
  now += 8 * day;
  assert.equal((await read()).events.length, 0);
});
