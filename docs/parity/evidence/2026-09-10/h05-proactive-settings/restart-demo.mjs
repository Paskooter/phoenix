// H-05 runtime + durability demo: enforce a real proactive user setting end to end, then
// ACTUALLY RESTART both the Settings/account service and the hub, and re-observe the gate.
//
// Run from the repository root:  node docs/parity/evidence/2026-09-10/h05-proactive-settings/restart-demo.mjs
//
// It spawns the real service entrypoints as child processes:
//   node packages/account/src/index.js     (the Settings service: NET_settings target)
//   node packages/gateway/src/index.js     (the hub: /v1/proactive transactions)
// and a tiny in-process history stub (the IHRule needs a history answer). The report-skill's
// skill URL is deliberately left unreachable: the PROACTIVE match frame is written before the
// skill launch, so the frame itself is the observable gate.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import { jwt } from '@phoenix/common';

// walk up to the repository root so the script can live under docs/parity/evidence/...
let ROOT = dirname(fileURLToPath(import.meta.url));
while (!existsSync(join(ROOT, 'package.json'))) ROOT = dirname(ROOT);
const SECRET = 'h05-demo-secret';
const ACCOUNT_PORT = 7611;
const GATEWAY_PORT = 7612;

const { Store } = await import('@phoenix/account/src/store.js');
const { createOwnerAccount, createLoop } = await import('@phoenix/account/src/model.js');

const out = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHttp(url, label) {
  for (let i = 0; i < 100; i++) {
    try { await fetch(url); return; } catch { await sleep(100); }
  }
  throw new Error(`${label} never became reachable at ${url}`);
}

const dir = mkdtempSync(join(tmpdir(), 'h05-demo-'));
const storeFile = join(dir, 'store.json');

// --- seed the persistent account/settings store (survives every restart) ----------------
const seedStore = new Store(storeFile);
const owner = createOwnerAccount(seedStore, { email: 'h05-demo@jetson.test', password: 'h05-demo-pass' });
const { loop } = createLoop(seedStore, { owner, robotId: 'h05-demo-robot' });
out(`seeded store ${storeFile}: account=${owner._id} loop=${loop._id}`);

// --- stub history (the report registration's IHRule needs a reachable answer) -----------
const history = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ count: 0 })); });
await new Promise((r) => history.listen(0, '127.0.0.1', r));
const HISTORY = `127.0.0.1:${history.address().port}`;

let account = null;
let gateway = null;
const spawnLogged = (name, args, env) => {
  const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => process.stdout.write(`[${name}] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[${name}!] ${d}`));
  return child;
};
const kill = (child) => new Promise((r) => { if (!child) return r(); child.once('exit', r); child.kill('SIGKILL'); });

async function startStack(phase) {
  out(`\n=== phase ${phase}: starting account/Settings + hub child processes ===`);
  account = spawnLogged('account', ['packages/account/src/index.js'], { PORT: String(ACCOUNT_PORT), ETCO_account_dataFile: storeFile });
  gateway = spawnLogged('hub', ['packages/gateway/src/index.js'], {
    PORT: String(GATEWAY_PORT), ETCO_server_hubTokenSecret: SECRET, ETCO_hub_disableAuth: 'false',
    NET_settings: `127.0.0.1:${ACCOUNT_PORT}`, NET_history: HISTORY, NET_parser: '127.0.0.1:9',
  });
  await waitHttp(`http://127.0.0.1:${ACCOUNT_PORT}/healthcheck`, 'account');
  await waitHttp(`http://127.0.0.1:${GATEWAY_PORT}/healthcheck`, 'hub');
  out(`up: account pid=${account.pid} hub pid=${gateway.pid}`);
}
async function stopStack() {
  out(`stopping account pid=${account?.pid} hub pid=${gateway?.pid}`);
  await Promise.all([kill(gateway), kill(account)]);
  gateway = account = null;
}

const amzSettings = async (op, body) => {
  const res = await fetch(`http://127.0.0.1:${ACCOUNT_PORT}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json;charset=utf-8', 'x-amz-target': `Settings_20160801.${op}`, 'x-amz-credentials': JSON.stringify({ id: owner._id }) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

function driveProactive() {
  const frames = [
    { type: 'CONTEXT', msgID: 'c1', ts: Date.now(), data: {
      general: { accountID: owner._id, robotID: 'h05-demo-robot', lang: 'en-US', release: '2.0.1' },
      runtime: {
        loop: { loopId: loop._id, users: [{ id: 'person-1', accountId: owner._id, firstName: 'Ada' }] },
        perception: { peoplePresent: [{ id: 'person-1' }], speaker: 'person-1' },
        location: { iso: '2026-06-13T10:00:00-04:00' }, dialog: {},
      },
      skill: { id: null },
    } },
    { type: 'TRIGGER', msgID: 't1', ts: Date.now(), data: { triggerSource: 'SURPRISE', triggerData: { looperID: 'person-1' } } },
  ];
  const token = jwt.sign({ id: owner._id, friendlyId: 'h05-demo-robot' }, SECRET);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${GATEWAY_PORT}/v1/proactive`, { headers: { Authorization: `Bearer ${token}`, 'x-jibo-transid': 'h05-demo-trans' } });
    const messages = [];
    let settled = false;
    const finish = () => { if (settled) return; settled = true; try { ws.close(); } catch {} resolve(messages); };
    setTimeout(finish, 4000);
    ws.on('open', () => frames.forEach((f) => ws.send(JSON.stringify(f))));
    ws.on('message', (d) => { const m = JSON.parse(d.toString()); messages.push(m); if (m.final) setTimeout(finish, 50); });
    ws.on('error', reject);
  });
}

const report = (label, messages) => {
  const match = messages.find((m) => m.type === 'PROACTIVE' && m.data && m.data.match && m.data.match.skillID === 'report-skill');
  out(`${label}: frames=[${messages.map((m) => m.type).join(', ')}] -> proactive_match=${Boolean(match)}${match ? ` skillID=${match.data.match.skillID}` : ' (no-action)'}`);
  return Boolean(match);
};

try {
  // --- phase 1: default preference (report manifest declares offerProactively default true)
  await startStack('1');
  let s = await amzSettings('GetSettings', { loopId: loop._id, transId: 'demo-1', skills: ['report-skill'], getView: false });
  out(`GetSettings offerProactively=${JSON.stringify(s.body?.[0]?.data?.offerProactively)}`);
  const matchedEnabled = report('drive #1 (unset preference)', await driveProactive());

  // --- phase 2: the user opts out through the real Settings API, then re-drives
  s = await amzSettings('UpdateSettings', { data: { offerProactively: { value: false } } });
  out(`UpdateSettings offerProactively=false -> ${s.status}`);
  const matchedDisabled = report('drive #2 (opted out)', await driveProactive());

  // --- phase 3: ACTUALLY RESTART the Settings service and the hub, then re-drive
  await stopStack();
  await startStack('2 (after restart)');
  s = await amzSettings('GetSettings', { loopId: loop._id, transId: 'demo-2', skills: ['report-skill'], getView: false });
  out(`GetSettings after restart offerProactively=${JSON.stringify(s.body?.[0]?.data?.offerProactively)}`);
  const matchedAfterRestart = report('drive #3 (opted out, after restart)', await driveProactive());

  // --- phase 4: opt back in on the restarted stack
  s = await amzSettings('UpdateSettings', { data: { offerProactively: { value: true } } });
  out(`UpdateSettings offerProactively=true -> ${s.status}`);
  const matchedReEnabled = report('drive #4 (opted back in)', await driveProactive());

  const ok = matchedEnabled && !matchedDisabled && !matchedAfterRestart && matchedReEnabled;
  out(`\nRESULT ${ok ? 'PASS' : 'FAIL'}: enabled=${matchedEnabled} optedOut=${matchedDisabled} optedOutAfterRestart=${matchedAfterRestart} reEnabled=${matchedReEnabled}`);
  await stopStack();
  process.exitCode = ok ? 0 : 1;
} finally {
  history.close();
  rmSync(dir, { recursive: true, force: true });
}
