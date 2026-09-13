import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClassicEntrypoint, createVerifiedClassicCaller, MediaStore } from '../src/index.js';
import { signSigV4 } from '@phoenix/common';

const NOW = new Date('2026-09-10T12:00:00.000Z');
const OWNER = Object.freeze({
  _id: 'account-owner', id: 'account-owner', accessKeyId: 'owner-access', secretAccessKey: 'owner-secret',
  isActive: true, isAdmin: false, friendlyId: 'owner-robot',
});
const OTHER = Object.freeze({
  _id: 'account-other', id: 'account-other', accessKeyId: 'other-access', secretAccessKey: 'other-secret',
  isActive: true, isAdmin: false, friendlyId: 'other-robot',
});
const ADMIN = Object.freeze({
  _id: 'account-admin', id: 'account-admin', accessKeyId: 'admin-access', secretAccessKey: 'admin-secret',
  isActive: true, isAdmin: true, friendlyId: 'admin-robot',
});
const ACCOUNTS = new Map([
  [OWNER.accessKeyId, OWNER],
  [OTHER.accessKeyId, OTHER],
  [ADMIN.accessKeyId, ADMIN],
]);
const LOOP = 'loop-owner';
const OTHER_LOOP = 'loop-other';
const signedCaller = createVerifiedClassicCaller({
  now: NOW,
  resolveCredentials: (accessKeyId) => ACCOUNTS.get(accessKeyId) || null,
});

let server;
let mediaDir;
let mediaStore;
let port;

function signedHeaders(target, body, account, { date = NOW, extra = {} } = {}) {
  const raw = Buffer.from(JSON.stringify(body));
  return signSigV4({
    method: 'POST',
    path: '/',
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': target,
      ...extra,
    },
    body: raw,
    accessKeyId: account.accessKeyId,
    secretAccessKey: account.secretAccessKey,
    region: 'us-east-1',
    service: 'jibo',
    date,
  }).headers;
}

async function post(target, body, account, options = {}) {
  const raw = Buffer.from(JSON.stringify(body));
  const headers = signedHeaders(target, body, account, options);
  if (options.tamperedBody !== undefined) raw.set(Buffer.from(JSON.stringify(options.tamperedBody)));
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers: { ...headers, ...(options.forgedCredentials === undefined ? {} : {
      'x-amz-credentials': JSON.stringify(options.forgedCredentials),
    }) },
    body: options.tamperedBody === undefined ? raw : Buffer.from(JSON.stringify(options.tamperedBody)),
  });
  return { status: res.status, type: res.headers.get('x-amzn-errortype'), body: await res.json().catch(() => null) };
}

async function mediaUpload(path, bytes, account, { loopId = LOOP, extra = {}, forgedCredentials } = {}) {
  const headers = signSigV4({
    method: 'POST',
    path: '/',
    headers: {
      'content-type': 'application/octet-stream',
      'x-amz-target': 'Media_20160725.Create',
      'x-loop-id': loopId,
      'x-path': path,
      'x-type': 'image',
      'x-encrypted': 'false',
      ...extra,
    },
    body: bytes,
    accessKeyId: account.accessKeyId,
    secretAccessKey: account.secretAccessKey,
    region: 'us-east-1',
    service: 'jibo',
    date: NOW,
  }).headers;
  if (forgedCredentials !== undefined) headers['x-amz-credentials'] = JSON.stringify(forgedCredentials);
  const res = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', headers: { ...headers, host: 'evil.invalid' }, body: bytes });
  return { status: res.status, type: res.headers.get('x-amzn-errortype'), body: await res.json().catch(() => null) };
}

before(async () => {
  mediaDir = await mkdtemp(join(tmpdir(), 'phoenix-classic-caller-'));
  mediaStore = new MediaStore({ directory: join(mediaDir, 'objects'), file: join(mediaDir, 'media.json') });
  server = await createClassicEntrypoint({
    publicUrl: 'https://canonical.example.test/',
    callerBoundary: signedCaller,
    media: {
      store: mediaStore,
      loops: {
        members: (loopId) => loopId === LOOP ? [OWNER.id] : [],
        accountLoops: (accountId) => accountId === OWNER.id ? [LOOP] : [],
        ownedLoops: (accountId) => accountId === OWNER.id ? [LOOP] : [],
      },
    },
    backup: { dir: join(mediaDir, 'backups'), bearerSecret: 'caller-boundary-test' },
    keyMembership: { memberIds: async () => [OWNER.id] },
    keyBinaryDir: join(mediaDir, 'key-binaries'),
    backupOwnership: { loopRobotId: async (loopId) => loopId === LOOP ? OWNER.id : null },
  }).listen(0);
  port = server.address().port;
});

after(async () => {
  server?.close();
  await rm(mediaDir, { recursive: true, force: true });
});

test('verified media identity wins over a forged x-amz-credentials admin/account header', async () => {
  const listed = await post('Media_20160725.List', { loopIds: [LOOP] }, OWNER, { forgedCredentials: ADMIN });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body, []);

  const upload = await mediaUpload('caller-photo', Buffer.from('signed-by-owner'), OWNER, {
    forgedCredentials: { id: OTHER.id, isAdmin: true },
  });
  assert.equal(upload.status, 200);
  assert.equal(upload.body.accountId, OWNER.id);
});

test('tampered body, stale signature, and cross-account signature are rejected', async () => {
  const tampered = await post('Media_20160725.List', { loopIds: [LOOP] }, OWNER, {
    tamperedBody: { loopIds: [OTHER_LOOP] },
  });
  assert.equal(tampered.status, 401);
  assert.equal(tampered.type, 'SIGNATURE_MISMATCH');

  const stale = await post('Media_20160725.List', { loopIds: [LOOP] }, OWNER, {
    date: new Date(NOW.getTime() - 16 * 60 * 1000),
  });
  assert.equal(stale.status, 401);
  assert.equal(stale.type, 'CLOCK_SKEW_TOO_LONG');

  const crossAccount = await post('Media_20160725.List', { loopIds: [LOOP] }, OTHER);
  assert.equal(crossAccount.status, 403);
  assert.equal(crossAccount.type, 'MEDIA_MUST_BE_MEMBER');
});

test('admin decisions use the verified account, not a forged forwarded header', async () => {
  const seeded = mediaStore.find('caller-photo');
  assert.ok(seeded);
  const forgedAdmin = await post('MediaAdmin_20160725.RemoveAllMediaFromLoop', { loopId: LOOP }, OWNER, {
    forgedCredentials: { id: ADMIN.id, isAdmin: true },
  });
  assert.equal(forgedAdmin.status, 401);
  assert.equal(forgedAdmin.type, 'AUTHORIZED_UNDER_ADMIN');
  assert.ok(mediaStore.find('caller-photo'));

  const admin = await post('MediaAdmin_20160725.RemoveAllMediaFromLoop', { loopId: LOOP }, ADMIN, {
    forgedCredentials: { id: OWNER.id, isAdmin: false },
  });
  assert.equal(admin.status, 200);
  assert.equal(mediaStore.find('caller-photo'), null);
});

test('signed Backup owner works, while a signed nonowner and forged identity fail', async () => {
  const owner = await post('Backup_20170222.New', { loopId: LOOP }, OWNER, {
    forgedCredentials: { id: OTHER.id, isAdmin: true },
  });
  assert.equal(owner.status, 200);
  assert.match(owner.body.uploadUrl, /^https:\/\/canonical\.example\.test\/backup\/blob\?/);

  const nonowner = await post('Backup_20170222.New', { loopId: LOOP }, OTHER);
  assert.equal(nonowner.status, 403);
  assert.equal(nonowner.body.code, 'ROBOT_SHOULD_BELONG_TO_LOOP');
});

test('raw Media.Create verifies the exact bytes and never uses the request Host for object URLs', async () => {
  const bytes = Buffer.from('raw-upload-exact-bytes');
  const created = await mediaUpload('canonical-photo', bytes, OWNER, {
    forgedCredentials: { id: OTHER.id, isAdmin: true },
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.url, 'https://canonical.example.test/media/blob/canonical-photo');

  const signed = signSigV4({
    method: 'POST', path: '/', headers: {
      'content-type': 'application/octet-stream', 'x-amz-target': 'Media_20160725.Create',
      'x-loop-id': LOOP, 'x-path': 'tampered-photo', 'x-type': 'image', 'x-encrypted': 'false',
    }, body: Buffer.from('expected-bytes'), accessKeyId: OWNER.accessKeyId,
    secretAccessKey: OWNER.secretAccessKey, region: 'us-east-1', service: 'jibo', date: NOW,
  }).headers;
  const tampered = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST', headers: { ...signed, host: 'evil.invalid' }, body: Buffer.from('different-bytes'),
  });
  assert.equal(tampered.status, 401);
  assert.equal(tampered.headers.get('x-amzn-errortype'), 'SIGNATURE_MISMATCH');
  assert.equal(mediaStore.find('tampered-photo'), null);
});

test('direct Key routes verify identity and preserve raw ShareBinary bytes', async () => {
  const createBody = { loopId: LOOP, accountId: OTHER.id, encryptedUrl: 'encrypted-key.bin' };
  const createRaw = Buffer.from(JSON.stringify(createBody));
  const create = await signedDirect('/binaryRequest', 'POST', { 'content-type': 'application/json' }, createRaw, OWNER);
  const createdBody = await create.json();
  assert.equal(create.status, 200);
  assert.equal(createdBody.accountId, OWNER.id, 'the body accountId cannot choose the stored owner');

  const exact = Buffer.from([0x00, 0x11, 0x7f, 0x80, 0xff]);
  const shared = await signedDirect('/', 'POST', {
    'content-type': 'application/octet-stream',
    'x-amz-target': 'Key_20160201.ShareBinary',
    'x-id': createdBody.id,
  }, exact, OWNER);
  assert.equal(shared.status, 200);
  const persisted = await readFile(join(mediaDir, 'key-binaries', OWNER.id, createdBody.id));
  assert.deepEqual(persisted, exact, 'the verifier and handler use the same raw bytes');
});

async function signedDirect(path, method, headers, body, account) {
  const signed = signSigV4({
    method, path, headers, body, accessKeyId: account.accessKeyId,
    secretAccessKey: account.secretAccessKey, region: 'us-east-1', service: 'jibo', date: NOW,
  }).headers;
  return fetch(`http://127.0.0.1:${port}${path}`, { method, headers: signed, body });
}
