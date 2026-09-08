// Public security-gateway parity. All accounts and personal fields are invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccountService, Store } from '../src/index.js';
import { createOwnerAccount, createLoop } from '../src/model.js';
import { createClassicEntrypoint } from '../../classic/src/index.js';
import { signSigV4 } from '@phoenix/common';

test('Loop gateway authenticates before household reads, mutations, and validation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-loop-gateway-'));
  const store = new Store(join(dir, 'account.json'));
  const owner = createOwnerAccount(store, { email: 'owner@gateway-fixture.test', password: 'fixture-password' });
  const { loop, robot } = createLoop(store, { owner, robotId: 'gateway-fixture-robot' });
  const member = loop.members.find(member => member.accountId === robot._id);
  const account = await createAccountService({ store }).listen(0);
  const previousNet = process.env.NET_account;
  process.env.NET_account = `localhost:${account.address().port}`;
  const classic = await createClassicEntrypoint().listen(0);
  const cases = [
    ['ListLoops', {}],
    ['SetEnrollment', { loopId: loop._id, id: member._id, face: true }],
    ['UpdateNickname', { loopId: loop._id, id: member._id, nickname: 'Invented fixture nickname' }],
    ['SuspendLoop', { loopId: loop._id }],
    ['InviteLoopMember', { loopId: loop._id, firstName: 'Invented invitee' }],
    ['RemoveLoopMember', { loopId: loop._id, id: member._id }],
  ];
  try {
    for (const server of [account, classic]) {
      const base = `http://localhost:${server.address().port}`;
      async function post(body, headers) {
        const response = await fetch(base + '/', { method: 'POST', body, headers });
        return { status: response.status, body: await response.json() };
      }
      for (const [operation, payload] of cases) {
        const before = readFileSync(store.file);
        const beforeMemory = JSON.stringify([...store.loops]);
        const beforeOutbox = JSON.stringify(store.notificationOutbox);
        const body = JSON.stringify(payload);
        const headers = { host: new URL(base).host, 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'Loop_20160324.' + operation };
        const signed = secretAccessKey => signSigV4({ method: 'POST', path: '/', body, headers, accessKeyId: owner.accessKeyId, secretAccessKey, region: 'global', service: 'jibo' }).headers;
        const forged = await post(body, signed('invented-wrong-secret'));
        assert.equal(forged.status, 401, operation);
        assert.equal(forged.body.__type, 'SIGNATURE_MISMATCH');
        const anonymous = await post('null', { ...headers, 'x-amz-credentials': JSON.stringify({ id: owner._id, isAdmin: true }) });
        assert.equal(anonymous.status, 401, operation);
        assert.equal(anonymous.body.__type, 'MISSING_AUTH_HEADER');
        owner.isActive = false;
        try {
          const inactive = await post(body, signed(owner.secretAccessKey));
          assert.equal(inactive.status, 403);
          assert.equal(inactive.body.__type, 'ACCOUNT_NOT_ACTIVE');
        } finally { owner.isActive = true; }
        owner.isDeleted = true;
        try {
          const deleted = await post(body, signed(owner.secretAccessKey));
          assert.equal(deleted.status, 401, 'deleted active account is not an authentication identity');
        } finally { owner.isDeleted = false; }
        assert.deepEqual(readFileSync(store.file), before);
        assert.equal(JSON.stringify([...store.loops]), beforeMemory);
        assert.equal(JSON.stringify(store.notificationOutbox), beforeOutbox);
      }
      // A real signed robot can still retrieve its household through either face.
      const body = '{}';
      const headers = signSigV4({ method: 'POST', path: '/', body,
        headers: { host: new URL(base).host, 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'Loop_20160324.ListLoops' },
        accessKeyId: robot.accessKeyId, secretAccessKey: robot.secretAccessKey, region: 'global', service: 'jibo' }).headers;
      const result = await post(body, headers);
      assert.equal(result.status, 200);
      assert.equal(result.body[0].id, loop._id);
    }
  } finally {
    await Promise.all([account, classic].map(server => new Promise(resolve => server.close(resolve))));
    if (previousNet === undefined) delete process.env.NET_account;
    else process.env.NET_account = previousNet;
    rmSync(dir, { recursive: true, force: true });
  }
});
