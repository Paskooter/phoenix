// A-04/reconnect — OOBE_20161026.ReconnectRobot.
//
// Handler decorators pin to srv-account-ws@6cea434 (the A-04 source snapshot):
//   src/handlers/oobe.handler.ts — @parseCredentials({}) then
//   @validatePayload({ id: Joi.string(), token: Joi.string().required() }).
// The pinned 6cea434 snapshot's controller body is intentionally simple:
// `reconnectRobot({ token }) { await deleteToken(token); return COMMAND_RESULT; }`.
// The compatibility face still resolves an Authorization Credential before entering
// the controller, then validates and consumes the setup token without loop,
// suspension, or membership checks.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'phx-reconnect-'));
process.env.ETCO_account_dataFile = join(dir, 'store.json');

const { createAccountService, getStore } = await import('../src/index.js');
const { createOwnerAccount, createLoop, findOrCreateRobotAccount, mintSetupToken, ACCESS_TOKEN_LIFETIME_MS } = await import('../src/model.js');

let server; let base;

async function amz(target, body, headers = {}) {
  const res = await fetch(`${base}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': target,
      ...headers,
      connection: 'close',
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, errType: res.headers.get('x-amzn-errortype'), body: await res.json().catch(() => null) };
}

// The OOBE compatibility face resolves the caller's accessKeyId from the
// Authorization Credential; like the source's parseCredentials, no SigV4
// signature check applies on this legacy LAN path.
const sig = (keyId) => `AWS4-HMAC-SHA256 Credential=${keyId}/20260612/us-east-1/account/aws4_request, SignedHeaders=host, Signature=feedface`;

before(async () => {
  server = await createAccountService().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

test('ReconnectRobot: happy path deletes the token and returns Command accepted', async () => {
  const store = getStore();
  const owner = createOwnerAccount(store, { email: 'reconn-owner@jetson.test', password: 'orbit-city-4ever', firstName: 'Reconn' });
  const { loop, robot } = createLoop(store, { owner, robotId: 'anchor-brace-cable-delta' });
  const token = mintSetupToken(store, owner._id, loop._id);

  const r = await amz('OOBE_20161026.ReconnectRobot', { token: token._id }, { authorization: sig(robot.accessKeyId) });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { result: 'Command accepted' });
  assert.ok(!store.tokens.has(token._id), 'token deleted');

  // ONE-TIME: replay fails with the reference unknown-token envelope.
  const replay = await amz('OOBE_20161026.ReconnectRobot', { token: token._id }, { authorization: sig(robot.accessKeyId) });
  assert.equal(replay.status, 404);
  assert.equal(replay.body.__type, 'TOKEN_NOT_FOUND');
  assert.equal(replay.errType, 'TOKEN_NOT_FOUND');
});

test('ReconnectRobot: unknown token fails before any loop check', async () => {
  const store = getStore();
  const owner = createOwnerAccount(store, { email: 'reconn-unknown@jetson.test', password: 'orbit-city-4ever', firstName: 'Unknown' });
  const { robot } = createLoop(store, { owner, robotId: 'halo-iced-jazz-kilo' });

  const r = await amz('OOBE_20161026.ReconnectRobot', { token: 'NoSuchTok' }, { authorization: sig(robot.accessKeyId) });
  assert.equal(r.status, 404);
  assert.equal(r.body.__type, 'TOKEN_NOT_FOUND');
  assert.equal(r.body.message, 'Token not found');
  assert.equal(r.errType, 'TOKEN_NOT_FOUND');
});

test('ReconnectRobot: expired token is 401 TOKEN_EXPIRED and is not deleted', async () => {
  const store = getStore();
  const owner = createOwnerAccount(store, { email: 'reconn-expired@jetson.test', password: 'orbit-city-4ever', firstName: 'Expired' });
  const { loop, robot } = createLoop(store, { owner, robotId: 'lime-mint-note-ozone' });
  const token = mintSetupToken(store, owner._id, loop._id);
  store.tokens.get(token._id).created = Date.now() - ACCESS_TOKEN_LIFETIME_MS - 1000;

  const r = await amz('OOBE_20161026.ReconnectRobot', { token: token._id }, { authorization: sig(robot.accessKeyId) });
  assert.equal(r.status, 401);
  assert.equal(r.body.__type, 'TOKEN_EXPIRED');
  assert.ok(store.tokens.has(token._id), 'expired token is reported, not deleted');
});

test('ReconnectRobot: robot with no loop still consumes the token', async () => {
  const store = getStore();
  const owner = createOwnerAccount(store, { email: 'reconn-noloop@jetson.test', password: 'orbit-city-4ever', firstName: 'NoLoop' });
  const robot = findOrCreateRobotAccount(store, 'roger-sunset-tango-vole');
  const token = mintSetupToken(store, owner._id);

  const r = await amz('OOBE_20161026.ReconnectRobot', { token: token._id }, { authorization: sig(robot.accessKeyId) });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { result: 'Command accepted' });
  assert.equal(r.errType, null);
  assert.ok(!store.tokens.has(token._id), 'source-simple reconnect consumes the token');
});

test('ReconnectRobot: suspended loop still consumes the token', async () => {
  const store = getStore();
  const owner = createOwnerAccount(store, { email: 'reconn-susp@jetson.test', password: 'orbit-city-4ever', firstName: 'Susp' });
  const { loop, robot } = createLoop(store, { owner, robotId: 'ulna-violin-wisp-yawn' });
  loop.isSuspended = true;
  const token = mintSetupToken(store, owner._id, loop._id);

  const r = await amz('OOBE_20161026.ReconnectRobot', { token: token._id }, { authorization: sig(robot.accessKeyId) });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { result: 'Command accepted' });
  assert.equal(r.errType, null);
  assert.ok(!store.tokens.has(token._id), 'source-simple reconnect consumes the token');
});

test('ReconnectRobot: token account need not be a loop member', async () => {
  const store = getStore();
  const owner = createOwnerAccount(store, { email: 'reconn-alien@jetson.test', password: 'orbit-city-4ever', firstName: 'Alien' });
  const { loop, robot } = createLoop(store, { owner, robotId: 'zenith-amber-copper-dune' });
  const stranger = createOwnerAccount(store, { email: 'stranger@elsewhere.test', password: 'orbit-city-4ever', firstName: 'Stranger' });
  const token = mintSetupToken(store, stranger._id, loop._id);

  const r = await amz('OOBE_20161026.ReconnectRobot', { token: token._id }, { authorization: sig(robot.accessKeyId) });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { result: 'Command accepted' });
  assert.equal(r.errType, null);
  assert.ok(!store.tokens.has(token._id), 'source-simple reconnect consumes the token');
});

test('ReconnectRobot: an invited member status does not block token consumption', async () => {
  const store = getStore();
  const owner = createOwnerAccount(store, { email: 'reconn-invitee@jetson.test', password: 'orbit-city-4ever', firstName: 'Invited' });
  const { loop, robot } = createLoop(store, { owner, robotId: 'fable-geode-hyper-iris' });
  const pending = createOwnerAccount(store, { email: 'pending@nowhere.test', password: 'orbit-city-4ever', firstName: 'Pending' });
  // Only an invited (not accepted) membership links the token's account.
  loop.members.push({ _id: 'member-' + pending._id, accountId: pending._id, status: 'invited' });

  const token = mintSetupToken(store, pending._id, loop._id);
  const r = await amz('OOBE_20161026.ReconnectRobot', { token: token._id }, { authorization: sig(robot.accessKeyId) });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { result: 'Command accepted' });
  assert.ok(!store.tokens.has(token._id), 'source-simple reconnect consumes the token');
});

test('ReconnectRobot: member status casing does not affect token consumption', async () => {
  const store = getStore();
  const owner = createOwnerAccount(store, { email: 'reconn-case@jetson.test', password: 'orbit-city-4ever', firstName: 'Casey' });
  const { loop, robot } = createLoop(store, { owner, robotId: 'jiggle-karma-lunar-marble' });
  const oops = createOwnerAccount(store, { email: 'oops@nowhere.test', password: 'orbit-city-4ever', firstName: 'Oops' });
  loop.members.push({ _id: 'member-' + oops._id, accountId: oops._id, status: 'Invited' });

  const token = mintSetupToken(store, oops._id, loop._id);
  const r = await amz('OOBE_20161026.ReconnectRobot', { token: token._id }, { authorization: sig(robot.accessKeyId) });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { result: 'Command accepted' });
  assert.ok(!store.tokens.has(token._id), 'source-simple reconnect consumes the token');
});

test('ReconnectRobot: missing credentials is 401 CREDENTIALS_REQUIRED', async () => {
  const store = getStore();
  const owner = createOwnerAccount(store, { email: 'reconn-anon@jetson.test', password: 'orbit-city-4ever', firstName: 'Anon' });
  const token = mintSetupToken(store, owner._id);

  const r = await amz('OOBE_20161026.ReconnectRobot', { token: token._id });
  assert.equal(r.status, 401);
  assert.equal(r.body.__type, 'CREDENTIALS_REQUIRED');
});

test('ReconnectRobot: missing token payload is a 422 Joi validation error', async () => {
  const store = getStore();
  const owner = createOwnerAccount(store, { email: 'reconn-valid@jetson.test', password: 'orbit-city-4ever', firstName: 'Valid' });
  const { robot } = createLoop(store, { owner, robotId: 'nova-opal-panda-quest' });

  const r = await amz('OOBE_20161026.ReconnectRobot', {}, { authorization: sig(robot.accessKeyId) });
  // oobe.handler.ts @validatePayload({ id: Joi.string(), token: Joi.string().required() })
  // raises Boom.badData -> Hapi's 422 envelope, not the AWS 400 ValidationException.
  assert.equal(r.status, 422);
  assert.equal(r.body.statusCode, 422);
  assert.equal(r.body.message, 'child "token" fails because ["token" is required]');
  assert.equal(r.errType, null);
});
