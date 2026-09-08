// Source-shaped ListLoops payload validation over the real Account and Classic HTTP faces.
// Source: srv-account-ws@6cea434, LoopHandler.ListLoops (@validatePayload({ loopId: Joi.string() }))
// and @jibo/server@4.0.17 validate.ts (Joi 10.5.2, allowUnknown:true; validated value discarded).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccountService, Store } from '../src/index.js';
import { createOwnerAccount, createLoop } from '../src/model.js';
import { createClassicEntrypoint } from '../../classic/src/index.js';
import { signSigV4 } from '@phoenix/common';

const TARGET = 'Loop_20160324.ListLoops';

function signedHeaders(base, body, account) {
  return signSigV4({
    method: 'POST',
    path: '/',
    body,
    headers: {
      host: new URL(base).host,
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': TARGET,
    },
    accessKeyId: account.accessKeyId,
    secretAccessKey: account.secretAccessKey,
    region: 'global',
    service: 'jibo',
  }).headers;
}

async function post(base, body, account) {
  const response = await fetch(`${base}/`, {
    method: 'POST',
    headers: signedHeaders(base, body, account),
    body,
  });
  const raw = await response.text();
  return {
    status: response.status,
    raw,
    body: raw ? JSON.parse(raw) : null,
  };
}

function loopSnapshot(store) {
  return JSON.stringify([...store.loops].map(([id, loop]) => [id, JSON.parse(JSON.stringify(loop))]));
}

test('ListLoops preserves source object validation on Account and Classic faces', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-list-validation-'));
  const store = new Store(join(dir, 'account.json'));
  const owner = createOwnerAccount(store, {
    email: 'list-validation-owner@synthetic.invalid',
    password: 'synthetic-list-validation-password',
  });
  const first = createLoop(store, { owner, robotId: 'list-validation-robot-one' });
  const second = createLoop(store, { owner, robotId: 'list-validation-robot-two' });
  store.flush();

  const accountService = await createAccountService({ store }).listen(0);
  const previousNetAccount = process.env.NET_account;
  process.env.NET_account = `127.0.0.1:${accountService.address().port}`;
  const classicService = await createClassicEntrypoint({
    notificationFile: join(dir, 'notifications.json'),
    notificationPollIntervalMs: 60000,
  }).listen(0);

  // Count Map reads separately from the immutable state checks. A valid list
  // must read loops; invalid values must return from validation first.
  const rawLoops = store.loops;
  let loopReads = 0;
  store.loops = new Proxy(rawLoops, {
    get(target, property, receiver) {
      if (['entries', 'forEach', 'get', 'keys', 'values'].includes(property)) {
        const method = Reflect.get(target, property, target);
        return (...args) => {
          loopReads += 1;
          return method.apply(target, args);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });

  const invalidBodies = [
    ['null', '"value" must be an object'],
    ['[]', '"value" must be an object'],
    ['1', '"value" must be an object'],
    ['true', '"value" must be an object'],
    ['"text"', '"value" must be an object'],
    ['{"loopId":1}', 'child "loopId" fails because ["loopId" must be a string]'],
    ['{"loopId":null}', 'child "loopId" fails because ["loopId" must be a string]'],
    ['{"loopId":""}', 'child "loopId" fails because ["loopId" is not allowed to be empty]'],
  ];

  try {
    const beforeDisk = readFileSync(store.file);
    const beforeLoops = loopSnapshot({ ...store, loops: rawLoops });
    const beforeOutbox = JSON.stringify([...store.notificationOutbox]);

    for (const [face, service] of [
      ['account', accountService],
      ['classic', classicService],
    ]) {
      const base = `http://127.0.0.1:${service.address().port}`;
      for (const [rawBody, expectedMessage] of invalidBodies) {
        const readsBefore = loopReads;
        const result = await post(base, rawBody, owner);
        assert.equal(result.status, 422, `${face}:${rawBody}`);
        assert.equal(result.body.statusCode, 422, `${face}:${rawBody}:statusCode`);
        assert.equal(result.body.error, 'Unprocessable Entity', `${face}:${rawBody}:error`);
        assert.equal(result.body.message, expectedMessage, `${face}:${rawBody}:message`);
        assert.equal(loopReads, readsBefore, `${face}:${rawBody}:no loop read before validation`);
        assert.deepEqual(readFileSync(store.file), beforeDisk, `${face}:${rawBody}:disk unchanged`);
        assert.equal(loopSnapshot({ ...store, loops: rawLoops }), beforeLoops, `${face}:${rawBody}:loops unchanged`);
        assert.equal(JSON.stringify([...store.notificationOutbox]), beforeOutbox, `${face}:${rawBody}:outbox unchanged`);
      }

      const all = await post(base, '{}', owner);
      assert.equal(all.status, 200, `${face}:empty object`);
      assert.deepEqual(new Set(all.body.map((loop) => loop.id)), new Set([first.loop._id, second.loop._id]));
      assert.ok(loopReads > 0, `${face}:valid list reads loops`);

      // Joi allows unknown keys and the source decorator discards its converted
      // result; ListLoops itself only consumes the optional loopId field.
      const selected = await post(base, JSON.stringify({ loopId: first.loop._id, ignored: true }), owner);
      assert.equal(selected.status, 200, `${face}:valid optional loopId`);
      assert.deepEqual(selected.body.map((loop) => loop.id), [first.loop._id]);

      const absent = await post(base, JSON.stringify({ loopId: 'missing-list-validation-loop' }), owner);
      assert.equal(absent.status, 200, `${face}:valid missing loopId`);
      assert.deepEqual(absent.body, [], `${face}:valid missing loopId result`);
    }
  } finally {
    store.loops = rawLoops;
    await Promise.all([
      new Promise((resolve) => accountService.close(resolve)),
      new Promise((resolve) => classicService.close(resolve)),
    ]);
    if (previousNetAccount === undefined) delete process.env.NET_account;
    else process.env.NET_account = previousNetAccount;
    rmSync(dir, { recursive: true, force: true });
  }
});
