// I-01 Phoenix runtime probe — drives a REAL spawned history service process over HTTP.
//
// Two full passes with a real process restart in between, so route durability is observed rather
// than asserted. The case matrix mirrors w7-ref-routes-oracle.mjs so the two JSON files can be
// diffed case-by-case.
//
// Run:  node w7-runtime-probe.mjs <port> <out.json>
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = Number(process.argv[2] || 19306);
const OUT = process.argv[3] || 'w7-runtime-probe.json';
const ROOT = '/home/shell/work/phoenix/.parity/worktrees/w7-i01';
const base = `http://127.0.0.1:${PORT}`;

function startService() {
  const child = spawn('node', ['packages/history/src/index.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  return { child, log: () => out };
}

async function waitReady(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/healthcheck`);
      if (r.status === 200) return true;
    } catch { /* not up yet */ }
    await sleep(150);
  }
  throw new Error('service did not become ready');
}

async function probe(method, path, { body, query, headers, raw } = {}) {
  const url = query ? `${base}${path}?${query}` : `${base}${path}`;
  const h = { ...(headers || {}) };
  let payload;
  if (raw !== undefined) payload = raw;
  else if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
  const res = await fetch(url, { method, headers: h, body: payload });
  const text = await res.text();
  let json = null; try { json = text === '' ? null : JSON.parse(text); } catch { json = text; }
  const env = json && json.type === 'ERROR'
    ? { type: json.type, final: json.final, message: json.data && json.data.message }
    : undefined;
  return { method, path: path + (query ? `?${query}` : ''), status: res.status, contentType: res.headers.get('content-type'), body: json, envelope: env };
}

// Same matrix as the reference oracle, minus the reference-only stubbed-DB failures.
async function matrix() {
  const TS = 1789084000000; // shared realistic wall-clock ms (retention is 14 days)

const out = [];
  const rec = async (label, ...a) => { out.push({ label, ...(await probe(...a)) }); };
  await rec('POST /v1/skill/launch full', 'POST', '/v1/skill/launch', { body: { timestamp: TS, sessionID: 'sess-1', robotID: 'R-1', skillID: 'SK-1', intent: 'intent-1', personIDs: ['person-2', 'person-1'] } });
  await rec('PUT /v1/skill/launch/payload match', 'PUT', '/v1/skill/launch/payload', { body: { sessionID: 'sess-1', robotID: 'R-1', skillID: 'SK-1', payload: { a: 1, b: 2 } } });
  await rec('PUT /v1/skill/launch/payload no match, payload present', 'PUT', '/v1/skill/launch/payload', { body: { sessionID: 'nope', robotID: 'R-x', skillID: 'SK-x', payload: { a: 1 } } });
  await rec('PUT /v1/skill/launch/payload NO payload key, no match', 'PUT', '/v1/skill/launch/payload', { body: { sessionID: 'nope', robotID: 'R-y', skillID: 'SK-y' } });
  await rec('PUT /v1/skill/launch/payload NO payload key, match', 'PUT', '/v1/skill/launch/payload', { body: { sessionID: 'sess-1', robotID: 'R-1', skillID: 'SK-1' } });
  await rec('PUT /v1/skill/launch/payload payload null, no match', 'PUT', '/v1/skill/launch/payload', { body: { sessionID: 'nope', robotID: 'R-z', skillID: 'SK-z', payload: null } });
  await rec('POST /v1/skill/launch/latest hit', 'POST', '/v1/skill/launch/latest', { body: { robotID: 'R-1', rules: [] } });
  await rec('POST /v1/skill/launch/latest miss', 'POST', '/v1/skill/launch/latest', { body: { robotID: 'R-absent', rules: [] } });
  await rec('GET /v1/skill/launch/latest hit', 'GET', '/v1/skill/launch/latest', { query: 'robotID=R-1' });
  await rec('GET /v1/skill/launch/latest miss', 'GET', '/v1/skill/launch/latest', { query: 'robotID=R-absent' });
  await rec('POST /v1/skill/launch/count', 'POST', '/v1/skill/launch/count', { body: { robotID: 'R-1', rules: [] } });
  await rec('GET /v1/skill/launch/count', 'GET', '/v1/skill/launch/count', { query: 'robotID=R-1' });
  const speech = await probe('POST', '/v1/speech', { body: { robotID: 'some-robot-id', accountID: 'some-acc-id', transID: 'some-trans-id', audioFileURL: 'http://aws.test.com', timestamp: TS } });
  out.push({ label: 'POST /v1/speech create', ...speech });
  const sid = speech.body && speech.body.id;
  await rec('PUT /v1/speech/:id update', 'PUT', `/v1/speech/${sid}`, { body: { audioFileURL: 'http://aws2.test.com', asr: null } });
  await rec('PUT /v1/speech/:id unknown id', 'PUT', '/v1/speech/deadbeefdeadbeefdeadbeef', { body: { audioFileURL: 'http://x' } });
  await rec('GET /healthcheck', 'GET', '/healthcheck', {});
  await rec('GET /v1/skill/launch/does-not-exist', 'GET', '/v1/skill/launch/does-not-exist', {});
  await rec('GET /nope', 'GET', '/nope', {});
  await rec('DELETE /v1/skill/launch/latest', 'DELETE', '/v1/skill/launch/latest', {});
  await rec('PATCH /v1/skill/launch/count', 'PATCH', '/v1/skill/launch/count', {});
  await rec('PUT /v1/skill/launch/latest', 'PUT', '/v1/skill/launch/latest', {});
  await rec('POST /v1/skill/launch/ trailing slash', 'POST', '/v1/skill/launch/', { body: { timestamp: TS + 1000, sessionID: 's2', robotID: 'R-2', skillID: 'SK-2' } });
  await rec('GET /V1/SKILL/LAUNCH/COUNT case-insensitive', 'GET', '/V1/SKILL/LAUNCH/COUNT', { query: 'robotID=R-2' });
  await rec('HEAD /v1/skill/launch/count', 'HEAD', '/v1/skill/launch/count', { query: 'robotID=R-2' });
  await rec('POST /v1/skill/launch empty body no content-type', 'POST', '/v1/skill/launch', {});
  await rec('POST /v1/skill/launch text/plain body', 'POST', '/v1/skill/launch', { raw: 'hello', headers: { 'content-type': 'text/plain' } });
  await rec('POST /v1/skill/launch malformed JSON', 'POST', '/v1/skill/launch', { raw: '{"a":', headers: { 'content-type': 'application/json' } });
  await rec('GET /v1/skill/launch/latest no query', 'GET', '/v1/skill/launch/latest', {});
  await rec('POST /v1/skill/launch/count empty body', 'POST', '/v1/skill/launch/count', {});
  await rec('PUT /v1/speech/:id empty body', 'PUT', '/v1/speech/abc', {});
  await rec('GET /skill/launch/count BARE alias (expect 404)', 'GET', '/skill/launch/count', { query: 'robotID=R-1' });
  await rec('PUT /speech/abc BARE alias (expect 404)', 'PUT', '/speech/abc', { body: {} });

  // 3. retention substrate probe (I-03-owned): Phoenix prunes synchronously on read/write; the
  // reference delegates to Mongo's TTL index on the `timestamp` field (expires 14*86400 s).
  await rec('RETENTION: POST old timestamp (40 days ago)', 'POST', '/v1/skill/launch', { body: { timestamp: TS - 40 * 86400 * 1000, sessionID: 's-old', robotID: 'R-old', skillID: 'SK-old' } });
  await rec('RETENTION: GET count for the old record', 'GET', '/v1/skill/launch/count', { query: 'robotID=R-old' });
  return out;
}

// Pass 1
let svc = startService();
await waitReady();
const pass1 = await matrix();
const log1 = svc.log();
// real restart
svc.child.kill('SIGKILL');
await sleep(500);
svc = startService();
await waitReady();
const pass2 = await matrix();
const log2 = svc.log();
svc.child.kill('SIGTERM');
await sleep(300);
svc.child.kill('SIGKILL');

const routePaths = ['/v1/skill/launch', '/v1/skill/launch/payload', '/v1/skill/launch/latest', '/v1/skill/launch/count', '/v1/speech', '/v1/speech/:id'];
writeFileSync(OUT, JSON.stringify({
  pass1, pass2,
  restarted: true,
  pass1RouteStatuses: Object.fromEntries(pass1.map((c) => [c.label, c.status])),
  servedAfterRestart: routePaths.map((p) => ({ route: p, pass1: pass1.some((c) => c.label.includes(p.slice(3))), pass2: pass2.some((c) => c.label.includes(p.slice(3))) })),
  startedLog1: log1.split('\n').filter((l) => l.includes('successfully started')),
  startedLog2: log2.split('\n').filter((l) => l.includes('successfully started')),
}, null, 2));
console.log(JSON.stringify({ pass1: pass1.length, pass2: pass2.length, restart: true, started: log1.includes('successfully started') && log2.includes('successfully started') }, null, 1));
process.exit(0);
