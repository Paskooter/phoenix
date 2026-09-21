// Browser Web Push: VAPID stays server-side, subscriptions stay account-scoped,
// and a household message can safely fan out without exposing its content.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { Store, WebPushService, createAccountService } = await import('../src/index.js');
const { createOwnerAccount, createLoop } = await import('../src/model.js');
const { createSession } = await import('../src/sessions.js');
const { portalMessagingRoutes } = await import('../src/portal/messaging.js');

const directory = mkdtempSync(join(tmpdir(), 'phx-web-push-'));
const store = new Store(join(directory, 'store.json'));
const owner = createOwnerAccount(store, { email: 'push-owner@fixture.test', password: 'push-owner-1' });
const recipient = createOwnerAccount(store, { email: 'push-recipient@fixture.test', password: 'push-recipient-1' });
const { loop } = createLoop(store, { owner, robotId: 'push-fixture-robot' });
loop.members.push({ _id: 'recipient-member', accountId: recipient._id, status: 'ACCEPTED', created: Date.now() });
store.flush();

const delivered = [];
let clock = 1700000000000;
const webPush = new WebPushService({
  store,
  config: {
    enabled: true,
    publicKey: 'a'.repeat(87),
    privateKey: 'b'.repeat(43),
    subject: 'mailto:ops@fixture.test',
    endpointHosts: ['fcm.googleapis.com'],
  },
  sender: async (subscription, payload, options) => { delivered.push({ subscription, payload, options }); },
  clock: () => clock,
});

const browserSubscription = (suffix = 'one') => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/${suffix}`,
  keys: { p256dh: 'c'.repeat(87), auth: 'd'.repeat(24) },
});

function response() {
  return {
    statusCode: 200,
    body: undefined,
    status(statusCode) { this.statusCode = statusCode; return this; },
    json(body) { this.body = body; return this; },
  };
}

function sessionRequest(account) {
  const session = createSession(store, { kind: 'user', accountId: account._id });
  return { headers: { cookie: `phx_session=${session._id}` } };
}

after(() => rmSync(directory, { recursive: true, force: true }));

test('subscription endpoints are provider-restricted, private, and move with a browser account', () => {
  const first = webPush.subscribe(owner._id, browserSubscription(), 'Owner phone');
  assert.equal(first.label, 'Owner phone');
  assert.equal(Object.hasOwn(first, 'endpoint'), false);
  assert.equal(store.webPushSubscriptions.size, 1);

  const status = webPush.status(owner._id);
  assert.equal(status.available, true);
  assert.equal(status.publicKey, 'a'.repeat(87));
  assert.equal(JSON.stringify(status).includes('fcm/send'), false);
  assert.equal(JSON.stringify(status).includes('c'.repeat(30)), false);

  assert.throws(() => webPush.subscribe(owner._id, {
    endpoint: 'https://127.0.0.1/private', keys: browserSubscription().keys,
  }), /approved browser push service/);

  webPush.subscribe(recipient._id, browserSubscription(), 'Recipient phone');
  assert.equal(webPush.list(owner._id).length, 0);
  assert.equal(webPush.list(recipient._id).length, 1);
  assert.equal(store.webPushSubscriptions.size, 1);
});

test('expired subscriptions are removed and test delivery is rate limited', async () => {
  webPush.subscribe(owner._id, browserSubscription('owner'), 'Owner phone');
  const expired = new WebPushService({
    store,
    config: { enabled: true, publicKey: 'a'.repeat(87), privateKey: 'b'.repeat(43), subject: 'mailto:ops@fixture.test', endpointHosts: ['fcm.googleapis.com'] },
    sender: async () => { const error = new Error('gone'); error.statusCode = 410; throw error; },
    clock: () => clock,
  });
  const result = await expired.notifyAccounts([owner._id], { title: 'test', body: 'test', url: '/app' });
  assert.equal(result.expired, 1);
  assert.equal(webPush.list(owner._id).length, 0);

  webPush.subscribe(owner._id, browserSubscription('owner-again'), 'Owner phone');
  delivered.length = 0;
  await webPush.sendTest(owner._id);
  await webPush.sendTest(owner._id);
  await webPush.sendTest(owner._id);
  await assert.rejects(() => webPush.sendTest(owner._id), (error) => error.statusCode === 429);
  assert.equal(delivered.length, 3);
  clock += (60 * 60 * 1000) + 1;
});

test('Jot fans out a content-free browser notification only to accepted household members', async () => {
  webPush.unsubscribe(recipient._id, browserSubscription());
  webPush.subscribe(recipient._id, browserSubscription('recipient'), 'Recipient phone');
  delivered.length = 0;
  const routes = portalMessagingRoutes(store, {
    webPush,
    classicCall: async ({ target, body }) => {
      assert.equal(target, 'Jot_20160512.CreateMessage');
      return { body: { loopId: body.loopId, content: body.content } };
    },
  });
  const res = response();
  const created = await routes['POST /api/jot/message']({
    req: sessionRequest(owner), res, body: { loopId: loop._id, content: 'private household message' },
  });
  assert.equal(created.message.content, 'private household message');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].payload.title, 'New household message');
  assert.equal(delivered[0].payload.body.includes('private household message'), false);
  assert.equal(delivered[0].payload.url, '/app#/messaging');
  assert.equal(delivered[0].subscription.endpoint.endsWith('/recipient'), true);
});

test('the browser API requires a session and never serializes endpoint capabilities', async () => {
  const service = await createAccountService({ store, webPushService: webPush }).listen(0);
  const base = `http://127.0.0.1:${service.address().port}`;
  try {
    const anonymous = await fetch(`${base}/api/web-push`);
    assert.equal(anonymous.status, 401);

    const login = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: owner.email, password: 'push-owner-1' }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const state = await fetch(`${base}/api/web-push`, { headers: { cookie } });
    assert.equal(state.status, 200);
    const body = await state.json();
    assert.equal(body.available, true);
    assert.equal(JSON.stringify(body).includes('fcm/send'), false);
    assert.equal(JSON.stringify(body).includes('c'.repeat(30)), false);

    const rejected = await fetch(`${base}/api/web-push/subscribe`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ subscription: { endpoint: 'https://127.0.0.1/private', keys: browserSubscription().keys } }),
    });
    assert.equal(rejected.status, 400);
  } finally {
    await new Promise((resolve) => service.close(resolve));
  }
});
