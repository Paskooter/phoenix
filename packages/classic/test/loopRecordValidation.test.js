// A-04 primitive payload boundary through the public Classic proxy.
// The upstream Account service owns Loop state; this test verifies that the
// Classic entrypoint preserves parsed primitive JSON long enough for that
// source-shaped validator to reject it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, createAccountService, model } from '@phoenix/account';
import { signSigV4 } from '@phoenix/common';
import { createClassicEntrypoint } from '../src/index.js';

function signedRequest(account, target, body) {
  return signSigV4({
    method: 'POST',
    path: '/',
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': target,
    },
    body,
    accessKeyId: account.accessKeyId,
    secretAccessKey: account.secretAccessKey,
    region: 'global',
    service: 'jibo',
  });
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function request(base, target, body, account, raw = false) {
  const serialized = raw ? body : JSON.stringify(body);
  const signed = account ? signedRequest(account, target, serialized) : null;
  const response = await fetch(`${base}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': target,
      ...(signed ? {
        authorization: signed.authorization,
        'x-amz-date': signed.headers['X-Amz-Date'],
      } : {}),
    },
    body: serialized,
  });
  const rawBody = await response.text();
  let parsed;
  try { parsed = JSON.parse(rawBody); } catch (_) { parsed = undefined; }
  return { status: response.status, body: parsed, rawBody };
}

test('Classic proxy preserves Loop record primitive bodies and ClearRobot auth ordering', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-a04-classic-loop-record-'));
  const oldAccount = process.env.NET_account;
  let accountServer;
  let classicServer;
  try {
    const store = new Store(join(dir, 'account.json'));
    const owner = model.createOwnerAccount(store, {
      email: 'classic-loop-owner@synthetic.invalid',
      password: 'owner-password',
      firstName: 'Classic',
      lastName: 'Owner',
    });
    const admin = model.createOwnerAccount(store, {
      email: 'classic-loop-admin@synthetic.invalid',
      password: 'admin-password',
      firstName: 'Classic',
      lastName: 'Admin',
    });
    admin.isAdmin = true;
    store.flush();
    const { loop, robot } = model.createLoop(store, { owner, robotId: 'classic-loop-robot' });

    const account = createAccountService({ store });
    accountServer = await account.listen(0);
    process.env.NET_account = `127.0.0.1:${accountServer.address().port}`;
    const classic = createClassicEntrypoint({ notificationPollIntervalMs: -1 });
    classicServer = await classic.listen(0);
    const base = `http://127.0.0.1:${classicServer.address().port}`;

    const primitiveBodies = [null, 'not-an-object', 7, []];
    for (const operation of ['UpdateLoop', 'RemoveLoop']) {
      for (const body of primitiveBodies) {
        const result = await request(base, `Loop_20160324.${operation}`, body, owner);
        assert.equal(result.status, 422, `${operation} ${JSON.stringify(body)}`);
        assert.equal(result.body.message, '"value" must be an object');
      }
    }
    for (const body of primitiveBodies) {
      const result = await request(base, 'Loop_20160324.ClearRobot', body, admin);
      assert.equal(result.status, 422, `ClearRobot ${JSON.stringify(body)}`);
      assert.equal(result.body.message, '"value" must be an object');
    }

    const unauthorised = await request(base, 'Loop_20160324.ClearRobot', null, owner);
    assert.equal(unauthorised.status, 401);
    assert.equal(unauthorised.body.__type, 'AUTHORIZED_UNDER_ADMIN');

    const malformed = await request(base, 'Loop_20160324.UpdateLoop', '{', owner, true);
    assert.equal(malformed.status, 400);
    assert.equal(store.loops.get(loop._id).isDeleted, undefined);
    assert.equal(store.loops.get(loop._id).robot, robot._id);
  } finally {
    await closeServer(classicServer);
    await closeServer(accountServer);
    if (oldAccount === undefined) delete process.env.NET_account;
    else process.env.NET_account = oldAccount;
    rmSync(dir, { recursive: true, force: true });
  }
});
