import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';

import { signSigV4 } from '@phoenix/common';
import { createAccountService } from '../src/index.js';
import { createLoop, createOwnerAccount } from '../src/model.js';
import { updateMemberPhoto } from '../src/loopMemberPhotos.js';
import { MemberPhotoStorage } from '../src/memberPhotoStorage.js';
import { Store } from '../src/store.js';
import { updatePhoto } from '../src/accountIdentity.js';
import { LoopUpdatedOutbox } from '../src/loopUpdatedOutbox.js';

const PASSWORD = 'ValidPass1';
const OLD = Buffer.from('old-photo');
const FIRST = Buffer.from('first-photo');
const SECOND = Buffer.from('second-photo');

function photoKey(url) {
  return String(url).split('/').pop();
}

function fakePhotoProvider(objects, calls = [], { delayMs = 0, failRemove = null } = {}) {
  return {
    async createPublic({ dataStream, path }) {
      const chunks = [];
      for await (const chunk of dataStream) chunks.push(Buffer.from(chunk));
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const bytes = Buffer.concat(chunks);
      calls.push(['upload', path, bytes]);
      objects.set(path, bytes);
      return { path, url: `https://photos.synthetic/${path}` };
    },
    async remove(path) {
      calls.push(['remove', path]);
      if (failRemove && failRemove(path)) throw new Error(`remove failed for ${path}`);
      objects.delete(path);
    },
  };
}

async function prepareAccount(file, email, provider, initialBytes = OLD) {
  const store = new Store(file);
  const owner = createOwnerAccount(store, { email, password: PASSWORD });
  const oldKey = `${owner._id}-old`;
  owner.photoUrl = `https://photos.synthetic/${oldKey}`;
  provider.objects.set(oldKey, Buffer.from(initialBytes));
  store.flush();
  return { store, owner, oldKey };
}

async function prepareMember(file, email, provider, initialBytes = OLD) {
  const store = new Store(file);
  const owner = createOwnerAccount(store, { email, password: PASSWORD });
  const { loop, robot } = createLoop(store, { owner, robotId: `${email}-robot` });
  const member = loop.members.find((item) => item.accountId === robot._id);
  member.status = 'declined';
  const oldKey = `${member._id}-old`;
  member.memberProperties = { photoUrl: `https://photos.synthetic/${oldKey}` };
  provider.objects.set(oldKey, Buffer.from(initialBytes));
  store.flush();
  return { store, owner, loop, member, oldKey, outbox: new LoopUpdatedOutbox(store) };
}

function signedChunkHeaders(base, target, body, account, extra = {}) {
  return signSigV4({
    method: 'POST',
    path: '/',
    body,
    headers: {
      host: new URL(base).host,
      'content-type': 'application/octet-stream',
      'x-amz-content-sha256': createHash('sha256').update(body).digest('hex'),
      'x-amz-target': target,
      ...extra,
    },
    accessKeyId: account.accessKeyId,
    secretAccessKey: account.secretAccessKey,
    region: 'global',
    service: 'jibo',
  }).headers;
}

function chunkedPost(base, target, body, account, extra = {}) {
  const headers = { ...signedChunkHeaders(base, target, body, account, extra), connection: 'close' };
  delete headers['content-length'];
  return new Promise((resolve, reject) => {
    const request = http.request(`${base}/`, { method: 'POST', headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = JSON.parse(rawBody); } catch { parsed = undefined; }
        resolve({ status: response.statusCode, body: parsed, rawBody });
      });
    });
    request.on('error', reject);
    request.write(body.subarray(0, Math.ceil(body.length / 2)));
    setImmediate(() => request.end(body.subarray(Math.ceil(body.length / 2))));
  });
}

async function close(server) {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
}

test('account same-clock replacement cannot overwrite committed bytes when metadata fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phoenix-account-photo-collision-'));
  try {
    const objects = new Map();
    const provider = fakePhotoProvider(objects);
    const { store, owner } = await prepareAccount(join(dir, 'store.json'), 'collision-account@synthetic.invalid', { objects });
    const first = await updatePhoto(store, {
      ownerId: owner._id,
      dataStream: Readable.from([FIRST]),
      photoProvider: provider,
      clock: () => 42,
    });
    const committedKey = photoKey(first.photoUrl);
    assert.deepEqual(objects.get(committedKey), FIRST);
    const originalFlush = store.flush.bind(store);
    store.flush = () => { throw new Error('synthetic account metadata failure'); };

    await assert.rejects(updatePhoto(store, {
      ownerId: owner._id,
      dataStream: Readable.from([SECOND]),
      photoProvider: provider,
      clock: () => 42,
    }), /synthetic account metadata failure/);

    store.flush = originalFlush;
    assert.deepEqual(objects.get(committedKey), FIRST, 'a failed same-clock replacement preserves the old object bytes');
    assert.equal(store.accounts.get(owner._id).photoUrl, first.photoUrl);
    assert.equal(new Store(join(dir, 'store.json')).accounts.get(owner._id).photoUrl, first.photoUrl);
    assert.equal(objects.size, 1, 'the failed replacement leaves no staged object');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('member same-clock replacement cannot overwrite committed bytes when metadata fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phoenix-member-photo-collision-'));
  try {
    const objects = new Map();
    const provider = fakePhotoProvider(objects);
    const { store, owner, loop, member, outbox } = await prepareMember(join(dir, 'store.json'), 'collision-member@synthetic.invalid', { objects });
    const first = await updateMemberPhoto(store, {
      ownerId: owner._id,
      loopId: loop._id,
      id: member._id,
      dataStream: Readable.from([FIRST]),
    }, provider, outbox, () => 42);
    const committedUrl = first.members.find((item) => item.id === member._id).account.photoUrl;
    const committedKey = photoKey(committedUrl);
    assert.deepEqual(objects.get(committedKey), FIRST);
    const originalFlush = store.flush.bind(store);
    store.flush = () => { throw new Error('synthetic member metadata failure'); };

    await assert.rejects(updateMemberPhoto(store, {
      ownerId: owner._id,
      loopId: loop._id,
      id: member._id,
      dataStream: Readable.from([SECOND]),
    }, provider, outbox, () => 42), /synthetic member metadata failure/);

    store.flush = originalFlush;
    const reopened = new Store(join(dir, 'store.json'));
    const reopenedMember = reopened.loops.get(loop._id).members.find((item) => item._id === member._id);
    assert.deepEqual(objects.get(committedKey), FIRST);
    assert.equal(reopenedMember.memberProperties.photoUrl, committedUrl);
    assert.equal(objects.size, 1, 'the failed member replacement leaves no staged object');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('account concurrent same-clock replacements serialize and reopen to one live object', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phoenix-account-photo-concurrent-'));
  try {
    const objects = new Map();
    const calls = [];
    const provider = fakePhotoProvider(objects, calls, { delayMs: 5 });
    const { store, owner } = await prepareAccount(join(dir, 'store.json'), 'concurrent-account@synthetic.invalid', { objects });
    let active = 0;
    let maximumActive = 0;
    const originalCreate = provider.createPublic;
    provider.createPublic = async (args) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try { return await originalCreate(args); } finally { active -= 1; }
    };

    const [first, second] = await Promise.all([
      updatePhoto(store, { ownerId: owner._id, dataStream: Readable.from([FIRST]), photoProvider: provider, clock: () => 7 }),
      updatePhoto(store, { ownerId: owner._id, dataStream: Readable.from([SECOND]), photoProvider: provider, clock: () => 7 }),
    ]);
    const keys = calls.filter(([kind]) => kind === 'upload').map(([, key]) => key);
    assert.equal(maximumActive, 1, 'the account photo lock prevents concurrent object replacements');
    assert.equal(new Set(keys).size, 2, 'same-clock account replacements use unique object keys');
    assert.equal(objects.size, 1, 'only the final account object remains');
    const reopened = new Store(join(dir, 'store.json'));
    assert.equal(reopened.accounts.get(owner._id).photoUrl, second.photoUrl);
    assert.deepEqual(objects.get(photoKey(second.photoUrl)), SECOND);
    assert.notEqual(first.photoUrl, second.photoUrl);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('member concurrent same-clock replacements serialize and reopen to one live object', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phoenix-member-photo-concurrent-'));
  try {
    const objects = new Map();
    const calls = [];
    const provider = fakePhotoProvider(objects, calls, { delayMs: 5 });
    const { store, owner, loop, member, outbox } = await prepareMember(join(dir, 'store.json'), 'concurrent-member@synthetic.invalid', { objects });
    let active = 0;
    let maximumActive = 0;
    const originalCreate = provider.createPublic;
    provider.createPublic = async (args) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try { return await originalCreate(args); } finally { active -= 1; }
    };

    const [first, second] = await Promise.all([
      updateMemberPhoto(store, { ownerId: owner._id, loopId: loop._id, id: member._id, dataStream: Readable.from([FIRST]) }, provider, outbox, () => 7),
      updateMemberPhoto(store, { ownerId: owner._id, loopId: loop._id, id: member._id, dataStream: Readable.from([SECOND]) }, provider, outbox, () => 7),
    ]);
    const keys = calls.filter(([kind]) => kind === 'upload').map(([, key]) => key);
    const secondUrl = second.members.find((item) => item.id === member._id).account.photoUrl;
    assert.equal(maximumActive, 1, 'the member photo lock prevents concurrent object replacements');
    assert.equal(new Set(keys).size, 2, 'same-clock member replacements use unique object keys');
    assert.equal(objects.size, 1, 'only the final member object remains');
    const reopened = new Store(join(dir, 'store.json'));
    const reopenedMember = reopened.loops.get(loop._id).members.find((item) => item._id === member._id);
    assert.equal(reopenedMember.memberProperties.photoUrl, secondUrl);
    assert.deepEqual(objects.get(photoKey(secondUrl)), SECOND);
    assert.notEqual(first.members.find((item) => item.id === member._id).account.photoUrl, secondUrl);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('account and member object failures roll back metadata and remove their staged objects', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phoenix-photo-object-failure-'));
  try {
    const accountObjects = new Map();
    const accountProvider = fakePhotoProvider(accountObjects, [], { failRemove: (key) => key === 'account-old' });
    const account = await prepareAccount(join(dir, 'account.json'), 'object-account@synthetic.invalid', { objects: accountObjects });
    accountObjects.clear();
    account.owner.photoUrl = 'https://photos.synthetic/account-old';
    accountObjects.set('account-old', OLD);
    account.store.flush();
    await assert.rejects(updatePhoto(account.store, {
      ownerId: account.owner._id,
      dataStream: Readable.from([SECOND]),
      photoProvider: accountProvider,
      clock: () => 88,
    }), /remove failed/);
    assert.equal(account.store.accounts.get(account.owner._id).photoUrl, 'https://photos.synthetic/account-old');
    assert.equal(new Store(join(dir, 'account.json')).accounts.get(account.owner._id).photoUrl, 'https://photos.synthetic/account-old');
    assert.deepEqual(accountObjects.get('account-old'), OLD);
    assert.equal(accountObjects.size, 1);

    const memberObjects = new Map();
    const memberProvider = fakePhotoProvider(memberObjects, [], { failRemove: (key) => key === 'member-old' });
    const member = await prepareMember(join(dir, 'member.json'), 'object-member@synthetic.invalid', { objects: memberObjects });
    memberObjects.clear();
    member.loop.members.find((item) => item._id === member.member._id).memberProperties.photoUrl = 'https://photos.synthetic/member-old';
    memberObjects.set('member-old', OLD);
    member.store.flush();
    await assert.rejects(updateMemberPhoto(member.store, {
      ownerId: member.owner._id,
      loopId: member.loop._id,
      id: member.member._id,
      dataStream: Readable.from([SECOND]),
    }, memberProvider, member.outbox, () => 89), /remove failed/);
    const reopened = new Store(join(dir, 'member.json'));
    const reopenedMember = reopened.loops.get(member.loop._id).members.find((item) => item._id === member.member._id);
    assert.equal(reopenedMember.memberProperties.photoUrl, 'https://photos.synthetic/member-old');
    assert.deepEqual(memberObjects.get('member-old'), OLD);
    assert.equal(memberObjects.size, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reopened account and member metadata point at readable committed objects', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phoenix-photo-reopen-'));
  try {
    const provider = new MemberPhotoStorage({ directory: join(dir, 'photos'), publicBaseUrl: 'https://photos.synthetic' });
    const file = join(dir, 'store.json');
    const store = new Store(file);
    const owner = createOwnerAccount(store, { email: 'reopen-account@synthetic.invalid', password: PASSWORD });
    const accountPhoto = await updatePhoto(store, {
      ownerId: owner._id,
      dataStream: Readable.from([FIRST]),
      photoProvider: provider,
      clock: () => 301,
    });
    const { loop, robot } = createLoop(store, { owner, robotId: 'reopen-member-robot' });
    const member = loop.members.find((item) => item.accountId === robot._id);
    member.status = 'declined';
    const outbox = new LoopUpdatedOutbox(store);
    const memberPhoto = await updateMemberPhoto(store, {
      ownerId: owner._id,
      loopId: loop._id,
      id: member._id,
      dataStream: Readable.from([SECOND]),
    }, provider, outbox, () => 302);
    const reopened = new Store(file);
    const reopenedAccount = reopened.accounts.get(owner._id);
    const reopenedLoop = reopened.loops.get(loop._id);
    const reopenedMember = reopenedLoop.members.find((item) => item._id === member._id);
    assert.equal(reopenedAccount.photoUrl, accountPhoto.photoUrl);
    assert.equal(reopenedMember.memberProperties.photoUrl,
      memberPhoto.members.find((item) => item.id === member._id).account.photoUrl);
    assert.deepEqual(await readFile(join(dir, 'photos', photoKey(reopenedAccount.photoUrl))), FIRST);
    assert.deepEqual(await readFile(join(dir, 'photos', photoKey(reopenedMember.memberProperties.photoUrl))), SECOND);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('account and member chunked uploads enforce cumulative configured byte caps', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phoenix-photo-chunked-cap-'));
  let service;
  try {
    const store = new Store(join(dir, 'store.json'));
    const owner = createOwnerAccount(store, { email: 'chunked-cap@synthetic.invalid', password: PASSWORD });
    const { loop, robot } = createLoop(store, { owner, robotId: 'chunked-cap-robot' });
    const member = loop.members.find((item) => item.accountId === robot._id);
    member.status = 'declined';
    const objects = new Map();
    const provider = fakePhotoProvider(objects);
    service = await createAccountService({ store, memberPhotoProvider: provider, photoMaxBytes: 4 }).listen(0);
    const base = `http://127.0.0.1:${service.address().port}`;

    const accountNear = await chunkedPost(base, 'Account_20151111.UpdatePhoto', Buffer.from('1234'), owner);
    assert.equal(accountNear.status, 200, accountNear.rawBody);
    const accountUrl = accountNear.body.photoUrl;
    const accountOver = await chunkedPost(base, 'Account_20151111.UpdatePhoto', Buffer.from('12345'), owner);
    assert.equal(accountOver.status, 400, accountOver.rawBody);
    assert.equal(store.accounts.get(owner._id).photoUrl, accountUrl);

    const memberNear = await chunkedPost(base, 'Loop_20160324.UpdateMemberPhoto', Buffer.from('abcd'), owner, {
      'x-id': member._id,
      'x-loop-id': loop._id,
    });
    assert.equal(memberNear.status, 200, memberNear.rawBody);
    const memberUrl = memberNear.body.members.find((item) => item.id === member._id).account.photoUrl;
    const memberOver = await chunkedPost(base, 'Loop_20160324.UpdateMemberPhoto', Buffer.from('abcde'), owner, {
      'x-id': member._id,
      'x-loop-id': loop._id,
    });
    assert.equal(memberOver.status, 400, memberOver.rawBody);
    assert.equal(store.loops.get(loop._id).members.find((item) => item._id === member._id).memberProperties.photoUrl, memberUrl);
    assert.equal(objects.size, 2, 'over-limit chunked requests never reach the public-object provider');
  } finally {
    await close(service);
    await rm(dir, { recursive: true, force: true });
  }
});
