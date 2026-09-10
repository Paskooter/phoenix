// A-15 durability, proven at the *process* level (stronger than the in-process entrypoint test in
// packages/classic/test/person.test.js). Starts the real classic entrypoint as a child `node`
// process pointed at a store file, writes Person state over the AWS-JSON wire, SIGKILLs the
// process (no graceful shutdown), starts a brand-new process over the same file, and reads the
// state back. If the store is not on disk the second process cannot know any of it.
//
//   node docs/parity/evidence/2026-09-10/a15-person-collision/restart-process.mjs
//
// Exit 0 = every value survived; 1 = a mismatch (prints the offending key/value). Each child picks
// its own ephemeral port (restart-server.mjs) so the probe never collides with a parallel worktree.

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('./restart-server.mjs', import.meta.url));
const OWNER = 'acct-owner';
const LOOP = 'loop-1';

let port = 0;
const post = (target, body, accessKeyId = OWNER) => fetch(`http://localhost:${port}/`, {
  method: 'POST',
  headers: {
    'content-type': 'application/x-amz-json-1.1',
    'x-amz-target': target,
    ...(accessKeyId
      ? { authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/20180910/us-east-1/person/aws4_request, SignedHeaders=host, Signature=ff` }
      : {}),
  },
  body: JSON.stringify(body || {}),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

function startProcess(storeFile) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, ETCO_classic_personFile: storeFile, A15_FIXED_NOW: String(Date.UTC(2018, 8, 10, 12, 0, 0)) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('classic entrypoint never reported a port')); }, 15_000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const line = buffer.split('\n').find((l) => l.startsWith('A15PORT '));
      if (!line) return;
      clearTimeout(timer);
      resolve({ child, port: JSON.parse(line.slice('A15PORT '.length)).port });
    });
    child.on('error', reject);
  });
}

async function stop({ child }) {
  if (child.exitCode !== null || child.signalCode) return;
  const exited = new Promise((r) => child.once('exit', r));
  child.kill('SIGKILL');
  await exited;
}

const dir = await mkdtemp(join(tmpdir(), 'a15-restart-'));
const storeFile = join(dir, 'person.json');
const checks = [];
const assertEq = (name, got, want) => { checks.push({ name, got, want, ok: JSON.stringify(got) === JSON.stringify(want) }); };

// --- process 1: write state ----------------------------------------------------------------
let p1 = await startProcess(storeFile);
port = p1.port;
await post('Person_20160801.SetAccountProperty', { key: 'survives', value: { n: 42 } });
await post('Person_20160801.Answer', { key: 'APP_CAKE_PREFERENCE', answer: 'PINEAPPLE' });
const h1 = await post('Person_20160801.ListHolidays', { loopId: LOOP });
const halloween = h1.body.find((h) => h.name === 'Halloween');
await post('Person_20160801.EnableHolidays', { ids: [halloween.id], loopId: LOOP });
await stop(p1);

// --- process 2: cold start, same file -------------------------------------------------------
const p2 = await startProcess(storeFile);
port = p2.port;
try {
  const props = await post('Person_20160801.GetAccountProperties', { keys: ['survives'] });
  assertEq('account property value', props.body, { survives: { n: 42 } });
  const list = await post('Person_20160801.List', { category: 'app' });
  assertEq('answered question removed from List', list.body.map((q) => q.key), ['APP_PLACE_TO_LIVE']);
  const again = await post('Person_20160801.Answer', { key: 'APP_CAKE_PREFERENCE', answer: 'RASPBERRY' });
  assertEq('ALREADY_ANSWERED survives restart (409)', [again.status, again.body.__type], [409, 'ALREADY_ANSWERED']);
  const h2 = await post('Person_20160801.ListHolidays', { loopId: LOOP });
  const hw = h2.body.filter((h) => h.name === 'Halloween');
  assertEq('holiday id stable across restart', hw.every((h) => h.id === halloween.id), true);
  assertEq('enabled holiday survives restart', hw.every((h) => h.isEnabled === true), true);
} finally {
  await stop(p2);
  await rm(dir, { recursive: true, force: true });
}

let failed = 0;
for (const c of checks) {
  console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}  got=${JSON.stringify(c.got)}`);
  if (!c.ok) failed += 1;
}
console.log(failed === 0
  ? `PASS: ${checks.length}/${checks.length} values survived a real process restart (SIGKILL -> new process)`
  : `FAIL: ${failed}/${checks.length} checks failed`);
process.exit(failed === 0 ? 0 : 1);
