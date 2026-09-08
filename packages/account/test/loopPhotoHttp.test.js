import { test } from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAccountService, Store } from '../src/index.js';
import { createOwnerAccount, createLoop, newId } from '../src/model.js';
import { MemberPhotoStorage } from '../src/memberPhotoStorage.js';
import { createClassicEntrypoint } from '../../classic/src/index.js';
import { signSigV4 } from '@phoenix/common';

test('Account and Classic preserve signed binary photo bytes, validate headers and retain JSON parsing elsewhere', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phoenix-photo-http-'));
  const store = new Store(join(dir, 'account.json'));
  const owner = createOwnerAccount(store, { email: 'photo-http@synthetic.invalid', password: 'synthetic-password' });
  const { loop } = createLoop(store, { owner, robotId: 'synthetic-photo-http-robot' });
  const memberId = newId();
  loop.members.push({ _id: memberId, status: 'invited', memberProperties: {}, enrolled: { face: false, voice: false } });
  store.flush();
  const provider = new MemberPhotoStorage({ directory: join(dir, 'photos'), publicBaseUrl: 'http://synthetic.invalid/member-photos' });
  const account = await createAccountService({ store, memberPhotoProvider: provider }).listen(0);
  const accountBase = `http://127.0.0.1:${account.address().port}`;
  provider.publicBaseUrl = `${accountBase}/member-photos`;
  const previous = process.env.NET_account;
  process.env.NET_account = accountBase;
  const classic = await createClassicEntrypoint({ notificationFile: join(dir, 'notifications.json'), notificationPollIntervalMs: 60000 }).listen(0);
  try {
    for (const service of [account, classic]) {
      const base = `http://127.0.0.1:${service.address().port}`;
      const post = (op, body, extra = {}, secret = owner.secretAccessKey, declaredDigest = true) => {
        const headers = signSigV4({ method: 'POST', path: '/', body,
          headers: { host: new URL(base).host, 'content-type': 'application/json', ...(declaredDigest ? { 'x-amz-content-sha256': createHash('sha256').update(body).digest('hex') } : {}), 'x-amz-target': `Loop_20160324.${op}`, ...extra },
          accessKeyId: owner.accessKeyId, secretAccessKey: secret, region: 'global', service: 'Loop' }).headers;
        return fetch(`${base}/`, { method: 'POST', headers, body });
      };
      const binary = Buffer.from([255, 0, 10, 128, 1]);
      const headers = { 'x-id': memberId, 'x-loop-id': loop._id };
      const wrong = await post('UpdateMemberPhoto', binary, headers, 'synthetic-wrong-secret');
      assert.equal(wrong.status, 401);
      const invalid = await post('UpdateMemberPhoto', binary);
      assert.equal(invalid.status, 422);
      const uploaded = await post('UpdateMemberPhoto', binary, headers);
      assert.equal(uploaded.status, 200, await uploaded.clone().text());
      const result = await uploaded.json();
      const url = result.members.find((member) => member.id === memberId).account.photoUrl;
      const download = await fetch(url);
      assert.equal(download.status, 200);
      assert.deepEqual(Buffer.from(await download.arrayBuffer()), binary);
      const removed = await post('RemoveMemberPhoto', JSON.stringify({ loopId: loop._id, id: memberId }));
      assert.equal(removed.status, 200);
      assert.equal((await removed.json()).members.find((member) => member.id === memberId).account.photoUrl, null);
      assert.equal((await fetch(url)).status, 404);
      const computedHashUpload = await post('UpdateMemberPhoto', binary, headers, owner.secretAccessKey, false);
      assert.equal(computedHashUpload.status, 200, await computedHashUpload.clone().text());
      const computedResult = await computedHashUpload.json();
      const computedUrl = computedResult.members.find((member) => member.id === memberId).account.photoUrl;
      assert.deepEqual(Buffer.from(await (await fetch(computedUrl)).arrayBuffer()), binary);
      assert.equal((await post('UpdateMemberPhoto', binary, headers, 'synthetic-wrong-secret', false)).status, 401);
      assert.equal((await post('ListLoops', binary)).status, 400);
      assert.equal((await post('ListLoops', '{}')).status, 200);
      assert.equal((await post('RemoveMemberPhoto', 'null')).status, 422);
    }
  } finally {
    await Promise.all([account, classic].map((server) => new Promise((resolve) => server.close(resolve))));
    if (previous === undefined) delete process.env.NET_account;
    else process.env.NET_account = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
