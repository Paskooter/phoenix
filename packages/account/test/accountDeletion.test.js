import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAccountService, Store } from '../src/index.js';
import { createLoop, createOwnerAccount, newId } from '../src/model.js';
import {
  createClassicEntrypoint, createVerifiedClassicCaller, JotStore, KeyStore, PersonStore, RobotStore,
} from '../../classic/src/index.js';
import { HistoryStore } from '../../history/src/store.js';
import { createHistoryService } from '../../history/src/index.js';

// Every name, address and id here is invented for this test.
const ENV = ['ETCO_classic_accountDataFile', 'NET_classic', 'NET_history', 'ETCO_account_internalPeerToken', 'PHOENIX_DATA_DIR',
  'ETCO_classic_backupDir', 'PHOENIX_DELETION_BACKUP_DAYS'];
const PHOTO = (key) => `https://photos.fixture.test/member-photos/${key}`;

const member = (accountId, memberProperties = {}) => ({
  _id: newId(), accountId, status: 'ACCEPTED', memberProperties, enrolled: { face: false, voice: false }, created: Date.now(),
});

async function household(t) {
  const dir = mkdtempSync(join(tmpdir(), 'phx-account-deletion-'));
  const prior = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
  const servers = [];
  t.after(async () => {
    for (const server of servers.reverse()) if (server.listening) await new Promise((resolve) => server.close(resolve));
    for (const [name, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const store = new Store(join(dir, 'account', 'store.json'));
  const admin = createOwnerAccount(store, { email: 'admin@fixture.test', password: 'admin-password-1' });
  admin.isAdmin = true;
  // Leaver owns the Amber loop and is a member of Stayer's Birch loop.
  const leaver = createOwnerAccount(store, { email: 'leaver@fixture.test', password: 'leaver-password-1', firstName: 'Leaver' });
  leaver.photoUrl = PHOTO('leaver-account');
  const stayer = createOwnerAccount(store, { email: 'stayer@fixture.test', password: 'stayer-password-1', firstName: 'Stayer' });
  stayer.photoUrl = PHOTO('stayer-account');
  // A child account from the original app: no email address, only in Leaver's loop.
  const child = { _id: newId(), email: null, friendlyId: null, firstName: 'Child', isActive: true, created: Date.now() };
  store.accounts.set(child._id, child);

  const amber = createLoop(store, { owner: leaver, robotId: 'Amber-Cliff-Hazel-Wren' });
  amber.loop.name = 'Leaver home';
  amber.loop.members.push(
    // An imported household can point a member entry at the account's own photo.
    member(stayer._id, { photoUrl: stayer.photoUrl }),
    member(child._id),
    member(undefined, { firstName: 'Guest', photoUrl: PHOTO('guest-member') }),
  );
  const birch = createLoop(store, { owner: stayer, robotId: 'Birch-Canyon-Otter-Lime' });
  birch.loop.name = 'Stayer home';
  birch.loop.members.push(member(leaver._id, { photoUrl: PHOTO('leaver-in-birch') }));
  // An invitation Leaver has not answered, and a loop Leaver left long ago.
  const invitedTo = createLoop(store, { owner: admin, robotId: 'Cedar-Harbor-Kite-Moss' });
  invitedTo.loop.name = 'Admin home';
  invitedTo.loop.members.push({ ...member(leaver._id, { email: 'leaver@fixture.test' }), status: 'INVITED' });
  const left = createLoop(store, { owner: admin, robotId: 'Delta-Frost-Ivy-Nook' });
  left.loop.name = 'Old loop';
  left.loop.members.push({ ...member(leaver._id), status: 'REMOVED' });
  store.settings.set(String(leaver._id), { _id: String(leaver._id), data: { report: 'theirs' } });
  store.settings.set(`lasso:${leaver._id}`, { _id: `lasso:${leaver._id}`, data: {} });
  store.settings.set(String(stayer._id), { _id: String(stayer._id), data: { report: 'kept' } });
  for (const account of [leaver, stayer]) {
    store.emailVerifications.set(account._id, {
      _id: account._id, email: account.email, tokenHash: 'a'.repeat(64),
      requests: [Date.now()], expiresAt: Date.now() + 60_000,
    });
  }
  store.flush();

  process.env.ETCO_classic_accountDataFile = store.file;
  process.env.ETCO_account_internalPeerToken = 'deletion-fixture-peer-token';
  process.env.PHOENIX_DATA_DIR = dir;
  process.env.ETCO_classic_backupDir = join(dir, 'classic', 'backups');
  delete process.env.PHOENIX_DELETION_BACKUP_DAYS;

  const L = String(leaver._id);
  const S = String(stayer._id);
  const birchId = String(birch.loop._id);
  const amberId = String(amber.loop._id);
  const jot = new JotStore({ file: join(dir, 'classic', 'jot.json') });
  const sent = jot.create({ sender: L, loopId: birchId, content: 'from leaver', tags: [S], read: [L, S] });
  const onlyForLeaver = jot.create({ sender: S, loopId: birchId, content: 'for leaver', tags: [L], read: [S, L] });
  const forEveryone = jot.create({ sender: S, loopId: birchId, content: 'for the loop', tags: [], read: [S, L] });
  jot.create({ sender: L, loopId: amberId, content: 'in the leaving loop', tags: [], read: [L] });
  const keys = new KeyStore(join(dir, 'classic', 'keys.json'));
  // Leaver made the Birch key backup while it was theirs; the loop's next owner still needs it.
  keys.backup({ loopId: birchId, accountId: L, encryptedKey: Buffer.alloc(48, 1).toString('base64'), passwordHash: 'a'.repeat(40) });
  keys.backup({ loopId: amberId, accountId: L, encryptedKey: Buffer.alloc(48, 2).toString('base64'), passwordHash: 'b'.repeat(40) });
  keys.create({ accountId: L, loopId: birchId, publicKey: 'leaver-public-key' });
  keys.create({ accountId: S, loopId: birchId, publicKey: 'stayer-public-key' });
  const person = new PersonStore({ file: join(dir, 'classic', 'person.json') });
  person.createAnswer({ accountId: L, key: 'favoriteColor', answer: 'green' });
  person.createAnswer({ accountId: S, key: 'favoriteColor', answer: 'blue' });
  person.saveLoopProperty({ loopId: birchId, key: 'customHolidays', value: { holidays: [] }, updatedAccountId: L });
  const robots = new RobotStore({ dir: join(dir, 'classic', 'robots') });
  for (const friendlyId of ['Amber-Cliff-Hazel-Wren', 'Birch-Canyon-Otter-Lime']) {
    robots.append({ objectId: friendlyId, name: 'RobotCreated', created: Date.now(), payload: {} });
  }

  const classic = await createClassicEntrypoint({
    publicUrl: 'http://classic.fixture.test',
    callerBoundary: createVerifiedClassicCaller({ resolveCredentials: (id) => store.accountByAccessKeyId(id) }),
    robotStore: robots, keyStore: keys, person: { store: person }, jot: { store: jot },
  }).listen(0);
  servers.push(classic);
  process.env.NET_classic = `127.0.0.1:${classic.address().port}`;

  const history = new HistoryStore(join(dir, 'history', 'store.json'));
  history.addSkillLaunch({ robotID: 'Birch-Canyon-Otter-Lime', skillID: '@be/clock', sessionID: 's1', personIDs: [L] });
  history.addSkillLaunch({ robotID: 'Birch-Canyon-Otter-Lime', skillID: '@be/clock', sessionID: 's2', personIDs: [S] });
  history.addSkillLaunch({ robotID: 'Amber-Cliff-Hazel-Wren', skillID: '@be/clock', sessionID: 's3', personIDs: [] });
  const historyServer = await createHistoryService(history).listen(0);
  servers.push(historyServer);
  process.env.NET_history = `127.0.0.1:${historyServer.address().port}`;

  const photos = { removed: [], async remove(key) { this.removed.push(key); } };
  const account = await createAccountService({ store, memberPhotoProvider: photos }).listen(0);
  servers.push(account);
  const base = `http://127.0.0.1:${account.address().port}`;
  const cookies = {};
  const call = async (who, method, path, body) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookies[who] ? { cookie: cookies[who] } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookies[who] = setCookie.split(';')[0];
    return { status: response.status, body: await response.json().catch(() => null), setCookie };
  };
  return {
    dir, store, admin, leaver, stayer, child, amber, birch, jot, keys, person, robots, history, photos, call, classic,
    ids: {
      L, S, birchId, amberId, invitedId: String(invitedTo.loop._id), leftId: String(left.loop._id),
      sent: sent.id, onlyForLeaver: onlyForLeaver.id, forEveryone: forEveryone.id,
    },
  };
}

test('deleting an account removes it, its loops and robot, and only its own records elsewhere', async (t) => {
  const h = await household(t);
  const { call, ids } = h;
  assert.equal((await call('leaver', 'POST', '/api/login', { email: 'leaver@fixture.test', password: 'leaver-password-1' })).status, 200);
  assert.equal((await call('stayer', 'POST', '/api/login', { email: 'stayer@fixture.test', password: 'stayer-password-1' })).status, 200);

  // The console shows what will go before asking.
  const preview = await call('leaver', 'GET', '/api/me/deletion');
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.body.loops, [{ id: ids.amberId, name: 'Leaver home', robot: 'Amber-Cliff-Hazel-Wren', people: 3, canHandOn: true }]);
  assert.deepEqual(preview.body.robots, ['Amber-Cliff-Hazel-Wren']);
  assert.deepEqual(preview.body.memberships, [
    { id: ids.birchId, name: 'Stayer home', robot: 'Birch-Canyon-Otter-Lime', invited: false },
    { id: ids.invitedId, name: 'Admin home', robot: 'Cedar-Harbor-Kite-Moss', invited: true },
  ]);
  assert.equal(preview.body.onlyAdministrator, false);
  assert.equal(preview.body.backupDays, 30);
  assert.equal((await call('nobody', 'GET', '/api/me/deletion')).status, 401);

  // The password is required, and a wrong one changes nothing.
  assert.equal((await call('leaver', 'POST', '/api/me/delete', {})).status, 401);
  assert.equal((await call('leaver', 'POST', '/api/me/delete', { password: 'not-the-password' })).status, 401);

  // If Classic cannot confirm, the account store is not touched.
  const classicAddress = process.env.NET_classic;
  process.env.NET_classic = '127.0.0.1:9';
  const stopped = await call('leaver', 'POST', '/api/me/delete', { password: 'leaver-password-1' });
  assert.equal(stopped.status, 502);
  assert.match(stopped.body.error, /nothing was changed/);
  assert.ok(h.store.accounts.has(ids.L));
  assert.ok(h.store.loops.has(ids.amberId));
  assert.ok(h.store.emailVerifications.has(ids.L));
  process.env.NET_classic = classicAddress;

  const deleted = await call('leaver', 'POST', '/api/me/delete', { password: 'leaver-password-1' });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.deepEqual(deleted.body, { deleted: true });
  assert.match(deleted.setCookie, /Max-Age=0/);

  // Signed out everywhere, and the address can no longer sign in.
  assert.equal((await call('leaver', 'GET', '/api/me')).status, 401);
  assert.equal((await call('again', 'POST', '/api/login', { email: 'leaver@fixture.test', password: 'leaver-password-1' })).status, 401);

  // Account store: the account, its loop, its robot and the child account go.
  const reloaded = new Store(h.store.file);
  for (const store of [h.store, reloaded]) {
    assert.equal(store.accounts.has(ids.L), false);
    assert.equal(store.accounts.has(String(h.child._id)), false);
    assert.equal(store.accountByFriendlyId('Amber-Cliff-Hazel-Wren'), null);
    assert.equal(store.loops.has(ids.amberId), false);
    assert.equal(store.settings.has(ids.L), false);
    assert.equal(store.settings.has(`lasso:${ids.L}`), false);
    assert.ok(store.settings.has(ids.S));
    assert.equal(store.emailVerifications.has(ids.L), false);
    assert.equal(store.emailVerifications.get(ids.S)?.email, 'stayer@fixture.test');
    assert.equal([...store.sessions.values()].some((session) => String(session.accountId) === ids.L), false);
  }
  // Stayer keeps their loop, their robot and the admin their account; the loop no longer lists Leaver.
  assert.ok(h.store.accounts.has(ids.S));
  assert.ok(h.store.accounts.has(String(h.admin._id)));
  assert.ok(h.store.accountByFriendlyId('Birch-Canyon-Otter-Lime'));
  const birch = h.store.loops.get(ids.birchId);
  assert.equal(birch.members.some((entry) => String(entry.accountId) === ids.L), false);
  assert.equal(birch.members.length, 2);
  // The unanswered invitation and the old removed entry go as well.
  for (const loopId of [ids.invitedId, ids.leftId]) {
    assert.equal(h.store.loops.get(loopId).members.some((entry) => String(entry.accountId) === ids.L), false);
  }
  // Birch's robot is told its loop changed.
  assert.ok([...h.store.notificationOutbox.values()].some((entry) => JSON.stringify(entry).includes(ids.birchId)));
  const loops = await call('stayer', 'GET', '/api/loop');
  assert.equal(loops.status, 200);
  assert.deepEqual(loops.body.loops.map((loop) => loop.id), [ids.birchId]);
  assert.equal(h.store.accounts.size, 5, 'admin, stayer and the three robots that stay');

  // Classic: Leaver's own messages and the one only for them go; everyone else's stay without them.
  const messages = new Map(h.jot.messages.map((message) => [message.id, message]));
  assert.equal(messages.has(ids.sent), false);
  assert.equal(messages.has(ids.onlyForLeaver), false);
  assert.deepEqual(messages.get(ids.forEveryone).read, [ids.S]);
  assert.equal(h.jot.messages.some((message) => message.loopId === ids.amberId), false);
  assert.ok(h.keys.backups.has(ids.birchId), 'the key backup Leaver made for the loop they handed on stays');
  assert.equal(h.keys.backups.has(ids.amberId), false);
  assert.deepEqual([...h.keys.keys.values()].map((key) => key.accountId), [ids.S]);
  assert.equal(h.person.findAnswers(ids.L).length, 0);
  assert.equal(h.person.findAnswers(ids.S).length, 1);
  assert.ok(h.person.findLoopProperty(ids.birchId, 'customHolidays'));
  assert.equal(h.robots.eventsFor('Amber-Cliff-Hazel-Wren').length, 0);
  assert.equal(h.robots.eventsFor('Birch-Canyon-Otter-Lime').length, 1);
  // History: launches with Leaver in them and Amber's go; Stayer's stays.
  assert.deepEqual(h.history.skillLaunches.map((launch) => launch.sessionID), ['s2']);

  // Photos: Leaver's own, Leaver's in Birch and the guest in the deleted loop; never Stayer's.
  assert.deepEqual(h.photos.removed.sort(), ['guest-member', 'leaver-account', 'leaver-in-birch']);

  // Every service saved a deletion backup first.
  const backups = readdirSync(join(h.dir, 'removal-backups'));
  for (const service of ['account', 'classic', 'history']) {
    assert.ok(backups.some((name) => name.startsWith('deletion-') && name.endsWith(`-${service}`)), `${service} in ${backups}`);
  }
});

test('the only administrator cannot delete their account', async (t) => {
  const h = await household(t);
  const { call } = h;
  assert.equal((await call('admin', 'POST', '/api/login', { email: 'admin@fixture.test', password: 'admin-password-1' })).status, 200);
  const preview = await call('admin', 'GET', '/api/me/deletion');
  assert.equal(preview.body.onlyAdministrator, true);
  const refused = await call('admin', 'POST', '/api/me/delete', { password: 'admin-password-1' });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'ONLY_ADMINISTRATOR');
  assert.ok(h.store.accounts.has(String(h.admin._id)));

  // A deactivated administrator cannot sign in and cannot keep the console
  // accessible after its last active administrator leaves.
  h.stayer.isAdmin = true;
  h.stayer.isActive = false;
  h.store.flush();
  assert.equal((await call('admin', 'GET', '/api/me/deletion')).body.onlyAdministrator, true);
  assert.equal((await call('admin', 'POST', '/api/me/delete', { password: 'admin-password-1' })).status, 409);

  // With a second administrator, the first can go.
  h.stayer.isActive = true;
  h.store.accounts.get(String(h.stayer._id)).isAdmin = true;
  const deleted = await call('admin', 'POST', '/api/me/delete', { password: 'admin-password-1' });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal(h.store.accounts.has(String(h.admin._id)), false);
});
