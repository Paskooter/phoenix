// Push_20160729 — device registration (CreateDevice/RemoveDevice), durable ownership,
// and notification delivery behind a replaceable provider.
//
// Grounded in jiborobot/srv-push-ws (master): AccountController.createDevice /
// removeDevice / removeDeviceByToken / listDevices, the AccountPush Mongo doc, the
// handler @validatePayload decorators (Boom.badData -> 422), MobileController.send
// (provider failure contained), and the PushTokenNotRegistered downstream removal.
// The real APNs/FCM providers and credentials are dead, so delivery is exercised
// through a FixturePushProvider; no live mobile client exists (see report).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClassicEntrypoint } from '../src/index.js';
import { DeviceRegistry, makePushHandler, FixturePushProvider } from '../src/push.js';

let server; let port;
let dir;
function amz(target, body, accessKeyId) {
  return fetch(`http://localhost:${port}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': target,
      ...(accessKeyId ? { authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/20260613/us-east-1/push/aws4_request, SignedHeaders=host, Signature=ff` } : {}),
    },
    body: JSON.stringify(body || {}),
  }).then(async (res) => ({
    status: res.status,
    errType: res.headers.get('x-amzn-errortype'),
    body: await res.json().catch(() => null),
  }));
}

const device = (name, pushToken, type) => ({ name, pushToken, type });

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-push-test-'));
  const registry = new DeviceRegistry(join(dir, 'devices.json'));
  const entry = createClassicEntrypoint({
    extra: [{ match: /^push/i, handler: makePushHandler(registry) }],
  });
  server = await entry.listen(0);
  port = server.address().port;
  // Keep the temp store for the process; tests that need clean state use unit-level stores.
  after(() => { rmSync(dir, { recursive: true, force: true }); });
});

after(() => { if (server) server.close(); });

// ---- device creation / removal over the wire -----------------------------------

test('push: CreateDevice returns the active Devices list including the new device', async () => {
  const reg = await amz('Push_20160729.CreateDevice', { name: 'phone-1', pushToken: 'apns-tok', type: 'ios' }, 'acct-C');
  assert.equal(reg.status, 200);
  assert.deepEqual(reg.body, [device('phone-1', 'apns-tok', 'ios')]);
  // a second device appends
  const reg2 = await amz('Push_20160729.CreateDevice', { name: 'phone-2', pushToken: 'fcm-tok', type: 'android' }, 'acct-C');
  assert.equal(reg2.status, 200);
  assert.deepEqual(reg2.body, [device('phone-1', 'apns-tok', 'ios'), device('phone-2', 'fcm-tok', 'android')]);
});

test('push: re-registering an existing name upserts pushToken and revives a removed device', async () => {
  const upsert = await amz('Push_20160729.CreateDevice', { name: 'phone-1', pushToken: 'apns-tok-2', type: 'android' }, 'acct-C');
  assert.equal(upsert.status, 200);
  assert.deepEqual(upsert.body, [device('phone-1', 'apns-tok-2', 'ios'), device('phone-2', 'fcm-tok', 'android')]);
  // remove then re-create: isDeleted=false on the existing row
  await amz('Push_20160729.RemoveDevice', { name: 'phone-2' }, 'acct-C');
  const revived = await amz('Push_20160729.CreateDevice', { name: 'phone-2', pushToken: 'fcm-tok', type: 'android' }, 'acct-C');
  assert.deepEqual(revived.body, [device('phone-1', 'apns-tok-2', 'ios'), device('phone-2', 'fcm-tok', 'android')]);
});

test('push: RemoveDevice returns the remaining active list and drops the device', async () => {
  const rm = await amz('Push_20160729.RemoveDevice', { name: 'phone-1' }, 'acct-C');
  assert.equal(rm.status, 200);
  assert.deepEqual(rm.body, [device('phone-2', 'fcm-tok', 'android')]);
});

test('push: CreateDevice validation is 422 (source Boom.badData) for missing/invalid fields', async () => {
  for (const bad of [
    {},
    { name: 'x' },
    { name: 'x', pushToken: 't' },
    { name: 'x', pushToken: 't', type: 'windows' },
  ]) {
    const r = await amz('Push_20160729.CreateDevice', bad, 'acct-C');
    assert.equal(r.status, 422, JSON.stringify(bad));
    assert.equal(r.body.error, 'Unprocessable Entity');
  }
  // a valid payload with an extra member still succeeds (Joi allowUnknown)
  const ok = await amz('Push_20160729.CreateDevice', { name: 'phone-3', pushToken: 't3', type: 'ios', extra: 1 }, 'acct-C');
  assert.equal(ok.status, 200);
});

test('push: RemoveDevice missing name is 422; unknown device and unknown account are 404', async () => {
  const missing = await amz('Push_20160729.RemoveDevice', {}, 'acct-C');
  assert.equal(missing.status, 422);
  const missingAccount = await amz('Push_20160729.RemoveDevice', { name: 'never' }, 'acct-ghost');
  assert.equal(missingAccount.status, 404);
  assert.equal(missingAccount.errType, 'ACCOUNT_NOT_FOUND');
  const missingDevice = await amz('Push_20160729.RemoveDevice', { name: 'phone-4' }, 'acct-C');
  assert.equal(missingDevice.status, 404);
  assert.equal(missingDevice.errType, 'DEVICE_NOT_FOUND');
});

test('push: devices are owned per-account and a pushToken is single-owner (stale-token pull)', async () => {
  await amz('Push_20160729.CreateDevice', { name: 'borrower', pushToken: 'shared-tok', type: 'ios' }, 'acct-D');
  const owner = await amz('Push_20160729.CreateDevice', { name: 'owner-phone', pushToken: 'shared-tok', type: 'ios' }, 'acct-C');
  assert.deepEqual(owner.body, [device('phone-2', 'fcm-tok', 'android'), device('phone-3', 't3', 'ios'), device('owner-phone', 'shared-tok', 'ios')]);
  // acct-D's borrower device was pulled from the other account (source removeStalePushTokens)
  const other = await amz('Push_20160729.CreateDevice', { name: 'other', pushToken: 'other-tok', type: 'ios' }, 'acct-D');
  assert.deepEqual(other.body, [device('other', 'other-tok', 'ios')]);
});

test('push: unknown operation is rejected', async () => {
  const r = await amz('Push_20160729.Frobnicate', {}, 'acct-C');
  assert.equal(r.status, 400);
  assert.equal(r.errType, 'ValidationException');
});

// ---- durable registration ------------------------------------------------------

test('push: registrations persist across registry instances (atomic file store)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-push-durable-'));
  const file = join(dir, 'devices.json');
  const first = new DeviceRegistry(file);
  first.createDevice('acct-P', { name: 'persist', pushToken: 'tok-p', type: 'android' });
  first.removeDevice('acct-P', 'persist');
  first.createDevice('acct-P', { name: 'persist', pushToken: 'tok-p2', type: 'android' });
  const reopened = new DeviceRegistry(file);
  assert.deepEqual(reopened.activeDevices('acct-P'), [device('persist', 'tok-p2', 'android')]);
  rmSync(dir, { recursive: true, force: true });
});

test('push: a failed durability write rejects the mutation and rolls back (no partial registration)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-push-fail-'));
  const file = join(dir, 'devices.json');
  const registry = new DeviceRegistry(file, {
    persistence: {
      writeFile: () => { const e = new Error('disk full'); e.code = 'ENOSPC'; throw e; },
      rename: () => { const e = new Error('disk full'); e.code = 'ENOSPC'; throw e; },
    },
  });
  assert.throws(() => registry.createDevice('acct-F', { name: 'd', pushToken: 't', type: 'ios' }), /disk full/);
  assert.deepEqual(registry.activeDevices('acct-F'), [], 'mutation must not survive a failed write');
  rmSync(dir, { recursive: true, force: true });
});

// ---- delivery behind a replaceable provider -----------------------------------

test('push: sendNotification delivers to every active device through the fixture provider', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-push-deliver-'));
  const registry = new DeviceRegistry(join(dir, 'devices.json'));
  registry.createDevice('acct-M', { name: 'ios-dev', pushToken: 'apns-1', type: 'ios' });
  registry.createDevice('acct-M', { name: 'and-dev', pushToken: 'fcm-1', type: 'android' });
  const sent = [];
  const provider = new FixturePushProvider({ sent });
  await registry.sendNotification('acct-M', { body: 'New photo', data: { loopId: 'L1' } }, provider);
  assert.equal(sent.length, 2);
  assert.deepEqual(
    sent.map(({ device, notification }) => ({ device, notification })),
    [
      { device: device('ios-dev', 'apns-1', 'ios'), notification: { body: 'New photo', data: { loopId: 'L1' } } },
      { device: device('and-dev', 'fcm-1', 'android'), notification: { body: 'New photo', data: { loopId: 'L1' } } },
    ],
  );
  rmSync(dir, { recursive: true, force: true });
});

test('push: provider failure is contained and does not stop other deliveries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-push-faildeliver-'));
  const registry = new DeviceRegistry(join(dir, 'devices.json'));
  registry.createDevice('acct-N', { name: 'a', pushToken: 'ta', type: 'ios' });
  registry.createDevice('acct-N', { name: 'b', pushToken: 'tb', type: 'android' });
  let calls = 0;
  const failing = {
    setInvalidTokenHandler() {},
    async send() { calls += 1; if (calls === 1) throw new Error('APNs transport down'); return { success: true }; },
  };
  await registry.sendNotification('acct-N', { body: 'x' }, failing); // must resolve, not reject
  assert.equal(calls, 2, 'all devices still attempted');
  rmSync(dir, { recursive: true, force: true });
});

test('push: a provider-reported invalid token removes the device (downstream effect)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-push-invalid-'));
  const registry = new DeviceRegistry(join(dir, 'devices.json'));
  registry.createDevice('acct-M', { name: 'stale', pushToken: 'dead-tok', type: 'android' });
  registry.createDevice('acct-M', { name: 'keeper', pushToken: 'live-tok', type: 'ios' });
  const provider = new FixturePushProvider({ invalidTokens: ['dead-tok'] });
  await registry.sendNotification('acct-M', { body: 'nudge' }, provider);
  assert.deepEqual(registry.activeDevices('acct-M'), [device('keeper', 'live-tok', 'ios')], 'invalid token removed, others kept');
  rmSync(dir, { recursive: true, force: true });
});

test('push: removeDeviceByToken pulls the token from every account', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-push-token-'));
  const registry = new DeviceRegistry(join(dir, 'devices.json'));
  registry.createDevice('acct-A', { name: 'a1', pushToken: 'dup', type: 'ios' });
  registry.createDevice('acct-B', { name: 'b1', pushToken: 'dup', type: 'ios' });
  registry.removeDeviceByToken('dup');
  assert.deepEqual(registry.activeDevices('acct-A'), []);
  assert.deepEqual(registry.activeDevices('acct-B'), []);
  rmSync(dir, { recursive: true, force: true });
});