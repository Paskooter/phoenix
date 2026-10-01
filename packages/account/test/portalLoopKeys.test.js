import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, createHash, publicEncrypt, constants } from 'node:crypto';
import { Readable } from 'node:stream';
import { createAccountService, Store } from '../src/index.js';
import { createOwnerAccount, createLoop } from '../src/model.js';
import { createClassicEntrypoint, createVerifiedClassicCaller, KeyStore, MediaStore } from '../../classic/src/index.js';
import { classicCall } from '../src/portal/classicClient.js';
import { createExchange, encryptBackup } from '../portal/loop-crypto.js';
import forge from 'node-forge';

test('authenticated browser key exchange/first backup enforce membership, request ownership and atomic create-only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-portal-loop-keys-'));
  const store = new Store(join(dir, 'account.json'));
  const owner = createOwnerAccount(store, { email: 'key-owner@fixture.test', password: 'fixture-password-1' });
  const member = createOwnerAccount(store, { email: 'key-member@fixture.test', password: 'fixture-password-2' });
  const stranger = createOwnerAccount(store, { email: 'key-stranger@fixture.test', password: 'fixture-password-3' });
  const { loop, robot } = createLoop(store, { owner, robotId: 'key-robot-fixture' });
  loop.members.push({ accountId: member._id, status: 'accepted' }); store.flush();
  const keyStore = new KeyStore(join(dir, 'keys.json'));
  const mediaStore = new MediaStore({ file: join(dir, 'media.json'), directory: join(dir, 'media') });
  await mediaStore.putObject({ path: 'fixture-photo', type: 'image', accountId: robot._id,
    loopId: loop._id, url: 'http://classic.fixture/media/blob/fixture-photo', isEncrypted: true,
    isDeleted: false, created: Date.now(), thumbs: [] }, Readable.from([Buffer.alloc(48, 1)]));
  const membership = { memberIds: async (id) => store.loops.get(id)?.members.map((m) => m.accountId),
    loop: async (id) => { const row = store.loops.get(id); return row ? { owner: row.owner, robot: row.robot } : null; } };
  let classic; let account;
  const priorClassic = process.env.NET_classic;
  try {
    classic = await createClassicEntrypoint({ publicUrl: 'http://classic.fixture', keyStore,
      keyMembership: membership,
      media: { store: mediaStore, loops: { members: membership.memberIds,
        accountLoops: async (id) => loop.members.some((m) => m.accountId === id) ? [loop._id] : [],
        ownedLoops: async (id) => id === owner._id ? [loop._id] : [] } },
      callerBoundary: createVerifiedClassicCaller({ resolveCredentials: (id) => store.accountByAccessKeyId(id) }),
    }).listen(0);
    const classicBase = `http://127.0.0.1:${classic.address().port}`;
    process.env.NET_classic = classicBase;
    account = await createAccountService({ store }).listen(0);
    const base = `http://127.0.0.1:${account.address().port}`; const cookies = {};
    async function call(actor, method, path, body, headers = {}) {
      const response = await fetch(base + path, { method,
        headers: { 'content-type': 'application/json', ...(cookies[actor] ? { cookie: cookies[actor] } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body) });
      if (response.headers.get('set-cookie')) cookies[actor] = response.headers.get('set-cookie').split(';')[0];
      return { status: response.status, headers: response.headers, body: await response.json().catch(() => null) };
    }
    for (const actor of [owner, member, stranger]) assert.equal((await call(actor._id, 'POST', '/api/login', {
      email: actor.email, password: actor === owner ? 'fixture-password-1' : actor === member ? 'fixture-password-2' : 'fixture-password-3',
    })).status, 200);
    const exchange = await createExchange(crypto, forge);
    const blobs = await Promise.all(Array.from({ length: 3 }, () => call(owner._id, 'GET', '/api/media/blob/fixture-photo')));
    assert.deepEqual(blobs.map((r) => r.status), [200, 200, 200], 'same-second preview/viewer reads do not trip replay protection');
    assert.ok(blobs.every((r) => r.headers.get('cache-control').includes('no-store')));
    const requestBody = { loopId: loop._id, publicKey: exchange.publicKey };
    assert.equal((await call('anonymous', 'POST', '/api/loop-key/request', requestBody)).status, 401);
    assert.equal((await call(stranger._id, 'POST', '/api/loop-key/request', requestBody)).status, 404);
    assert.equal((await call(owner._id, 'POST', '/api/loop-key/request', { ...requestBody, privateKey: 'not-allowed' })).status, 400);
    assert.equal((await call(owner._id, 'POST', '/api/loop-key/request', { ...requestBody, publicKey: 'not-rsa' })).status, 400);
    assert.equal((await call(owner._id, 'POST', '/api/loop-key/request', requestBody, { origin: 'https://evil.fixture' })).status, 403);
    const requested = await call(owner._id, 'POST', '/api/loop-key/request', requestBody);
    assert.equal(requested.status, 200); assert.match(requested.headers.get('cache-control'), /no-store/);
    assert.equal(requested.body.encryptedKey, undefined);
    const id = requested.body.id;
    const raw = randomBytes(32);
    const encryptedKey = publicEncrypt({ key: Buffer.from(exchange.publicKey, 'base64'), format: 'der', type: 'spki',
      padding: constants.RSA_PKCS1_PADDING }, raw).toString('base64');
    assert.equal((await classicCall({ base: classicBase, account: robot, target: 'Key_20160201.Share',
      body: { id, encryptedKey } })).status, 200);
    const pollPath = `/api/loop-key/request?loopId=${loop._id}&id=${id}`;
    const response = await call(owner._id, 'GET', pollPath);
    assert.equal(response.status, 200); assert.deepEqual(Buffer.from(exchange.unwrap(response.body.encryptedKey)), raw);
    assert.equal((await call(member._id, 'GET', pollPath)).status, 404, 'sibling cannot read another browser request');
    assert.equal((await call(stranger._id, 'GET', pollPath)).status, 404);
    const memberRequest = await call(member._id, 'POST', '/api/loop-key/request', requestBody);
    assert.equal(memberRequest.status, 200, 'accepted members can obtain keys');
    loop.members.find((m) => m.accountId === member._id).status = 'invited'; store.flush();
    assert.equal((await call(member._id, 'GET', `/api/loop-key/request?loopId=${loop._id}&id=${memberRequest.body.id}`)).status, 404);
    loop.members.find((m) => m.accountId === member._id).status = 'accepted'; store.flush();
    assert.deepEqual((await call(owner._id, 'GET', `/api/loop-key/status?loopId=${loop._id}`)).body,
      { canManageRecovery: true, backupExists: false });
    assert.deepEqual((await call(member._id, 'GET', `/api/loop-key/status?loopId=${loop._id}`)).body,
      { canManageRecovery: false, backupExists: null });
    const backup = await encryptBackup(crypto, new Uint8Array(raw), 'a strong recovery passphrase');
    const backupBody = { loopId: loop._id, ...backup };
    assert.equal((await call(member._id, 'POST', '/api/loop-key/backup', backupBody)).status, 403);
    assert.equal((await call(owner._id, 'POST', '/api/loop-key/backup', { ...backupBody, passphrase: 'must-not-be-sent' })).status, 400);
    const concurrent = await Promise.all([call(owner._id, 'POST', '/api/loop-key/backup', backupBody),
      call(owner._id, 'POST', '/api/loop-key/backup', backupBody)]);
    assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 409]);
    assert.equal((await call(owner._id, 'GET', `/api/loop-key/status?loopId=${loop._id}`)).body.backupExists, true);
    const saved = readFileSync(keyStore.file, 'utf8');
    assert.equal(saved.includes(raw.toString('base64')), false); assert.equal(saved.includes('a strong recovery passphrase'), false);
    assert.equal((await call(owner._id, 'POST', '/api/robot/backup-key/current', {
      loopId: loop._id, passwordHash: createHash('sha1').update('incorrect').digest('hex'),
    })).status, 403);
    assert.equal((await call(owner._id, 'POST', '/api/robot/backup-key/current', {
      loopId: loop._id, passwordHash: backup.passwordHash,
    })).body.encryptedKey, backup.encryptedKey);
    // Keep original native Backup replace behavior for shipped app compatibility.
    const changed = await encryptBackup(crypto, new Uint8Array(raw), 'another strong passphrase');
    assert.equal((await classicCall({ base: classicBase, account: owner, target: 'Key_20160201.Backup',
      body: { loopId: loop._id, ...changed } })).status, 200);
    assert.equal(keyStore.restore(loop._id).encryptedKey, changed.encryptedKey);
    for (let i = 0; i < 23; i++) await call(owner._id, 'POST', '/api/loop-key/request', requestBody);
    assert.equal((await call(owner._id, 'POST', '/api/loop-key/request', requestBody)).status, 429);
    const asset = await fetch(base + '/api/crypto/forge.js');
    assert.equal(asset.status, 200); assert.match(asset.headers.get('content-type'), /javascript/);
  } finally {
    if (account?.listening) await new Promise((r) => account.close(r));
    if (classic?.listening) await new Promise((r) => classic.close(r));
    if (priorClassic === undefined) delete process.env.NET_classic; else process.env.NET_classic = priorClassic;
    rmSync(dir, { recursive: true, force: true });
  }
});
