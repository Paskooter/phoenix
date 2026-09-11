// I-03 — restart durability + retention for the history service, proven at PROCESS level.
//
// The reference keeps skill-launch and speech records in Mongo
// (pegasus packages/history/src/skilllaunch/db/SkillLaunchCollection.ts,
// speech/db/SpeechHistoryRecordsCollection.ts), so a record outlives the server process, and the
// skill-launch `timestamp` carries a TTL index (`expires: config.skillLaunch.eventExpirationSeconds`
// = 14 * 86400 s, SkillLaunchSchema.ts + HistoryServiceConfigProvider.ts). The Phoenix default store
// is process-local, so this test starts the REAL history entrypoint as a CHILD process over
// `ETCO_history_dataFile`, writes through the wire, SIGKILLs it (no graceful shutdown, nothing
// flushed on exit), starts a FRESH process over the same store file and reads the state back — and
// then ages a record past 14 days and observes eviction that must NOT be resurrected by the restart.
//
// This mirrors packages/classic/test/iftttDurability.test.js (A-17) and voiceTraining.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ENTRY = join(ROOT, 'packages', 'history', 'src', 'index.js');
const DAY = 24 * 60 * 60 * 1000;

async function freePort() {
  const srv = http.createServer();
  await new Promise((resolve) => srv.listen(0, resolve));
  const port = srv.address().port;
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

async function request(base, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text === '' ? null : JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

/** Start the real history entrypoint as a child process over `file` (its own fresh HistoryStore). */
async function startChild(file) {
  const port = await freePort();
  const child = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), ETCO_history_dataFile: file },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stdout.resume();
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const res = await fetch(`${base}/healthcheck`);
      if (res.status === 200) {
        return {
          base,
          stop: () => new Promise((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) return resolve();
            child.once('close', resolve);
            child.kill('SIGKILL');
          }),
        };
      }
    } catch { /* not listening yet */ }
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill('SIGKILL');
  throw new Error(`history entrypoint child did not start: ${stderr}`);
}

const rawStore = async (file) => JSON.parse(await readFile(file, 'utf8'));

test('skill-launch and speech records survive a SIGKILL restart with stable ids, ordering and payload semantics', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'history-durable-'));
  const file = join(dir, 'history.json');
  const R = 'Robot-Durable';
  const SK = 'SK-1';
  const T = Date.now();
  let first;
  let second;
  try {
    first = await startChild(file);
    // Insertion order is deliberately the REVERSE of timestamp order: the newer record is written
    // first, so a restart that fell back to insertion order would surface the wrong "latest".
    const later = await request(first.base, 'POST', '/v1/skill/launch', {
      timestamp: T, sessionID: 'later', robotID: R, skillID: SK, intent: 'later',
    });
    assert.equal(later.status, 200);
    const earlier = await request(first.base, 'POST', '/v1/skill/launch', {
      timestamp: T - 60000, sessionID: 'earlier', robotID: R, skillID: SK, intent: 'earlier',
    });
    assert.equal(earlier.status, 200);
    const payload = await request(first.base, 'PUT', '/v1/skill/launch/payload', {
      robotID: R, sessionID: 'earlier', skillID: SK, payload: { k1: 'v1', k2: 'v2' },
    });
    assert.equal(payload.status, 200);
    assert.equal(payload.json.id, earlier.json.id, 'payload update returns the earlier record');
    assert.equal(payload.json.payloadSize, 2);

    const speech = await request(first.base, 'POST', '/v1/speech', {
      robotID: R, accountID: 'acct-1', transID: 't-1', timestamp: T, audioFileURL: 'http://a', asr: { text: 'hi' },
    });
    assert.equal(speech.status, 200);
    assert.equal(typeof speech.json.id, 'string');
    const speechId = speech.json.id;

    const count = await request(first.base, 'POST', '/v1/skill/launch/count', { robotID: R });
    assert.deepEqual(count.json, { count: 2 });

    await first.stop(); // SIGKILL: no graceful shutdown, nothing flushed on exit
    first = null;

    // The kill must not have needed the process to finish: the file already holds every row.
    const raw1 = await rawStore(file);
    assert.equal(raw1.skillLaunches.length, 2);
    const storedEarlier = raw1.skillLaunches.find((r) => r.id === earlier.json.id);
    assert.equal(storedEarlier.payloadSize, 2);
    assert.deepEqual(storedEarlier.payload, { k1: 'v1', k2: 'v2' });
    assert.equal(raw1.speech.length, 1);
    assert.equal(raw1.speech[0].id, speechId);
    assert.deepEqual(raw1.speech[0].asr, { text: 'hi' });

    // Process 2: a fresh process over the same file reads the state back through the same wire.
    second = await startChild(file);
    const count2 = await request(second.base, 'POST', '/v1/skill/launch/count', { robotID: R });
    assert.deepEqual(count2.json, { count: 2 }, 'row count survives the restart');

    const latest = await request(second.base, 'POST', '/v1/skill/launch/latest', { robotID: R });
    assert.equal(latest.json.id, later.json.id, 'identifier is stable across the restart');
    assert.equal(latest.json.intent, 'later', 'latest is chosen by timestamp, not insertion order');
    assert.equal(latest.json.timestamp, T);

    const earlierAfter = await request(second.base, 'POST', '/v1/skill/launch/latest', { robotID: R, intent: 'earlier' });
    assert.equal(earlierAfter.json.id, earlier.json.id);
    assert.equal(earlierAfter.json.payloadSize, 2, 'payload-update semantics survive the restart');
    assert.deepEqual(earlierAfter.json.payload, { k1: 'v1', k2: 'v2' });

    // The speech record has no read route (the reference handler exposes only POST / and PUT /:id),
    // so the wire proof it survived is that the PUT resolves the pre-restart id instead of 500ing.
    const updated = await request(second.base, 'PUT', `/v1/speech/${speechId}`, { nlu: { intent: 'greet' } });
    assert.equal(updated.status, 200, 'a speech id minted before the SIGKILL still resolves');
    assert.deepEqual(updated.json, { id: speechId });

    await second.stop();
    second = null;
    const raw2 = await rawStore(file);
    const speechAfter = raw2.speech.find((r) => r.id === speechId);
    assert.deepEqual(speechAfter.asr, { text: 'hi' }, 'pre-restart field preserved (non-erasing update)');
    assert.deepEqual(speechAfter.nlu, { intent: 'greet' }, 'post-restart update persisted');
  } finally {
    if (first) await first.stop();
    if (second) await second.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a back-dated launch is evicted and does NOT reappear after a SIGKILL restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'history-retention-'));
  const file = join(dir, 'history.json');
  const R = 'R-old';
  const SK = 'SK-old';
  const T = Date.now();
  let first;
  let second;
  try {
    first = await startChild(file);
    // Fresh row FIRST, then a 40-day-old row: the expired row is NOT the head of the insertion-
    // ordered array, which is the exact shape the old head-only prune could never remove (P12).
    const fresh = await request(first.base, 'POST', '/v1/skill/launch', {
      timestamp: T - 13 * DAY, sessionID: 'fresh', robotID: R, skillID: SK, intent: 'fresh',
    });
    assert.equal(fresh.status, 200);
    const expired = await request(first.base, 'POST', '/v1/skill/launch', {
      timestamp: T - 40 * DAY, sessionID: 'expired', robotID: R, skillID: SK, intent: 'expired',
    });
    assert.equal(expired.status, 200, 'the write is accepted; eviction is a retention decision, not a validation one');

    await first.stop();
    first = null;

    // Both rows really are on disk (the expired one last) — the eviction below comes from the
    // retention rule applied by a FRESH process, not from the write path dropping it.
    const raw1 = await rawStore(file);
    assert.equal(raw1.skillLaunches.length, 2);
    assert.equal(raw1.skillLaunches[0].id, fresh.json.id);
    assert.equal(raw1.skillLaunches[1].id, expired.json.id, 'the expired row is behind a fresh head');

    second = await startChild(file);
    const counted = await request(second.base, 'GET', `/v1/skill/launch/count?robotID=${R}`);
    assert.deepEqual(counted.json, { count: 1 }, 'the 40-day-old row is not counted after the restart');
    const expiredCount = await request(second.base, 'POST', '/v1/skill/launch/count', { robotID: R, intent: 'expired' });
    assert.deepEqual(expiredCount.json, { count: 0 });
    const latest = await request(second.base, 'POST', '/v1/skill/launch/latest', { robotID: R });
    assert.equal(latest.json.id, fresh.json.id);
    assert.equal(latest.json.intent, 'fresh');

    await second.stop();
    second = null;

    const raw2 = await rawStore(file);
    assert.deepEqual(raw2.skillLaunches.map((r) => r.id), [fresh.json.id], 'the eviction is persisted, so it cannot be resurrected');
  } finally {
    if (first) await first.stop();
    if (second) await second.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
