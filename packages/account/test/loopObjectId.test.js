import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { createAccountService } from '../src/index.js';
import { createOwnerAccount, createLoop } from '../src/model.js';
import { idsEqual, isValidObjectIdString, mapGetById } from '../src/id.js';
import { signedLoopHeaders } from './fixtures/signedLoopRequest.js';

const OBJECT_ID = 'abcdefabcdefabcdefabcdef';

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function post(base, store, target, body, account) {
  const headers = signedLoopHeaders(store, base, target, body, account.accessKeyId);
  const response = await fetch(`${base}/`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const rawBody = Buffer.from(await response.arrayBuffer()).toString('utf8');
  let parsed;
  try { parsed = JSON.parse(rawBody); } catch (_) { parsed = undefined; }
  return { status: response.status, body: parsed, rawBody };
}

test('ObjectId equality is case-insensitive only for valid 24-hex IDs', () => {
  assert.equal(isValidObjectIdString(OBJECT_ID), true);
  assert.equal(isValidObjectIdString(OBJECT_ID.toUpperCase()), true);
  assert.equal(isValidObjectIdString('abcdefghijklmnopqrstuvwx'), false);
  assert.equal(isValidObjectIdString('abcdefghijkl'), false);
  assert.equal(idsEqual(OBJECT_ID, OBJECT_ID.toUpperCase()), true);
  assert.equal(idsEqual('friendly-robot', 'FRIENDLY-ROBOT'), false);
  assert.equal(idsEqual('abcdefghijkl', 'ABCDEFGHIJKL'), false);
  assert.equal(idsEqual('uuid-like-id-1', 'UUID-LIKE-ID-1'), false);

  const map = new Map([[OBJECT_ID, { id: OBJECT_ID }], ['friendly-robot', { id: 'friendly-robot' }]]);
  assert.equal(mapGetById(map, OBJECT_ID.toUpperCase()).id, OBJECT_ID);
  assert.equal(mapGetById(map, 'FRIENDLY-ROBOT'), undefined);
});

test('Loop handlers cast a valid uppercase ObjectId while preserving the wire string', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'phoenix-loop-objectid-'));
  let server;
  try {
    const store = new Store(join(directory, 'account.json'));
    const owner = createOwnerAccount(store, {
      email: 'objectid-owner@synthetic.invalid',
      password: 'synthetic-password',
      firstName: 'ObjectId',
    });
    const { loop, robot } = createLoop(store, { owner, robotId: 'objectid-friendly-robot' });
    // Use a deterministic valid ObjectId so the control always exercises a
    // case-changing query instead of relying on random hex containing a-f.
    const generatedId = loop._id;
    store.loops.delete(generatedId);
    loop._id = OBJECT_ID;
    store.loops.set(loop._id, loop);
    store.flush();

    const service = createAccountService({ store });
    server = await service.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    const upper = OBJECT_ID.toUpperCase();

    const update = await post(base, store, 'Loop_20160324.UpdateLoop', {
      loopId: upper,
      name: 'uppercase query loop',
    }, owner);
    assert.equal(update.status, 200);
    assert.deepEqual(update.body, { result: 'Command accepted' });
    assert.equal(store.loops.get(OBJECT_ID).name, 'uppercase query loop');

    const list = await post(base, store, 'Loop_20160324.ListLoops', { loopId: upper }, owner);
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].id, OBJECT_ID);

    const getRobot = await post(base, store, 'Loop_20160324.GetRobot', { loopId: upper }, owner);
    assert.equal(getRobot.status, 200);
    assert.deepEqual(getRobot.body, {
      accessKeyId: robot.accessKeyId,
      secretAccessKey: robot.secretAccessKey,
      friendlyId: robot.friendlyId,
    });

    const suspend = await post(base, store, 'Loop_20160324.SuspendLoop', { loopId: upper }, robot);
    assert.equal(suspend.status, 200);
    assert.deepEqual(suspend.body, { result: 'Command accepted' });
    assert.equal(store.loops.get(OBJECT_ID).isSuspended, true);
  } finally {
    if (server) await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});
