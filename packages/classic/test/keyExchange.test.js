// A-11 — key exchange, backup and binary-key operations.
//
// Grounded in the pinned source (read via the Jibo archive MCP):
//   jiborobot/srv-key-ws  src/controllers/key.ctrl.ts, src/handlers/key.handler.ts,
//                         src/errors/key.ts, src/routes/binary.route.ts, config/config.json
//   jiborobot/srv-jibo-server-client  apis/key-2016-02-01.normal.json (targetPrefix Key_20160201)
//   jiborobot/srv-key-ws  test/key.handler.spec.ts, test/key.ctrl.spec.ts, test/binary.share.spec.ts
//
// Every operation is exercised over the real HTTP face (the source's client model), the encrypted
// key sharing round trip uses a real RSA/AES pair owned by the test, ownership/membership refusals
// are compared against the pinned error catalogue, and durability is proven by SIGKILLing the
// process and re-reading the state from a fresh one.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import {
  generateKeyPairSync, publicEncrypt, privateDecrypt, randomBytes, constants, createHash,
} from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createClassicEntrypoint, KeyStore, KEY_ERRORS } from '../src/index.js';
import { Store, createAccountService } from '@phoenix/account';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ENTRY = join(ROOT, 'packages', 'classic', 'src', 'index.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let dir; let server; let port; let prevKeyFile; let prevBinDir;
const base = () => `http://localhost:${port}`;

/** One AMZ call. `opts.accessKey` sets the SigV4 Credential user (the identity seam). */
async function amz(target, body, { accessKey, rawBody, headers } = {}) {
  const res = await fetch(`${base()}/`, {
    method: 'POST',
    headers: {
      ...(rawBody !== undefined ? { 'content-type': 'application/octet-stream' } : { 'content-type': 'application/x-amz-json-1.1' }),
      'x-amz-target': target,
      ...(accessKey ? { authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/20260613/us-east-1/aws4_request, SignedHeaders=host, Signature=ff` } : {}),
      ...(headers || {}),
    },
    body: rawBody !== undefined ? rawBody : JSON.stringify(body || {}),
  });
  return {
    status: res.status,
    errType: res.headers.get('x-amzn-errortype'),
    body: await parseBody(res),
  };
}

/** The wire body is JSON for every reply except the raw-binary GET; parse when possible. */
async function parseBody(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

// The pinned client's error precedence: lib/protocol/json.js:62-71 (__type || code || error).
function clientErrorCode(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  return parsed.__type || parsed.code || parsed.error || null;
}

let store;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'phx-key-a11-'));
  prevKeyFile = process.env.ETCO_classic_keyFile;
  prevBinDir = process.env.ETCO_classic_keyBinaryDir;
  process.env.ETCO_classic_keyFile = join(dir, 'keys.json');
  process.env.ETCO_classic_keyBinaryDir = join(dir, 'binaries');
  store = new KeyStore(process.env.ETCO_classic_keyFile);
  server = await createClassicEntrypoint({ keyStore: store }).listen(0);
  port = server.address().port;
});
after(() => {
  server.close();
  if (prevKeyFile === undefined) delete process.env.ETCO_classic_keyFile; else process.env.ETCO_classic_keyFile = prevKeyFile;
  if (prevBinDir === undefined) delete process.env.ETCO_classic_keyBinaryDir; else process.env.ETCO_classic_keyBinaryDir = prevBinDir;
  rmSync(dir, { recursive: true, force: true });
});

// ---- 1. all nine operations are SERVED (runtime, not static) ----------------

test('all nine Key_20160201 operations are dispatched at runtime', async () => {
  // A loop with a real member set so the membership checks pass instead of refusing.
  const svc = await withMembership(
    { memberIds: async () => ['acct-A', 'acct-B'], loop: async () => ({ owner: 'acct-A', robot: 'acct-B' }) },
    async (b) => {
      const created = await b.amz('Key_20160201.CreateRequest', { loopId: 'l-all', publicKey: 'PEM' }, { accessKey: 'acct-A' });
      const calls = {
        CreateRequest: created,
        GetRequest: await b.amz('Key_20160201.GetRequest', { id: created.body.id }, { accessKey: 'acct-A' }),
        Share: await b.amz('Key_20160201.Share', { id: created.body.id, encryptedKey: 'EK' }, { accessKey: 'acct-B' }),
        ListIncomingRequests: await b.amz('Key_20160201.ListIncomingRequests', { loopId: 'l-all' }, { accessKey: 'acct-B' }),
        ShouldCreate: await b.amz('Key_20160201.ShouldCreate', { loopId: 'l-all' }, { accessKey: 'acct-A' }),
        Backup: await b.amz('Key_20160201.Backup', { loopId: 'l-all', encryptedKey: 'BK' }, { accessKey: 'acct-A' }),
        Restore: await b.amz('Key_20160201.Restore', { loopId: 'l-all' }, { accessKey: 'acct-B' }),
        ListBinaryRequests: await b.amz('Key_20160201.ListBinaryRequests', { loopId: 'l-all' }, { accessKey: 'acct-B' }),
        ShareBinary: await b.amz('Key_20160201.ShareBinary', 'BYTES', {
          accessKey: 'acct-B', rawBody: 'BYTES', headers: { 'x-id': '000000000000000000000000' },
        }),
      };
      return calls;
    },
  );
  for (const [name, res] of Object.entries(svc)) {
    assert.notEqual(res.status, 400, `${name} must be dispatched (not an unknown operation)`);
    if (name !== 'ShareBinary') assert.notEqual(res.status, 404, `${name} must be a served operation`);
  }
  assert.equal(svc.CreateRequest.status, 200);
  assert.equal(svc.ShouldCreate.body.shouldCreate, false, 'Share satisfied the loop key');
  assert.equal(svc.ShareBinary.status, 404, 'unknown binary id -> BINARY_NOT_FOUND, but the OP is served');
  assert.equal(svc.ShareBinary.errType, 'BINARY_NOT_FOUND');
});

// ---- 2. request state transitions + a real encryption round trip ------------

test('CreateRequest -> ListIncomingRequests -> Share -> GetRequest: real RSA/AES round trip', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const aes = randomBytes(32); // the shared symmetric key the members exchange
  const keyHash = createHash('sha1').update(aes).digest('hex');

  const svc = await withMembership(
    { memberIds: async () => ['requester', 'sharer'], loop: async () => ({ owner: 'requester', robot: null }) },
    async (b) => {
      const created = await b.amz('Key_20160201.CreateRequest', { loopId: 'l-rt', publicKey: pem }, { accessKey: 'requester' });
      const satisfiedBefore = (await b.amz('Key_20160201.ShouldCreate', { loopId: 'l-rt' }, { accessKey: 'requester' })).body.shouldCreate;
      const incoming = await b.amz('Key_20160201.ListIncomingRequests', { loopId: 'l-rt' }, { accessKey: 'sharer' });

      // the sibling encrypts the symmetric key to the requester's PUBLIC key (pinned model:
      // ShareRequest.encryptedKey is "Base64 encoded encrypted key").
      const encryptedKey = publicEncrypt(
        { key: pem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        aes,
      ).toString('base64');
      const shared = await b.amz('Key_20160201.Share', { id: created.body.id, encryptedKey, keyHash }, { accessKey: 'sharer' });

      // the requester fetches it back and decrypts with the PRIVATE key.
      const got = await b.amz('Key_20160201.GetRequest', { id: created.body.id }, { accessKey: 'requester' });
      const decrypted = privateDecrypt(
        { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        Buffer.from(got.body.encryptedKey, 'base64'),
      );
      const satisfiedAfter = (await b.amz('Key_20160201.ShouldCreate', { loopId: 'l-rt' }, { accessKey: 'requester' })).body.shouldCreate;
      return { created, incoming, shared, got, decrypted, satisfiedBefore, satisfiedAfter };
    },
  );

  // CreateRequest output = the pinned `Request` shape (declared members only).
  assert.deepEqual(Object.keys(svc.created.body).sort(), ['accountId', 'id', 'loopId', 'publicKey'].sort());
  assert.equal(svc.created.body.accountId, 'requester');
  assert.equal(svc.created.body.publicKey, pem, 'the PEM public key is stored and returned verbatim');
  assert.match(svc.created.body.id, /^[a-f0-9]{24}$/, '24-hex id, like a Mongo ObjectId');

  assert.equal(svc.satisfiedBefore, true, 'a fresh loop still needs a key');
  assert.equal(svc.incoming.body.length, 1, 'the sibling sees the pending request');
  assert.equal(svc.incoming.body[0].id, svc.created.body.id);
  assert.equal(svc.incoming.body[0].encryptedKey, undefined, 'unsatisfied request carries no key');

  assert.equal(svc.shared.status, 200);
  assert.equal(svc.got.body.encryptedKey, svc.shared.body.encryptedKey, 'key material returned byte-for-byte');
  assert.deepEqual(svc.decrypted, aes, 'the requester decrypts the exact symmetric key the sharer sent');
  assert.equal(svc.satisfiedAfter, false, 'a satisfied loop must not create another key');
});

test('re-creating the same (account, loop, publicKey) reuses one request document', async () => {
  const svc = await withMembership({ memberIds: async () => ['a', 'b'] }, async (b) => ({
    one: await b.amz('Key_20160201.CreateRequest', { loopId: 'l-dedupe', publicKey: 'P1' }, { accessKey: 'a' }),
    two: await b.amz('Key_20160201.CreateRequest', { loopId: 'l-dedupe', publicKey: 'P1' }, { accessKey: 'a' }),
    three: await b.amz('Key_20160201.CreateRequest', { loopId: 'l-dedupe', publicKey: 'P2' }, { accessKey: 'a' }),
  }));
  assert.equal(svc.one.body.id, svc.two.body.id, 'source findOne({accountId,loopId,publicKey}) reuse');
  assert.notEqual(svc.one.body.id, svc.three.body.id, 'a different public key is a new request');
});

// ---- 3. exact error envelopes (pinned errors/key.ts) ------------------------

test('pinned error catalogue: exact codes and statuses over the wire', async () => {
  const owner = 'owner-1';
  const robot = 'robot-1';
  const other = 'other-1';
  const svc = await withMembership(
    {
      // l-hash has three members; l-err and any other loop only owner-1 + robot-1, so `other`
      // is a genuine non-member there (source: only siblings may GetRequest/Share/List).
      memberIds: async (loopId) => (loopId === 'l-hash' ? ['owner-1', 'robot-1', 'other-1'] : ['owner-1', 'robot-1']),
      loop: async (loopId) => (loopId === 'l-none' ? null : { owner, robot }),
    },
    async (b) => {
      // seed a request owned by owner-1 in l-err
      const created = await b.amz('Key_20160201.CreateRequest', { loopId: 'l-err', publicKey: 'P' }, { accessKey: owner });
      const r = {
        getUnknown: await b.amz('Key_20160201.GetRequest', { id: 'ffffffffffffffffffffffff' }, { accessKey: owner }),
        shareUnknown: await b.amz('Key_20160201.Share', { id: 'ffffffffffffffffffffffff', encryptedKey: 'E' }, { accessKey: robot }),
        getForeign: await b.amz('Key_20160201.GetRequest', { id: created.body.id }, { accessKey: other }),
        shareForeign: await b.amz('Key_20160201.Share', { id: created.body.id, encryptedKey: 'E' }, { accessKey: 'stranger' }),
        listForeign: await b.amz('Key_20160201.ListIncomingRequests', { loopId: 'l-foreign' }, { accessKey: 'stranger' }),
        shouldCreateNoLoop: await b.amz('Key_20160201.ShouldCreate', { loopId: 'l-none' }, { accessKey: owner }),
        backupNotOwner: await b.amz('Key_20160201.Backup', { loopId: 'l-err', encryptedKey: 'B' }, { accessKey: other }),
        restoreNotOwnerRobot: await b.amz('Key_20160201.Restore', { loopId: 'l-err' }, { accessKey: other }),
        restoreNoBackup: await b.amz('Key_20160201.Restore', { loopId: 'l-missing' }, { accessKey: owner }),
        backupNonexistentLoop: await b.amz('Key_20160201.Backup', { loopId: 'l-none', encryptedKey: 'B' }, { accessKey: owner }),
        missingLoopId: await b.amz('Key_20160201.CreateRequest', { publicKey: 'P' }, { accessKey: owner }),
        missingPublicKey: await b.amz('Key_20160201.CreateRequest', { loopId: 'l-err' }, { accessKey: owner }),
        missingEncryptedKey: await b.amz('Key_20160201.Backup', { loopId: 'l-err' }, { accessKey: owner }),
      };
      // seed a satisfied loop to trigger KEY_HASH_DOESNT_MATCH
      const k = await b.amz('Key_20160201.CreateRequest', { loopId: 'l-hash', publicKey: 'P' }, { accessKey: owner });
      await b.amz('Key_20160201.Share', { id: k.body.id, encryptedKey: 'E1', keyHash: 'HASH-1' }, { accessKey: robot });
      const k2 = await b.amz('Key_20160201.CreateRequest', { loopId: 'l-hash', publicKey: 'P2' }, { accessKey: other });
      r.shareHashMismatch = await b.amz('Key_20160201.Share', { id: k2.body.id, encryptedKey: 'E2', keyHash: 'HASH-2' }, { accessKey: robot });
      return r;
    },
  );

  const check = (res, code, status) => {
    assert.equal(res.status, status, `${code} status`);
    assert.equal(res.errType, code, `${code} x-amzn-errortype`);
    assert.equal(clientErrorCode(res.body), code, `${code} body code (pinned client sees this)`);
    assert.equal(res.body.message, KEY_ERRORS[code].message);
  };

  check(svc.getUnknown, 'KEY_NOT_FOUND', 404);
  check(svc.shareUnknown, 'KEY_NOT_FOUND', 404);
  check(svc.getForeign, 'KEY_NOT_PART_OF_LOOP', 403);
  check(svc.shareForeign, 'KEY_NOT_PART_OF_LOOP', 403);
  check(svc.listForeign, 'KEY_NOT_PART_OF_LOOP', 403);
  check(svc.shouldCreateNoLoop, 'KEY_NOT_PART_OF_LOOP', 403);
  check(svc.backupNotOwner, 'ONLY_OWNER_CAN_BACKUP_RESTORE', 403);
  check(svc.restoreNotOwnerRobot, 'ONLY_OWNER_OR_ROBOT_CAN_RESTORE', 403);
  check(svc.restoreNoBackup, 'BACKUP_NOT_FOUND', 404);
  check(svc.backupNonexistentLoop, 'ONLY_OWNER_CAN_BACKUP_RESTORE', 403);
  check(svc.shareHashMismatch, 'KEY_HASH_DOESNT_MATCH', 409);

  for (const bad of [svc.missingLoopId, svc.missingPublicKey, svc.missingEncryptedKey]) {
    assert.equal(bad.status, 422, 'source @validatePayload -> Boom.badData (422)');
    assert.equal(bad.body.statusCode, 422);
    assert.equal(bad.body.error, 'Unprocessable Entity');
    assert.match(bad.body.message, /is required/);
  }
});

test('Restore compares only a SUPPLIED passwordHash (BACKUP_PASSWORD_WRONG 409)', async () => {
  const svc = await withMembership(
    { memberIds: async () => ['owner-1', 'robot-1'], loop: async () => ({ owner: 'owner-1', robot: 'robot-1' }) },
    async (b) => {
      await b.amz('Key_20160201.Backup', { loopId: 'l-pw', encryptedKey: 'BLOB', passwordHash: 'correct' }, { accessKey: 'owner-1' });
      return {
        omitted: await b.amz('Key_20160201.Restore', { loopId: 'l-pw' }, { accessKey: 'owner-1' }),
        right: await b.amz('Key_20160201.Restore', { loopId: 'l-pw', passwordHash: 'correct' }, { accessKey: 'owner-1' }),
        wrong: await b.amz('Key_20160201.Restore', { loopId: 'l-pw', passwordHash: 'wrong' }, { accessKey: 'owner-1' }),
        byRobot: await b.amz('Key_20160201.Restore', { loopId: 'l-pw' }, { accessKey: 'robot-1' }),
      };
    },
  );
  assert.equal(svc.omitted.status, 200, 'passwordHash is optional in the pinned RestoreRequest');
  assert.equal(svc.right.body.encryptedKey, 'BLOB');
  assert.equal(svc.wrong.status, 409);
  assert.equal(svc.wrong.errType, 'BACKUP_PASSWORD_WRONG');
  assert.equal(svc.byRobot.status, 200, 'ONLY_OWNER_OR_ROBOT: the loop robot may restore');
});

test('Backup is one document PER LOOP (pinned unique index on loopId)', async () => {
  const svc = await withMembership(
    { memberIds: async () => ['owner-1', 'robot-1'], loop: async () => ({ owner: 'owner-1', robot: 'robot-1' }) },
    async (b) => {
      const first = await b.amz('Key_20160201.Backup', { loopId: 'l-one', encryptedKey: 'FIRST', passwordHash: 'h1' }, { accessKey: 'owner-1' });
      const second = await b.amz('Key_20160201.Backup', { loopId: 'l-one', encryptedKey: 'SECOND', passwordHash: 'h2' }, { accessKey: 'owner-1' });
      const withNewHash = await b.amz('Key_20160201.Restore', { loopId: 'l-one', passwordHash: 'h2' }, { accessKey: 'owner-1' });
      const withOldHash = await b.amz('Key_20160201.Restore', { loopId: 'l-one', passwordHash: 'h1' }, { accessKey: 'owner-1' });
      return { first, second, withNewHash, withOldHash };
    },
  );
  assert.equal(svc.first.body.encryptedKey, 'FIRST');
  assert.equal(svc.second.body.encryptedKey, 'SECOND');
  assert.deepEqual(Object.keys(svc.second.body).sort(), ['accountId', 'encryptedKey', 'loopId'], 'pinned `Backup` output shape');
  assert.equal(svc.withNewHash.body.encryptedKey, 'SECOND', 'a re-backup replaces the loop document');
  assert.equal(svc.withOldHash.status, 409, 'the old hash no longer matches -> BACKUP_PASSWORD_WRONG');
  assert.equal(svc.withOldHash.errType, 'BACKUP_PASSWORD_WRONG');
});

// ---- 4. 7-day list windows (expiry) ----------------------------------------

test('ListIncomingRequests/ListBinaryRequests use the source 7-day window', () => {
  const file = join(dir, 'window.json');
  let now = 1_700_000_000_000;
  const s = new KeyStore(file, { clock: () => now });
  const fresh = s.create({ accountId: 'a', loopId: 'L', publicKey: 'P-fresh' });
  now -= 8 * 24 * 60 * 60 * 1000; // 8 days ago
  const stale = s.create({ accountId: 'b', loopId: 'L', publicKey: 'P-stale' });
  now += 8 * 24 * 60 * 60 * 1000;
  const ids = s.incomingRequests('L', {}).map((k) => k.id);
  assert.ok(ids.includes(fresh.id), 'a request from today is listed');
  assert.ok(!ids.includes(stale.id), 'a request older than 7 days is not');

  const binaryFresh = s.createBinary({ accountId: 'a', loopId: 'L', encryptedUrl: 'u-new' });
  now -= 8 * 24 * 60 * 60 * 1000;
  s.createBinary({ accountId: 'a', loopId: 'L', encryptedUrl: 'u-old' });
  now += 8 * 24 * 60 * 60 * 1000;
  const urls = s.listBinaries('L', {}).map((b) => b.encryptedUrl);
  assert.deepEqual(urls, ['u-new'], 'binary requests share the 7-day window');
  assert.ok(binaryFresh.id);
  rmSync(file, { force: true });
});

test('ListIncomingRequests excludes the caller own request (siblings only)', async () => {
  const svc = await withMembership(
    { memberIds: async () => ['me', 'sibling'] },
    async (b) => {
      const mine = await b.amz('Key_20160201.CreateRequest', { loopId: 'l-self', publicKey: 'P' }, { accessKey: 'me' });
      const theirs = await b.amz('Key_20160201.CreateRequest', { loopId: 'l-self', publicKey: 'Q' }, { accessKey: 'sibling' });
      const mineList = await b.amz('Key_20160201.ListIncomingRequests', { loopId: 'l-self' }, { accessKey: 'me' });
      const theirsList = await b.amz('Key_20160201.ListIncomingRequests', { loopId: 'l-self' }, { accessKey: 'sibling' });
      return { mine, theirs, mineList, theirsList };
    },
  );
  assert.deepEqual(svc.mineList.body.map((r) => r.id), [svc.theirs.body.id], 'I see only my sibling request');
  assert.deepEqual(svc.theirsList.body.map((r) => r.id), [svc.mine.body.id]);
});

// ---- 5. binary exchange end to end -----------------------------------------

test('binary: POST /binaryRequest -> ListBinaryRequests -> ShareBinary(x-id + body) -> fetch', async () => {
  const binary = Buffer.from([0x00, 0x01, 0xff, 0x42, 0x43]);
  const svc = await withMembership(
    { memberIds: async () => ['requester', 'robot'] },
    async (b) => {
      // pinned binary.route.ts: POST /binaryRequest {accountId, encryptedUrl, loopId}
      const res = await fetch(`${b.base}/binaryRequest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId: 'requester', encryptedUrl: 'https://s3.example/enc/photo.jpg', loopId: 'l-bin' }),
      });
      const created = { status: res.status, body: await res.json() };
      const listed = await b.amz('Key_20160201.ListBinaryRequests', { loopId: 'l-bin' }, { accessKey: 'robot' });

      // pinned ShareBinaryRequest: the BODY is the decrypted stream, the id rides in x-id.
      const shared = await b.amz('Key_20160201.ShareBinary', binary, {
        accessKey: 'robot', rawBody: binary, headers: { 'x-id': created.body.id },
      });
      const afterShare = await b.amz('Key_20160201.ListBinaryRequests', { loopId: 'l-bin' }, { accessKey: 'robot' });
      // the restarted/other member fetches the decrypted binary from the returned url
      const dl = await fetch(shared.body.decryptedUrl);
      const bytes = Buffer.from(await dl.arrayBuffer());
      return { created, listed, shared, afterShare, downloadStatus: dl.status, bytes };
    },
  );

  assert.equal(svc.created.status, 200);
  assert.deepEqual(Object.keys(svc.created.body).sort(), ['accountId', 'encryptedUrl', 'id', 'loopId']);
  assert.equal(svc.listed.body.length, 1);
  assert.equal(svc.listed.body[0].id, svc.created.body.id);
  assert.equal(svc.listed.body[0].encryptedUrl, 'https://s3.example/enc/photo.jpg');

  assert.equal(svc.shared.status, 200, 'ShareBinary is served (x-id + binary payload)');
  assert.equal(svc.shared.body.id, svc.created.body.id);
  assert.match(svc.shared.body.decryptedUrl, /\/key\/binary\?accountId=robot&id=/);
  assert.deepEqual(svc.afterShare.body, [], 'a shared binary leaves the pending list');

  const got = { status: svc.downloadStatus };
  assert.equal(got.status, 200);
  assert.deepEqual(svc.bytes, binary, 'the decrypted binary round-trips byte-for-byte');
});

test('binary errors: unknown id 404 BINARY_NOT_FOUND, non-member 403, missing x-id 422, deleteBinaries', async () => {
  const svc = await withMembership(
    { memberIds: async () => ['member-1', 'other'] },
    async (b) => {
      const res = await fetch(`${b.base}/binaryRequest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId: 'member-1', encryptedUrl: 'u1', loopId: 'l-berr' }),
      });
      const created = await res.json();
      return {
        unknown: await b.amz('Key_20160201.ShareBinary', 'X', { accessKey: 'member-1', rawBody: 'X', headers: { 'x-id': 'ffffffffffffffffffffffff' } }),
        noHeader: await b.amz('Key_20160201.ShareBinary', 'X', { accessKey: 'member-1', rawBody: 'X' }),
        stranger: await b.amz('Key_20160201.ShareBinary', 'X', { accessKey: 'stranger', rawBody: 'X', headers: { 'x-id': created.id } }),
        listStranger: await b.amz('Key_20160201.ListBinaryRequests', { loopId: 'l-berr' }, { accessKey: 'stranger' }),
        created,
        del: await fetch(`${b.base}/deleteBinaries`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ encryptedUrls: ['u1'] }),
        }),
        after: await b.amz('Key_20160201.ListBinaryRequests', { loopId: 'l-berr' }, { accessKey: 'member-1' }),
      };
    },
  );
  assert.equal(svc.unknown.status, 404);
  assert.equal(svc.unknown.errType, 'BINARY_NOT_FOUND');
  assert.equal(svc.noHeader.status, 422, 'pinned @validateHeaders x-id required -> Boom.badData');
  assert.equal(svc.stranger.status, 403);
  assert.equal(svc.stranger.errType, 'BINARY_NOT_PART_OF_LOOP');
  assert.equal(svc.listStranger.status, 403);
  assert.equal(svc.listStranger.errType, 'KEY_NOT_PART_OF_LOOP', 'list uses getMemberIds -> KEY_NOT_PART_OF_LOOP');
  assert.equal(svc.del.status, 200);
  assert.deepEqual(await svc.del.json(), { result: 'Command accepted' });
  assert.deepEqual(svc.after.body, []);
});

// ---- 6. durability: real process restart (SIGKILL) -------------------------

test('durable: requests, backups and binaries survive a SIGKILL restart', async () => {
  const file = join(dir, 'restart-keys.json');
  const binDir = join(dir, 'restart-binaries');
  const binaryBytes = Buffer.from([0x11, 0x22, 0x00, 0xff]);
  let first; let second;
  try {
    const p1 = await freePort();
    first = await startChild({ port: p1, keyFile: file, binDir });
    const created = await childAmz(first.base, 'Key_20160201.CreateRequest', { loopId: 'l-restart', publicKey: 'PEM-RESTART' }, 'acct-A');
    assert.equal(created.status, 200);
    const bin = await fetch(`${first.base}/binaryRequest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: 'acct-A', encryptedUrl: 'u-restart', loopId: 'l-restart' }),
    });
    const binaryDoc = await bin.json();
    // share the decrypted bytes BEFORE the kill so both the document and the object survive
    const shared = await fetch(`${first.base}/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-amz-target': 'Key_20160201.ShareBinary',
        'x-id': binaryDoc.id,
        authorization: 'AWS4-HMAC-SHA256 Credential=acct-B/20260613/us-east-1/aws4_request, SignedHeaders=host, Signature=ff',
      },
      body: binaryBytes,
    });
    assert.equal(shared.status, 200);
    const sharedDoc = await shared.json();
    await childAmz(first.base, 'Key_20160201.Share', { id: created.body.id, encryptedKey: 'ENC-RESTART', keyHash: 'h' }, 'acct-B');
    await childAmz(first.base, 'Key_20160201.Backup', { loopId: 'l-restart', encryptedKey: 'BACKUP-RESTART', passwordHash: 'pw' }, 'acct-A');
    await first.stop(); // SIGKILL: nothing flushed on the way out

    const p2 = await freePort();
    second = await startChild({ port: p2, keyFile: file, binDir });
    assert.notEqual(p1, p2, 'a genuinely new process on a new port');

    const got = await childAmz(second.base, 'Key_20160201.GetRequest', { id: created.body.id }, 'acct-A');
    assert.equal(got.status, 200, 'the request written before the kill is still there');
    assert.equal(got.body.encryptedKey, 'ENC-RESTART', 'and still satisfied');

    const restored = await childAmz(second.base, 'Key_20160201.Restore', { loopId: 'l-restart', passwordHash: 'pw' }, 'acct-A');
    assert.equal(restored.status, 200);
    assert.equal(restored.body.encryptedKey, 'BACKUP-RESTART', 'the key backup survived the restart');

    const listed = await childAmz(second.base, 'Key_20160201.ListBinaryRequests', { loopId: 'l-restart' }, 'acct-A');
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body, [], 'the binary was shared before the kill, so it is no longer pending');

    // The decrypted-binary URL is composed from the serving origin (the source returned a stable
    // S3 URL). The restarted process listens on a NEW port, so re-base the stored path onto it —
    // this is the self-hosted-URL divergence (§8.2), not a durability loss.
    const path = new URL(sharedDoc.decryptedUrl).pathname + new URL(sharedDoc.decryptedUrl).search;
    const dl = await fetch(`${second.base}${path}`);
    assert.equal(dl.status, 200, 'the restarted service serves a binary uploaded by the killed process');
    assert.deepEqual(Buffer.from(await dl.arrayBuffer()), binaryBytes, 'binary bytes survive the restart');

    const sc = await childAmz(second.base, 'Key_20160201.ShouldCreate', { loopId: 'l-restart' }, 'acct-A');
    assert.equal(sc.body.shouldCreate, false, 'the satisfied key survives the restart');
  } finally {
    await first?.stop();
    await second?.stop();
  }
});

// ---- 7. membership against a real Account service --------------------------

test('membership: end-to-end against a real Account service (GET /loopMembers + GET /loop)', async () => {
  const dir2 = mkdtempSync(join(tmpdir(), 'phx-key-acct-'));
  const prevNet = process.env.NET_account;
  const prevKey = process.env.ETCO_classic_keyFile;
  let accountServer; let classic;
  try {
    const acct = new Store(join(dir2, 'account.json'));
    for (const id of ['owner-1', 'robot-1', 'stranger-1']) {
      acct.accounts.set(id, { _id: id, friendlyId: id, isActive: true, isDeleted: false });
    }
    acct.loops.set('loop-1', {
      _id: 'loop-1', owner: 'owner-1', robot: 'robot-1', isSuspended: false,
      members: [
        { accountId: 'owner-1', status: 'accepted', type: 'incoming' },
        { accountId: 'robot-1', status: 'accepted', type: 'incoming' },
      ],
    });
    const accountService = createAccountService({ store: acct });
    accountServer = await accountService.listen(0);
    process.env.NET_account = `127.0.0.1:${accountServer.address().port}`;
    process.env.ETCO_classic_keyFile = join(dir2, 'keys.json');

    // DEFAULT membership seam — no injection, the real accountMembership HTTP client.
    classic = await createClassicEntrypoint().listen(0);
    const cb = `http://localhost:${classic.address().port}/`;
    const post = async (target, body, key) => {
      const res = await fetch(cb, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-amz-json-1.1',
          'x-amz-target': target,
          ...(key ? { authorization: `AWS4-HMAC-SHA256 Credential=${key}/20260613/us-east-1/aws4-key-request, SignedHeaders=host, Signature=ff` } : {}),
        },
        body: JSON.stringify(body || {}),
      });
      return { status: res.status, errType: res.headers.get('x-amzn-errortype'), body: await res.json().catch(() => null) };
    };

    const created = await post('Key_20160201.CreateRequest', { loopId: 'loop-1', publicKey: 'PEM' }, 'owner-1');
    assert.equal(created.status, 200, 'a real member may create a request');
    assert.equal(created.body.accountId, 'owner-1');

    const nonMemberR = await post('Key_20160201.CreateRequest', { loopId: 'loop-1', publicKey: 'PEM' }, 'stranger-1');
    assert.equal(nonMemberR.status, 403, 'a non-member is refused by the real Account loop');
    assert.equal(nonMemberR.errType, 'KEY_NOT_PART_OF_LOOP');

    const sibling = await post('Key_20160201.ListIncomingRequests', { loopId: 'loop-1' }, 'robot-1');
    assert.equal(sibling.status, 200);
    assert.deepEqual(sibling.body.map((r) => r.id), [created.body.id], 'the robot sees the owner pending request');

    const strangerGet = await post('Key_20160201.GetRequest', { id: created.body.id }, 'stranger-1');
    assert.equal(strangerGet.status, 403);
    assert.equal(strangerGet.errType, 'KEY_NOT_PART_OF_LOOP');

    // the gateway-forwarded identity (x-amz-credentials) is the other seam
    const forwarded = await fetch(cb, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': 'Key_20160201.Backup',
        'x-amz-credentials': JSON.stringify({ id: 'owner-1' }),
      },
      body: JSON.stringify({ loopId: 'loop-1', encryptedKey: 'BLOB' }),
    });
    assert.equal(forwarded.status, 200, 'owner-1 may back up (x-amz-credentials identity)');

    const robotBackup = await post('Key_20160201.Backup', { loopId: 'loop-1', encryptedKey: 'B' }, 'robot-1');
    assert.equal(robotBackup.status, 403);
    assert.equal(robotBackup.errType, 'ONLY_OWNER_CAN_BACKUP_RESTORE');

    const robotRestore = await post('Key_20160201.Restore', { loopId: 'loop-1' }, 'robot-1');
    assert.equal(robotRestore.status, 200, 'the loop robot may restore');
    assert.equal(robotRestore.body.encryptedKey, 'BLOB');

    const strangerRestore = await post('Key_20160201.Restore', { loopId: 'loop-1' }, 'stranger-1');
    assert.equal(strangerRestore.status, 403);
    assert.equal(strangerRestore.errType, 'ONLY_OWNER_OR_ROBOT_CAN_RESTORE');

    const shouldCreate = await post('Key_20160201.ShouldCreate', { loopId: 'loop-1' }, 'owner-1');
    assert.equal(shouldCreate.status, 200, 'the real loop exists');
  } finally {
    classic?.close();
    if (accountServer) await new Promise((r) => accountServer.close(r));
    if (prevNet === undefined) delete process.env.NET_account; else process.env.NET_account = prevNet;
    if (prevKey === undefined) delete process.env.ETCO_classic_keyFile; else process.env.ETCO_classic_keyFile = prevKey;
    rmSync(dir2, { recursive: true, force: true });
  }
});

// ---- 8. the store itself is file-backed and self-reloading -----------------

test('KeyStore reloads every collection from the same file', () => {
  const file = join(dir, 'reload.json');
  const a = new KeyStore(file);
  const k = a.create({ accountId: 'x', loopId: 'L', publicKey: 'P' });
  a.share(k.id, 'ENC', 'H');
  a.backup({ loopId: 'L', accountId: 'x', encryptedKey: 'B', passwordHash: 'pw' });
  const b2 = a.createBinary({ accountId: 'x', loopId: 'L', encryptedUrl: 'u' });
  a.setBinaryDecryptedUrl(b2.id, 'http://d');

  const restarted = new KeyStore(file);
  assert.equal(restarted.get(k.id).encryptedKey, 'ENC');
  assert.equal(restarted.restore('L').encryptedKey, 'B');
  assert.equal(restarted.getBinary(b2.id).decryptedUrl, 'http://d');
  assert.ok(existsSync(file), 'the state is on disk, not only in memory');
});

// ---- helpers ---------------------------------------------------------------

async function withMembership(membership, fn) {
  const svc = await createClassicEntrypoint({ keyMembership: membership }).listen(0);
  const p = svc.address().port;
  try {
    return await fn({
      port: p,
      base: `http://localhost:${p}`,
      amz: async (target, body, opts = {}) => {
        const res = await fetch(`http://localhost:${p}/`, {
          method: 'POST',
          headers: {
            ...(opts.rawBody !== undefined ? { 'content-type': 'application/octet-stream' } : { 'content-type': 'application/x-amz-json-1.1' }),
            'x-amz-target': target,
            ...(opts.accessKey ? { authorization: `AWS4-HMAC-SHA256 Credential=${opts.accessKey}/20260613/us-east-1/aws4_request, SignedHeaders=host, Signature=ff` } : {}),
            ...(opts.headers || {}),
          },
          body: opts.rawBody !== undefined ? opts.rawBody : JSON.stringify(body || {}),
        });
        return {
          status: res.status,
          errType: res.headers.get('x-amzn-errortype'),
          body: await parseBody(res),
        };
      },
    });
  } finally {
    svc.close();
  }
}

async function freePort() {
  const s = http.createServer();
  await new Promise((resolve) => s.listen(0, resolve));
  const p = s.address().port;
  await new Promise((resolve) => s.close(resolve));
  return p;
}

async function startChild({ port, keyFile, binDir }) {
  const child = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      ETCO_classic_keyFile: keyFile,
      ETCO_classic_keyBinaryDir: binDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stdout.resume();
  child.stderr.on('data', (c) => { stderr += c; });
  const baseUrl = `http://localhost:${port}`;
  const ready = async () => {
    try {
      const res = await fetch(`${baseUrl}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'Key_20160201.ShouldCreate' },
        body: JSON.stringify({ loopId: 'readiness-probe' }),
      });
      return res.status === 200;
    } catch { return false; }
  };
  for (let i = 0; i < 150; i++) {
    if (await ready()) {
      return {
        base: baseUrl,
        child,
        stop: () => new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) return resolve();
          child.once('close', resolve);
          child.kill('SIGKILL');
        }),
      };
    }
    if (child.exitCode !== null) break;
    await sleep(100);
  }
  child.kill('SIGKILL');
  throw new Error(`classic entrypoint child did not start: ${stderr}`);
}

async function childAmz(baseUrl, target, body, accessKey) {
  const res = await fetch(`${baseUrl}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': target,
      ...(accessKey ? { authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/20260613/us-east-1/aws4_request, SignedHeaders=host, Signature=ff` } : {}),
    },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
