// POST /deleteBinaries removes the stored file from the location ShareBinary wrote it to (the
// sharer's storage key carried in the decrypted URL), on both the authenticated and the
// unauthenticated entrypoint. A caller that may not delete the binary leaves it in place.
//
// All accounts, keys and secrets are SYNTHETIC test values.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { signedFetch, storeCallerBoundary, syntheticAccount, writeSyntheticAccountStore } from './fixtures/signedClassic.js';
import { createClassicEntrypoint, KeyStore } from '../src/index.js';

const LOOP = 'synthetic-key-loop';
const REQUESTER = 'synthetic-key-requester';
const SHARER = 'synthetic-key-sharer';
const OUTSIDER = 'synthetic-key-outsider';
const ACCOUNTS = Object.fromEntries([REQUESTER, SHARER, OUTSIDER].map((id) => [id, syntheticAccount(id)]));
const membership = {
  memberIds: async (loopId) => (loopId === LOOP ? [REQUESTER, SHARER] : []),
  loop: async (loopId) => (loopId === LOOP ? { owner: REQUESTER, robot: SHARER } : null),
};

async function harness({ authenticated }) {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-key-delete-'));
  const binaryDir = join(dir, 'binaries');
  const accountStore = writeSyntheticAccountStore(join(dir, 'account.json'), { accounts: Object.values(ACCOUNTS) });
  const classic = createClassicEntrypoint({
    ...(authenticated
      ? { publicUrl: 'https://classic.synthetic.test', callerBoundary: storeCallerBoundary(accountStore) }
      : { publicUrl: 'http://classic.synthetic.test' }),
    notificationFile: join(dir, 'notifications.json'),
    keyStore: new KeyStore(join(dir, 'keys.json')),
    keyMembership: membership,
    keyBinaryDir: binaryDir,
  });
  const server = await classic.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (path, { headers = {}, body, as }) => (authenticated
    ? signedFetch(`${base}${path}`, { headers, body, credentials: ACCOUNTS[as] })
    : fetch(`${base}${path}`, {
      method: 'POST',
      headers: { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${as}/20261009/us-east-1/jibo/aws4_request, SignedHeaders=host, Signature=00` },
      body,
    }));
  return {
    binaryDir,
    async shareOne(encryptedUrl) {
      const created = await (await send('/binaryRequest', {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId: REQUESTER, loopId: LOOP, encryptedUrl }),
        as: REQUESTER,
      })).json();
      const shared = await send('/', {
        headers: { 'content-type': 'application/octet-stream', 'x-amz-target': 'Key_20160201.ShareBinary', 'x-id': created.id },
        body: Buffer.from('synthetic decrypted bytes'),
        as: SHARER,
      });
      assert.equal(shared.status, 200);
      const file = join(binaryDir, SHARER, `${created.id}${encryptedUrl.endsWith('.jpg') ? '.jpg' : ''}`);
      assert.ok(existsSync(file), 'ShareBinary stored the file under the sharer storage key');
      return file;
    },
    del: (encryptedUrls, as) => send('/deleteBinaries', {
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ encryptedUrls }), as,
    }),
    async close() {
      await new Promise((resolve) => server.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('authenticated deleteBinaries removes the file a different member shared', async () => {
  const h = await harness({ authenticated: true });
  try {
    const file = await h.shareOne('https://synthetic.invalid/enc/photo.jpg');
    const res = await h.del(['https://synthetic.invalid/enc/photo.jpg'], REQUESTER);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { result: 'Command accepted' });
    assert.equal(existsSync(file), false, 'the shared file is gone from disk');
  } finally { await h.close(); }
});

test('authenticated deleteBinaries refuses a non-member and keeps the file', async () => {
  const h = await harness({ authenticated: true });
  try {
    const file = await h.shareOne('https://synthetic.invalid/enc/clip');
    const res = await h.del(['https://synthetic.invalid/enc/clip'], OUTSIDER);
    assert.equal(res.status, 403);
    assert.ok(existsSync(file), 'a refused delete leaves the file in place');
  } finally { await h.close(); }
});

test('unauthenticated deleteBinaries also removes the shared file', async () => {
  const h = await harness({ authenticated: false });
  try {
    const file = await h.shareOne('https://synthetic.invalid/enc/standalone.jpg');
    const res = await h.del(['https://synthetic.invalid/enc/standalone.jpg'], REQUESTER);
    assert.equal(res.status, 200);
    assert.equal(existsSync(file), false);
  } finally { await h.close(); }
});
