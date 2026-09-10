// w3/keypurge — the loop UGC key gate, server side.
//
// The original architecture (pinned source: jiborobot/srv-key-ws; official Jibo docs,
// "User Generated Content Key", /confluence/display/JN/User+Generated+Content+Key):
//
//   "A stated design goal is that Jibo the company and its servers do not possess or store the
//    user generated content key (UGC key)" … "The Jibo servers do not store this key."
//
// The server is a BLIND RELAY. A member device — in the live system the robot, jibo-sts — mints
// the AES-256 loop key locally, stores it under its own key store, and Shares it *encrypted to
// the requester's public key*. The server only brokers that exchange: it holds public keys and
// ciphertext, never plaintext key material.
//
// REMOVED HERE (an earlier w3/loopkey change had added it): an opt-in `mintOnRequest` path that
// made the SERVER mint and PERSIST one 32-byte AES key per loop (KeyStore.loopSecrets), and
// satisfy a request at CreateRequest time. That was wrong on three counts and is gone:
//   1. it violated the stated design goal above;
//   2. the provisioning branch wrote encryptedKey+keyHash into the request, and the holder's
//      ListIncomingRequests filters out requests that already carry encryptedKey — so the robot
//      skipped them and never shared its own (real) key;
//   3. the app adopted the server-minted key instead of the robot's, silently failing to decrypt
//      the robot's real user content.
//
// The guard tests at the bottom fail if server-side minting is ever reintroduced.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateKeyPairSync, privateDecrypt, publicEncrypt, constants, createHash,
} from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createClassicEntrypoint, KeyStore, accessKeyAccountResolver } from '../src/index.js';

const LOOP = 'loop-loopkey-1';
const ACCOUNT = '43ca532ad4090cfb80f2e7a5';
const ACCESS_KEY = 'ylaMUYGrT39yLGHoCUxt'; // the app's real SigV4 key — NOT an account id
const SIBLING_KEY = 'siblingaccesskey0001'; // the robot/peer's SigV4 key
const SIBLING_ACCOUNT = 'acct-owner';

let dir;
const servers = [];
/** The app's `KeyManager.getPublicKeyForSharing()` = base64 of the RSA SPKI DER. */
const spkiBase64 = (publicKey) => publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

function membershipFor(ids) {
  return { memberIds: async () => ids, loop: async () => ({ owner: 'acct-owner', robot: null }) };
}

/**
 * Build an entrypoint with the account-store resolver. `mint` injects the now-dead
 * `mintOnRequest` key option on purpose: the guard test below proves it is IGNORED.
 */
async function boot({ withResolver = true, mint, keyFile, accountByAccessKeyId = {
  [ACCESS_KEY]: { id: ACCOUNT },
  [SIBLING_KEY]: { id: SIBLING_ACCOUNT },
} } = {}) {
  const file = keyFile || join(dir, `keys-${servers.length}.json`);
  const store = new KeyStore(file);
  const options = {
    keyMembership: membershipFor([ACCOUNT, SIBLING_ACCOUNT]),
    keyStore: store,
    key: {
      accountResolver: withResolver
        ? accessKeyAccountResolver((akid) => accountByAccessKeyId[akid])
        : undefined,
      // Reintroducing a server-side mint that still reads this option would flip the guard test.
      ...(mint === undefined ? {} : { mintOnRequest: Boolean(mint) }),
    },
  };
  const svc = await createClassicEntrypoint(options).listen(0);
  servers.push(svc);
  const port = svc.address().port;
  const amz = async (target, body, accessKey = ACCESS_KEY, extraHeaders = {}) => {
    const res = await fetch(`http://localhost:${port}/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': target,
        ...(accessKey
          ? { authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/20260910/us-east-1/aws4_request, SignedHeaders=host, Signature=ff` }
          : {}),
        ...extraHeaders,
      },
      body: JSON.stringify(body || {}),
    });
    let parsed;
    try { parsed = JSON.parse(await res.text()); } catch { parsed = null; }
    return { status: res.status, errType: res.headers.get('x-amzn-errortype'), body: parsed };
  };
  return { amz, store, file };
}

before(() => { dir = mkdtempSync(join(tmpdir(), 'phx-key-loopkey-')); });
after(() => {
  for (const svc of servers) svc.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---- 1. the identity defect, reproduced: access key is not an account id -----

test('WITHOUT the account resolver, a real SigV4 access key is refused (the live defect)', async () => {
  const { amz } = await boot({ withResolver: false });
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const res = await amz('Key_20160201.CreateRequest', { loopId: LOOP, publicKey: spkiBase64(publicKey) });
  assert.equal(res.status, 403, 'exactly what the emulator saw against the deployed relay');
  assert.equal(res.errType, 'KEY_NOT_PART_OF_LOOP');
});

test('WITH the account resolver, the same real access key is a member (fixed)', async () => {
  const { amz } = await boot({ withResolver: true });
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const res = await amz('Key_20160201.CreateRequest', { loopId: LOOP, publicKey: spkiBase64(publicKey) });
  assert.equal(res.status, 200, 'the app reaches the handler instead of 403');
  assert.equal(res.body.accountId, ACCOUNT, 'identity resolved to the account, not the access key');
});

// ---- 2. faithful relay default: no minting, no key material ------------------

test('CreateRequest returns an unsatisfied Request with no encryptedKey (pinned behaviour)', async () => {
  const { amz } = await boot({ withResolver: true });
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const res = await amz('Key_20160201.CreateRequest', { loopId: 'loop-relay', publicKey: spkiBase64(publicKey) });
  assert.equal(res.status, 200);
  assert.equal(res.body.encryptedKey, undefined, 'the server does not hold or mint a key');
  assert.deepEqual(Object.keys(res.body).sort(), ['accountId', 'id', 'loopId', 'publicKey']);
});

test('a request is satisfied ONLY by a peer Share, never by the server', async () => {
  const { amz } = await boot({ withResolver: true });
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const api = publicKey.export({ type: 'spki', format: 'pem' }).toString();

  const created = await amz('Key_20160201.CreateRequest', { loopId: LOOP, publicKey: spkiBase64(publicKey) });
  assert.equal(created.body.encryptedKey, undefined, 'unsatisfied after create');
  assert.equal((await amz('Key_20160201.ShouldCreate', { loopId: LOOP })).body.shouldCreate, true,
    'the loop still needs a member to originate the key');

  const incoming = await amz('Key_20160201.ListIncomingRequests', { loopId: LOOP }, SIBLING_KEY);
  assert.equal(incoming.body.length, 1, 'the robot/peer sees the pending request');
  assert.equal(incoming.body[0].encryptedKey, undefined, 'and it carries no key material');

  // The peer (jibo-sts) originates the AES key and Shares it encrypted to the requester.
  const aes = createHash('sha256').update('robot-originated-loop-key').digest(); // 32 bytes
  const encryptedKey = publicEncrypt(
    { key: api, padding: constants.RSA_PKCS1_PADDING },
    aes,
  ).toString('base64');
  await amz('Key_20160201.Share', { id: created.body.id, encryptedKey, keyHash: createHash('sha1').update(aes).digest('hex') }, SIBLING_KEY);

  const got = await amz('Key_20160201.GetRequest', { id: created.body.id });
  const decrypted = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(got.body.encryptedKey, 'base64'));
  assert.deepEqual(decrypted, aes, 'the requester decrypts the exact key the peer originated');
  assert.equal((await amz('Key_20160201.ShouldCreate', { loopId: LOOP })).body.shouldCreate, false,
    'a peer-satisfied loop no longer needs a key');
});

// ---- 3. GUARDS: the server can never mint or persist a plaintext loop key ---

test('GUARD: the dead mintOnRequest option is ignored — CreateRequest never mints', async () => {
  // This is the test that FAILS if server-side minting is reintroduced. `mintOnRequest: true`
  // is injected on purpose; the server must ignore it.
  const { amz } = await boot({ withResolver: true, mint: true });
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const res = await amz('Key_20160201.CreateRequest', { loopId: 'loop-forced-mint', publicKey: spkiBase64(publicKey) });
  assert.equal(res.status, 200);
  assert.equal(res.body.encryptedKey, undefined,
    'server-side minting must not exist: no encryptedKey is returned at CreateRequest time');
});

test('GUARD: KeyStore exposes no loop-key capability and persists no key material', async () => {
  const file = join(dir, 'guard-store.json');
  const { amz, store } = await boot({ withResolver: true, mint: true, keyFile: file });
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await amz('Key_20160201.CreateRequest', { loopId: 'loop-guard', publicKey: spkiBase64(publicKey) });

  // No API that could mint/hold a plaintext loop key.
  assert.equal(typeof store.loopSecret, 'undefined', 'KeyStore must not have a loopSecret() minter');
  assert.equal(store.loopSecrets, undefined, 'KeyStore must not hold a loopSecrets map');

  // The persisted file must never carry loop-key material or server-written ciphertext.
  assert.ok(existsSync(file), 'the store is on disk (so the assertion below is meaningful)');
  const raw = readFileSync(file, 'utf8');
  assert.ok(!raw.includes('loopSecrets'), 'no loopSecrets collection in the persisted state');
  assert.ok(!raw.includes('"encryptedKey"'),
    'nothing is shared unless a peer posts it — the server wrote no key ciphertext');
  const doc = JSON.parse(raw);
  assert.deepEqual(Object.keys(doc).sort(), ['backups', 'binaries', 'keys', 'version'],
    'the persisted schema is exactly relay state: requests, backups, binaries');
});
