// VoiceTraining — the robot's voice-sample enrollment/training store (A-20).
//
// Every expectation is pinned to the archive, not invented:
//   jibo:server/voice-ws@a0ec047a86d6811176d0f05a6cce5a660a2cadd8
//     server.js, lib/handlers/index.js, lib/handlers/base.handler.js,
//     lib/handlers/upload-voice-sample.handler.js, lib/handlers/list-voice-trainings.handler.js
//   jibo:jiborobot/srv-voice-ws-archived@0e8dc870beaad8caf1dc9ae415a5d250a580b570 (same exports)
//   jiborobot/srv-backup-ws-archived lib/handlers/backup.handler.js, lib/controllers/backup.ctrl.js,
//     lib/schemes/backup.js (the `client.Backup` the pinned handlers call)
//   jiborobot/srv-jibo-server-client apis/voicetraining-2015-06-17|2015-11-03|2016-01-03.normal.json
//   https://pvindex.org/docs/latest/Jibo/VoiceTraining.html
//
// The regression this file exists to prevent: there was NO /^voicetraining/i route at all, so every
// VoiceTraining target — including the two operations the pinned dispatcher DOES export — answered
// UnknownOperationException 400 and no training ever persisted.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  signedAmz, signedFetch, startClassicChild, syntheticAccount, writeSyntheticAccountStore,
} from './fixtures/signedClassic.js';
import {
  createClassicEntrypoint, VoiceTrainingStore, voiceTrainingBackup,
  VOICE_TRAINING_OPERATIONS, VOICE_TRAINING_UNSUPPORTED_OPERATIONS, VOICE_TRAINING_TARGET_PREFIXES,
  VOICE_TRAINING_PATH_ROOT, VOICE_TRAINING_MAX_BYTES, VOICE_TRAINING_BLOB_ROUTE,
  VOICE_TRAINING_ACCOUNT_REQUIRED, VOICE_TRAINING_VALIDATORS, MISSING_AUTH_HEADER,
} from '../src/index.js';


const A = '5a0b20f5ddee0000197e2881';
const B = '59e66fc3762588001e64c296';

let dir;
before(async () => { dir = await mkdtemp(join(tmpdir(), 'phoenix-voiceTraining-')); });
after(async () => { await rm(dir, { recursive: true, force: true }); });

let seq = 0;
const nextFile = () => join(dir, `voiceTraining-${(seq += 1)}.json`);

function amzOn(port, target, body, accountId = A) {
  const headers = { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': target };
  if (accountId) {
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${accountId}/20180910/us-east-1/voice/aws4_request, SignedHeaders=host, Signature=ff`;
  }
  return fetch(`http://localhost:${port}/`, { method: 'POST', headers, body: JSON.stringify(body || {}) })
    .then(async (res) => ({ status: res.status, errType: res.headers.get('x-amzn-errortype'), body: await res.json().catch(() => null) }));
}

/** A private entrypoint + store for one test (no shared state, controllable clock). */
async function fresh({ file = nextFile(), backup, maxBytes, account = A } = {}) {
  const store = new VoiceTrainingStore({ file });
  const opts = { voiceTraining: { store } };
  if (backup !== undefined) opts.voiceTraining.backup = backup;
  if (maxBytes !== undefined) opts.voiceTraining.maxBytes = maxBytes;
  const server = await createClassicEntrypoint(opts).listen(0);
  const port = server.address().port;
  return { server, port, store, amz: (t, b, ak = account) => amzOn(port, t, b, ak) };
}

// ------------------------------------------------------------------------------------------------
// Both supported operations are SERVED, under every observed model prefix
// ------------------------------------------------------------------------------------------------

test('UploadVoiceTraining and ListVoiceTrainings are served under all three model prefixes', async () => {
  const j = await fresh();
  try {
    for (const prefix of VOICE_TRAINING_TARGET_PREFIXES) {
      const up = await j.amz(`${prefix}.UploadVoiceTraining`, { key: `k-${prefix}`, body: 'bytes' });
      assert.equal(up.status, 200, `${prefix}.UploadVoiceTraining is served`);
      assert.equal(up.body.path, `${VOICE_TRAINING_PATH_ROOT}k-${prefix}`);
      assert.match(up.body._id, /^[a-f0-9]{24}$/);

      const list = await j.amz(`${prefix}.ListVoiceTrainings`, {});
      assert.equal(list.status, 200, `${prefix}.ListVoiceTrainings is served`);
      assert.ok(Array.isArray(list.body));
    }
  } finally { await j.server.close(); }
});

test('the reply is the legacy Backup document (schemes/backup.js toJSON + the url virtual)', async () => {
  const j = await fresh();
  try {
    const r = await j.amz('VoiceTraining_20151020.UploadVoiceTraining', { key: 'voice-1', body: 'hello' });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ['_id', 'accountId', 'created', 'path', 'url'].sort());
    assert.equal(r.body.accountId, A);
    assert.equal(r.body.path, `${VOICE_TRAINING_PATH_ROOT}voice-1`);
    assert.equal(typeof r.body.created, 'number');
    assert.match(r.body.url, new RegExp(`${VOICE_TRAINING_BLOB_ROUTE}\\?key=${r.body._id}$`));
  } finally { await j.server.close(); }
});

// ------------------------------------------------------------------------------------------------
// The file-operation versions are NOT served: the pinned dispatcher's own 404
// ------------------------------------------------------------------------------------------------

test('the historical file operations answer the source 404 "Method not found in VoiceTraining"', async () => {
  const j = await fresh();
  try {
    // The 2015-11-03 and 2016-01-03 models declare these four names; the pinned handler exports
    // neither `<name>` nor `<name>Handler`, so server.js replies Boom.notFound.
    for (const op of ['UploadFile', 'RemoveFile', 'ListFiles', 'GetFile']) {
      for (const prefix of ['VoiceTraining_20151103', 'VoiceTraining_20160103']) {
        const r = await j.amz(`${prefix}.${op}`, {});
        assert.equal(r.status, 404, `${prefix}.${op} is NOT served`);
        assert.equal(r.body.statusCode, 404);
        assert.equal(r.body.error, 'Not Found');
        assert.equal(r.body.message, `Method not found in VoiceTraining, method ${op}`);
      }
    }
    // An operation no model ever declared is the same fallback (never invented).
    const madeUp = await j.amz('VoiceTraining_20160103.Frobnicate', {});
    assert.equal(madeUp.status, 404);
    assert.equal(madeUp.body.message, 'Method not found in VoiceTraining, method Frobnicate');
  } finally { await j.server.close(); }
});

test('VOICE_TRAINING_OPERATIONS and the unsupported set are the pinned method names', () => {
  assert.deepEqual(VOICE_TRAINING_OPERATIONS, ['uploadvoicetraining', 'listvoicetrainings']);
  assert.deepEqual(VOICE_TRAINING_UNSUPPORTED_OPERATIONS, ['uploadfile', 'removefile', 'listfiles', 'getfile']);
  assert.deepEqual(VOICE_TRAINING_TARGET_PREFIXES, ['VoiceTraining_20151020', 'VoiceTraining_20151103', 'VoiceTraining_20160103']);
  assert.equal(VOICE_TRAINING_MAX_BYTES, 100000000);
  assert.equal(VOICE_TRAINING_PATH_ROOT, '/voiceTraining/');
});

// ------------------------------------------------------------------------------------------------
// Validation / auth / error precedence
// ------------------------------------------------------------------------------------------------

test('UploadVoiceTraining validates key then body with the pinned Joi messages (Boom 400)', async () => {
  const j = await fresh();
  try {
    const cases = [
      [{}, 'child "key" fails because ["key" is required]'],
      [{ key: 5, body: 'x' }, 'child "key" fails because ["key" must be a string]'],
      [{ key: '', body: 'x' }, 'child "key" fails because ["key" is not allowed to be empty]'],
      [{ key: 'k' }, 'child "body" fails because ["body" is required]'],
    ];
    for (const [body, message] of cases) {
      const r = await j.amz('VoiceTraining_20151020.UploadVoiceTraining', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.statusCode, 400);
      assert.equal(r.body.error, 'Bad Request');
      assert.equal(r.body.message, message);
    }
    assert.equal(VOICE_TRAINING_VALIDATORS.listvoicetrainings, undefined, 'ListVoiceTrainings sets no validate');
    // ListVoiceTrainings has NO validation: an empty body is served.
    assert.equal((await j.amz('VoiceTraining_20151020.ListVoiceTrainings', {})).status, 200);
  } finally { await j.server.close(); }
});

test('an unsigned call is MISSING_AUTH_HEADER 401 before any dispatch (gateway allow-list)', async () => {
  const j = await fresh();
  try {
    for (const target of ['VoiceTraining_20151020.UploadVoiceTraining', 'VoiceTraining_20151020.ListVoiceTrainings', 'VoiceTraining_20160103.UploadFile']) {
      const r = await j.amz(target, { key: 'k', body: 'b' }, null);
      assert.equal(r.status, 401, target);
      assert.equal(r.errType, 'MISSING_AUTH_HEADER');
      assert.equal(r.body.__type, 'MISSING_AUTH_HEADER');
      assert.equal(r.body.message, MISSING_AUTH_HEADER.message);
    }
  } finally { await j.server.close(); }
});

test('the identity may arrive as x-amz-credentials {id} (the gateway forwarding header)', async () => {
  const j = await fresh();
  try {
    const res = await fetch(`http://localhost:${j.port}/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': 'VoiceTraining_20151020.UploadVoiceTraining',
        'x-amz-credentials': JSON.stringify({ id: B, _id: B }),
      },
      body: JSON.stringify({ key: 'via-header', body: 'x' }),
    });
    assert.equal(res.status, 200);
    const rec = await res.json();
    assert.equal(rec.accountId, B);
  } finally { await j.server.close(); }
});

test('a failing client.Backup hop is Boom.wrap(err, 400) with the Backup message', async () => {
  const j = await fresh({
    backup: {
      createBackup: async () => { throw new Error('Only account can create backup'); },
      listBackups: async () => { throw new Error('Backup service down'); },
    },
  });
  try {
    const up = await j.amz('VoiceTraining_20151020.UploadVoiceTraining', { key: 'k', body: 'b' });
    assert.equal(up.status, 400);
    assert.equal(up.body.error, 'Bad Request');
    assert.equal(up.body.message, 'Only account can create backup');

    const list = await j.amz('VoiceTraining_20151020.ListVoiceTrainings', {});
    assert.equal(list.status, 400);
    assert.equal(list.body.message, 'Backup service down');
  } finally { await j.server.close(); }
});

test('the default seam requires an account for createBackup (archived backup handler)', async () => {
  const store = new VoiceTrainingStore({ file: nextFile() });
  const seam = voiceTrainingBackup(store);
  await assert.rejects(() => seam.createBackup({ path: `${VOICE_TRAINING_PATH_ROOT}k`, body: 'b', credentials: {} }),
    (err) => err.message === VOICE_TRAINING_ACCOUNT_REQUIRED && err.statusCode === 401);
  assert.deepEqual(await seam.listBackups({ path: VOICE_TRAINING_PATH_ROOT, credentials: {} }), []);
});

// ------------------------------------------------------------------------------------------------
// Store semantics: prefix list, newest-first, same-path replace, account isolation
// ------------------------------------------------------------------------------------------------

test('list is an account-scoped literal path prefix, newest first; the same path is replaced', async () => {
  const j = await fresh();
  try {
    await j.amz('VoiceTraining_20151020.UploadVoiceTraining', { key: 'a', body: 'a1' });
    const first = await j.amz('VoiceTraining_20151020.UploadVoiceTraining', { key: 'b', body: 'b1' });
    // Re-uploading the same key replays the same {accountId,path}: backup.ctrl.js create drops the
    // previous document, so exactly one record remains for that path.
    const again = await j.amz('VoiceTraining_20151020.UploadVoiceTraining', { key: 'a', body: 'a2' });
    assert.notEqual(again.body._id, first.body._id);

    const list = (await j.amz('VoiceTraining_20151020.ListVoiceTrainings', {})).body;
    assert.equal(list.length, 2, 'one record per {accountId,path}');
    assert.deepEqual(list.map((r) => r.path).sort(), [`${VOICE_TRAINING_PATH_ROOT}a`, `${VOICE_TRAINING_PATH_ROOT}b`]);
    assert.ok(list[0].created >= list[1].created, 'newest first');
    assert.equal(list.find((r) => r.path === `${VOICE_TRAINING_PATH_ROOT}a`)._id, again.body._id);
  } finally { await j.server.close(); }
});

test('trainings never leak across accounts', async () => {
  const j = await fresh();
  try {
    await j.amz('VoiceTraining_20151020.UploadVoiceTraining', { key: 'mine', body: 'a' }, A);
    await j.amz('VoiceTraining_20151020.UploadVoiceTraining', { key: 'theirs', body: 'b' }, B);

    const asA = (await j.amz('VoiceTraining_20151020.ListVoiceTrainings', {}, A)).body;
    assert.deepEqual(asA.map((r) => r.path), [`${VOICE_TRAINING_PATH_ROOT}mine`]);
    assert.ok(asA.every((r) => r.accountId === A));

    const asB = (await j.amz('VoiceTraining_20151020.ListVoiceTrainings', {}, B)).body;
    assert.deepEqual(asB.map((r) => r.path), [`${VOICE_TRAINING_PATH_ROOT}theirs`]);
  } finally { await j.server.close(); }
});

test('the stored artifact bytes are retrievable from the record url (self-hosted blob route)', async () => {
  const j = await fresh();
  try {
    const up = await j.amz('VoiceTraining_20151020.UploadVoiceTraining', { key: 'artifact', body: 'the-voice-sample' });
    assert.equal(up.status, 200);
    const res = await fetch(up.body.url);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/octet-stream');
    assert.equal(await res.text(), 'the-voice-sample');

    const missing = await fetch(`http://localhost:${j.port}${VOICE_TRAINING_BLOB_ROUTE}?key=deadbeefdeadbeefdeadbeef`);
    assert.equal(missing.status, 404);
  } finally { await j.server.close(); }
});

test('a body over maxBytes is the Hapi payload 413', async () => {
  const j = await fresh({ maxBytes: 4 });
  try {
    const over = await j.amz('VoiceTraining_20151020.UploadVoiceTraining', { key: 'k', body: '12345' });
    assert.equal(over.status, 413);
    assert.equal(over.body.error, 'Request Entity Too Large');
    assert.match(over.body.message, /Payload content length greater than maximum allowed: 4/);
    assert.equal(j.store.records.length, 0, 'nothing persisted');

    const ok = await j.amz('VoiceTraining_20151020.UploadVoiceTraining', { key: 'k', body: '1234' });
    assert.equal(ok.status, 200);
  } finally { await j.server.close(); }
});

// ------------------------------------------------------------------------------------------------
// Durability
// ------------------------------------------------------------------------------------------------

test('voiceTraining state survives a restart (new entrypoint, same store file)', async () => {
  const file = nextFile();
  const first = await fresh({ file });
  let id;
  try {
    id = (await first.amz('VoiceTraining_20151020.UploadVoiceTraining', { key: 'persisted', body: 'survives' })).body._id;
  } finally { await first.server.close(); }

  const second = await fresh({ file });
  try {
    const list = (await second.amz('VoiceTraining_20151020.ListVoiceTrainings', {})).body;
    assert.equal(list.length, 1);
    assert.equal(list[0]._id, id);
    assert.equal(list[0].path, `${VOICE_TRAINING_PATH_ROOT}persisted`);
    const res = await fetch(list[0].url);
    assert.equal(await res.text(), 'survives', 'the artifact bytes read back after the restart');
  } finally { await second.server.close(); }

  const raw = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(raw.records.length, 1);
  assert.equal(raw.records[0].path, `${VOICE_TRAINING_PATH_ROOT}persisted`);
});

test('voiceTraining survives a SIGKILL process restart (fresh process, same store file)', async () => {
  const file = nextFile();
  const first = await startChild(file);
  let created;
  try {
    created = (await childAmz(first.base, 'VoiceTraining_20151020.UploadVoiceTraining', { key: 'kill-survivor', body: 'raw-bytes' })).body;
    assert.equal(created.path, `${VOICE_TRAINING_PATH_ROOT}kill-survivor`);
  } finally { await first.stop(); } // SIGKILL: no graceful shutdown, nothing flushed on exit

  const second = await startChild(file);
  try {
    const list = (await childAmz(second.base, 'VoiceTraining_20151020.ListVoiceTrainings', {})).body;
    assert.equal(list.length, 1);
    assert.equal(list[0]._id, created._id);
    assert.equal(list[0].accountId, A);
    // The artifact is still served by the fresh process. On the authenticated executable face
    // the blob route is behind the same SigV4 boundary and is owner-scoped
    // (voiceTraining.js voiceTrainingBlobRoutes), so the owning account signs the GET.
    const blobUrl = `${second.base}${VOICE_TRAINING_BLOB_ROUTE}?key=${created._id}`;
    const res = await signedFetch(blobUrl, { method: 'GET', credentials: CHILD_CREDENTIALS[A] });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'raw-bytes');
    const unsigned = await fetch(blobUrl);
    assert.equal(unsigned.status, 401, 'an unsigned blob read is refused by the caller boundary');
    const foreign = await signedFetch(blobUrl, { method: 'GET', credentials: CHILD_CREDENTIALS[B] });
    assert.equal(foreign.status, 403, 'another account may not read the artifact');
  } finally { await second.stop(); }

  const raw = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(raw.records.length, 1);
  assert.equal(raw.records[0].accountId, A);
});

// Synthetic signing credentials for the child. The executable entrypoint (index.js start())
// verifies every request's SigV4 signature against the Account store named by
// ETCO_classic_accountDataFile; VoiceTraining then sees the VERIFIED account id, so each
// synthetic account's _id is the fixture's account id and its access key is different.
const CHILD_CREDENTIALS = {
  [A]: syntheticAccount(A),
  [B]: syntheticAccount(B),
};

/** Start the real classic entrypoint as a child process over `voiceFile` (its own fresh store). */
async function startChild(voiceFile) {
  const accountDataFile = `${voiceFile}.account.json`;
  writeSyntheticAccountStore(accountDataFile, { accounts: Object.values(CHILD_CREDENTIALS) });
  return startClassicChild({
    accountDataFile,
    env: { ETCO_classic_voiceTrainingFile: voiceFile },
    ready: async (base) => (await childAmz(base, 'VoiceTraining_20151020.ListVoiceTrainings', {})).status === 200,
  });
}

function childAmz(base, target, body, accountId = A) {
  return signedAmz(base, target, body, CHILD_CREDENTIALS[accountId]);
}

// Re-ported from the September week-review hardening (synthetic data).
test('the advertised 100 MB request limit does not inherit common parser\'s 100 KB default', async () => {
  const j = await fresh();
  try {
    const body = 'v'.repeat(128 * 1024);
    const accepted = await j.amz('VoiceTraining_20151020.UploadVoiceTraining', { key: 'large', body });
    assert.equal(accepted.status, 200);
    assert.equal(j.store.records[0].size, Buffer.byteLength(body));
  } finally { await j.server.close(); }
});
