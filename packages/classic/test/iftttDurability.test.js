// A-17 (IFTTT_20170207) durability — the original controller kept Identity/Trigger/Action/
// TriggerMedia in Mongo (jiborobot/srv-ifttt-ws src/schemes/*.ts), so the state must survive a
// process death without any graceful shutdown. This starts the real Classic entrypoint as a CHILD
// process over `ETCO_classic_iftttFile`, writes through the wire, SIGKILLs it, starts a FRESH
// process over the same file and reads the state back. Nothing is flushed on exit — only the
// store's own atomic writes can make the assertions pass.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  signedAmz, startClassicChild, syntheticAccount, writeSyntheticAccountStore,
} from './fixtures/signedClassic.js';

const ACCOUNT = 'acct-a17';
const TRIGGER_TEXT = 'hello twitter';
// Synthetic robot credentials. The executable entrypoint (index.js start()) verifies every
// request's SigV4 signature against the Account store named by ETCO_classic_accountDataFile,
// so the child gets a synthetic snapshot and every call below is really signed. The access
// key equals the account id here so the IFTTT identity (ifttt.js keys it by the SigV4
// Credential access key) and the account id coincide, as in the original fixture.
const CREDENTIALS = syntheticAccount(ACCOUNT, { accessKeyId: ACCOUNT });

function childAmz(base, target, body) {
  return signedAmz(base, target, body, CREDENTIALS);
}

/** Start the real classic entrypoint as a child process over `file` (its own fresh IftttStore). */
async function startChild(dir, file) {
  const accountDataFile = join(dir, 'account.json');
  writeSyntheticAccountStore(accountDataFile, { accounts: [CREDENTIALS] });
  return startClassicChild({
    accountDataFile,
    env: { ETCO_classic_iftttFile: file },
    ready: async (base) => (await childAmz(base, 'IFTTT_20170207.UserInfo', {})).status === 200,
  });
}

test('IFTTT identity/trigger/action state survives a SIGKILL process restart (same store file)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ifttt-durable-'));
  const file = join(dir, 'ifttt.json');
  let first;
  let second;
  try {
    // Process 1: write through the wire. ListTriggers mints the applet identity, Trigger then
    // matches it and creates the Trigger row; Action creates an owner-loop Action row.
    first = await startChild(dir, file);
    // The child is the authenticated production face: an unsigned call is refused.
    const unsigned = await fetch(`${first.base}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'IFTTT_20170207.UserInfo' },
      body: '{}',
    });
    assert.equal(unsigned.status, 401);
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
    second = await startChild(dir, file);
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
    first = await startChild(dir, file);
    await childAmz(first.base, 'IFTTT_20170207.ListTriggers', { identity: 'idf-del', text: 'goodnight' });
    await childAmz(first.base, 'IFTTT_20170207.Trigger', { text: 'goodnight' });
    const deleted = await childAmz(first.base, 'IFTTT_20170207.DeleteIdentity', { identity: 'idf-del' });
    assert.equal(deleted.status, 200);
    await first.stop();
    first = null;

    const raw = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(raw.triggers, []);

    second = await startChild(dir, file);
    // idf-del no longer exists, so ListTriggers mints it fresh with no triggers attached.
    const listed = await childAmz(second.base, 'IFTTT_20170207.ListTriggers', { identity: 'idf-del', text: 'goodnight' });
    assert.deepEqual(listed.body, []);
  } finally {
    if (first) await first.stop();
    if (second) await second.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
