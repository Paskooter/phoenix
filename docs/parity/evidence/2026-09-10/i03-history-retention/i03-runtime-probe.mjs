// I-03 runtime probe — the retention + restart contract observed over the wire from a REAL spawned
// history process, not asserted from source.
//
// It reproduces the exact I-01 RETENTION case (docs/parity/evidence/2026-09-10/i01-history-routes/
// w7-runtime-probe.json): POST a launch whose `timestamp` is 40 days old as the SECOND row of the
// store, then read it back. Before I-03 that GET returned {count: 1} because the prune only
// inspected the oldest ARRAY element; the reference deletes by timestamp value (Mongo TTL index:
// SkillLaunchSchema.ts `expires: config.skillLaunch.eventExpirationSeconds` = 14 * 86400 s).
//
// It then SIGKILLs the child, starts a FRESH process over the same store file and re-reads, so both
// halves of the acceptance (restart recovery, eventual 14-day expiry independent of insertion
// order) are observed end to end. The raw store file is dumped before and after so the eviction can
// be attributed to the retention rule rather than to the write path.
//
// Run: node i03-runtime-probe.mjs <out.json>

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const OUT = process.argv[2] || 'i03-runtime-probe.json';
const ROOT = dirname(fileURLToPath(import.meta.url));
// Walk up to the repo root (the directory holding docs/parity/tasks.json) so the probe works from
// wherever the evidence file sits.
function findRepo(start) {
  let dir = start;
  for (let i = 0; i < 10; i += 1) {
    if (existsSync(join(dir, 'docs', 'parity', 'tasks.json'))) return dir;
    dir = dirname(dir);
  }
  throw new Error(`repo root not found above ${start}`);
}
const REPO = findRepo(ROOT);
const ENTRY = join(REPO, 'packages', 'history', 'src', 'index.js');
const DAY = 86400000;
const T = Date.now();
const dir = mkdtempSync(join(tmpdir(), 'i03-probe-'));
const file = join(dir, 'history.json');
const out = { phoenixRevision: 'w8/i03', storeFile: file, startedAt: T, cases: [], store: {} };

function startChild(port) {
  const child = spawn(process.execPath, [ENTRY], {
    cwd: REPO,
    env: { ...process.env, PORT: String(port), ETCO_history_dataFile: file },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.resume();
  child.stderr.resume();
  return child;
}

async function waitReady(base) {
  for (let i = 0; i < 150; i += 1) {
    try { if ((await fetch(`${base}/healthcheck`)).status === 200) return; } catch { /* retry */ }
    await sleep(100);
  }
  throw new Error('history service did not become ready');
}

async function probe(label, method, path, body) {
  const base = globalThis.__base;
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text === '' ? null : JSON.parse(text); } catch { json = text; }
  out.cases.push({ label, method, path, status: res.status, body: json });
}

const dumpStore = () => JSON.parse(readFileSync(file, 'utf8'));

let child;
try {
  let port = 19513;
  child = startChild(port);
  globalThis.__base = `http://127.0.0.1:${port}`;
  await waitReady(globalThis.__base);

  // --- pass 1: write, over the wire ------------------------------------------------------------
  await probe('PASS1 POST fresh launch (13 days old)',
    'POST', '/v1/skill/launch', { timestamp: T - 13 * DAY, sessionID: 'fresh', robotID: 'R-old', skillID: 'SK-old', intent: 'fresh' });
  await probe('PASS1 POST back-dated launch (40 days old, written SECOND so it is NOT the head)',
    'POST', '/v1/skill/launch', { timestamp: T - 40 * DAY, sessionID: 'expired', robotID: 'R-old', skillID: 'SK-old', intent: 'expired' });
  await probe('PASS1 POST speech record',
    'POST', '/v1/speech', { robotID: 'R-old', accountID: 'acct', transID: 't-1', timestamp: T - 13 * DAY, asr: { text: 'hi' } });
  const speechId = out.cases[out.cases.length - 1].body.id;
  out.store.afterPass1 = dumpStore();
  out.cases.push({
    label: 'PASS1 store file: both rows are on disk, the expired one last',
    path: file,
    storedRows: out.store.afterPass1.skillLaunches.map((r) => ({ sessionID: r.sessionID, timestamp: r.timestamp })),
    storedSpeech: out.store.afterPass1.speech.length,
  });

  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('close', resolve));
  child = null;

  // --- pass 2: a FRESH process over the same store file ----------------------------------------
  port = 19514;
  child = startChild(port);
  globalThis.__base = `http://127.0.0.1:${port}`;
  await waitReady(globalThis.__base);

  await probe('PASS2 GET count for R-old (I-01 RETENTION case: was 1 with the head-only prune)',
    'GET', '/v1/skill/launch/count?robotID=R-old');
  await probe('PASS2 POST count for the expired intent',
    'POST', '/v1/skill/launch/count', { robotID: 'R-old', intent: 'expired' });
  await probe('PASS2 POST latest for R-old (stable identifier + timestamp ordering)',
    'POST', '/v1/skill/launch/latest', { robotID: 'R-old' });
  await probe('PASS2 PUT the speech id minted before the SIGKILL (500 would mean it was lost)',
    'PUT', `/v1/speech/${speechId}`, { nlu: { intent: 'greet' } });
  out.store.afterPass2 = dumpStore();

  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('close', resolve));
  child = null;
} finally {
  if (child) child.kill('SIGKILL');
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  rmSync(dir, { recursive: true, force: true });
}
console.log(JSON.stringify(out, null, 2));
