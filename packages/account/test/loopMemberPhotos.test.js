import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { Store } from '../src/store.js';
import { createOwnerAccount, createLoop, newId } from '../src/model.js';
import { LoopUpdatedOutbox } from '../src/loopUpdatedOutbox.js';
import { updateMemberPhoto, removeMemberPhoto } from '../src/loopMemberPhotos.js';
import { MemberPhotoStorage } from '../src/memberPhotoStorage.js';

test('photo replacement/removal preserves source ordering and failed-save state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phoenix-photo-'));
  try {
    const store = new Store(join(dir, 'account.json'));
    const owner = createOwnerAccount(store, { email: 'photo-owner@synthetic.invalid', password: 'synthetic-password' });
    const { loop, robot } = createLoop(store, { owner, robotId: 'synthetic-photo-robot' });
    const memberId = newId();
    loop.members.push({ _id: memberId, status: 'declined', memberProperties: { isChild: true, photoUrl: 'https://synthetic.invalid/old-photo' }, enrolled: { face: false, voice: false } });
    loop.isSuspended = true;
    store.flush();
    const outbox = new LoopUpdatedOutbox(store);
    const calls = [];
    let failRemoval = false;
    const binary = {
      async createPublic({ dataStream, path }) {
        const chunks = []; for await (const chunk of dataStream) chunks.push(Buffer.from(chunk));
        assert.deepEqual(Buffer.concat(chunks), Buffer.from([0, 255, 1, 128]));
        calls.push(['upload', path]); return { url: `https://synthetic.invalid/${path}` };
      },
      async remove(path) { calls.push(['remove', path]); if (failRemoval) throw new Error('synthetic removal failure'); },
    };
    const payload = () => ({ ownerId: robot._id, loopId: loop._id, id: memberId, dataStream: Readable.from([Buffer.from([0, 255, 1, 128])]) });
    const before = JSON.stringify([...store.loops]);
    failRemoval = true;
    await assert.rejects(updateMemberPhoto(store, payload(), binary, outbox, () => 123), /removal failure/);
    assert.deepEqual(calls, [['upload', memberId + '123'], ['remove', 'old-photo']]);
    assert.equal(JSON.stringify([...store.loops]), before);
    assert.equal(store.notificationOutbox.size, 0);
    failRemoval = false; calls.length = 0;
    const result = await updateMemberPhoto(store, payload(), binary, outbox, () => 124);
    assert.equal(result.members.find((m) => m.id === memberId).account.photoUrl, `https://synthetic.invalid/${memberId}124`);
    assert.deepEqual(calls, [['upload', memberId + '124'], ['remove', 'old-photo']]);
    assert.equal(store.notificationOutbox.size, 1);
    const prior = JSON.stringify([...store.loops]);
    const flush = store.flush;
    store.flush = () => { throw new Error('synthetic save failure'); };
    await assert.rejects(removeMemberPhoto(store, payload(), binary, outbox), /save failure/);
    assert.equal(JSON.stringify([...store.loops]), prior);
    assert.equal(store.notificationOutbox.size, 1);
    store.flush = flush;
    const removed = await removeMemberPhoto(store, { ...payload(), ownerId: owner._id }, binary, outbox);
    assert.equal(removed.members.find((m) => m.id === memberId).account.photoUrl, null);
    assert.equal(store.notificationOutbox.size, 2);
    const count = calls.length;
    await removeMemberPhoto(store, payload(), binary, outbox);
    assert.equal(calls.length, count); // absent object still results in a Loop save
    assert.equal(store.notificationOutbox.size, 3);
    for (const [change, code] of [
      [{ loopId: 'synthetic-missing' }, 'LOOP_NOT_FOUND'],
      [{ ownerId: 'synthetic-outsider' }, 'CAN_BE_ACCESSED_BY_OWNER_OR_ROBOT'],
      [{ id: 'synthetic-missing' }, 'MEMBER_NOT_FOUND'],
    ]) await assert.rejects(updateMemberPhoto(store, { ...payload(), ...change }, binary, outbox), { code });
    assert.equal(calls.length, count);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('local binary storage preserves bytes and cleans up interrupted uploads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phoenix-photo-storage-'));
  try {
    const provider = new MemberPhotoStorage({ directory: dir, publicBaseUrl: 'https://synthetic.invalid/photos' });
    const bytes = Buffer.from([255, 0, 137, 10, 13]);
    const saved = await provider.createPublic({ path: 'synthetic-photo123', dataStream: Readable.from([bytes]) });
    assert.equal(saved.url, 'https://synthetic.invalid/photos/synthetic-photo123');
    assert.deepEqual(await readFile(join(dir, saved.path)), bytes);
    await assert.rejects(provider.createPublic({ path: 'synthetic-broken', dataStream: Readable.from((async function* () { yield bytes; throw new Error('synthetic stream failure'); })()) }), /stream failure/);
    assert.deepEqual(await readdir(dir), ['synthetic-photo123']);
    await provider.remove(saved.path);
    await provider.remove(saved.path); // source S3 deletion is idempotent
    assert.deepEqual(await readdir(dir), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
