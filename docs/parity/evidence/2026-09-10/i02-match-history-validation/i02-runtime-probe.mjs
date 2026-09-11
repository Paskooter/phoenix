// I-02 Phoenix runtime probe — the I-01 probe, extended to the shared matrix.
//
// Drives a REAL spawned history service process over HTTP, twice, with a real process restart in
// between (durability/determinism observed, not asserted). Imports the same i02-matrix.mjs the
// reference oracle uses, so the two JSON artefacts are directly comparable case-by-case.
//
// Run:  node i02-runtime-probe.mjs <port> <out.json>
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { runMatrix } from './i02-matrix.mjs';

const PORT = Number(process.argv[2] || 19307);
const OUT = process.argv[3] || 'i02-runtime-probe.json';
// I02_ROOT lets the same probe run against a pre-fix checkout to produce the BEFORE artefact.
const ROOT = process.env.I02_ROOT || '/home/shell/work/phoenix/.parity/worktrees/w8-i02';
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
    try { const r = await fetch(`${base}/healthcheck`); if (r.status === 200) return true; } catch { /* not up */ }
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
  const env = json && json.type === 'ERROR' ? { type: json.type, final: json.final, message: json.data && json.data.message } : undefined;
  return { method, path: path + (query ? `?${query}` : ''), status: res.status, contentType: res.headers.get('content-type'), body: json, envelope: env };
}

let svc = startService();
await waitReady();
const pass1 = await runMatrix(probe);
const log1 = svc.log();
svc.child.kill('SIGKILL');
await sleep(500);
svc = startService();
await waitReady();
const pass2 = await runMatrix(probe);
const log2 = svc.log();
svc.child.kill('SIGTERM');
await sleep(300);
svc.child.kill('SIGKILL');

writeFileSync(OUT, JSON.stringify({
  target: 'LIVE phoenix history service process (node packages/history/src/index.js)',
  pass1,
  pass2,
  restarted: true,
  startedLog1: log1.split('\n').filter((l) => l.includes('successfully started')),
  startedLog2: log2.split('\n').filter((l) => l.includes('successfully started')),
}, null, 2));
console.log(JSON.stringify({ pass1: pass1.length, pass2: pass2.length, restart: true, started: log1.includes('successfully started') && log2.includes('successfully started') }, null, 1));
process.exit(0);
