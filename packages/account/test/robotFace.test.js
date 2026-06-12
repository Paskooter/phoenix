// G.2 — robot-facing AWS-JSON face: setupRobot happy path, exact error envelopes, prefix
// tolerance, prepareRobot via SigV4 Credential parse, getStatus, Update_* proxy to a mock OTA.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'phx-robotface-'));
process.env.ETCO_account_dataFile = join(dir, 'store.json');

const { createAccountService, getStore } = await import('../src/index.js');
const { createOwnerAccount, mintSetupToken, ACCESS_TOKEN_LIFETIME_MS } = await import('../src/model.js');

let server; let base; let mockOta; let otaHits = [];

async function amz(target, body, headers = {}) {
  const res = await fetch(`${base}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': target, ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, errType: res.headers.get('x-amzn-errortype'), body: await res.json().catch(() => null) };
}

before(async () => {
  mockOta = http.createServer((req, res) => {
    otaHits.push({ target: req.headers['x-amz-target'] });
    res.writeHead(200, { 'content-type': 'application/x-amz-json-1.1' });
    res.end(JSON.stringify([{ subsystem: 'os', toVersion: '13.0.0' }]));
  });
  await new Promise((r) => mockOta.listen(0, r));
  process.env.NET_ota = `localhost:${mockOta.address().port}`;

  server = await createAccountService().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(() => { server.close(); mockOta.close(); rmSync(dir, { recursive: true, force: true }); });

test('setupRobot: portal-minted token -> credentials, one-time, robot adopted into a loop', async () => {
  const store = getStore();
  const owner = createOwnerAccount(store, { email: 'jane@jetson.test', password: 'orbit-city-4ever', firstName: 'Jane' });
  const token = mintSetupToken(store, owner._id);

  const r = await amz('OOBE_20170101.SetupRobot', { token: token._id, id: 'castle-cylinder-fig-quilt' });
  assert.equal(r.status, 200);
  assert.match(r.body.accessKeyId, /^[A-Za-z0-9]{20}$/);
  assert.match(r.body.secretAccessKey, /^[A-Za-z0-9]{40}$/);
  assert.ok(!('serviceMode' in r.body) || r.body.serviceMode == null, 'normal accounts: serviceMode absent');

  // loop attached, named per getLoopName ("Jane's Jibo")
  const robots = store.allRobots();
  const mine = robots.find((x) => x.robot.friendlyId === 'castle-cylinder-fig-quilt');
  assert.ok(mine.loop);
  assert.equal(mine.loop.name, "Jane's Jibo");
  assert.equal(mine.owner.email, 'jane@jetson.test');

  // ONE-TIME: replay fails with the reference error envelope
  const replay = await amz('OOBE_20170101.SetupRobot', { token: token._id, id: 'castle-cylinder-fig-quilt' });
  assert.equal(replay.status, 404);
  assert.equal(replay.body.__type, 'TOKEN_NOT_FOUND');
  assert.equal(replay.errType, 'TOKEN_NOT_FOUND');

  // same-robot re-setup with a fresh loop-bound token re-issues the SAME keys
  const t2 = mintSetupToken(store, owner._id, mine.loop._id);
  const again = await amz('OOBE_20170101.SetupRobot', { token: t2._id, id: 'castle-cylinder-fig-quilt' });
  assert.equal(again.body.accessKeyId, r.body.accessKeyId);

  // a DIFFERENT robot against the live loop is rejected like the original
  const t3 = mintSetupToken(store, owner._id, mine.loop._id);
  const thief = await amz('OOBE_20170101.SetupRobot', { token: t3._id, id: 'other-robot-name-here' });
  assert.equal(thief.status, 409);
  assert.equal(thief.body.__type, 'LOOP_MUST_BE_SUSPENDED');
});

test('setupRobot errors: expired token 401 TOKEN_EXPIRED (not deleted), unknown 404', async () => {
  const store = getStore();
  const owner = store.accountByEmail('jane@jetson.test');
  const token = mintSetupToken(store, owner._id, null);
  store.tokens.get(token._id).created = Date.now() - ACCESS_TOKEN_LIFETIME_MS - 1000;

  const r = await amz('OOBE_20170101.SetupRobot', { token: token._id, id: 'x-y-z-robot' });
  assert.equal(r.status, 401);
  assert.equal(r.body.__type, 'TOKEN_EXPIRED');
  assert.ok(store.tokens.has(token._id), 'original semantics: expiry throws but does not delete');

  const unknown = await amz('OOBE_20170101.SetupRobot', { token: 'NoSuchTok', id: 'x-y-z-robot' });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.__type, 'TOKEN_NOT_FOUND');
});

test('prefix tolerance: any prefix routes by operation name; unknown op is 400', async () => {
  const store = getStore();
  const owner = store.accountByEmail('jane@jetson.test');
  const t = mintSetupToken(store, owner._id);
  const weird = await amz('Whatever_20990101.GetStatus', { token: t._id });
  assert.equal(weird.status, 200);
  assert.equal(weird.body.complete, false);

  const nope = await amz('OOBE_20170101.LaunchTheMissiles', {});
  assert.equal(nope.status, 400);
  assert.equal(nope.body.__type, 'UnknownOperationException');
});

test('getStatus flips to complete once the token is consumed (or invalid)', async () => {
  const store = getStore();
  const owner = store.accountByEmail('jane@jetson.test');
  const t = mintSetupToken(store, owner._id);
  assert.equal((await amz('OOBE.GetStatus', { token: t._id })).body.complete, false);
  await amz('OOBE.SetupRobot', { token: t._id, id: 'status-test-robot-abc' });
  assert.equal((await amz('OOBE.GetStatus', { token: t._id })).body.complete, true);
  assert.equal((await amz('OOBE.GetStatus', { token: 'bogus' })).body.complete, true);
});

test('prepareRobot: authed by SigV4 Credential accessKeyId; reuses the live token', async () => {
  const store = getStore();
  const owner = store.accountByEmail('jane@jetson.test');
  const sig = (keyId) => `AWS4-HMAC-SHA256 Credential=${keyId}/20260612/us-east-1/account/aws4_request, SignedHeaders=host, Signature=feedface`;

  const anon = await amz('OOBE.PrepareRobot', {});
  assert.equal(anon.status, 401);
  assert.equal(anon.body.__type, 'CREDENTIALS_REQUIRED');

  const r1 = await amz('OOBE.PrepareRobot', {}, { authorization: sig(owner.accessKeyId) });
  assert.equal(r1.status, 200);
  assert.ok(r1.body.token && r1.body.expires > Date.now());

  // token.ctrl.ts create: same account+loopId within TTL -> the SAME token, refreshed
  const r2 = await amz('OOBE.PrepareRobot', {}, { authorization: sig(owner.accessKeyId) });
  assert.equal(r2.body.token, r1.body.token);
});

test('Update_* targets proxy through to the OTA service untouched', async () => {
  otaHits = [];
  const r = await amz('Update_20160301.ListUpdatesFrom', { subsystem: 'os', fromVersion: '3.3.4' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, [{ subsystem: 'os', toVersion: '13.0.0' }]);
  assert.deepEqual(otaHits, [{ target: 'Update_20160301.ListUpdatesFrom' }]);
});
