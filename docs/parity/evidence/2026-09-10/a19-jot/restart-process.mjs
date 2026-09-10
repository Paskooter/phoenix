// A-19 durability, proven at the *process* level. Starts the real classic entrypoint as a child
// `node` process pointed at a Jot store file (ETCO_classic_jotFile), writes Jot state over the
// AWS-JSON wire using the archived integration test's literal `Jot_20160512` prefix, SIGKILLs the
// process (no graceful shutdown), starts a brand-new process over the same file, and reads the state
// back. If the store were not on disk the second process could not know any of it.
//
//   node docs/parity/evidence/2026-09-10/a19-jot/restart-process.mjs
//
// Exit 0 = every value survived; 1 = a mismatch (prints the offending key/value). Each child picks
// its own ephemeral port (restart-server.mjs) so the probe never collides with a parallel worktree.

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('./restart-server.mjs', import.meta.url));
const LOOP = '5a0b20f5ddee0000197e2881';
const OTHER_LOOP = '59e66fc3762588001e64c296';
const SENDER = '43ca532ad4090cfb80f2e7a5';
const RECEIVER = '43ca532ad4090cfb80f2e7a7';

let port = 0;
const post = (target, body, accessKeyId = SENDER) => fetch(`http://localhost:${port}/`, {
  method: 'POST',
  headers: {
    'content-type': 'application/x-amz-json-1.1',
    'x-amz-target': target,
    ...(accessKeyId
      ? { authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/20180910/us-east-1/jot/aws4_request, SignedHeaders=host, Signature=ff` }
      : {}),
  },
  body: JSON.stringify(body || {}),
}).then(async (r) => ({ status: r.status, errType: r.headers.get('x-amzn-errortype'), body: await r.json().catch(() => null) }));

function startProcess(storeFile) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, ETCO_classic_jotFile: storeFile },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('classic entrypoint never reported a port')); }, 15_000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const line = buffer.split('\n').find((l) => l.startsWith('A19PORT '));
      if (!line) return;
      clearTimeout(timer);
      resolve({ child, port: JSON.parse(line.slice('A19PORT '.length)).port });
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

const dir = await mkdtemp(join(tmpdir(), 'a19-restart-'));
const storeFile = join(dir, 'jot.json');
const checks = [];
const assertEq = (name, got, want) => { checks.push({ name, got, want, ok: JSON.stringify(got) === JSON.stringify(want) }); };
const ids = [];

// --- process 1: write state ------------------------------------------------------------------
let p1 = await startProcess(storeFile);
port = p1.port;
{
  const a = await post('Jot_20160512.CreateMessage', { loopId: LOOP, content: 'survives-a-kill', tags: [RECEIVER] });
  assertEq('create #1 (200, content)', [a.status, a.body.content], [200, 'survives-a-kill']);
  assertEq('create #1 sender + isRead', [a.body.sender, a.body.isRead], [SENDER, true]);
  ids.push(a.body.id);
  const b = await post('Jot_20160512.CreateMessage', { loopId: LOOP, content: 'second' });
  ids.push(b.body.id);
  await post('Jot_20160512.CreateMessage', { loopId: OTHER_LOOP, content: 'another-loop' });
  await post('Jot_20160512.MarkRead', { ids: [ids[0]] }, RECEIVER);
  const unread = await post('Jot_20160512.NumberOfUnreadMessagesInLoops', { loopIds: [LOOP] }, RECEIVER);
  assertEq('unread before the kill', unread.body, { count: 1 });
}
await stop(p1);

// --- process 2: cold start, same file ---------------------------------------------------------
const p2 = await startProcess(storeFile);
port = p2.port;
try {
  const listed = await post('Jot_20160512.ListMessages', { loopId: LOOP }, RECEIVER);
  assertEq('list is 200 (served after restart)', listed.status, 200);
  assertEq('both messages survive, same ids', listed.body.map((m) => m.id), ids);
  assertEq('contents survive', listed.body.map((m) => m.content), ['survives-a-kill', 'second']);
  assertEq('the read set survives', listed.body.map((m) => m.isRead), [true, false]);
  assertEq('other-loop message is not listed here', listed.body.some((m) => m.content === 'another-loop'), false);

  const unread = await post('Jot_20160512.NumberOfUnreadMessagesInLoops', { loopIds: [LOOP] }, RECEIVER);
  assertEq('unread count survives', unread.body, { count: 1 });

  const marked = await post('Jot_20160512.MarkLoopRead', { loopId: LOOP }, RECEIVER);
  assertEq('MarkLoopRead still served (200)', marked.status, 200);
  const after = await post('Jot_20160512.NumberOfUnreadMessagesInLoops', { loopIds: [LOOP] }, RECEIVER);
  assertEq('loop marked read after restart', after.body, { count: 0 });

  // Both observed prefixes still resolve to the same service after a cold start.
  const otherPrefix = await post('Jot_20160126.ListMessages', { loopId: LOOP }, RECEIVER);
  assertEq('Jot_20160126 prefix served after restart', otherPrefix.status, 200);
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
  ? `PASS: ${checks.length}/${checks.length} Jot values survived a real process restart (SIGKILL -> new process)`
  : `FAIL: ${failed}/${checks.length} checks failed`);
process.exit(failed === 0 ? 0 : 1);
