import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';

import { createAccountService } from '../src/index.js';
import {
  createLoop,
  createOwnerAccount,
  deleteToken,
  findOrCreateRobotAccount,
  mintSetupToken,
} from '../src/model.js';
import { updatePhoto } from '../src/accountIdentity.js';
import { updateMemberPhoto } from '../src/loopMemberPhotos.js';
import { LoopUpdatedOutbox } from '../src/loopUpdatedOutbox.js';
import { Store } from '../src/store.js';

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test('token deletion restores memory when its durable flush fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phoenix-token-atomic-'));
  try {
    const file = join(directory, 'store.json');
    const store = new Store(file);
    const token = mintSetupToken(store, 'account-atomic');
    const originalFlush = store.flush.bind(store);
    store.flush = () => { throw new Error('synthetic disk failure'); };

    assert.throws(() => deleteToken(store, token._id), /synthetic disk failure/);
    assert.equal(store.tokens.has(token._id), true, 'failed consumption remains replay-protected in memory');

    store.flush = originalFlush;
    assert.equal(new Store(file).tokens.has(token._id), true, 'the committed token remains available after restart');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('loop creation commits its LoopUpdated row with the new loop', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phoenix-loop-atomic-'));
  try {
    const file = join(directory, 'store.json');
    const store = new Store(file);
    const owner = createOwnerAccount(store, { email: 'loop-atomic@example.test', password: 'ValidPass1' });
    const robot = findOrCreateRobotAccount(store, 'loop-atomic-robot');
    const outbox = new LoopUpdatedOutbox(store);
    const originalFlush = store.flush.bind(store);
    let flushes = 0;
    store.flush = () => {
      flushes += 1;
      if (flushes === 2) throw new Error('synthetic loop snapshot failure');
      return originalFlush();
    };

    assert.throws(
      () => createLoop(store, { owner, robotId: robot.friendlyId }, outbox),
      /synthetic loop snapshot failure/,
    );
    assert.equal(store.loops.size, 0, 'a rejected atomic create leaves no in-memory loop');
    assert.equal(outbox.pending().length, 0, 'a rejected atomic create leaves no in-memory event');
    assert.equal(new Store(file).loops.size, 0, 'a rejected atomic create leaves no durable loop');

    store.flush = originalFlush;
    const committed = createLoop(store, { owner, robotId: robot.friendlyId }, outbox);
    assert.equal(outbox.pending().length, 1);
    const reopened = new Store(file);
    assert.ok(reopened.loops.has(committed.loop._id));
    assert.equal(reopened.notificationOutbox.size, 1, 'the loop and event share one committed snapshot');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('OOBE setup does not persist a loop without its required LoopUpdated row', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phoenix-oobe-loop-atomic-'));
  let service;
  try {
    const file = join(directory, 'store.json');
    const store = new Store(file);
    const owner = createOwnerAccount(store, { email: 'oobe-atomic@example.test', password: 'ValidPass1' });
    const setup = mintSetupToken(store, owner._id);
    const originalFlush = store.flush.bind(store);
    let flushes = 0;
    store.flush = () => {
      flushes += 1;
      // claim, robot creation, and the compatibility robot re-read succeed;
      // the atomic loop+outbox snapshot is the next flush.
      if (flushes === 4) throw new Error('synthetic OOBE snapshot failure');
      return originalFlush();
    };
    service = await createAccountService({ store }).listen(0);
    const response = await fetch(`http://127.0.0.1:${service.address().port}/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': 'OOBE_20161026.SetupRobot',
        connection: 'close',
      },
      body: JSON.stringify({ token: setup._id, id: 'oobe-atomic-robot' }),
    });
    assert.equal(response.status, 500);
    store.flush = originalFlush;
    const reopened = new Store(file);
    assert.equal(reopened.loops.size, 0);
    assert.equal(reopened.notificationOutbox.size, 0);
    assert.equal(reopened.tokens.has(setup._id), true, 'failed setup releases the claimed token');
  } finally {
    await closeServer(service);
    await rm(directory, { recursive: true, force: true });
  }
});

test('account photo commit failure compensates the staged public object', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phoenix-account-photo-atomic-'));
  try {
    const file = join(directory, 'store.json');
    const store = new Store(file);
    const owner = createOwnerAccount(store, { email: 'photo-atomic@example.test', password: 'ValidPass1' });
    owner.photoUrl = 'https://photos.example.test/old-object';
    store.flush();
    const objects = new Set(['old-object']);
    const provider = {
      async createPublic({ path }) {
        objects.add(path);
        return { path, url: `https://photos.example.test/${path}` };
      },
      async remove(path) { objects.delete(path); },
    };
    const originalFlush = store.flush.bind(store);
    store.flush = () => { throw new Error('synthetic account snapshot failure'); };

    await assert.rejects(
      updatePhoto(store, {
        ownerId: owner._id,
        dataStream: Readable.from([Buffer.from('photo')]),
        photoProvider: provider,
        clock: () => 17,
      }),
      /synthetic account snapshot failure/,
    );
    assert.equal(store.accounts.get(owner._id).photoUrl, 'https://photos.example.test/old-object');
    assert.equal(new Store(file).accounts.get(owner._id).photoUrl, 'https://photos.example.test/old-object');
    assert.equal(objects.has('old-object'), true, 'the old object remains when metadata commit fails');
    assert.equal(objects.has(owner._id + '17'), false, 'the staged object is compensated');

    store.flush = originalFlush;
    const result = await updatePhoto(store, {
      ownerId: owner._id,
      dataStream: Readable.from([Buffer.from('photo')]),
      photoProvider: provider,
      clock: () => 18,
    });
    assert.equal(result.photoUrl, `https://photos.example.test/${owner._id}18`);
    assert.equal(objects.has('old-object'), false, 'old object is deleted only after the new metadata commits');
    assert.equal(objects.has(owner._id + '18'), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('member photo commit failure compensates the staged public object', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phoenix-member-photo-atomic-'));
  try {
    const file = join(directory, 'store.json');
    const store = new Store(file);
    const owner = createOwnerAccount(store, { email: 'member-photo-atomic@example.test', password: 'ValidPass1' });
    const { loop } = createLoop(store, { owner, robotId: 'member-photo-atomic-robot' });
    const memberId = 'member-photo-atomic-member';
    loop.members.push({
      _id: memberId,
      status: 'invited',
      memberProperties: { photoUrl: 'https://photos.example.test/old-member-object' },
      enrolled: { face: false, voice: false },
    });
    store.flush();
    const objects = new Set(['old-member-object']);
    const provider = {
      async createPublic({ path }) {
        objects.add(path);
        return { path, url: `https://photos.example.test/${path}` };
      },
      async remove(path) { objects.delete(path); },
    };
    const outbox = new LoopUpdatedOutbox(store);
    const originalFlush = store.flush.bind(store);
    store.flush = () => { throw new Error('synthetic member snapshot failure'); };

    await assert.rejects(
      updateMemberPhoto(store, {
        ownerId: owner._id,
        loopId: loop._id,
        id: memberId,
        dataStream: Readable.from([Buffer.from('photo')]),
      }, provider, outbox, () => 19),
      /synthetic member snapshot failure/,
    );
    assert.equal(store.loops.get(loop._id).members.find((member) => member._id === memberId).memberProperties.photoUrl,
      'https://photos.example.test/old-member-object');
    assert.equal(objects.has('old-member-object'), true);
    assert.equal(objects.has(memberId + '19'), false, 'the staged member object is compensated');
    const reopened = new Store(file);
    assert.equal(reopened.loops.get(loop._id).members.find((member) => member._id === memberId).memberProperties.photoUrl,
      'https://photos.example.test/old-member-object');
    assert.equal(reopened.notificationOutbox.size, 0);
    assert.equal(outbox.pending().length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('OTA redirects stay on the configured origin and drop Authorization on a follow-up', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phoenix-ota-redirect-'));
  let source;
  let destination;
  let account;
  const previousOta = process.env.NET_ota;
  try {
    const sourceRequests = [];
    const destinationRequests = [];
    let mode = 'same-origin';
    destination = http.createServer((req, res) => {
      destinationRequests.push({ method: req.method, authorization: req.headers.authorization || null });
      req.resume();
      req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"destination":true}'); });
    });
    const destinationBase = await listen(destination);
    source = http.createServer((req, res) => {
      sourceRequests.push({ url: req.url, method: req.method, authorization: req.headers.authorization || null });
      req.resume();
      req.on('end', () => {
        if (mode === 'same-origin' && req.url === '/') {
          res.writeHead(307, { location: '/target' });
          return res.end();
        }
        if (mode === 'cross-origin' && req.url === '/') {
          res.writeHead(302, { location: `${destinationBase}/target` });
          return res.end();
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"source":true}');
      });
    });
    const sourceBase = await listen(source);
    process.env.NET_ota = sourceBase;
    account = await createAccountService({ store: new Store(join(directory, 'store.json')) }).listen(0);
    const accountBase = `http://127.0.0.1:${account.address().port}`;

    const call = () => fetch(`${accountBase}/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-amz-target': 'Update_20160301.GetUpdateFrom',
        authorization: 'AWS4-HMAC-SHA256 Credential=synthetic-auth-marker',
        connection: 'close',
      },
      body: '{}',
    });

    const sameOrigin = await call();
    assert.equal(sameOrigin.status, 200);
    assert.deepEqual(sourceRequests.map(({ url, method, authorization }) => ({ url, method, authorization })), [
      { url: '/', method: 'POST', authorization: 'AWS4-HMAC-SHA256 Credential=synthetic-auth-marker' },
      { url: '/target', method: 'POST', authorization: null },
    ]);
    assert.deepEqual(destinationRequests, []);

    mode = 'cross-origin';
    sourceRequests.length = 0;
    const crossOrigin = await call();
    assert.equal(crossOrigin.status, 502);
    assert.deepEqual(destinationRequests, [], 'a redirect to another origin is rejected before contact');
  } finally {
    if (previousOta === undefined) delete process.env.NET_ota;
    else process.env.NET_ota = previousOta;
    await closeServer(account);
    await closeServer(source);
    await closeServer(destination);
    await rm(directory, { recursive: true, force: true });
  }
});

test('outbox publisher errors retain a safe code without credential-bearing text', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phoenix-outbox-private-'));
  try {
    const store = new Store(join(directory, 'store.json'));
    const outbox = new LoopUpdatedOutbox(store, {
      publisher: async () => {
        const error = new Error(
          `request https://user:opaqueOne@example.test/ota?access_token=opaqueTwo&accessKeyId=opaqueSeven&safe=yes `
          + 'Authorization: Bearer opaqueThree Credential=opaqueFour '
          + 'x-api-key=opaqueFive X-Amz-Signature=opaqueSix X-Amz-Security-Token=opaqueNine '
          + 'secretAccessKey=opaqueEight ' + 'x'.repeat(900),
        );
        error.code = 'ETIMEDOUT';
        throw error;
      },
    });
    outbox.record({ _id: 'private-loop', robot: 'private-robot', members: [] });
    await outbox.draining;

    const lastError = outbox.pending()[0].lastError;
    assert.match(lastError, /^ETIMEDOUT:/);
    assert.match(lastError, /request/);
    assert.ok(lastError.length <= 512, 'publisher diagnostics are bounded');
    for (const marker of ['opaqueOne', 'opaqueTwo', 'opaqueThree', 'opaqueFour', 'opaqueFive', 'opaqueSix', 'opaqueSeven', 'opaqueEight', 'opaqueNine']) {
      assert.doesNotMatch(lastError, new RegExp(marker));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
