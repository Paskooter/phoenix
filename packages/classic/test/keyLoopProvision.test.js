// w3/loopkey — the loop UGC key gate, server side.
//
// Two facts established while resolving the Gallery's "Waiting for Jibo" gate (viewNoKey):
//
//   1. IDENTITY DEFECT (fixed here). A real client is the recovered Jibo Android app: it signs
//      with SigV4 and carries NO gateway `x-amz-credentials` header. `keyCallerAccountId` returned
//      the raw access key id as the account id, so the membership check compared an access key
//      (`ylaMUYGrT39yLGHoCUxt`) against account ids and refused EVERY Key_20160201.CreateRequest
//      with 403 KEY_NOT_PART_OF_LOOP. A-11's tests missed it because their fixture used the account
//      id AS the access key (`accessKey: 'requester'`). Observed live in the emulator: the app's
//      CreateRequest for loop 5a0b20f5ddee0000197e2881 returned 403 "Only loop members can list
//      keys" — reproduced here as the no-resolver case, then fixed with the injected resolver.
//
//   2. PROVISIONING (opt-in divergence). The pinned service is relay-only: a member device mints
//      the AES key locally (`KeyManager.generateSymmetricKey`) and shares it out. With no member
//      holding a key (no running robot), `CreateRequest` yields a Request with no `encryptedKey`
//      and the app saves nothing. `mintOnRequest` makes Phoenix mint/reuse one 32-byte AES key per
//      loop and hand it to the requester already encrypted to the requester's RSA public key — the
//      exact shape the app's `KeyManager.saveSymmetricKey` accepts.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, privateDecrypt, constants } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createClassicEntrypoint, KeyStore, accessKeyAccountResolver } from '../src/index.js';

const LOOP = 'loop-loopkey-1';
const ACCOUNT = '43ca532ad4090cfb80f2e7a5';
const ACCESS_KEY = 'ylaMUYGrT39yLGHoCUxt'; // the app's real SigV4 key — NOT an account id

let dir;
const servers = [];
/** The app's `KeyManager.getPublicKeyForSharing()` = base64 of the RSA SPKI DER. */
const spkiBase64 = (publicKey) => publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

function membershipFor(ids) {
  return { memberIds: async () => ids, loop: async () => ({ owner: 'acct-owner', robot: null }) };
}

/** Build an entrypoint with the account-store resolver (or without it, to expose the defect). */
async function boot({ withResolver, mint, accountByAccessKeyId = { [ACCESS_KEY]: { id: ACCOUNT } } } = {}) {
  const options = {
    keyMembership: membershipFor([ACCOUNT, 'acct-owner']),
    keyStore: new KeyStore(join(dir, `keys-${servers.length}.json`)),
  };
  if (withResolver || mint) {
    options.key = {
      accountResolver: withResolver
        ? accessKeyAccountResolver((akid) => accountByAccessKeyId[akid])
        : undefined,
      mintOnRequest: Boolean(mint),
    };
  }
  const svc = await createClassicEntrypoint(options).listen(0);
  servers.push(svc);
  const port = svc.address().port;
  return async (target, body, accessKey = ACCESS_KEY, extraHeaders = {}) => {
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
}

before(() => { dir = mkdtempSync(join(tmpdir(), 'phx-key-loopkey-')); });
after(() => {
  for (const svc of servers) svc.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---- 1. the defect, reproduced: access key is not an account id -------------

test('WITHOUT the account resolver, a real SigV4 access key is refused (the live defect)', async () => {
  const amz = await boot({ withResolver: false });
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const res = await amz('Key_20160201.CreateRequest', { loopId: LOOP, publicKey: spkiBase64(publicKey) });
  assert.equal(res.status, 403, 'exactly what the emulator saw against the deployed relay');
  assert.equal(res.errType, 'KEY_NOT_PART_OF_LOOP');
});

test('WITH the account resolver, the same real access key is a member (fixed)', async () => {
  const amz = await boot({ withResolver: true });
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const res = await amz('Key_20160201.CreateRequest', { loopId: LOOP, publicKey: spkiBase64(publicKey) });
  assert.equal(res.status, 200, 'the app reaches the handler instead of 403');
  assert.equal(res.body.accountId, ACCOUNT, 'identity resolved to the account, not the access key');
});

// ---- 2. faithful default: no minting, no key material -----------------------

test('relay-only default (mintOnRequest off) returns a Request with no encryptedKey', async () => {
  const amz = await boot({ withResolver: true, mint: false });
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const res = await amz('Key_20160201.CreateRequest', { loopId: 'loop-relay', publicKey: spkiBase64(publicKey) });
  assert.equal(res.status, 200);
  assert.equal(res.body.encryptedKey, undefined, 'pinned behaviour: the server does not hold/min a key');
});

// ---- 3. opt-in provisioning: the app's exact acceptance path ----------------

test('mintOnRequest hands the requester a key the app decrypts with RSA/NONE/PKCS1Padding', async () => {
  const amz = await boot({ withResolver: true, mint: true });
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const res = await amz('Key_20160201.CreateRequest', { loopId: LOOP, publicKey: spkiBase64(publicKey) });

  assert.equal(res.status, 200);
  assert.equal(typeof res.body.encryptedKey, 'string', 'the request is satisfied in the response');

  // KeyManager.saveSymmetricKey: Cipher "RSA/NONE/PKCS1Padding" (PKCS#1 v1.5) then
  // Arrays.copyOfRange(decrypted, len-32, len).
  const decrypted = privateDecrypt(
    { key: privateKey, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(res.body.encryptedKey, 'base64'),
  );
  assert.equal(decrypted.length, 32, 'a 32-byte AES-256 key, exactly what the app keeps');
  const appKey = decrypted.subarray(decrypted.length - 32);

  // A second device in the same loop must be handed the SAME loop key.
  const second = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const res2 = await amz('Key_20160201.CreateRequest', { loopId: LOOP, publicKey: spkiBase64(second.publicKey) });
  const decrypted2 = privateDecrypt(
    { key: second.privateKey, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(res2.body.encryptedKey, 'base64'),
  );
  assert.deepEqual(decrypted2, appKey, 'one key per loop, shared to every member');

  // The loop is now satisfied, so a member would not mint a competing key.
  const should = await amz('Key_20160201.ShouldCreate', { loopId: LOOP });
  assert.equal(should.body.shouldCreate, false);
});

test('provisioned loop keys survive a store reload (durable)', async () => {
  const file = join(dir, 'keys-durable.json');
  const store = new KeyStore(file);
  const first = store.loopSecret(LOOP);
  assert.equal(first.length, 32);
  const reloaded = new KeyStore(file);
  assert.deepEqual(reloaded.loopSecret(LOOP), first, 'the minted key is persisted, not ephemeral');
});
