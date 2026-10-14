import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.PHOENIX_ENV_FILE = '/dev/null';
const { DefaultPort } = await import('../../contracts/src/index.js');
for (const service of Object.keys(DefaultPort)) process.env[`NET_${service}`] = 'http://127.0.0.1:9';
const { createAccountService, Store } = await import('../src/index.js');
const { createLoop, createOwnerAccount } = await import('../src/model.js');
const { SIDE_COLLECTIONS } = await import('../src/admin/removalRoutes.js');
const { markEmailVerified } = await import('../src/emailVerification.js');
const { createClassicEntrypoint, createVerifiedClassicCaller, KeyStore, PersonStore, RobotStore } = await import('../../classic/src/index.js');
const { HistoryStore } = await import('../../history/src/store.js');
const { createHistoryService } = await import('../../history/src/index.js');

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'phx-owner-removal-'));
  const servers = [];
  const store = new Store(join(dir, 'account.json'));
  const owner = createOwnerAccount(store, { email: 'owner@fixture.test', password: 'Fixture-password-1' });
  const member = createOwnerAccount(store, { email: 'member@fixture.test', password: 'Fixture-password-1' });
  const stranger = createOwnerAccount(store, { email: 'stranger@fixture.test', password: 'Fixture-password-1' });
  for (const person of [owner, member, stranger]) markEmailVerified(person);
  const { loop, robot } = createLoop(store, { owner, robotId: 'Cedar-Cove-Maple-Wren' });
  loop.name = 'Living room';
  loop.members.push({ _id: 'fixture-member', accountId: member._id, status: 'accepted' });
  const kept = createLoop(store, { owner: stranger, robotId: 'Birch-Pond-Robin-Fern' });
  for (const name of SIDE_COLLECTIONS) {
    store[name].set(`removed-${name}`, { accountId: robot._id, loopId: loop._id, bindings: [], expiresAt: Date.now() + 60_000 });
    store[name].set(`kept-${name}`, { accountId: owner._id, bindings: [], expiresAt: Date.now() + 60_000 });
  }
  store.settings.set(robot._id, { news: false });
  store.settings.set(owner._id, { news: true });
  store.flush();
  process.env.PHOENIX_DATA_DIR = dir;
  process.env.HUB_TOKEN_SECRET = 'fixture-hub-secret';
  process.env.ETCO_account_internalPeerToken = 'fixture-removal-peer-token';
  process.env.ETCO_classic_accountDataFile = store.file;
  const robots = new RobotStore({ dir: join(dir, 'robots') });
  const keys = new KeyStore(join(dir, 'keys.json'));
  const people = new PersonStore({ file: join(dir, 'people.json') });
  for (const current of [loop, kept.loop]) {
    const id = store.accounts.get(current.robot).friendlyId;
    robots.append({ objectId: id, name: 'RobotCreated', created: Date.now(), payload: {} });
    keys.backup({ loopId: current._id, accountId: current.owner, encryptedKey: Buffer.alloc(48, 1).toString('base64'), passwordHash: 'a'.repeat(40) });
    people.saveLoopProperty({ loopId: current._id, key: 'customHolidays', value: { holidays: [] }, updatedAccountId: current.owner });
  }
  const classic = await createClassicEntrypoint({
    publicUrl: 'http://classic.fixture.test',
    callerBoundary: createVerifiedClassicCaller({ resolveCredentials: (id) => store.accountByAccessKeyId(id) }),
    robotStore: robots, keyStore: keys, person: { store: people },
    notificationFile: join(dir, 'notifications.json'), log: { dir: join(dir, 'logs') }, backup: { dir: join(dir, 'backups') },
  }).listen(0, '127.0.0.1');
  servers.push(classic);
  process.env.NET_classic = `http://127.0.0.1:${classic.address().port}`;
  const history = new HistoryStore(join(dir, 'history.json'));
  history.addSkillLaunch({ robotID: robot.friendlyId, skillID: '@be/clock', sessionID: 'fixture-session', personIDs: [] });
  const historyServer = await createHistoryService(history).listen(0, '127.0.0.1');
  servers.push(historyServer);
  process.env.NET_history = `http://127.0.0.1:${historyServer.address().port}`;
  let robotCalls = 0;
  const account = await createAccountService({ store, notificationPublisher: () => { robotCalls += 1; throw new Error('Robot contact is forbidden'); } }).listen(0, '127.0.0.1');
  servers.push(account);
  const base = `http://127.0.0.1:${account.address().port}`;
  const cookies = {};
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.hostname, '127.0.0.1', 'no external or robot contact');
    requests.push({ path: parsed.pathname, body: options?.body ? JSON.parse(options.body) : null });
    return originalFetch(url, options);
  };
  t.after(async () => {
    globalThis.fetch = originalFetch;
    for (const server of servers.reverse()) await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  const call = async (who, path, body, headers = {}) => {
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(cookies[who] ? { cookie: cookies[who] } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.headers.get('set-cookie')) cookies[who] = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, body: await response.json() };
  };
  for (const who of ['owner', 'member', 'stranger']) {
    assert.equal((await call(who, '/api/login', { email: `${who}@fixture.test`, password: 'Fixture-password-1' })).status, 200);
  }
  requests.length = 0;
  const setupRobot = async (body) => {
    const response = await fetch(`${base}/`, { method: 'POST',
      headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'OOBE.SetupRobot' },
      body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { dir, store, owner, member, stranger, loop, robot, kept, robots, keys, history, requests, call, setupRobot, robotCalls: () => robotCalls };
}

const previewPath = '/api/robot/removal/preview';
const removePath = '/api/robot/removal';

test('owner previews and removes an offline Jibo with peer purges and backups, without contacting a robot', async (t) => {
  const f = await fixture(t);
  assert.equal(f.robot.lastSeen, undefined, 'robot has never connected');
  const preview = await f.call('owner', previewPath, { loopId: f.loop._id });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.confirmWith, f.loop.name);
  assert.equal(preview.body.account.robot.friendlyId, f.robot.friendlyId);
  assert.equal(preview.body.account.loops[0].name, f.loop.name);
  assert.equal(preview.body.services.find((entry) => entry.service === 'history').stores[0].removed.skillLaunches, 1);
  assert.doesNotMatch(JSON.stringify(preview.body), /ownerEmail|secretAccessKey|accessKeyId|backupDir|fixture\.test/);
  assert.ok(f.store.accounts.has(f.robot._id), 'preview does not remove anything');
  const result = await f.call('owner', removePath, { loopId: f.loop._id, confirm: f.loop.name });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.removed, true);
  assert.doesNotMatch(JSON.stringify(result.body), /backupDir|secretAccessKey|ownerEmail/);
  assert.equal(f.store.accountByFriendlyId(f.robot.friendlyId), null);
  assert.equal(f.store.loops.has(f.loop._id), false);
  assert.equal(new Store(f.store.file).accountByAccessKeyId(f.robot.accessKeyId), null);
  for (const name of SIDE_COLLECTIONS) {
    assert.equal(f.store[name].has(`removed-${name}`), false, name);
    assert.equal(f.store[name].has(`kept-${name}`), true, name);
  }
  assert.ok(f.store.accounts.has(f.owner._id));
  assert.ok(f.store.accounts.has(f.member._id));
  assert.ok(f.store.accounts.has(f.kept.robot._id));
  assert.ok(f.store.loops.has(f.kept.loop._id));
  assert.equal(f.store.settings.has(f.robot._id), false);
  assert.equal(f.store.settings.has(f.owner._id), true);
  assert.equal(f.robots.eventsFor(f.robot.friendlyId).length, 0);
  assert.equal(f.keys.backups.has(f.loop._id), false);
  assert.equal(f.history.skillLaunches.length, 0);
  const backups = readdirSync(join(f.dir, 'removal-backups'));
  for (const service of ['account', 'classic', 'history']) assert.ok(backups.some((name) => name.endsWith(`-${service}`)), service);
  const accountBackup = join(f.dir, 'removal-backups', backups.find((name) => name.endsWith('-account')), 'store.json');
  assert.ok(existsSync(accountBackup));
  const audit = JSON.parse(readFileSync(join(accountBackup, '..', 'removal.json'), 'utf8'));
  assert.equal(audit.actorId, f.owner._id);
  assert.equal(audit.completed, true);
  assert.equal(audit.source, 'owner');
  assert.match(readFileSync(accountBackup, 'utf8'), new RegExp(f.robot.accessKeyId));
  assert.equal(f.robotCalls(), 0);
  assert.ok(f.requests.every((request) => [previewPath, removePath, '/internal/admin/purge'].includes(request.path)), JSON.stringify(f.requests));
});


test('members and strangers get the same not-found response as unknown robots and remove nothing', async (t) => {
  const f = await fixture(t);
  for (const who of ['member', 'stranger']) {
    for (const path of [previewPath, removePath]) {
      const unknown = await f.call(who, path, { loopId: 'unknown-loop', confirm: f.loop.name });
      const foreign = await f.call(who, path, { loopId: f.loop._id, confirm: f.loop.name });
      assert.deepEqual(foreign, { status: 404, body: { error: 'Owned robot not found' } });
      assert.deepEqual(foreign, unknown);
    }
  }
  assert.ok(f.store.accounts.has(f.robot._id));
  assert.ok(f.store.loops.has(f.loop._id));
  assert.equal(f.requests.filter((entry) => entry.path === '/internal/admin/purge').length, 0);
  assert.equal(existsSync(join(f.dir, 'removal-backups')), false);
});

test('owner removal requires a portal session and same-origin requests', async (t) => {
  const f = await fixture(t);
  for (const path of [previewPath, removePath]) {
    assert.equal((await f.call('anonymous', path, { loopId: f.loop._id })).status, 401);
    assert.equal((await f.call('owner', path, { loopId: f.loop._id, confirm: f.loop.name }, { origin: 'https://foreign.fixture.test' })).status, 403);
  }
  assert.ok(f.store.accounts.has(f.robot._id));
  assert.equal(f.requests.filter((entry) => entry.path === '/internal/admin/purge').length, 0);
});

test('owner removal refuses missing or incorrect typed names before backups or peer purges', async (t) => {
  const f = await fixture(t);
  for (const confirm of [undefined, '', 'wrong', f.robot.friendlyId, 123]) {
    const result = await f.call('owner', removePath, { loopId: f.loop._id, confirm });
    assert.equal(result.status, 400);
    assert.equal(result.body.error, `Type ${f.loop.name} to confirm the removal`);
  }
  assert.ok(f.store.accounts.has(f.robot._id));
  assert.equal(f.requests.filter((entry) => entry.path === '/internal/admin/purge').length, 0);
  assert.equal(existsSync(join(f.dir, 'removal-backups')), false);
});

test('removed robot credentials no longer authenticate, including a previously issued hub identity', async (t) => {
  const f = await fixture(t);
  const credentials = { accessKeyId: f.robot.accessKeyId, secretAccessKey: f.robot.secretAccessKey };
  assert.equal((await f.call('owner', '/api/token', credentials)).status, 200);
  assert.equal((await f.call('owner', `/api/verify?accessKeyId=${credentials.accessKeyId}`)).body.valid, true);
  assert.equal((await f.call('owner', removePath, { loopId: f.loop._id, confirm: f.loop.name })).status, 200);
  assert.equal((await f.call('owner', '/api/token', credentials)).status, 401);
  assert.deepEqual((await f.call('owner', `/api/verify?accessKeyId=${credentials.accessKeyId}`)).body, { valid: false });
  assert.equal(f.store.accountByAccessKeyId(credentials.accessKeyId), null);
  assert.equal((await f.call('owner', '/api/me')).status, 200, 'human session stays valid');
});

test('a new owner can set up the removed robot from scratch with fresh credentials', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call('owner', removePath, { loopId: f.loop._id, confirm: f.loop.name })).status, 200);
  const setup = await f.call('stranger', '/api/robots/setup', { ssid: 'Fixture network', password: 'fixture-password' });
  assert.equal(setup.status, 200);
  // Exercise the real setup handler locally, not a store-level creation helper.
  const result = await f.setupRobot({ token: setup.body.token, id: f.robot.friendlyId });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const robot = f.store.accountByFriendlyId(f.robot.friendlyId);
  assert.ok(robot);
  assert.notEqual(robot._id, f.robot._id);
  assert.notEqual(robot.accessKeyId, f.robot.accessKeyId);
  assert.notEqual(robot.secretAccessKey, f.robot.secretAccessKey);
  assert.equal([...f.store.loops.values()].find((loop) => loop.robot === robot._id).owner, f.stranger._id);
  assert.equal((await f.call('stranger', '/api/token', { accessKeyId: robot.accessKeyId, secretAccessKey: robot.secretAccessKey })).status, 200);
});

test('deleted household ownership and a conflicting live owner cannot authorize removal', async (t) => {
  const f = await fixture(t);
  const snapshot = structuredClone(f.loop);
  f.loop.isDeleted = true;
  f.store.flush();
  assert.deepEqual(await f.call('owner', previewPath, { loopId: f.loop._id }), { status: 404, body: { error: 'Owned robot not found' } });
  f.store.loops.set(f.loop._id, snapshot);
  f.store.loops.set('fixture-conflicting-loop', { ...snapshot, _id: 'fixture-conflicting-loop', owner: f.stranger._id });
  f.store.flush();
  assert.equal((await f.call('owner', removePath, { loopId: f.loop._id, confirm: f.loop.name })).status, 404);
  assert.ok(f.store.accounts.has(f.robot._id));
  assert.equal(f.requests.filter((entry) => entry.path === '/internal/admin/purge').length, 0);
});

test('a required purge service failure keeps the robot account and its credentials', async (t) => {
  const f = await fixture(t);
  process.env.NET_classic = 'http://127.0.0.1:9';
  const preview = await f.call('owner', previewPath, { loopId: f.loop._id });
  assert.equal(preview.status, 502);
  assert.doesNotMatch(preview.body.error, /127\.0\.0\.1|classic|fetch|ECONN/);
  const removed = await f.call('owner', removePath, { loopId: f.loop._id, confirm: f.loop.name });
  assert.equal(removed.status, 502);
  assert.ok(f.store.accounts.has(f.robot._id));
  assert.ok(f.store.loops.has(f.loop._id));
  assert.equal((await f.call('owner', '/api/token', { accessKeyId: f.robot.accessKeyId, secretAccessKey: f.robot.secretAccessKey })).status, 200);
});

test('privacy explains that removal backups remain until the operator deletes them', () => {
  const privacy = readFileSync(new URL('../portal/privacy.html', import.meta.url), 'utf8');
  assert.match(privacy, /Removal backups stay until the person running Phoenix deletes them/);
});
