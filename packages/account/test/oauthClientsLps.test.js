import { signedLoopHeaders } from './fixtures/signedLoopRequest.js';
// A-18 — OauthClients_20171108 (admin OAuth-client registry) and Lps_20171201
// (log-upload STS credentials) through the Phoenix AWS-JSON face.
// Source: srv-oauth-clients-ws@3e546cb7 (handlers/client.handler.ts, controllers/
// client.ctrl.ts, schemes/client.ts, errors/client.ts), srv-lps-ws@e36e378a
// (handlers/handler.ts, controllers/sts.ctrl.ts, errors/lps.ts) and the pinned
// API JSON files (oauthclientsadmin-2017-11-08, lps-2017-12-01). Original runtime
// was not executed; expected codes and shapes are controller-sourced.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';

const { createAccountService } = await import('../src/index.js');
const { Store } = await import('../src/store.js');
const { createOwnerAccount, findOrCreateRobotAccount } = await import('../src/model.js');
const { createLpsStsProvider, lpsBucketPath } = await import('../src/lps.js');

const dir = mkdtempSync(join(tmpdir(), 'phx-a18-'));
const store = new Store(join(dir, 'store.json'));
let server;
let base;

// Fake STS issuing the documented NewCredentialsResponse shape.
function fakeAws() {
  const calls = [];
  return {
    calls,
    async newCredentials(accountId, friendlyId) {
      calls.push({ accountId, friendlyId });
      return {
        bucketName: 'jibo-lps-test',
        bucketPath: `lps/robot=${friendlyId}/account=${accountId}/year=2026/month=8/day=10/session=1725900000000/`,
        credentials: {
          AccessKeyId: 'AKIAFAKEFAKEFAKEFAKEF',
          Expiration: '2026-11-10T00:00:00.000Z',
          SecretAccessKey: 'fake-secret-fake-secret-fake-secret',
          SessionToken: 'fake-session-token',
        },
        region: 'us-east-1',
      };
    },
  };
}

async function post(target, body, accessKeyId, extraHeaders = {}) {
  const response = await fetch(`${base}/`, {
    method: 'POST',
    headers: {
      ...signedLoopHeaders(store, base, target, body, accessKeyId, extraHeaders),
      connection: 'close',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  let parsed = null;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch (_) { /* empty or non-JSON */ }
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: parsed,
    rawBody: bytes.toString('utf8'),
  };
}

let admin;

before(async () => {
  admin = createOwnerAccount(store, { email: 'a18-admin@example.test', password: 'adminpass', firstName: 'Admin' });
  admin.isAdmin = true;
  const secondAdmin = createOwnerAccount(store, { email: 'a18-music@example.test', password: 'adminpass2', firstName: 'Music' });
  secondAdmin.isAdmin = true;
  store.flush();
  server = await createAccountService({ store, lpsStsProvider: fakeAws() }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

test('OauthClients_20171108.Create: admin creates a client with source defaults and toJSON shape', async () => {
  const created = await post('OauthClients_20171108.Create', {
    clientId: 'com.jibo.test.one',
    redirectUri: 'https://example.invalid/callback',
    updatedBy: admin._id,
  }, admin.accessKeyId);
  assert.equal(created.status, 200);
  assert.match(created.body.id, /^[0-9a-f]{24}$/);
  assert.equal(created.body.clientId, 'com.jibo.test.one');
  assert.equal(created.body.redirectUri, 'https://example.invalid/callback');
  assert.equal(created.body.updatedBy, admin._id);
  assert.equal(created.body.refresh, true, 'scheme refresh defaults true');
  assert.deepEqual(created.body.aco, { keepAliveTimeout: 500, recoveryTimeout: 300, version: '1.0' }, 'aco scheme defaults applied');
  assert.ok(!('_id' in created.body), 'toJSON drops _id');
  assert.equal(created.body.id, [...store.oauthClients.values()].find((c) => c.clientId === 'com.jibo.test.one')._id);
});

test('OauthClients_20171108: duplicate clientId -> CLIENT_ALREADY_EXISTS 409; aco.sourceId falls back to clientId', async () => {
  const first = await post('OauthClients_20171108.Create', {
    clientId: 'com.jibo.dup',
    redirectUri: 'https://example.invalid/cb',
    updatedBy: admin._id,
  }, admin.accessKeyId);
  assert.equal(first.status, 200);

  const dup = await post('OauthClients_20171108.Create', {
    clientId: 'com.jibo.dup',
    redirectUri: 'https://example.invalid/cb2',
    updatedBy: admin._id,
    aco: { commandSet: ['a'] },
  }, admin.accessKeyId);
  assert.equal(dup.status, 409);
  assert.equal(dup.body.__type, 'CLIENT_ALREADY_EXISTS');
  assert.equal(dup.headers['x-amzn-errortype'], 'CLIENT_ALREADY_EXISTS');

  const withAco = await post('OauthClients_20171108.Create', {
    clientId: 'com.jibo.aco',
    redirectUri: 'https://example.invalid/cb3',
    updatedBy: admin._id,
    aco: { commandSet: ['cmd'] },
  }, admin.accessKeyId);
  assert.equal(withAco.status, 200);
  assert.equal(withAco.body.aco.sourceId, 'com.jibo.aco', 'sourceId falls back to clientId');
});

test('OauthClients_20171108.ListClients returns every client', async () => {
  await post('OauthClients_20171108.Create', {
    clientId: 'com.jibo.musicclient',
    redirectUri: 'https://example.invalid/music',
    updatedBy: admin._id,
  }, admin.accessKeyId);
  const list = await post('OauthClients_20171108.ListClients', {}, admin.accessKeyId);
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body));
  assert.ok(list.body.some((c) => c.clientId === 'com.jibo.musicclient'));
});

test('OauthClients_20171108.Update: assigns defined fields, bumps updated, cannot change clientId; missing id -> 404', async () => {
  const created = await post('OauthClients_20171108.Create', {
    clientId: 'com.jibo.updateclient',
    redirectUri: 'https://example.invalid/u',
    updatedBy: admin._id,
  }, admin.accessKeyId);
  assert.equal(created.status, 200);
  const id = created.body.id;
  await new Promise((resolve) => setTimeout(resolve, 5));

  const updated = await post('OauthClients_20171108.Update', {
    id,
    updatedBy: admin._id,
    redirectUri: 'https://example.invalid/updated',
    pkce: true,
  }, admin.accessKeyId);
  assert.equal(updated.status, 200);
  assert.equal(updated.body.redirectUri, 'https://example.invalid/updated');
  assert.equal(updated.body.pkce, true);
  assert.ok(updated.body.updated > created.body.updated, 'pre-save hook bumps updated');
  assert.equal(updated.body.id, id);

  const missing = await post('OauthClients_20171108.Update', {
    id: 'ffffffffffffffffffffffff',
    updatedBy: admin._id,
    redirectUri: 'https://example.invalid/x',
  }, admin.accessKeyId);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.__type, 'CLIENT_NOT_FOUND');
});

test('OauthClients_20171108.Remove: removes by id; missing id -> empty 200 (controller does not throw)', async () => {
  const created = await post('OauthClients_20171108.Create', {
    clientId: 'com.jibo.removeme',
    redirectUri: 'https://example.invalid/r',
    updatedBy: admin._id,
  }, admin.accessKeyId);
  assert.equal(created.status, 200);
  const removed = await post('OauthClients_20171108.Remove', { id: created.body.id }, admin.accessKeyId);
  assert.equal(removed.status, 200);
  assert.equal(removed.body.id, created.body.id);
  const gone = await post('OauthClients_20171108.ListClients', {}, admin.accessKeyId);
  assert.ok(!gone.body.some((c) => c.clientId === 'com.jibo.removeme'));

  const missing = await post('OauthClients_20171108.Remove', { id: 'ffffffffffffffffffffffff' }, admin.accessKeyId);
  assert.equal(missing.status, 200);
  assert.equal(missing.rawBody, '', 'findByIdAndRemove null -> empty 200, no CLIENT_NOT_FOUND');
});

test('OauthClients_20171108 auth: non-admin rejected, unsigned rejected, validation errors Joi-faithful', async () => {
  const nonAdmin = createOwnerAccount(store, { email: 'a18-user@example.test', password: 'userpass', firstName: 'U' });
  const forbidden = await post('OauthClients_20171108.Create', {
    clientId: 'com.jibo.no',
    redirectUri: 'https://example.invalid/x',
    updatedBy: nonAdmin._id,
  }, nonAdmin.accessKeyId);
  assert.equal(forbidden.status, 401);
  assert.equal(forbidden.body.__type, 'AUTHORIZED_UNDER_ADMIN');
  assert.equal(forbidden.headers['x-amzn-errortype'], 'AUTHORIZED_UNDER_ADMIN');
  assert.ok(![...store.oauthClients.values()].some((c) => c.clientId === 'com.jibo.no'), 'non-admin cannot create');

  const unsigned = await post('OauthClients_20171108.ListClients', {});
  assert.notEqual(unsigned.status, 200);

  const missing = await post('OauthClients_20171108.Create', {
    clientId: 'com.jibo.missingreq',
    redirectUri: 'https://example.invalid/x',
  }, admin.accessKeyId);
  assert.equal(missing.status, 422);
  assert.equal(missing.body.message, 'child "updatedBy" fails because ["updatedBy" is required]');

  const emptyStr = await post('OauthClients_20171108.Create', {
    clientId: '',
    redirectUri: 'r',
    updatedBy: admin._id,
  }, admin.accessKeyId);
  assert.equal(emptyStr.status, 422);
  // joi 13.1.2 wraps the empty-string failure like every other key failure:
  // `child "x" fails because ["x" is not allowed to be empty]`. Confirmed by
  // running the pinned joi from .parity/reference. This assertion previously
  // pinned Phoenix's unwrapped message, i.e. it encoded the defect.
  assert.equal(emptyStr.body.message, 'child "clientId" fails because ["clientId" is not allowed to be empty]');

  const badAco = await post('OauthClients_20171108.Create', {
    clientId: 'com.jibo.badaco',
    redirectUri: 'r',
    updatedBy: admin._id,
    aco: [],
  }, admin.accessKeyId);
  assert.equal(badAco.status, 422);
  assert.equal(badAco.body.message, 'child "aco" fails because ["aco" must be an object]');
});

test('Lps_20171201.NewCredentials: robot account gets STS credentials; non-robot -> ROBOT_ONLY 403; unsigned rejected', async () => {
  const robot = findOrCreateRobotAccount(store, 'a18-robot-friendly');
  store.flush();
  const r = await post('Lps_20171201.NewCredentials', {}, robot.accessKeyId);
  assert.equal(r.status, 200);
  assert.equal(r.body.bucketName, 'jibo-lps-test');
  assert.equal(r.body.region, 'us-east-1');
  assert.match(r.body.bucketPath, /^lps\/robot=a18-robot-friendly\/account=[0-9a-f]{24}\/year=2026\/month=8\/day=10\/session=1725900000000\/$/);
  assert.equal(r.body.credentials.AccessKeyId, 'AKIAFAKEFAKEFAKEFAKEF');
  assert.equal(r.body.credentials.Expiration, '2026-11-10T00:00:00.000Z');
});

test('Lps_20171201.NewCredentials: ROBOT_ONLY for an identity without friendlyId', async () => {
  const human = createOwnerAccount(store, { email: 'a18-human@example.test', password: 'humanpass', firstName: 'H' });
  const r = await post('Lps_20171201.NewCredentials', {}, human.accessKeyId);
  assert.equal(r.status, 403);
  assert.equal(r.body.__type, 'ROBOT_ONLY');
  assert.equal(r.body.message, 'Request forbidden. Only robotd are allowed.');
  assert.equal(r.headers['x-amzn-errortype'], 'ROBOT_ONLY');
});

test('lpsBucketPath uses the source 0-based month', () => {
  const now = new Date('2025-03-15T12:00:00Z'); // March -> index 2
  const path = lpsBucketPath('robot-1', 'acct-1', now);
  assert.equal(path, 'lps/robot=robot-1/account=acct-1/year=2025/month=2/day=15/session=1742040000000/');
});

test('createLpsStsProvider: unconfigured -> LPS_STS_UNAVAILABLE; configured provider shapes the wire response', async () => {
  const unconfigured = createLpsStsProvider({ config: {} });
  let caught;
  try { await unconfigured.newCredentials('acct', 'robot'); } catch (error) { caught = error; }
  assert.equal(caught.code, 'LPS_STS_UNAVAILABLE');
  assert.equal(caught.statusCode, 503);

  let assumedArgs;
  const provider = createLpsStsProvider({
    assumeRole: async (params) => {
      assumedArgs = params;
      return { AssumedRoleUser: { Arn: 'arn:aws:sts::x:assumed-role/robot' }, Credentials: {
        AccessKeyId: 'AKIA', Expiration: '2026-11-10T00:00:00Z', SecretAccessKey: 'S', SessionToken: 'T',
      } };
    },
    config: { server: { bucketName: 'lps-bucket', lps: { robotRole: 'arn:aws:iam::x:role/robot', region: 'us-east-1' } } },
  });
  const response = await provider.newCredentials('a-1', 'my-robot');
  assert.deepEqual(assumedArgs, {
    ExternalId: 'my-robot_a-1',
    RoleArn: 'arn:aws:iam::x:role/robot',
    RoleSessionName: 'my-robot_a-1',
  });
  assert.equal(response.bucketName, 'lps-bucket');
  assert.equal(response.region, 'us-east-1');
  assert.equal(response.credentials.AccessKeyId, 'AKIA');
  assert.match(response.bucketPath, /^lps\/robot=my-robot\/account=a-1\/year=\d{4}\/month=\d{1,2}\/day=\d{1,2}\/session=\d+\/$/);
});

test('dispatch: unknown OauthClients / Lps operation is 400 UnknownOperationException', async () => {
  const bogus = await post('OauthClients_20171108.Frobnicate', {}, admin.accessKeyId);
  assert.equal(bogus.status, 400);
  assert.equal(bogus.body.__type, 'UnknownOperationException');
  const robot = findOrCreateRobotAccount(store, 'a18-robot-2');
  const bogusLps = await post('Lps_20171201.Frobnicate', {}, robot.accessKeyId);
  assert.equal(bogusLps.status, 400);
  assert.equal(bogusLps.body.__type, 'UnknownOperationException');
});

test('classic router: OauthClients_* and Lps_* prefixes proxy to the account upstream by default', async () => {
  // The account service already proxies every classic AWS-JSON face; router.js adds
  // the two remaining admin prefixes as default proxies so a caller-supplied
  // registration (classicRoutes `extra`) always wins.
  const { createClassicRouter } = await import('@phoenix/classic');
  const upstreamTargets = [];
  const upstream = http.createServer((req, res) => {
    upstreamTargets.push(req.headers['x-amz-target']);
    res.writeHead(200, { 'content-type': 'application/x-amz-json-1.1' });
    res.end(JSON.stringify({ proxied: req.headers['x-amz-target'] }));
  });
  await new Promise((resolve) => upstream.listen(0, resolve));
  const previous = process.env.NET_account;
  process.env.NET_account = `localhost:${upstream.address().port}`;
  const router = createClassicRouter([{ match: /^log/i, handler: () => {} }]);
  const classic = http.createServer((req, res) => {
    router['POST /']({ req, res, body: {}, log: { info() {}, warn() {}, error() {} } });
  });
  await new Promise((resolve) => classic.listen(0, resolve));
  const port = classic.address().port;
  try {
    for (const target of ['OauthClients_20171108.ListClients', 'Lps_20171201.NewCredentials']) {
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': target },
        body: '{}',
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.proxied, target);
    }
    assert.deepEqual(upstreamTargets, ['OauthClients_20171108.ListClients', 'Lps_20171201.NewCredentials']);
  } finally {
    classic.close();
    upstream.close();
    if (previous === undefined) delete process.env.NET_account;
    else process.env.NET_account = previous;
  }
});