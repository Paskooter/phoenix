// A-03 account photos: UpdatePhoto and RemovePhoto.
// Fixtures are synthetic. Source is srv-account-ws@6cea434, srv-server binary
// mapping, @jibo/binary createPublic/remove, and srv-security-gw@43a692fe.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { signSigV4 } from '@phoenix/common';
import { Store } from '../src/store.js';
import { createOwnerAccount } from '../src/model.js';
import { MemberPhotoStorage } from '../src/memberPhotoStorage.js';
import {
  ACCOUNT_ANONYMOUS_TARGETS,
  ACCOUNT_IDENTITY_METHODS,
  accountToSourceJson,
  isAccountPhotoUpload,
  removePhoto,
  updatePhoto,
} from '../src/accountIdentity.js';
import { createAccountService } from '../src/index.js';
import { createClassicEntrypoint } from '../../classic/src/index.js';

const PASSWORD = 'ValidPass1';
const BYTES = Buffer.from([255, 0, 10, 128, 1]);
const REPLACEMENT = Buffer.from([1, 2, 3, 4]);

function signedAccountHeaders(base, target, body, account, extraHeaders = {}) {
  return signSigV4({
    method: 'POST',
    path: '/',
    headers: {
      host: new URL(base).host,
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': target,
      ...extraHeaders,
    },
    body,
    accessKeyId: account.accessKeyId,
    secretAccessKey: account.secretAccessKey,
    region: 'global',
    service: 'jibo',
  }).headers;
}

async function postJson(base, target, body, account) {
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  const headers = {
    'content-type': 'application/x-amz-json-1.1',
    'x-amz-target': target,
  };
  if (account) Object.assign(headers, signedAccountHeaders(base, target, serialized ?? '', account));
  const response = await fetch(`${base}/`, {
    method: 'POST',
    headers,
    body: serialized,
  });
  const rawBody = Buffer.from(await response.arrayBuffer()).toString('utf8');
  let parsed;
  try { parsed = JSON.parse(rawBody); } catch { parsed = undefined; }
  return { status: response.status, headers: Object.fromEntries(response.headers), body: parsed, rawBody };
}

async function postPhoto(base, body, account, extraHeaders = {}, secret = account.secretAccessKey, declaredDigest = true) {
  const headers = signSigV4({
    method: 'POST',
    path: '/',
    body,
    headers: {
      host: new URL(base).host,
      'content-type': 'application/x-amz-json-1.1',
      ...(declaredDigest ? { 'x-amz-content-sha256': createHash('sha256').update(body).digest('hex') } : {}),
      'x-amz-target': 'Account_20151111.UpdatePhoto',
      ...extraHeaders,
    },
    accessKeyId: account.accessKeyId,
    secretAccessKey: secret,
    region: 'global',
    service: 'jibo',
  }).headers;
  const response = await fetch(`${base}/`, { method: 'POST', headers, body });
  const rawBody = Buffer.from(await response.arrayBuffer()).toString('utf8');
  let parsed;
  try { parsed = JSON.parse(rawBody); } catch { parsed = undefined; }
  return { status: response.status, headers: Object.fromEntries(response.headers), body: parsed, rawBody };
}

test('photo operations are credentialed identity methods, not anonymous targets', () => {
  assert.ok(ACCOUNT_IDENTITY_METHODS.includes('updatePhoto'));
  assert.ok(ACCOUNT_IDENTITY_METHODS.includes('removePhoto'));
  assert.ok(!ACCOUNT_ANONYMOUS_TARGETS.includes('Account_20151111.UpdatePhoto'));
  assert.ok(!ACCOUNT_ANONYMOUS_TARGETS.includes('Account_20151111.RemovePhoto'));
  assert.equal(isAccountPhotoUpload({ headers: { 'x-amz-target': 'Account_20151111.UpdatePhoto' } }), true);
  assert.equal(isAccountPhotoUpload({ headers: { 'x-amz-target': 'Account_20151111.RemovePhoto' } }), false);
  assert.equal(isAccountPhotoUpload({ headers: { 'x-amz-target': 'Loop_20160324.UpdateMemberPhoto' } }), false);
});

test('account JSON emits photoUrl null after remove and omits an unset field', () => {
  const unset = accountToSourceJson({ _id: 'acct-1', email: 'wire@synthetic.invalid' });
  assert.ok(!('photoUrl' in unset));
  const cleared = accountToSourceJson({ _id: 'acct-1', email: 'wire@synthetic.invalid', photoUrl: null });
  assert.equal(cleared.photoUrl, null);
});

test('account photo replacement/removal preserves source ordering and failed-save state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phoenix-account-photo-'));
  try {
    const store = new Store(join(dir, 'account.json'));
    const owner = createOwnerAccount(store, { email: 'photo-owner@synthetic.invalid', password: PASSWORD });
    owner.photoUrl = 'https://synthetic.invalid/old-photo';
    store.flush();
    const calls = [];
    let failRemoval = false;
    const binary = {
      async createPublic({ dataStream, path }) {
        const chunks = [];
        for await (const chunk of dataStream) chunks.push(Buffer.from(chunk));
        assert.deepEqual(Buffer.concat(chunks), BYTES);
        calls.push(['upload', path]);
        return { url: `https://synthetic.invalid/${path}` };
      },
      async remove(path) {
        calls.push(['remove', path]);
        if (failRemoval) throw new Error('synthetic removal failure');
      },
    };
    const payload = () => ({
      ownerId: owner._id,
      dataStream: Readable.from([BYTES]),
      photoProvider: binary,
    });
    const before = JSON.stringify([...store.accounts]);
    failRemoval = true;
    await assert.rejects(updatePhoto(store, { ...payload(), clock: () => 123 }), /removal failure/);
    assert.deepEqual(calls, [['upload', owner._id + '123'], ['remove', 'old-photo']]);
    assert.equal(JSON.stringify([...store.accounts]), before);
    failRemoval = false;
    calls.length = 0;
    const result = await updatePhoto(store, { ...payload(), clock: () => 124 });
    assert.equal(result.photoUrl, `https://synthetic.invalid/${owner._id}124`);
    assert.deepEqual(calls, [['upload', owner._id + '124'], ['remove', 'old-photo']]);
    const prior = JSON.stringify([...store.accounts]);
    const flush = store.flush;
    store.flush = () => { throw new Error('synthetic save failure'); };
    await assert.rejects(removePhoto(store, payload()), /save failure/);
    assert.equal(JSON.stringify([...store.accounts]), prior);
    store.flush = flush;
    const removed = await removePhoto(store, payload());
    assert.equal(removed.photoUrl, null);
    const count = calls.length;
    await removePhoto(store, payload());
    assert.equal(calls.length, count);
    await assert.rejects(updatePhoto(store, { ...payload(), ownerId: 'synthetic-missing' }), { code: 'ACCOUNT_NOT_FOUND' });
    const stored = store.accounts.get(owner._id);
    stored.isDeleted = true;
    store.flush();
    await assert.rejects(updatePhoto(store, payload()), { code: 'ACCOUNT_IS_DELETED' });
    stored.isDeleted = false;
    store.flush();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('Account UpdatePhoto/RemovePhoto HTTP', { concurrency: 1 }, () => {
  test('Account and Classic preserve signed binary photo bytes and emit photoUrl null on remove', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phoenix-account-photo-http-'));
    const store = new Store(join(dir, 'account.json'));
    const owner = createOwnerAccount(store, { email: 'photo-http@synthetic.invalid', password: PASSWORD, firstName: 'Photo' });
    const outsider = createOwnerAccount(store, { email: 'photo-outsider@synthetic.invalid', password: PASSWORD });
    store.flush();
    const provider = new MemberPhotoStorage({
      directory: join(dir, 'photos'),
      publicBaseUrl: 'http://synthetic.invalid/member-photos',
    });
    const account = await createAccountService({ store, memberPhotoProvider: provider }).listen(0);
    const accountBase = `http://127.0.0.1:${account.address().port}`;
    provider.publicBaseUrl = `${accountBase}/member-photos`;
    const previous = process.env.NET_account;
    process.env.NET_account = accountBase;
    const classic = await createClassicEntrypoint({
      notificationFile: join(dir, 'notifications.json'),
      notificationPollIntervalMs: 60000,
    }).listen(0);
    try {
      for (const service of [account, classic]) {
        const base = `http://127.0.0.1:${service.address().port}`;
        const overLimit = await new Promise((resolve, reject) => {
          const request = httpRequest(`${base}/`, {
            method: 'POST',
            headers: {
              'x-amz-target': 'Account_20151111.UpdatePhoto',
              'content-length': '1000000001',
              'content-type': 'application/octet-stream',
            },
          }, (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => {
              resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) });
              request.destroy();
            });
          });
          request.on('error', reject);
          request.setTimeout(5000, () => request.destroy(new Error('oversize response deadline')));
          request.end();
        });
        assert.equal(overLimit.status, 400);
        assert.equal(overLimit.body.error, 'Bad Request');

        const missing = await fetch(`${base}/`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'Account_20151111.UpdatePhoto' },
          body: BYTES,
        });
        assert.equal(missing.status, 401);
        assert.equal((await missing.json()).__type, 'MISSING_AUTH_HEADER');

        const forgedHeader = await postPhoto(base, BYTES, owner, {
          'x-amz-credentials': JSON.stringify({ id: outsider._id, isAdmin: true }),
        });
        assert.equal(forgedHeader.status, 200, forgedHeader.rawBody);
        assert.equal(forgedHeader.body.id, owner._id);
        assert.notEqual(forgedHeader.body.id, outsider._id);

        const wrong = await postPhoto(base, BYTES, owner, {}, 'synthetic-wrong-secret');
        assert.equal(wrong.status, 401);
        assert.equal(wrong.body.__type, 'SIGNATURE_MISMATCH');

        const uploaded = await postPhoto(base, BYTES, owner);
        assert.equal(uploaded.status, 200, uploaded.rawBody);
        assert.ok(!('secretAccessKey' in uploaded.body));
        assert.ok(!('password' in uploaded.body));
        const url = uploaded.body.photoUrl;
        const key = url.split('/').pop();
        assert.ok(key.startsWith(owner._id));
        assert.match(key.slice(owner._id.length), /^\d+$/);
        const download = await fetch(url);
        assert.equal(download.status, 200);
        assert.deepEqual(Buffer.from(await download.arrayBuffer()), BYTES);

        const got = await postJson(base, 'Account_20151111.Get', {}, owner);
        assert.equal(got.status, 200, got.rawBody);
        assert.equal(got.body[0].photoUrl, url);

        const replaced = await postPhoto(base, REPLACEMENT, owner);
        assert.equal(replaced.status, 200, replaced.rawBody);
        const nextUrl = replaced.body.photoUrl;
        assert.notEqual(nextUrl, url);
        assert.equal((await fetch(url)).status, 404);
        assert.deepEqual(Buffer.from(await (await fetch(nextUrl)).arrayBuffer()), REPLACEMENT);

        const computed = await postPhoto(base, BYTES, owner, {}, owner.secretAccessKey, false);
        assert.equal(computed.status, 200, computed.rawBody);
        const computedUrl = computed.body.photoUrl;
        assert.deepEqual(Buffer.from(await (await fetch(computedUrl)).arrayBuffer()), BYTES);
        assert.equal((await postPhoto(base, BYTES, owner, {}, 'synthetic-wrong-secret', false)).status, 401);

        const removed = await postJson(base, 'Account_20151111.RemovePhoto', {}, owner);
        assert.equal(removed.status, 200, removed.rawBody);
        assert.equal(removed.body.photoUrl, null);
        assert.equal((await fetch(computedUrl)).status, 404);
        const after = await postJson(base, 'Account_20151111.Get', {}, owner);
        assert.equal(after.body[0].photoUrl, null);

        const removedAgain = await postJson(base, 'Account_20151111.RemovePhoto', null, owner);
        assert.equal(removedAgain.status, 200, removedAgain.rawBody);
        assert.equal(removedAgain.body.photoUrl, null);

        const jsonStillParsed = await postJson(base, 'Account_20151111.CheckEmail', { email: owner.email });
        assert.equal(jsonStillParsed.status, 200);
        assert.deepEqual(jsonStillParsed.body, { exists: true });
      }
    } finally {
      await Promise.all([account, classic].map((server) => new Promise((resolve) => server.close(resolve))));
      if (previous === undefined) delete process.env.NET_account;
      else process.env.NET_account = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('local binary storage still preserves bytes for account photo keys', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phoenix-account-photo-storage-'));
    try {
      const provider = new MemberPhotoStorage({ directory: dir, publicBaseUrl: 'https://synthetic.invalid/photos' });
      const path = `abc123${124}`;
      const saved = await provider.createPublic({ path, dataStream: Readable.from([BYTES]) });
      assert.equal(saved.url, `https://synthetic.invalid/photos/${path}`);
      assert.deepEqual(await readFile(join(dir, saved.path)), BYTES);
      await provider.remove(path);
      assert.deepEqual(await readdir(dir), []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
