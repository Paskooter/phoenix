import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, PassThrough } from 'node:stream';
import { makeKeyHandler, accountMembership } from '../src/key.js';
import { VERIFIED_CALLER } from '../src/caller.js';
import { removeMember, declineInvitation } from '../../account/src/loopMembership.js';
import { createAccountService, LoopUpdatedOutbox } from '../../account/src/index.js';
import { createClassicEntrypoint, KeyStore, MediaStore } from '../src/index.js';
import {
  setEnv, signedAmz, signedFetch, storeCallerBoundary, syntheticAccount, writeSyntheticAccountStore,
} from './fixtures/signedClassic.js';

const LOOP = 'accepted-loop';
const OWNER = syntheticAccount('accepted-owner');
const ROBOT = syntheticAccount('accepted-robot');
const MEMBER = syntheticAccount('accepted-member');

async function fixture(t, status = 'accepted') {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-accepted-members-'));
  const accounts = writeSyntheticAccountStore(join(dir, 'accounts.json'), {
    accounts: [OWNER, ROBOT, MEMBER],
    loops: [{ _id: LOOP, owner: OWNER._id, robot: ROBOT._id, isDeleted: false,
      members: [OWNER, ROBOT, MEMBER].map((account, index) => ({
        _id: `member-${index}`, accountId: account._id, status: account === MEMBER ? status : 'accepted',
      })) }],
  });
  const accountServer = await createAccountService({ store: accounts }).listen(0);
  const restore = setEnv({
    NET_account: `127.0.0.1:${accountServer.address().port}`,
    ETCO_account_internalPeerToken: 'synthetic-accepted-peer',
  });
  const keys = new KeyStore(join(dir, 'keys.json'));
  const media = new MediaStore({ directory: join(dir, 'objects'), file: join(dir, 'media.json') });
  await media.putObject({ path: 'accepted-photo', type: 'image', accountId: OWNER._id, loopId: LOOP,
    created: 1, meta: {}, thumbs: [], isDeleted: false }, Readable.from(['synthetic-photo-bytes']));
  const classic = await createClassicEntrypoint({
    publicUrl: 'https://synthetic.example.test', callerBoundary: storeCallerBoundary(accounts),
    keyStore: keys, keyBinaryDir: join(dir, 'binaries'), media: { store: media },
    notificationFile: join(dir, 'notifications.json'),
    backup: { dir: join(dir, 'backups'), bearerSecret: 'synthetic-accepted-backup' },
  }).listen(0);
  const base = `http://127.0.0.1:${classic.address().port}`;
  t.after(async () => {
    classic.closeAllConnections();
    accountServer.closeAllConnections();
    await Promise.all([classic, accountServer].map(server => new Promise(resolve => server.close(resolve))));
    restore();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    accounts, keys, media, dir, base,
    state(value) { accounts.loops.get(LOOP).members[2].status = value; accounts.flush(); },
    key(op, body, caller = MEMBER) { return signedAmz(base, `Key_20160201.${op}`, body, caller); },
    list() { return signedAmz(base, 'Media_20160725.List', { loopIds: [LOOP] }, MEMBER); },
    getMedia() { return signedAmz(base, 'Media_20160725.Get', { paths: ['accepted-photo'] }, MEMBER); },
    blob() { return signedFetch(`${base}/media/blob/accepted-photo`, { method: 'GET', credentials: MEMBER }); },
    seed(publicKey = 'synthetic-public') { return keys.create({ accountId: MEMBER._id, loopId: LOOP, publicKey }); },
    seedBinary(encryptedUrl = 'https://synthetic.example.test/encrypted.jpg') {
      return keys.createBinary({ accountId: MEMBER._id, loopId: LOOP, encryptedUrl });
    },
    async shareBinary(id, caller = ROBOT) {
      const res = await signedFetch(`${base}/`, { credentials: caller, body: 'synthetic-binary-bytes',
        headers: { 'x-amz-target': 'Key_20160201.ShareBinary', 'x-id': id,
          'content-type': 'application/octet-stream' } });
      return { status: res.status, body: await res.json() };
    },
    binaryUrl(binary) { return `${base}/key/binary?accountId=${ROBOT._id}&id=${binary.id}`; },
    seedBinaryBytes(binary) {
      mkdirSync(join(dir, 'binaries', ROBOT._id), { recursive: true });
      writeFileSync(join(dir, 'binaries', ROBOT._id, `${binary.id}.jpg`), 'synthetic-binary-bytes');
      keys.setBinaryDecryptedUrl(binary.id, this.binaryUrl(binary));
    },
  };
}

for (const status of ['invited', 'declined', 'removed', 'accepted', 'ACCEPTED']) {
  const allowed = status.toLowerCase() === 'accepted';
  test(`Key and Media require accepted membership: ${status}`, async (t) => {
    const f = await fixture(t, status);
    await t.test('CreateRequest', async () => {
      const reply = await f.key('CreateRequest', { loopId: LOOP, publicKey: 'create-public' });
      assert.equal(reply.status, allowed ? 200 : 403, 'CreateRequest requires accepted membership');
    });
    await t.test('ListIncomingRequests', async () => {
      const pending = f.seed('incoming-public');
      const reply = await f.key('ListIncomingRequests', { loopId: LOOP }, ROBOT);
      assert.equal(reply.status, 200);
      assert.equal(reply.body.some(row => row.id === pending.id), allowed, 'incoming requests require accepted requesters');
    });
    await t.test('Share', async () => {
      const pending = f.seed('share-public');
      const reply = await f.key('Share', { id: pending.id, encryptedKey: 'synthetic-envelope' }, ROBOT);
      assert.equal(reply.status, allowed ? 200 : 403, 'Share requires an accepted requester');
      if (!allowed) assert.equal(f.keys.get(pending.id)?.encryptedKey, undefined);
    });
    await t.test('GetRequest', async () => {
      const key = f.seed('get-public');
      f.keys.share(key.id, 'synthetic-envelope');
      const reply = await f.key('GetRequest', { id: key.id });
      assert.equal(reply.status, allowed ? 200 : 403, 'GetRequest requires current accepted membership');
      assert.equal(reply.body.encryptedKey, allowed ? 'synthetic-envelope' : undefined);
    });
    await t.test('binary requests', async () => {
      const res = await signedFetch(`${f.base}/binaryRequest`, { credentials: MEMBER,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ loopId: LOOP, encryptedUrl: 'https://synthetic.example.test/create.jpg' }) });
      assert.equal(res.status, allowed ? 200 : 403, 'binary requests require accepted membership');
      await res.text();
    });
    await t.test('ListBinaryRequests', async () => {
      const binary = f.seedBinary();
      const reply = await f.key('ListBinaryRequests', { loopId: LOOP }, ROBOT);
      assert.equal(reply.status, 200);
      assert.equal(reply.body.some(row => row.id === binary.id), allowed);
    });
    await t.test('ShareBinary', async () => {
      const binary = f.seedBinary('https://synthetic.example.test/share.jpg');
      const reply = await f.shareBinary(binary.id);
      assert.equal(reply.status, allowed ? 200 : 403, 'ShareBinary requires an accepted requester');
      if (!allowed) assert.equal(reply.body.decryptedUrl, undefined);
    });
    await t.test('binary bytes', async () => {
      const binary = f.seedBinary('https://synthetic.example.test/get.jpg');
      f.seedBinaryBytes(binary);
      const res = await signedFetch(f.binaryUrl(binary), { method: 'GET', credentials: MEMBER });
      assert.equal(res.status, allowed ? 200 : 403, 'binary bytes require current accepted membership');
      assert.equal(await res.text(), allowed ? 'synthetic-binary-bytes' : 'forbidden');
    });
    await t.test('Media.List', async () => {
      const reply = await f.list();
      assert.equal(reply.status, allowed ? 200 : 403, 'Media.List requires accepted membership');
      if (allowed) assert.equal(reply.body[0].path, 'accepted-photo');
    });
    await t.test('Media blob', async () => {
      const reply = await f.blob();
      assert.equal(reply.status, allowed ? 200 : 403, 'Media bytes require accepted membership');
      assert.equal(await reply.text(), allowed ? 'synthetic-photo-bytes' : 'forbidden');
    });
  });
}

test('Key and Media recheck membership after request creation', async (t) => {
  const f = await fixture(t);
  const pending = await f.key('CreateRequest', { loopId: LOOP, publicKey: 'pending-public' });
  const completed = await f.key('CreateRequest', { loopId: LOOP, publicKey: 'completed-public' });
  const shared = await f.key('Share', { id: completed.body.id, encryptedKey: 'synthetic-envelope' }, ROBOT);
  assert.equal(shared.status, 200);
  const binary = f.seedBinary('https://synthetic.example.test/completed.jpg');
  assert.equal((await f.shareBinary(binary.id)).status, 200);
  f.state('removed');
  await t.test('Share uses current membership', async () => {
    const reply = await f.key('Share', { id: pending.body.id, encryptedKey: 'fresh-envelope' }, ROBOT);
    assert.equal(reply.status, 403, 'Share rechecks the requester membership');
    assert.equal(f.keys.get(pending.body.id)?.encryptedKey, undefined);
  });
  await t.test('GetRequest uses current membership', async () => {
    const reply = await f.key('GetRequest', { id: completed.body.id });
    assert.equal(reply.status, 403, 'GetRequest rechecks the requester membership');
    assert.equal(reply.body.encryptedKey, undefined);
  });
  await t.test('binary reads use current membership', async () => {
    const reply = await signedFetch(f.binaryUrl(binary), { method: 'GET', credentials: MEMBER });
    assert.equal(reply.status, 403, 'binary reads recheck the requester membership');
    assert.equal(await reply.text(), 'forbidden');
  });
  await t.test('Media reads use current membership', async () => {
    assert.equal((await f.list()).status, 403);
    assert.equal((await f.getMedia()).status, 403);
    const reply = await f.blob();
    assert.equal(reply.status, 403);
    assert.equal(await reply.text(), 'forbidden');
  });
});

test('Key and Media fail closed when the Account peer is unavailable', async (t) => {
  const f = await fixture(t);
  const pending = f.seed();
  f.keys.share(pending.id, 'synthetic-envelope');
  process.env.ETCO_account_internalPeerToken = 'synthetic-different-peer';
  // The Account server reads its token on each request; use an absent peer route instead.
  process.env.NET_account = `${f.base}/unavailable-peer`;
  for (const [op, body, caller] of [
    ['CreateRequest', { loopId: LOOP, publicKey: 'another-public' }, MEMBER],
    ['GetRequest', { id: pending.id }, MEMBER],
    ['Share', { id: pending.id, encryptedKey: 'fresh-envelope' }, ROBOT],
    ['ListIncomingRequests', { loopId: LOOP }, ROBOT],
  ]) await t.test(op, async () => {
    const reply = await f.key(op, body, caller);
    assert.equal(reply.status, 503, `${op} requires an available Account peer`);
    assert.equal(reply.body.encryptedKey, undefined);
  });
  assert.equal((await f.list()).status, 503);
  const blob = await f.blob();
  assert.equal(blob.status, 403);
  assert.equal(await blob.text(), 'forbidden');
});

for (const status of ['removed', 'declined']) test(`pending requests follow current membership: ${status}`, async (t) => {
  const f = await fixture(t);
  const key = f.seed();
  const binary = f.seedBinary();
  const retained = f.keys.create({ accountId: OWNER._id, loopId: LOOP, publicKey: 'owner-public' });
  const completed = f.seed('completed-public');
  f.keys.share(completed.id, 'retained-envelope');
  if (status === 'removed') {
    await removeMember(f.accounts, { ownerId: OWNER._id, loopId: LOOP, id: 'member-2' }, new LoopUpdatedOutbox(f.accounts));
  } else {
    await declineInvitation(f.accounts, { loopId: LOOP, accountId: MEMBER._id }, new LoopUpdatedOutbox(f.accounts));
  }
  await f.key('ListIncomingRequests', { loopId: LOOP }, ROBOT);
  assert.equal(f.keys.get(key.id), null, 'pending key requests are invalidated on membership refresh');
  assert.equal(f.keys.getBinary(binary.id), null, 'pending binary requests are invalidated on membership refresh');
  const reopened = new KeyStore(f.keys.file);
  assert.equal(reopened.get(key.id), null, 'pending key invalidation is durable');
  assert.equal(reopened.getBinary(binary.id), null, 'pending binary invalidation is durable');
  assert.ok(reopened.get(retained.id), 'other accepted members retain their pending requests');
  assert.equal(reopened.get(completed.id).encryptedKey, 'retained-envelope', 'completed keys are not rotated');
});

test('binary completion rechecks membership after writing the stream', async (t) => {
  const f = await fixture(t);
  const binary = f.seedBinary();
  const req = Readable.from((async function* () {
    yield Buffer.from('synthetic-first-chunk');
    f.state('removed');
    yield Buffer.from('synthetic-last-chunk');
  })());
  req.headers = { 'x-id': binary.id };
  const caller = { accountId: ROBOT._id };
  Object.defineProperty(caller, VERIFIED_CALLER, { value: true });
  req[VERIFIED_CALLER] = caller;
  const res = new PassThrough();
  let status = 200;
  const chunks = [];
  res.writeHead = (value) => { status = value; return res; };
  res.setHeader = () => {};
  res.on('data', chunk => chunks.push(chunk));
  const ended = new Promise(resolve => res.on('end', resolve));
  await makeKeyHandler(f.keys, { callerBoundary: true, membership: accountMembership(),
    baseFor: 'https://synthetic.example.test', binaryDir: join(f.dir, 'binaries') })({ req, res, op: 'ShareBinary' });
  await ended;
  assert.equal(status, 403, 'binary completion requires current accepted membership');
  assert.equal(JSON.parse(Buffer.concat(chunks)).decryptedUrl, undefined);
  assert.equal(f.keys.getBinary(binary.id)?.decryptedUrl, undefined);
  assert.equal(existsSync(join(f.dir, 'binaries', ROBOT._id, `${binary.id}.jpg`)), false,
    'unpublished binary bytes are discarded');
});

test('deleted loops do not authorize Key or Media reads and completions', async (t) => {
  const f = await fixture(t);
  const key = f.seed();
  f.keys.share(key.id, 'synthetic-envelope');
  const binary = f.seedBinary();
  f.seedBinaryBytes(binary);
  f.accounts.loops.get(LOOP).isDeleted = true;
  f.accounts.flush();
  for (const [op, body, caller] of [
    ['CreateRequest', { loopId: LOOP, publicKey: 'another-public' }, MEMBER],
    ['GetRequest', { id: key.id }, MEMBER],
    ['Share', { id: key.id, encryptedKey: 'fresh-envelope' }, ROBOT],
    ['ListIncomingRequests', { loopId: LOOP }, ROBOT],
  ]) {
    const reply = await f.key(op, body, caller);
    assert.ok(reply.status === 403 || reply.status === 503, `${op} requires a non-deleted loop`);
    assert.equal(reply.body.encryptedKey, undefined);
  }
  assert.equal((await f.shareBinary(binary.id)).status, 503);
  const bytes = await signedFetch(f.binaryUrl(binary), { method: 'GET', credentials: MEMBER });
  assert.equal(bytes.status, 403, 'binary reads require a non-deleted loop');
  assert.equal(await bytes.text(), 'forbidden');
  assert.equal((await f.list()).status, 503);
  assert.equal((await f.getMedia()).status, 403);
  const blob = await f.blob();
  assert.equal(blob.status, 403);
  assert.equal(await blob.text(), 'forbidden');
});
