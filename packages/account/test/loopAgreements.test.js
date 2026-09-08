import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccountService, Store } from '../src/index.js';
import { createOwnerAccount, createLoop, newId } from '../src/model.js';
import { createClassicEntrypoint } from '../../classic/src/index.js';
import { signedLoopHeaders } from './fixtures/signedLoopRequest.js';
import { EchoSignProvider } from '../src/echoSignProvider.js';

test('guardian assignment and anonymous agreement confirmation preserve distinct source save effects', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-agreement-'));
  const store = new Store(join(dir, 'account.json'));
  const owner = createOwnerAccount(store, { email: 'agreement-owner@synthetic.invalid', password: 'invented-password', firstName: 'SyntheticGiven', lastName: 'SyntheticSurname' });
  // Source parent lookup needs stored account properties independently of portal creation defaults.
  Object.assign(owner, { firstName: 'SyntheticGiven', lastName: 'SyntheticSurname' });
  const { loop } = createLoop(store, { owner, robotId: 'synthetic-agreement-robot' });
  loop.updated = 123;
  const childId = newId();
  loop.members.push({ _id: childId, status: 'invited', isChild: true, memberProperties: {}, enrolled: { face: false, voice: false } });
  store.flush();
  const calls = [];
  let signed = false;
  let rejectRefresh = false;
  const provider = {
    async refreshToken() { calls.push('refresh'); if (rejectRefresh) throw new Error('synthetic failure'); },
    async send(...args) { calls.push(['send', ...args]); return 'synthetic-agreement-code'; },
    async isSigned(value) { calls.push(['signed', value]); return signed; },
  };
  const account = await createAccountService({ store, agreementProvider: provider }).listen(0);
  const previous = process.env.NET_account;
  process.env.NET_account = `127.0.0.1:${account.address().port}`;
  const classic = await createClassicEntrypoint({ notificationFile: join(dir, 'notifications.json'), notificationPollIntervalMs: 60000 }).listen(0);
  try {
    for (const server of [account, classic]) {
      const base = `http://127.0.0.1:${server.address().port}`;
      const post = async (op, body, identity = owner) => {
        const headers = signedLoopHeaders(store, base, `Loop_20160324.${op}`, body, identity?.accessKeyId);
        const response = await fetch(`${base}/`, { method: 'POST', headers, body: JSON.stringify(body) });
        return { status: response.status, body: await response.json() };
      };
      const input = { loopId: loop._id, childId, parentId: loop.members[0]._id };
      let current = store.loops.get(loop._id);
      current.members.find((member) => member._id === childId).status = 'invited';
      const timestamp = current.updated;
      const events = store.notificationOutbox.size;
      calls.length = 0;
      const parent = current.members[0];
      const expectFailure = async (body, code, identity = owner) => {
        const before = JSON.stringify([...store.loops]);
        const diskBefore = readFileSync(store.file);
        const count = calls.length;
        const response = await post('SetLegalGuardian', body, identity);
        assert.equal(response.body.__type, code);
        assert.equal(JSON.stringify([...store.loops]), before);
        assert.deepEqual(readFileSync(store.file), diskBefore);
        assert.equal(calls.length, count);
      };
      await expectFailure({ ...input, loopId: 'synthetic-missing-loop' }, 'LOOP_NOT_FOUND');
      await expectFailure(input, 'CAN_BE_ACCESSED_BY_OWNER', store.accounts.get(current.robot));
      current.isSuspended = true;
      await expectFailure(input, 'LOOP_SUSPENDED');
      current.isSuspended = false;
      await expectFailure({ ...input, childId: 'synthetic-missing-child' }, 'MEMBER_NOT_FOUND');
      const previousStatus = parent.status;
      parent.status = 'invited';
      await expectFailure(input, 'PARENT_MUST_BE_ACCEPTED');
      parent.status = previousStatus;
      const previousName = owner.lastName;
      owner.lastName = '';
      await expectFailure(input, 'PARENT_MUST_HAVE_EMAIL_AND_NAME');
      owner.lastName = previousName;
      assert.deepEqual(await post('SetLegalGuardian', input), { status: 200, body: { result: 'Command accepted' } });
      assert.deepEqual(calls, ['refresh', ['send', owner.email, owner.firstName, owner.lastName, 'Unknown Unknown']]);
      current = store.loops.get(loop._id);
      const child = current.members.find((member) => member._id === childId);
      assert.equal(child.legalGuardianId, input.parentId);
      assert.equal(child.agreementId, 'synthetic-agreement-code');
      assert.equal(current.updated, timestamp);
      assert.equal(store.notificationOutbox.size, events);
      const disk = readFileSync(store.file);
      signed = false;
      assert.equal((await post('UpdateAgreementStatus', { agreementId: child.agreementId }, null)).status, 200);
      assert.deepEqual(readFileSync(store.file), disk);
      signed = true;
      assert.equal((await post('UpdateAgreementStatus', { agreementId: child.agreementId }, null)).status, 200);
      assert.equal(store.loops.get(loop._id).members.find((member) => member._id === childId).status, 'accepted');
      assert.equal(store.notificationOutbox.size, events + 1);
      assert.notEqual(store.loops.get(loop._id).updated, timestamp);
      assert.equal((await post('UpdateAgreementStatus', { agreementId: child.agreementId }, null)).body.__type, 'AGREEMENT_NOT_FOUND');
      assert.equal((await post('UpdateAgreementStatus', null, null)).status, 422);
      assert.equal((await post('SetLegalGuardian', null)).status, 422);
      const beforeFailure = readFileSync(store.file);
      rejectRefresh = true;
      assert.equal((await post('SetLegalGuardian', input)).status, 500);
      assert.deepEqual(readFileSync(store.file), beforeFailure);
      rejectRefresh = false;
      const originalFlush = store.flush;
      const beforeStore = JSON.stringify([...store.loops]);
      store.flush = () => { throw new Error('synthetic flush failure'); };
      assert.equal((await post('SetLegalGuardian', input)).status, 500);
      assert.equal(JSON.stringify([...store.loops]), beforeStore);
      store.flush = originalFlush;
    }
  } finally {
    await Promise.all([account, classic].map((server) => new Promise((resolve) => server.close(resolve))));
    if (previous === undefined) delete process.env.NET_account;
    else process.env.NET_account = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('EchoSign provider keeps refresh/send/status protocol and tolerates user-creation failure', async () => {
  const calls = [];
  const provider = new EchoSignProvider({
    adobe: { appId: 'synthetic-app', appSecret: 'synthetic-secret', appRefreshToken: 'synthetic-refresh', agreementUrl: 'https://synthetic.invalid/agreement.pdf' },
    server: { portalUrl: 'https://synthetic.invalid' },
    requestImpl: async (url, options) => {
      calls.push({ url, ...options });
      if (url.endsWith('/users')) throw new Error('synthetic existing user');
      return { ok: true, json: async () => url.endsWith('/oauth/refresh') ? { access_token: 'synthetic-access' }
        : options.method === 'GET' ? { status: 'SIGNED' } : { agreementId: 'synthetic-agreement' } };
    },
  });
  await provider.refreshToken();
  assert.equal(await provider.send('guardian@synthetic.invalid', 'SyntheticGiven', 'SyntheticSurname', 'SyntheticChild'), 'synthetic-agreement');
  assert.equal(await provider.isSigned('synthetic-agreement'), true);
  assert.deepEqual(calls.map((call) => [call.method, new URL(call.url).pathname]), [
    ['POST', '/oauth/refresh'], ['POST', '/api/rest/v5/users'], ['POST', '/api/rest/v5/agreements'], ['GET', '/api/rest/v5/agreements/synthetic-agreement'],
  ]);
  assert.equal(new URLSearchParams(calls[0].body).get('grant_type'), 'refresh_token');
  assert.equal(calls[3].body, 'null');
  assert.equal(calls[3].headers['access-token'], 'synthetic-access');
  const document = JSON.parse(calls[2].body).documentCreationInfo;
  assert.equal(document.callbackInfo, 'https://synthetic.invalid/callback');
  assert.equal(document.mergeFieldInfo[2].defaultValue, 'SyntheticChild');
  assert.equal(document.postSignOptions.redirectUrl, 'https://synthetic.invalid/signed');
  await assert.rejects(new EchoSignProvider().refreshToken(), { code: 'ECHO_SIGN_UNAVAILABLE' });
});
