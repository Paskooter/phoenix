// A-17 — IFTTT_20170207 wire contract, derived from the pinned source:
//   apis/ifttt-2017-02-07.normal.json, jiborobot/srv-ifttt-ws
//     src/handlers/ifttt.handler.ts, src/controllers/ifttt.ctrl.ts,
//     src/schemes/{action,identity,media,trigger}.ts, src/errors/ifttt.ts,
//     src/clients/{ifttt,account}.client.ts
//
// The third-party IFTTT realtime endpoint is dead, so the notify step is asserted as an explicit
// UNAVAILABLE outcome — never a fabricated success. Account/loop list and KeyClient are fixture
// adapters.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createClassicEntrypoint, IftttStore, localPhoneticKey } from '../src/index.js';

let server; let port; let defaultServer; let defaultEntrypoint; let defaultPort;

const store = new IftttStore();
const notifyCalls = [];
const keyCalls = [];
let loopMode = 'robot';
let emailValue = 'jane@example.com';

const loops = {
  listLoops: async (accountId) => {
    if (loopMode === 'not-robot') return [{ id: `loop-${accountId}`, robot: 'someone-else', owner: accountId }];
    if (loopMode === 'multi') return [{ id: `loop-${accountId}-a`, robot: accountId, owner: accountId }, { id: `loop-${accountId}-b`, robot: accountId, owner: accountId }];
    return [{ id: `loop-${accountId}`, robot: accountId, owner: accountId }];
  },
  listOwnerLoops: async (accountId) => [{ id: `loop-${accountId}`, robot: accountId, owner: accountId }],
};

const notify = async (identities) => {
  notifyCalls.push(identities.map((i) => i.id));
  return { delivered: false, reason: 'IFTTT realtime endpoint is dead' };
};

const key = {
  removeBinaries: async ({ encryptedUrls }) => { keyCalls.push({ op: 'removeBinaries', encryptedUrls }); return { removed: true }; },
  createBinaryRequest: async () => ({}),
};

async function amz(target, body, accessKeyId = 'acct-1') {
  const res = await fetch(`http://localhost:${port}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.1', 'x-amz-target': target,
      authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/20260613/us-east-1/x/aws4_request, SignedHeaders=host, Signature=ff`,
    },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, errType: res.headers.get('x-amzn-errortype'), body: await res.json().catch(() => null) };
}

async function amzDefault(target, body, accessKeyId = 'acct-1') {
  const res = await fetch(`http://localhost:${defaultPort}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.1', 'x-amz-target': target,
      authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/20260613/us-east-1/x/aws4_request, SignedHeaders=host, Signature=ff`,
    },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, errType: res.headers.get('x-amzn-errortype'), body: await res.json().catch(() => null) };
}

before(async () => {
  server = await createClassicEntrypoint({ ifttt: { store, loops, notify, key, email: () => emailValue } }).listen(0);
  port = server.address().port;
  defaultEntrypoint = createClassicEntrypoint();
  defaultServer = await defaultEntrypoint.listen(0);
  defaultPort = defaultServer.address().port;
});
after(() => { server.close(); defaultServer.close(); });
beforeEach(() => {
  store.identities.clear();
  store.triggers.length = 0; store.actions.length = 0; store.media.length = 0;
  store.notifications.length = 0; store.keyCalls.length = 0;
  notifyCalls.length = 0; keyCalls.length = 0;
  loopMode = 'robot'; emailValue = 'jane@example.com';
});

const seedIdentity = (id, filter, loopIds = ['loop-acct-1']) => store.findOrCreateIdentity({ identity: id, filter, loopIds, refresh: true });

test('UserInfo returns the owner id + email and upserts the USER_FILTER identity', async () => {
  const r = await amz('IFTTT_20170207.UserInfo', {});
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { id: 'acct-1', name: 'jane@example.com' });
  assert.equal(store.findIdentity('acct-1').filter, '__USER_FILTER__');
});

test('Trigger requires text (source @validatePayload Joi.string().required())', async () => {
  const r = await amz('IFTTT_20170207.Trigger', {});
  assert.equal(r.status, 400);
  assert.equal(r.errType, 'ValidationException');
});

test('Trigger is robot-only (ROBOT_MUST_CALL 403)', async () => {
  loopMode = 'not-robot';
  const r = await amz('IFTTT_20170207.Trigger', { text: 'hello twitter' });
  assert.equal(r.status, 403);
  assert.equal(r.errType, 'ROBOT_MUST_CALL');
  assert.equal(r.body.message, 'Only robot must be calling this method');
});

test('Trigger creates one Trigger row per matching identity and reports the dead notify', async () => {
  seedIdentity('idf-1', localPhoneticKey('hello twitter'));
  const r = await amz('IFTTT_20170207.Trigger', { text: 'hello twitter' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { result: 'Command accepted' });
  assert.equal(store.triggers.length, 1);
  assert.equal(store.triggers[0].identity, 'idf-1');
  assert.equal(store.triggers[0].text, 'hello twitter');
  assert.deepEqual(notifyCalls, [['idf-1']]);
});

test('Trigger with no applet is APPLET_NOT_FOUND; without the user link it is USER_NOT_FOUND', async () => {
  const noUser = await amz('IFTTT_20170207.Trigger', { text: 'hello twitter' });
  assert.equal(noUser.status, 404);
  assert.equal(noUser.errType, 'USER_NOT_FOUND');
  seedIdentity('acct-1', '__USER_FILTER__');
  const noApplet = await amz('IFTTT_20170207.Trigger', { text: 'hello twitter' });
  assert.equal(noApplet.status, 404);
  assert.equal(noApplet.errType, 'APPLET_NOT_FOUND');
});

test('ListTriggers requires identity and returns the Triggers list with the 50/0 limit rules', async () => {
  const missing = await amz('IFTTT_20170207.ListTriggers', {});
  assert.equal(missing.status, 400);
  assert.equal(missing.errType, 'ValidationException');

  const zero = await amz('IFTTT_20170207.ListTriggers', { identity: 'idf-1', limit: 0 });
  assert.equal(zero.status, 200);
  assert.deepEqual(zero.body, []);
  // limit 0 returns before touching the store, but the identity upserts still ran
  assert.equal(store.findIdentity('acct-1').filter, '__USER_FILTER__');
  assert.equal(store.findIdentity('idf-1').filter, localPhoneticKey(undefined));

  store.createTrigger({ identity: 'idf-1', text: 'a' });
  const all = await amz('IFTTT_20170207.ListTriggers', { identity: 'idf-1' });
  assert.ok(Array.isArray(all.body));
  assert.equal(all.body.length, 1);
  assert.deepEqual(Object.keys(all.body[0]).sort(), ['created', 'id', 'identity', 'text']);
});

test('ListTriggers rejects an identity bound to a different filter (IDENTITY_TRIGGER_CHANGED 409)', async () => {
  seedIdentity('idf-1', '__MEDIA_FILTER__');
  const r = await amz('IFTTT_20170207.ListTriggers', { identity: 'idf-1' });
  assert.equal(r.status, 409);
  assert.equal(r.errType, 'IDENTITY_TRIGGER_CHANGED');
});

test('Action returns one Action per owner loop with the pinned members', async () => {
  const missing = await amz('IFTTT_20170207.Action', {});
  assert.equal(missing.status, 400);
  assert.equal(missing.errType, 'ValidationException');

  const r = await amz('IFTTT_20170207.Action', { fields: { url: 'https://example.test/a.jpg' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 1);
  assert.deepEqual(Object.keys(r.body[0]).sort(), ['created', 'fields', 'id', 'loopId']);
  assert.deepEqual(r.body[0].fields, { url: 'https://example.test/a.jpg' });
  assert.equal(r.body[0].loopId, 'loop-acct-1');
});

test('ListActions is robot-only and lists the robot loop actions', async () => {
  await amz('IFTTT_20170207.Action', { fields: { url: 'u' } });
  const zero = await amz('IFTTT_20170207.ListActions', { limit: 0 });
  assert.deepEqual(zero.body, []);
  const all = await amz('IFTTT_20170207.ListActions', {});
  assert.equal(all.body.length, 1);
  loopMode = 'not-robot';
  const refused = await amz('IFTTT_20170207.ListActions', {});
  assert.equal(refused.status, 403);
  assert.equal(refused.errType, 'ROBOT_MUST_CALL');
});

test('ListMedia requires identity, returns the MediaTriggers shape and 409s on a filter clash', async () => {
  const missing = await amz('IFTTT_20170207.ListMedia', {});
  assert.equal(missing.status, 400);

  const empty = await amz('IFTTT_20170207.ListMedia', { identity: 'idf-media' });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, []);
  assert.equal(store.findIdentity('idf-media').filter, '__MEDIA_FILTER__');

  seedIdentity('idf-user', localPhoneticKey('x'));
  const clash = await amz('IFTTT_20170207.ListMedia', { identity: 'idf-user' });
  assert.equal(clash.status, 409);
  assert.equal(clash.errType, 'IDENTITY_TRIGGER_CHANGED');
});

test('ListMedia returns decrypted media rows', async () => {
  await amz('IFTTT_20170207.ListMedia', { identity: 'media-1' }); // binds media-1 to MEDIA_FILTER
  const row = store.createMedia({ identity: 'media-1', encryptedUrl: 'enc://a' });
  store.updateMedia({ encryptedUrl: 'enc://a', decryptedUrl: 'dec://a' });
  const r = await amz('IFTTT_20170207.ListMedia', { identity: 'media-1' });
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 1);
  assert.deepEqual(Object.keys(r.body[0]).sort(), ['created', 'decryptedUrl', 'encryptedUrl', 'id', 'identity']);
  assert.equal(r.body[0].id, row._id);
  assert.equal(r.body[0].decryptedUrl, 'dec://a');
});

test('DeleteIdentity cascades triggers + media, calls the key adapter, and enforces the gates', async () => {
  const missingField = await amz('IFTTT_20170207.DeleteIdentity', {});
  assert.equal(missingField.status, 400);

  const notFound = await amz('IFTTT_20170207.DeleteIdentity', { identity: 'nope' });
  assert.equal(notFound.status, 404);
  assert.equal(notFound.errType, 'IDENTITY_NOT_FOUND');

  seedIdentity('idf-own', 'x', ['other-loop']);
  const foreign = await amz('IFTTT_20170207.DeleteIdentity', { identity: 'idf-own' });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.errType, 'IDENTITY_ONLY_ACCESSIBLE_BY_OWNER');

  seedIdentity('idf-del', 'x', ['loop-acct-1']);
  store.createTrigger({ identity: 'idf-del', text: 't' });
  store.createMedia({ identity: 'idf-del', encryptedUrl: 'enc://del' });
  store.updateMedia({ encryptedUrl: 'enc://del', decryptedUrl: 'dec://del' });
  const ok = await amz('IFTTT_20170207.DeleteIdentity', { identity: 'idf-del' });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { result: 'Command accepted' });
  assert.equal(store.findIdentity('idf-del'), null);
  assert.equal(store.triggers.length, 0);
  assert.equal(store.media.length, 0);
  assert.deepEqual(keyCalls, [{ op: 'removeBinaries', encryptedUrls: ['enc://del'] }]);
});

test('unknown ifttt operation -> ValidationException', async () => {
  const r = await amz('IFTTT_20170207.Frobnicate', {});
  assert.equal(r.status, 400);
  assert.equal(r.errType, 'ValidationException');
});

test('default adapters: Trigger is served and the dead IFTTT notify is recorded, never faked', async () => {
  const internal = defaultEntrypoint.iftttStore;
  internal.findOrCreateIdentity({ identity: 'idf-d', filter: localPhoneticKey('hi'), loopIds: ['loop-acct-1'], refresh: true });
  const r = await amzDefault('IFTTT_20170207.Trigger', { text: 'hi' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { result: 'Command accepted' });
  assert.equal(internal.triggers.length, 1);
  assert.equal(internal.notifications.length, 1);
  assert.equal(internal.notifications[0].outcome.delivered, false);
  assert.match(internal.notifications[0].outcome.reason, /IFTTT/);
});
