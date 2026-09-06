import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SETTINGS_GATEWAY_CONTENT_TYPE,
  SETTINGS_INTERNAL_CONTENT_TYPE,
  SETTINGS_PUBLIC_CONTENT_TYPE,
  SETTINGS_TRANSPORTS,
  createPublicSettingsForwarder,
  prepareInternalSettingsRequest,
  prepareSettingsRequest,
} from '../src/settingsTransport.js';

test('internal Settings profile matches the pinned Hub/Report client wire contract', () => {
  const request = prepareInternalSettingsRequest({
    accountId: 'account-1',
    body: { loopId: 'loop-1', transId: 'tx-1', skills: ['report-skill'], getView: false },
  });

  assert.deepEqual(request.headers, {
    'content-type': SETTINGS_INTERNAL_CONTENT_TYPE,
    'x-amz-credentials': '{"id":"account-1"}',
    'x-amz-target': 'Settings_20160801.GetSettings',
  });
  assert.equal(request.body, '{"loopId":"loop-1","transId":"tx-1","skills":["report-skill"],"getView":false}');
});

test('public profile translates only after an explicit authentication callback', async () => {
  const body = Buffer.from('{"loopId":"loop-1"}');
  const incoming = {
    headers: {
      'content-type': SETTINGS_PUBLIC_CONTENT_TYPE,
      'x-amz-target': 'Settings_20171219.GetSettings',
      'x-amz-credentials': '{"id":"forged"}',
      authorization: 'AWS4-HMAC-SHA256 verified',
      connection: 'keep-alive',
      'accept-encoding': 'gzip',
    },
    body,
  };
  let authenticatedRequest;
  const forwarder = createPublicSettingsForwarder({
    authenticate: async (request) => {
      authenticatedRequest = request;
      return {
        _id: 'trusted-account',
        email: 'trusted@example.test',
        accessKeyId: 'AKID',
        secretAccessKey: '***hidden***',
        isAdmin: false,
        friendlyId: 'jibo-1',
      };
    },
    forward: (request) => request,
  });
  const request = await forwarder(incoming);

  assert.equal(authenticatedRequest, incoming, 'the authenticator sees the original request');
  assert.equal(request.body, body);
  assert.equal(request.headers['content-type'], SETTINGS_GATEWAY_CONTENT_TYPE);
  assert.equal(request.headers.connection, undefined);
  assert.equal(request.headers['accept-encoding'], undefined);
  assert.equal(request.headers.authorization, 'AWS4-HMAC-SHA256 verified');
  assert.deepEqual(JSON.parse(request.headers['x-amz-credentials']), {
    _id: 'trusted-account',
    id: 'trusted-account',
    email: 'trusted@example.test',
    accessKeyId: 'AKID',
    secretAccessKey: '***hidden***',
    isAdmin: false,
    friendlyId: 'jibo-1',
  });
});

test('public profile preserves non-AWS content types and exact stream identity', async () => {
  const body = Buffer.from('{"loopId":"loop-1"}');
  const request = await createPublicSettingsForwarder({
    authenticate: () => ({ _id: 'trusted-account' }),
    forward: (prepared) => prepared,
  })({
    headers: { 'Content-Type': 'text/plain', 'X-Amz-Credentials': 'forged' },
    body,
  });

  assert.equal(request.body, body);
  assert.equal(request.headers['Content-Type'], 'text/plain');
  assert.equal(request.headers['content-type'], undefined);
  assert.equal(request.headers['X-Amz-Credentials'], undefined);
  assert.deepEqual(JSON.parse(request.headers['x-amz-credentials']), {
    _id: 'trusted-account', id: 'trusted-account',
  });
});

test('profile selection is explicit and rejects untrusted or ambiguous inputs', () => {
  assert.throws(() => prepareSettingsRequest({ transport: 'auto' }), /Unknown Settings transport/);
  assert.throws(() => createPublicSettingsForwarder({ forward: () => {} }), /authenticator/);
  assert.throws(() => createPublicSettingsForwarder({ authenticate: () => ({}) }), /forwarder/);
  assert.throws(() => prepareInternalSettingsRequest({ body: {} }), /requires accountId/);

  const selected = prepareSettingsRequest({
    transport: SETTINGS_TRANSPORTS.INTERNAL,
    accountId: 'account-1',
    body: {},
  });
  assert.equal(selected.headers['content-type'], SETTINGS_INTERNAL_CONTENT_TYPE);
  assert.equal(selected.headers['x-amz-target'], 'Settings_20160801.GetSettings');

  const publicSelected = prepareSettingsRequest({
    transport: SETTINGS_TRANSPORTS.PUBLIC,
    authenticate: () => ({ _id: 'trusted-account' }),
    forward: (request) => request,
  });
  assert.equal(typeof publicSelected, 'function');
});

test('public profile rejects credentials that the authentication boundary did not verify', async () => {
  const forwarder = createPublicSettingsForwarder({
    authenticate: () => ({ _id: 'trusted-account', secretAccessKey: 'raw-secret' }),
    forward: () => assert.fail('raw credentials must never reach the forwarder'),
  });
  await assert.rejects(() => forwarder({ headers: {}, body: Buffer.from('{}') }), /redacted secretAccessKey/);
  await assert.rejects(() => createPublicSettingsForwarder({
    authenticate: () => null,
    forward: () => {},
  })({}), /no credentials/);
});
