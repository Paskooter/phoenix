// A-17 (IFTTT_20170207) durability — the original controller kept Identity/Trigger/Action/
// TriggerMedia in Mongo (jiborobot/srv-ifttt-ws src/schemes/*.ts), so the state must survive a
// process death without any graceful shutdown. This starts the real Classic entrypoint as a CHILD
// process over `ETCO_classic_iftttFile`, writes through the wire, SIGKILLs it, starts a FRESH
// process over the same file and reads the state back. Nothing is flushed on exit — only the
// store's own atomic writes can make the assertions pass.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ENTRY = join(ROOT, 'packages', 'classic', 'src', 'index.js');
const ACCOUNT = 'acct-a17';
const TRIGGER_TEXT = 'hello twitter';

async function freePort() {
  const srv = http.createServer();
  await new Promise((resolve) => srv.listen(0, resolve));
  const port = srv.address().port;
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

function childAmz(base, target, body) {
  return fetch(`${base}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': target,
      authorization: `AWS4-HMAC-SHA256 Credential=${ACCOUNT}/20170207/us-east-1/ifttt/aws4_request, SignedHeaders=host, Signature=ff`,
    },
    body: JSON.stringify(body || {}),
  }).then(async (res) => ({ status: res.status, errType: res.headers.get('x-amzn-errortype'), body: await res.json().catch(() => null) }));
}

/** Start the real classic entrypoint as a child process over `file` (its own fresh IftttStore). */
async function startChild(file) {
  const port = await freePort();
  const child = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), ETCO_classic_iftttFile: file },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stdout.resume();
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const base = `http://localhost:${port}`;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const res = await childAmz(base, 'IFTTT_20170207.UserInfo', {});
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
  throw new Error(`classic entrypoint child did not start: ${stderr}`);
}

test('IFTTT identity/trigger/action state survives a SIGKILL process restart (same store file)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ifttt-durable-'));
  const file = join(dir, 'ifttt.json');
  let first;
  let second;
  try {
    // Process 1: write through the wire. ListTriggers mints the applet identity, Trigger then
    // matches it and creates the Trigger row; Action creates an owner-loop Action row.
    first = await startChild(file);
    const listed = await childAmz(first.base, 'IFTTT_20170207.ListTriggers', { identity: 'idf-1', text: TRIGGER_TEXT });
    assert.equal(listed.status, 200);
    const triggered = await childAmz(first.base, 'IFTTT_20170207.Trigger', { text: TRIGGER_TEXT });
    assert.equal(triggered.status, 200);
    assert.deepEqual(triggered.body, { result: 'Command accepted' });
    const action = await childAmz(first.base, 'IFTTT_20170207.Action', { fields: { key: 'value' } });
    assert.equal(action.status, 200);
    assert.equal(action.body.length, 1);
    const actionId = action.body[0].id;

    await first.stop(); // SIGKILL: no graceful shutdown, nothing flushed on exit
    first = null;

    // The kill must not have needed the process to finish: the file already holds the rows.
    const raw = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(raw.triggers.length, 1);
    assert.equal(raw.triggers[0].text, TRIGGER_TEXT);
    assert.equal(raw.actions.length, 1);
    assert.equal(raw.identities.find((i) => i.id === 'idf-1').filter, TRIGGER_TEXT.toLowerCase());

    // Process 2: a fresh process over the same file reads the state back through the same ops.
    second = await startChild(file);
    const triggers = await childAmz(second.base, 'IFTTT_20170207.ListTriggers', { identity: 'idf-1', text: TRIGGER_TEXT });
    assert.equal(triggers.status, 200);
    assert.equal(triggers.body.length, 1);
    assert.equal(triggers.body[0].text, TRIGGER_TEXT);

    const actions = await childAmz(second.base, 'IFTTT_20170207.ListActions', {});
    assert.equal(actions.status, 200);
    assert.deepEqual(actions.body.map((a) => a.id), [actionId]);
    assert.deepEqual(actions.body[0].fields, { key: 'value' });

    const user = await childAmz(second.base, 'IFTTT_20170207.UserInfo', {});
    assert.equal(user.status, 200);
    assert.deepEqual(user.body, { id: ACCOUNT, name: '' });
  } finally {
    if (first) await first.stop();
    if (second) await second.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('DeleteIdentity cascades across a restart: the deleted rows do not come back', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ifttt-durable-del-'));
  const file = join(dir, 'ifttt.json');
  let first;
  let second;
  try {
    first = await startChild(file);
    await childAmz(first.base, 'IFTTT_20170207.ListTriggers', { identity: 'idf-del', text: 'goodnight' });
    await childAmz(first.base, 'IFTTT_20170207.Trigger', { text: 'goodnight' });
    const deleted = await childAmz(first.base, 'IFTTT_20170207.DeleteIdentity', { identity: 'idf-del' });
    assert.equal(deleted.status, 200);
    await first.stop();
    first = null;

    const raw = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(raw.triggers, []);

    second = await startChild(file);
    // idf-del no longer exists, so ListTriggers mints it fresh with no triggers attached.
    const listed = await childAmz(second.base, 'IFTTT_20170207.ListTriggers', { identity: 'idf-del', text: 'goodnight' });
    assert.deepEqual(listed.body, []);
  } finally {
    if (first) await first.stop();
    if (second) await second.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
