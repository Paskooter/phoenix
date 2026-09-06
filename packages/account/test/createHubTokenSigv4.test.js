// A-02 candidate: the sensitive Account_20151111.CreateHubToken path is
// source-compatible with the pinned security gateway's SigV4 verifier, while
// the ordinary OOBE/Loop handlers remain explicit LAN-trust compatibility paths.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { jwt, signSigV4 } from '@phoenix/common';

const dir = mkdtempSync(join(tmpdir(), 'phx-a02-auth-'));
const storeFile = join(dir, 'store.json');
process.env.HUB_TOKEN_SECRET = 'a02-local-hub-secret';
process.env.ETCO_account_dataFile = storeFile;

const { createAccountService, Store } = await import('../src/index.js');
const { createOwnerAccount, createLoop } = await import('../src/model.js');
const { createClassicEntrypoint } = await import('../../classic/src/index.js');

let accountService;
let accountBase;
let classicService;
let classicBase;
let robot;
let owner;

function makeSigned(host, body, overrides = {}) {
  const result = signSigV4({
    method: 'POST',
    path: '/',
    body,
    headers: {
      Host: host,
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': 'Account_20151111.CreateHubToken',
      ...(overrides.headers || {}),
    },
    accessKeyId: overrides.accessKeyId || robot.accessKeyId,
    secretAccessKey: overrides.secretAccessKey || robot.secretAccessKey,
    region: 'global',
    service: 'jibo',
    date: overrides.date || new Date(),
  });
  return { ...result, body };
}

async function post(base, signed, { mutateBody, mutateHeaders } = {}) {
  const headers = { ...signed.headers, ...(mutateHeaders || {}) };
  const body = mutateBody === undefined ? signed.body : mutateBody;
  const response = await fetch(`${base}/`, { method: 'POST', headers, body });
  const rawBody = await response.text();
  let parsedBody = null;
  try { parsedBody = JSON.parse(rawBody); } catch { /* retain null for non-JSON errors */ }
  return {
    status: response.status,
    errorType: response.headers.get('x-amzn-errortype'),
    headers: Object.fromEntries(response.headers.entries()),
    rawBody,
    body: parsedBody,
  };
}

function assertHapiErrorWire(response) {
  assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(response.headers['cache-control'], 'no-cache');
  assert.equal(response.headers.vary, 'accept-encoding');
  assert.equal(response.headers.connection, 'keep-alive');
  assert.equal(response.headers['keep-alive'], undefined);
  assert.equal(response.headers['x-powered-by'], undefined);
  assert.equal(response.headers.etag, undefined);
  assert.equal(response.headers['content-length'], String(Buffer.byteLength(response.rawBody)));
}

before(async () => {
  const store = new Store(storeFile);
  owner = createOwnerAccount(store, { email: 'a02-owner@fixture.test', password: 'A02-safe-pass-4' });
  ({ robot } = createLoop(store, { owner, robotId: 'a02-auth-robot' }));
  accountService = await createAccountService({ store }).listen(0);
  accountBase = `http://localhost:${accountService.address().port}`;

  process.env.NET_account = `localhost:${accountService.address().port}`;
  classicService = await createClassicEntrypoint().listen(0);
  classicBase = `http://localhost:${classicService.address().port}`;
});

after(() => {
  accountService.close();
  classicService.close();
  delete process.env.NET_account;
  delete process.env.HUB_TOKEN_SECRET;
  delete process.env.ETCO_account_dataFile;
  rmSync(dir, { recursive: true, force: true });
});

test('signed CreateHubToken issues the source account claim object over Account JSON', async () => {
  const raw = '{\n  "payload": "source-compatible-payload"\n}';
  const signed = makeSigned(`localhost:${accountService.address().port}`, raw);
  const response = await post(accountBase, signed);

  assert.equal(response.status, 200);
  assert.equal(typeof response.body.token, 'string');
  assert.ok(response.body.expires > Date.now());
  const claims = jwt.verify(response.body.token, process.env.HUB_TOKEN_SECRET || 'a02-local-hub-secret');
  assert.deepEqual(Object.keys(claims), [
    'accessKeyId', 'email', 'friendlyId', 'id', 'payload', 'secretAccessKey', 'iat', 'exp',
  ]);
  assert.equal(claims.id, robot._id);
  assert.equal(claims.accessKeyId, robot.accessKeyId);
  assert.equal(claims.email, robot.email);
  assert.equal(claims.friendlyId, robot.friendlyId);
  assert.equal(claims.payload, 'source-compatible-payload');
  assert.equal(claims.secretAccessKey, robot.secretAccessKey);
  assert.equal(claims.exp - claims.iat, 3 * 60 * 60);
  assert.ok(response.body.expires >= claims.exp * 1000);
  assert.ok(response.body.expires <= claims.exp * 1000 + 999);
});

test('Classic forwards the exact signed body and auth headers to Account', async () => {
  const raw = '{ "payload": "whitespace survives", "nested": { "order": [2, 1] } }';
  const signed = makeSigned(`localhost:${classicService.address().port}`, raw, {
    headers: { 'X-Amz-Security-Token': 'synthetic-session-token' },
  });
  const response = await post(classicBase, signed, {
    mutateHeaders: {
      'X-Amz-Credentials': JSON.stringify({ id: owner._id, accessKeyId: owner.accessKeyId, secretAccessKey: robot.secretAccessKey }),
    },
  });
  assert.equal(response.status, 200);
  const claims = jwt.verify(response.body.token, 'a02-local-hub-secret');
  assert.equal(claims.payload, 'whitespace survives');
  assert.equal(claims.id, robot._id, 'public x-amz-credentials cannot replace the signed caller');
  assert.equal(claims.secretAccessKey, robot.secretAccessKey);
});

test('CreateHubToken uses null for an omitted payload and exact source 422 validation', async () => {
  const omitted = await post(accountBase, makeSigned(`localhost:${accountService.address().port}`, '{}'));
  assert.equal(omitted.status, 200);
  const omittedClaims = jwt.verify(omitted.body.token, 'a02-local-hub-secret');
  assert.equal(omittedClaims.payload, null);
  assert.equal(omittedClaims.secretAccessKey, robot.secretAccessKey);

  for (const invalid of [null, '', 7, {}]) {
    const raw = JSON.stringify({ payload: invalid });
    const response = await post(accountBase, makeSigned(`localhost:${accountService.address().port}`, raw));
    assert.equal(response.status, 422, `payload ${JSON.stringify(invalid)}`);
    assert.deepEqual(Object.keys(response.body), ['statusCode', 'error', 'message']);
    assert.equal(response.body.statusCode, 422);
    assert.equal(response.body.error, 'Unprocessable Entity');
    assert.equal(response.body.message, invalid === ''
      ? 'child "payload" fails because ["payload" is not allowed to be empty]'
      : 'child "payload" fails because ["payload" must be a string]');
    assertHapiErrorWire(response);
  }

  const unknown = await post(accountBase, makeSigned(`localhost:${accountService.address().port}`, '{"extra":true}'));
  assert.equal(unknown.status, 200, 'source validator allows unknown keys');
  assert.equal(jwt.verify(unknown.body.token, 'a02-local-hub-secret').payload, null);
});

test('direct Account and Classic match Hapi for top-level, missing, and payload validation', async () => {
  const cases = [
    ['top-null', 'null', '"value" must be an object'],
    ['top-array', '[]', '"value" must be an object'],
    ['top-number', '1', '"value" must be an object'],
    ['top-boolean', 'true', '"value" must be an object'],
    ['top-string', '"source-string"', '"value" must be an object'],
    ['missing-body', '', '"value" must be an object'],
    ['payload-null', '{"payload":null}', 'child "payload" fails because ["payload" must be a string]'],
    ['payload-empty', '{"payload":""}', 'child "payload" fails because ["payload" is not allowed to be empty]'],
    ['payload-number', '{"payload":4}', 'child "payload" fails because ["payload" must be a string]'],
    ['payload-object', '{"payload":{}}', 'child "payload" fails because ["payload" must be a string]'],
  ];

  for (const [endpoint, base, host] of [
    ['account', accountBase, `localhost:${accountService.address().port}`],
    ['classic', classicBase, `localhost:${classicService.address().port}`],
  ]) {
    for (const [name, raw, message] of cases) {
      const response = await post(base, makeSigned(host, raw));
      assert.equal(response.status, 422, `${endpoint}/${name}`);
      assert.deepEqual(response.body, {
        statusCode: 422,
        error: 'Unprocessable Entity',
        message,
      }, `${endpoint}/${name} body`);
      assertHapiErrorWire(response);
    }
  }

  for (const [endpoint, base, host] of [
    ['account', accountBase, `localhost:${accountService.address().port}`],
    ['classic', classicBase, `localhost:${classicService.address().port}`],
  ]) {
    for (const raw of ['{}', '{"extra":true}', '{"payload":"accepted"}']) {
      const response = await post(base, makeSigned(host, raw));
      assert.equal(response.status, 200, `${endpoint}/${raw}`);
      const claims = jwt.verify(response.body.token, 'a02-local-hub-secret');
      assert.equal(claims.payload, raw === '{"payload":"accepted"}' ? 'accepted' : null);
    }
  }
});

test('authentication errors precede Hapi payload validation', async () => {
  for (const [base, host] of [
    [accountBase, `localhost:${accountService.address().port}`],
    [classicBase, `localhost:${classicService.address().port}`],
  ]) {
    const signed = makeSigned(host, 'null', { accessKeyId: 'UNKNOWN-A02-KEY' });
    const response = await post(base, signed);
    assert.equal(response.status, 401);
    assert.equal(response.errorType, 'ACCESS_KEY_NOT_FOUND');
    assert.equal(response.body.__type, 'ACCESS_KEY_NOT_FOUND');
  }
});

test('body and signed target changes are rejected after the Classic boundary', async () => {
  const raw = '{"payload":"original"}';
  const signed = makeSigned(`localhost:${classicService.address().port}`, raw);
  const tamperedBody = await post(classicBase, signed, { mutateBody: '{"payload":"tampered"}' });
  assert.equal(tamperedBody.status, 401);
  assert.equal(tamperedBody.errorType, 'SIGNATURE_MISMATCH');

  const targetChanged = await post(classicBase, signed, {
    mutateHeaders: { 'X-Amz-Target': 'Account_20151111.createhubtoken' },
  });
  assert.equal(targetChanged.status, 401);
  assert.equal(targetChanged.errorType, 'SIGNATURE_MISMATCH');
});

test('Classic rejects signed compressed entities before forwarding inflated bytes', async () => {
  const body = gzipSync(Buffer.from('{"payload":"compressed"}'));
  const signed = makeSigned(`localhost:${classicService.address().port}`, body, {
    headers: { 'Content-Encoding': 'gzip' },
  });
  const response = await post(classicBase, signed);
  assert.equal(response.status, 415);
  assert.equal(response.errorType, 'UnsupportedMediaTypeException');
  assert.match(response.body.message, /compressed request entity/);
});

test('unknown, inactive, and stale credentials retain source error categories', async () => {
  const raw = '{}';
  const unknown = makeSigned(`localhost:${accountService.address().port}`, raw, { accessKeyId: 'UNKNOWN-A02-KEY' });
  const unknownResponse = await post(accountBase, unknown);
  assert.equal(unknownResponse.status, 401);
  assert.equal(unknownResponse.errorType, 'ACCESS_KEY_NOT_FOUND');

  robot.isActive = false;
  const inactive = makeSigned(`localhost:${accountService.address().port}`, raw);
  const inactiveResponse = await post(accountBase, inactive);
  assert.equal(inactiveResponse.status, 403);
  assert.equal(inactiveResponse.errorType, 'ACCOUNT_NOT_ACTIVE');
  robot.isActive = true;

  const stale = makeSigned(`localhost:${accountService.address().port}`, raw, {
    date: new Date(Date.now() - 16 * 60 * 1000),
  });
  const staleResponse = await post(accountBase, stale);
  assert.equal(staleResponse.status, 401);
  assert.equal(staleResponse.errorType, 'CLOCK_SKEW_TOO_LONG');
});

// The original Node 8 Hapi listener preserves explicit close and does not
// add a Keep-Alive timeout under either connection policy.
test('Hapi validation preserves Connection close through Account and Classic', async () => {
  for (const base of [accountBase, classicBase]) {
    const signed = makeSigned(new URL(base).host, 'null', { headers: { Connection: 'close' } });
    const response = await post(base, signed);
    assert.equal(response.status, 422);
    assert.equal(response.headers.connection, 'close');
    assert.equal(response.headers['keep-alive'], undefined);
    assert.equal(response.body.message, '\"value\" must be an object');
  }
});
