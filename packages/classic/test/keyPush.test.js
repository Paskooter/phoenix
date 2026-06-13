// H.4 — key (UGC encryption-key exchange) + push (mobile device registration) over the wire.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createClassicEntrypoint } from '../src/index.js';

let server; let port;
async function amz(target, body, accessKeyId) {
  const res = await fetch(`http://localhost:${port}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': target,
      ...(accessKeyId ? { authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/20260613/us-east-1/key/aws4_request, SignedHeaders=host, Signature=ff` } : {}),
    },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, errType: res.headers.get('x-amzn-errortype'), body: await res.json().catch(() => null) };
}

before(async () => { server = await createClassicEntrypoint().listen(0); port = server.address().port; });
after(() => server.close());

test('key: ShouldCreate -> CreateRequest -> Share -> GetRequest round-trip', async () => {
  const sc = await amz('Key_20160201.ShouldCreate', { loopId: 'loop-1' });
  assert.equal(sc.body.shouldCreate, true, 'fresh loop should create a key');

  const created = await amz('Key_20160201.CreateRequest', { loopId: 'loop-1', publicKey: 'PUBKEY-A' }, 'acct-A');
  assert.equal(created.status, 200);
  assert.match(created.body.id, /^[a-f0-9]{24}$/);
  assert.equal(created.body.loopId, 'loop-1');
  assert.equal(created.body.publicKey, 'PUBKEY-A');
  assert.equal(created.body.encryptedKey, null, 'unsatisfied until shared');

  // it shows up as an incoming request for the loop
  const incoming = await amz('Key_20160201.ListIncomingRequests', { loopId: 'loop-1' });
  assert.ok(incoming.body.some((r) => r.id === created.body.id));

  // another member encrypts the shared key to the requester
  const shared = await amz('Key_20160201.Share', { id: created.body.id, encryptedKey: 'ENC-FOR-A', keyHash: 'h' });
  assert.equal(shared.body.encryptedKey, 'ENC-FOR-A');

  // the requester fetches it back
  const got = await amz('Key_20160201.GetRequest', { id: created.body.id });
  assert.equal(got.body.encryptedKey, 'ENC-FOR-A');

  // now the loop has a satisfied key -> shouldCreate flips false
  const sc2 = await amz('Key_20160201.ShouldCreate', { loopId: 'loop-1' });
  assert.equal(sc2.body.shouldCreate, false);
});

test('key: Backup -> Restore by loop+passwordHash; missing -> 404', async () => {
  const bk = await amz('Key_20160201.Backup', { loopId: 'loop-2', encryptedKey: 'BLOB', passwordHash: 'pw1' }, 'acct-B');
  assert.equal(bk.body.encryptedKey, 'BLOB');
  const rs = await amz('Key_20160201.Restore', { loopId: 'loop-2', passwordHash: 'pw1' });
  assert.equal(rs.body.encryptedKey, 'BLOB');
  const wrong = await amz('Key_20160201.Restore', { loopId: 'loop-2', passwordHash: 'WRONG' });
  assert.equal(wrong.status, 404);
  assert.equal(wrong.errType, 'KEY_BACKUP_NOT_FOUND');
});

test('key: GetRequest unknown id -> 404', async () => {
  const r = await amz('Key_20160201.GetRequest', { id: 'nope' });
  assert.equal(r.status, 404);
  assert.equal(r.errType, 'KEY_REQUEST_NOT_FOUND');
});

test('push: CreateDevice / RemoveDevice return success (no-op delivery)', async () => {
  const reg = await amz('Push_20160729.CreateDevice', { name: 'phone-1', pushToken: 'apns-tok', type: 'ios' }, 'acct-C');
  assert.equal(reg.status, 200);
  assert.deepEqual(reg.body, {});
  const rm = await amz('Push_20160729.RemoveDevice', { name: 'phone-1' });
  assert.equal(rm.status, 200);
  const bad = await amz('Push_20160729.CreateDevice', {});
  assert.equal(bad.status, 400, 'name required');
});
