import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
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
  let providerError = null;
  const provider = {
    async refreshToken() {
      calls.push('refresh');
      if (providerError) throw providerError;
      if (rejectRefresh) throw new Error('synthetic failure');
    },
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
        return { status: response.status, headers: response.headers, body: await response.json() };
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
      const setResponse = await post('SetLegalGuardian', input);
      assert.equal(setResponse.status, 200);
      assert.deepEqual(setResponse.body, { result: 'Command accepted' });
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
      for (const [op, invalidBody, identity] of [['UpdateAgreementStatus', null, null], ['SetLegalGuardian', null, owner]]) {
        const validationResponse = await post(op, invalidBody, identity);
        assert.equal(validationResponse.status, 422);
        assert.equal(validationResponse.headers.get('content-type'), 'application/json; charset=utf-8');
        assert.equal(validationResponse.headers.get('cache-control'), 'no-cache');
        assert.equal(validationResponse.headers.get('vary'), 'accept-encoding');
        assert.equal(validationResponse.headers.get('x-powered-by'), null);
        assert.equal(validationResponse.headers.get('keep-alive'), null);
      }
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
      providerError = Object.assign(new Error('synthetic provider status'), { statusCode: 418 });
      assert.equal((await post('SetLegalGuardian', input)).status, 418);
      providerError = null;
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

test('EchoSign default transport follows source Wreck body, MIME, form, and status boundaries', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({
        path: req.url,
        method: req.method,
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      });
      if (req.url === '/oauth/refresh') {
        res.setHeader('content-type', 'application/json; charset=utf-8');
        return res.end(JSON.stringify({ access_token: 'synthetic-access' }));
      }
      if (req.url === '/api/rest/v5/agreements/synthetic') {
        // Wreck's json:true returns a Buffer for this MIME, so isSigned is false.
        res.setHeader('content-type', 'text/plain');
        return res.end(JSON.stringify({ status: 'SIGNED' }));
      }
      if (req.url === '/empty') {
        res.setHeader('content-type', 'application/json');
        return res.end();
      }
      if (req.url === '/malformed') {
        res.setHeader('content-type', 'application/json');
        return res.end('{"status":');
      }
      if (req.url === '/truncated') {
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '20' });
        res.write('{"status":');
        return setImmediate(() => res.destroy());
      }
      res.statusCode = 418;
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ message: 'synthetic status' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const provider = new EchoSignProvider({
      adobe: {
        appId: "a b~!'()",
        appSecret: 'synthetic-secret',
        appRefreshToken: 'refresh+/=',
        agreementUrl: 'https://synthetic.invalid/agreement.pdf',
      },
      server: { portalUrl: 'https://synthetic.invalid' },
      baseUrl: `http://127.0.0.1:${server.address().port}`,
    });

    assert.equal(await provider.refreshToken(), 'synthetic-access');
    assert.equal(await provider.isSigned('synthetic'), false);
    await assert.rejects(provider.request('GET', '/status', null), (error) => error.statusCode === 418);
    assert.equal(await provider.request('GET', '/empty', null), null);
    await assert.rejects(provider.request('GET', '/malformed', null), (error) => error instanceof SyntaxError);
    await assert.rejects(provider.request('GET', '/truncated', null), (error) => error.statusCode === 500);

    assert.equal(seen[0].method, 'POST');
    assert.equal(seen[0].body,
      "client_id=a%20b~!'()&client_secret=synthetic-secret&grant_type=refresh_token&refresh_token=refresh%2B%2F%3D");
    assert.equal(seen[0].headers.connection, 'close');
    assert.equal(seen[1].method, 'GET');
    assert.equal(seen[1].body, '');
    assert.equal(seen[1].headers['content-length'], undefined);
    assert.equal(seen[1].headers.connection, 'close');
    assert.equal(seen[2].body, '');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
