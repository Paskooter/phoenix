import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAccountService, resetStore, Store, start as startAccount } from '../src/index.js';
import { createOwnerAccount, createLoop, newId } from '../src/model.js';
import { createClassicEntrypoint } from '../../classic/src/index.js';
import { signSigV4 } from '@phoenix/common';

function signedPhotoRequest(base, owner, loopId, memberId, bytes) {
  const body = Buffer.from(bytes);
  const signed = signSigV4({
    method: 'POST',
    path: '/',
    body,
    headers: {
      host: new URL(base).host,
      'content-type': 'application/octet-stream',
      'x-amz-target': 'Loop_20160324.UpdateMemberPhoto',
      'x-id': memberId,
      'x-loop-id': loopId,
      'x-amz-content-sha256': createHash('sha256').update(body).digest('hex'),
    },
    accessKeyId: owner.accessKeyId,
    secretAccessKey: owner.secretAccessKey,
    region: 'global',
    service: 'Loop',
  });
  return { headers: signed.headers, body };
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

test('normal Account start exposes configured photos through the Classic public ingress', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phoenix-photo-deployment-'));
  const accountFile = join(dir, 'account.json');
  const photoDirectory = join(dir, 'member-photos');
  const notificationFile = join(dir, 'notifications.json');
  const envKeys = [
    'ETCO_account_dataFile',
    'ETCO_account_photoBaseUrl',
    'ETCO_account_photoDirectory',
    'PHOTO_PUBLIC_URL',
    'PHOTO_DIRECTORY',
    'NET_account',
    'ETCO_classic_publicUrl',
  ];
  const prior = new Map(envKeys.map((key) => [key, process.env[key]]));
  let accountServer;
  let classicServer;
  try {
    process.env.ETCO_account_dataFile = accountFile;
    process.env.ETCO_account_photoDirectory = photoDirectory;
    // This is filled after Classic has an ephemeral port. It exercises the
    // entrypoint's native ETCO configuration instead of provider injection.
    delete process.env.ETCO_account_photoBaseUrl;
    delete process.env.PHOTO_PUBLIC_URL;
    delete process.env.PHOTO_DIRECTORY;

    const store = new Store(accountFile);
    const owner = createOwnerAccount(store, {
      email: 'deployment-owner@fixture.test',
      password: 'deployment-password',
    });
    const { loop } = createLoop(store, { owner, robotId: 'deployment-robot' });
    const memberId = newId();
    loop.members.push({
      _id: memberId,
      status: 'invited',
      memberProperties: {},
      enrolled: { face: false, voice: false },
    });
    store.flush();
    resetStore();

    // Account's returned URL is deliberately the Classic listener, while
    // Classic's NET_account remains an internal backend address.
    classicServer = await createClassicEntrypoint({
      notificationFile,
      notificationPollIntervalMs: 60_000,
    }).listen(0);
    const classicBase = `http://127.0.0.1:${classicServer.address().port}`;
    process.env.ETCO_account_photoBaseUrl = classicBase;

    accountServer = await startAccount(0);
    const accountBase = `http://127.0.0.1:${accountServer.address().port}`;
    process.env.NET_account = accountBase;

    const bytes = Buffer.from([0, 1, 2, 127, 128, 254, 255]);
    const request = signedPhotoRequest(classicBase, owner, loop._id, memberId, bytes);
    const upload = await fetch(`${classicBase}/`, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
    });
    assert.equal(upload.status, 200, await upload.clone().text());
    const result = await upload.json();
    const member = result.members.find((candidate) => candidate.id === memberId);
    assert.ok(member, 'upload response includes the target member');
    assert.match(member.account.photoUrl, new RegExp(`^${classicBase}/member-photos/`));
    assert.ok(!member.account.photoUrl.startsWith(`${accountBase}/`), 'photo URL does not expose the Account backend');
    assert.equal(new URL(member.account.photoUrl).host, new URL(classicBase).host);

    // Follow the URL exactly as a robot would: GET enters the Classic public
    // listener and is proxied to Account's local object store.
    const download = await fetch(member.account.photoUrl);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'application/octet-stream');
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
    const missing = await fetch(`${classicBase}/member-photos/missing-synthetic-key`);
    assert.equal(missing.status, 404, 'Classic preserves Account missing-object status');

    const persisted = new Store(accountFile);
    const persistedLoop = persisted.loops.get(loop._id);
    const persistedMember = persistedLoop.members.find((candidate) => candidate._id === memberId);
    assert.equal(persistedMember.memberProperties.photoUrl, member.account.photoUrl);
    const objectKey = new URL(member.account.photoUrl).pathname.split('/').pop();
    assert.deepEqual(await readFile(join(photoDirectory, objectKey)), bytes);
  } finally {
    await Promise.all([accountServer, classicServer].map(closeServer));
    resetStore();
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test('photo configuration keeps explicit programmatic settings ahead of environment aliases', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phoenix-photo-config-'));
  const store = new Store(join(dir, 'account.json'));
  const owner = createOwnerAccount(store, {
    email: 'configured-owner@fixture.test',
    password: 'configured-password',
  });
  const { loop } = createLoop(store, { owner, robotId: 'configured-robot' });
  const memberId = newId();
  loop.members.push({
    _id: memberId,
    status: 'invited',
    memberProperties: {},
    enrolled: { face: false, voice: false },
  });
  store.flush();
  const priorUrl = process.env.ETCO_account_photoBaseUrl;
  const priorDir = process.env.ETCO_account_photoDirectory;
  let server;
  try {
    process.env.ETCO_account_photoBaseUrl = 'https://env.example/photos';
    process.env.ETCO_account_photoDirectory = join(dir, 'env-photos');
    const service = createAccountService({
      store,
      loopConfig: {
        server: {
          photoBaseUrl: 'https://configured.example',
          photoDirectory: join(dir, 'configured-photos'),
        },
      },
    });
    server = await service.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    const bytes = Buffer.from('programmatic-photo-config', 'utf8');
    const request = signedPhotoRequest(base, owner, loop._id, memberId, bytes);
    const upload = await fetch(`${base}/`, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
    });
    assert.equal(upload.status, 200, await upload.clone().text());
    const member = (await upload.json()).members.find((candidate) => candidate.id === memberId);
    assert.match(member.account.photoUrl, /^https:\/\/configured\.example\/member-photos\//);
    const objectKey = new URL(member.account.photoUrl).pathname.split('/').pop();
    assert.deepEqual(await readFile(join(dir, 'configured-photos', objectKey)), bytes);
  } finally {
    await closeServer(server);
    if (priorUrl === undefined) delete process.env.ETCO_account_photoBaseUrl;
    else process.env.ETCO_account_photoBaseUrl = priorUrl;
    if (priorDir === undefined) delete process.env.ETCO_account_photoDirectory;
    else process.env.ETCO_account_photoDirectory = priorDir;
    await rm(dir, { recursive: true, force: true });
  }
});
