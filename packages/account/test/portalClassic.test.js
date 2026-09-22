// Portal surfaces 6–9 through the real Classic entrypoint: media/gallery, robot read state,
// people + voicetraining, jot, notifications, push registrations, OTA/update status and IFTTT.
// The portal signs every classic call with the logged-in account's keys, exactly like the app.
// Fixture accounts/secrets only; stores live in temp dirs, no network besides localhost.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, openSync, writeFileSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';

const dir = mkdtempSync(join(tmpdir(), 'phx-portal-classic-'));

const { createAccountService, Store } = await import('../src/index.js');
const { createOwnerAccount, createLoop } = await import('../src/model.js');
const { createClassicEntrypoint, MediaStore, PersonStore, JotStore, DeviceRegistry } = await import('../../classic/src/index.js');
const { VoiceTrainingStore } = await import('../../classic/src/index.js');
const { createOtaService } = await import('../../ota/src/service.js');
const { Catalog } = await import('../../ota/src/catalog.js');

let owner; let loop; let robot; let accountStore;
let mediaStore; let personStore; let jotStore; let vtStore; let pushRegistry;
let accountServer; let classicServer; let otaServer; let classic;
let base;
const jars = new Map();

async function call(method, path, body, jar = 'owner') {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(jars.get(jar) ? { cookie: jars.get(jar) } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) jars.set(jar, setCookie.split(';')[0]);
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function otaEntryFile() {
  const parent = join(dir, 'ota');
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const file = join(parent, 'pkg.bin');
  const fd = openSync(file, 'w');
  writeFileSync(fd, 'ota-package-bytes');
  closeSync(fd);
  return file;
}

before(async () => {
  const accountDir = join(dir, 'account');
  accountStore = new Store(join(accountDir, 'store.json'));
  owner = createOwnerAccount(accountStore, { email: 'portal-classic@fixture.test', password: 'classic-pass-1', firstName: 'Portal' });
  ({ loop, robot } = createLoop(accountStore, { owner, robotId: 'classic-fixture-robot' }));
  accountStore.flush();

  mediaStore = new MediaStore({ directory: join(dir, 'media'), file: join(dir, 'media.json') });
  await mediaStore.putObject({
    path: 'alpha123', type: 'image', accountId: owner._id, loopId: loop._id,
    url: 'http://classic/media/blob/alpha123', created: 1700000000000,
    meta: {}, isEncrypted: false, isDeleted: false, thumbs: [],
  }, Readable.from([Buffer.from('fresh-media-bytes')]));

  personStore = new PersonStore({ file: join(dir, 'person.json') });
  jotStore = new JotStore({ file: join(dir, 'jot.json') });
  vtStore = new VoiceTrainingStore({ file: join(dir, 'vt.json') });
  pushRegistry = new DeviceRegistry(join(dir, 'push.json'));
  pushRegistry.createDevice(owner.accessKeyId, { name: 'test-phone', pushToken: 'tok-1', type: 'android' });

  classic = createClassicEntrypoint({
    media: { store: mediaStore },
    person: { store: personStore },
    jot: { store: jotStore, pushRegistry },
    voiceTraining: { store: vtStore },
  });
  classicServer = await classic.listen(0);
  const classicPort = classicServer.address().port;

  const pkgFile = await otaEntryFile();
  const catalog = await Catalog.load({
    dataDir: join(dir, 'ota'),
    entries: [{ id: 'upd-1', subsystem: 'main', toVersion: '13.0.0', file: 'pkg.bin' }],
  });
  otaServer = await createOtaService({ catalog }).listen(0);
  process.env.NET_ota = `127.0.0.1:${otaServer.address().port}`;
  process.env.NET_classic = `127.0.0.1:${classicPort}`;

  accountServer = await createAccountService({ store: accountStore }).listen(0);
  base = `http://127.0.0.1:${accountServer.address().port}`;
  const login = await call('POST', '/api/login', { email: owner.email, password: 'classic-pass-1' }, 'owner');
  assert.equal(login.status, 200);
});

after(async () => {
  if (accountServer?.listening) await new Promise((resolve) => accountServer.close(resolve));
  if (classicServer?.listening) await new Promise((resolve) => classicServer.close(resolve));
  if (otaServer?.listening) await new Promise((resolve) => otaServer.close(resolve));
  delete process.env.NET_classic;
  delete process.env.NET_ota;
  rmSync(dir, { recursive: true, force: true });
});

test('signature travel: the portal uses the account credentials, never forges identity', async () => {
  const robot = await call('GET', `/api/robot?loopId=${encodeURIComponent(loop._id)}`);
  assert.equal(robot.status, 200);
  assert.equal(robot.body.robot.friendlyId, 'classic-fixture-robot');
  // Legacy/adopted Account robots may not have a manufacturing lifecycle
  // record. Their verified owner gets the bounded empty bootstrap projection,
  // rather than a misleading Robot_20160225 404 in the console.
  assert.deepEqual(robot.body.getRobot, { id: 'classic-fixture-robot', payload: {} });
  assert.deepEqual(robot.body.connection, { connected: false });
  assert.equal(robot.body.diagnostics, undefined);
});

test('robot cards report notification-socket presence and persist the observation time', async () => {
  const offline = await call('GET', '/api/robots');
  const offlineRobot = offline.body.find((entry) => entry.friendlyId === robot.friendlyId);
  assert.equal(offline.status, 200);
  assert.deepEqual(offlineRobot.connection, { connected: false });
  assert.equal(offlineRobot.lastSeen, null);

  classic.hub.newRobotToken(robot._id, 'portal-status-test');
  classic.hub.store.markConnected({ accountId: robot._id });
  const online = await call('GET', '/api/robots');
  const onlineRobot = online.body.find((entry) => entry.friendlyId === robot.friendlyId);
  assert.deepEqual(onlineRobot.connection, { connected: true });
  assert.ok(Number.isSafeInteger(onlineRobot.lastSeen));
  assert.equal(accountStore.accounts.get(robot._id).lastSeen, onlineRobot.lastSeen);
});

test('gallery: list seeded media through Classic Media_20160725, serve its bytes, then delete', async () => {
  const list = await call('GET', `/api/media?loopId=${encodeURIComponent(loop._id)}`);
  assert.equal(list.status, 200);
  const row = list.body.media.find((m) => m.path === 'alpha123');
  assert.ok(row, 'seeded row listed');
  assert.equal(row.type, 'image');

  const blob = await fetch(`${base}/api/media/blob/alpha123`, { headers: { cookie: jars.get('owner') } });
  assert.equal(blob.status, 200);
  assert.equal(await blob.text(), 'fresh-media-bytes');

  const removed = await call('POST', '/api/media/remove', { loopId: loop._id, paths: ['alpha123'] });
  assert.equal(removed.status, 200);
  const after = await call('GET', `/api/media?loopId=${encodeURIComponent(loop._id)}`);
  assert.ok(!after.body.media.some((m) => m.path === 'alpha123' && !m.isDeleted));
});

test('jot: list (empty), create a recipient-tagged message, list has it', async () => {
  const beforeJot = await call('GET', `/api/jot?loopId=${encodeURIComponent(loop._id)}`);
  assert.equal(beforeJot.status, 200);
  assert.deepEqual(beforeJot.body.messages, []);

  const created = await call('POST', '/api/jot/message', {
    loopId: loop._id, content: 'Hi from the portal', tags: [owner._id],
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.message.content, 'Hi from the portal');
  assert.deepEqual(created.body.message.tags, [owner._id]);

  const afterJot = await call('GET', `/api/jot?loopId=${encodeURIComponent(loop._id)}`);
  assert.equal(afterJot.body.messages.length, 1);
  assert.equal(afterJot.body.messages[0].content, 'Hi from the portal');
  assert.deepEqual(afterJot.body.messages[0].tags, [owner._id]);
});

test('people: person catalog + voice-training enrolment surface answers cleanly', async () => {
  const people = await call('GET', `/api/people?loopId=${encodeURIComponent(loop._id)}`);
  assert.equal(people.status, 200);
  assert.ok(Array.isArray(people.body.answers));
  assert.ok(Array.isArray(people.body.holidays));
  assert.ok(Array.isArray(people.body.voiceTraining));
  assert.ok(typeof people.body.accountProperties === 'object');
});

test('push registrations: list the registered device, then remove it', async () => {
  const list = await call('GET', '/api/push');
  assert.equal(list.status, 200);
  const device = (list.body.devices || []).find((d) => d.name === 'test-phone');
  assert.ok(device, 'device registered under the account key is listed');
  assert.equal(device.type, 'android');

  const removed = await call('POST', '/api/push/remove', { name: 'test-phone' });
  assert.equal(removed.status, 200);
  const after = await call('GET', '/api/push');
  assert.ok(!(after.body.devices || []).some((d) => d.name === 'test-phone'));
});

test('notification status answers (the socket face)', async () => {
  const n = await call('GET', '/api/notifications');
  assert.equal(n.status, 200);
  assert.ok('status' in n.body);
});

test('OTA update status surfaces the catalog through the classic update proxy', async () => {
  const upd = await call('GET', '/api/update/status');
  assert.equal(upd.status, 200);
  assert.ok(Array.isArray(upd.body.updates));
  assert.ok(upd.body.updates.some((u) => u.toVersion === '13.0.0'));
});

test('the global OAuth client registry is not exposed to an ordinary account', async () => {
  const r = await call('GET', '/api/oauthclients');
  assert.equal(r.status, 403);
});

test('IFTTT identity is reported (possibly with an honest diagnostic when unavailable)', async () => {
  const r = await call('GET', '/api/ifttt');
  assert.equal(r.status, 200);
  assert.ok(r.body.identity !== undefined);
  assert.ok(Array.isArray(r.body.applets));
});
