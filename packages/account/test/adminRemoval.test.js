import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAccountService, Store } from '../src/index.js';
import { createLoop, createOwnerAccount } from '../src/model.js';
import { createClassicEntrypoint, createVerifiedClassicCaller, KeyStore, PersonStore, RobotStore } from '../../classic/src/index.js';
import { HistoryStore } from '../../history/src/store.js';
import { createHistoryService } from '../../history/src/index.js';

const ENV = ['ETCO_classic_accountDataFile', 'NET_classic', 'NET_history', 'ETCO_account_internalPeerToken', 'PHOENIX_DATA_DIR',
  'ETCO_classic_backupDir'];

test('an administrator removes one robot and its loop from every service, leaving other robots untouched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-admin-removal-'));
  const prior = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
  const servers = [];
  try {
    const accountStore = new Store(join(dir, 'account', 'store.json'));
    const admin = createOwnerAccount(accountStore, { email: 'admin@fixture.test', password: 'admin-password-1' });
    admin.isAdmin = true;
    const owner = createOwnerAccount(accountStore, { email: 'owner@fixture.test', password: 'owner-password-1' });
    const gone = createLoop(accountStore, { owner, robotId: 'Aero-Root-Okra-Knit' });
    const kept = createLoop(accountStore, { owner: admin, robotId: 'Moth-Radius-Breazeal-Felt' });
    accountStore.flush();

    process.env.ETCO_classic_accountDataFile = accountStore.file;
    process.env.ETCO_account_internalPeerToken = 'removal-fixture-peer-token';
    process.env.PHOENIX_DATA_DIR = dir;
    process.env.ETCO_classic_backupDir = join(dir, 'classic', 'backups');

    const robotStore = new RobotStore({ dir: join(dir, 'classic', 'robots') });
    const keyStore = new KeyStore(join(dir, 'classic', 'keys.json'));
    const personStore = new PersonStore({ file: join(dir, 'classic', 'person.json') });
    for (const [friendlyId, loop] of [['Aero-Root-Okra-Knit', gone.loop], ['Moth-Radius-Breazeal-Felt', kept.loop]]) {
      robotStore.append({ objectId: friendlyId, name: 'RobotCreated', created: Date.now(), payload: { SSID: `${friendlyId} wifi` } });
      keyStore.backup({ loopId: loop._id, accountId: loop.owner, encryptedKey: Buffer.alloc(48, 1).toString('base64'), passwordHash: 'a'.repeat(40) });
      personStore.saveLoopProperty({ loopId: loop._id, key: 'customHolidays', value: { holidays: [] }, updatedAccountId: loop.owner });
      mkdirSync(join(dir, 'classic', 'backups', String(loop._id)), { recursive: true });
      writeFileSync(join(dir, 'classic', 'backups', String(loop._id), 'blob'), 'backup bytes');
    }

    const classic = await createClassicEntrypoint({
      publicUrl: 'http://classic.fixture.test',
      callerBoundary: createVerifiedClassicCaller({ resolveCredentials: (id) => accountStore.accountByAccessKeyId(id) }),
      robotStore, keyStore, person: { store: personStore },
    }).listen(0);
    servers.push(classic);
    process.env.NET_classic = `127.0.0.1:${classic.address().port}`;

    const history = new HistoryStore(join(dir, 'history', 'store.json'));
    history.addSkillLaunch({ robotID: 'Aero-Root-Okra-Knit', skillID: '@be/clock', sessionID: 's1', personIDs: [] });
    history.addSkillLaunch({ robotID: 'Moth-Radius-Breazeal-Felt', skillID: '@be/clock', sessionID: 's2', personIDs: [] });
    const historyServer = await createHistoryService(history).listen(0);
    servers.push(historyServer);
    process.env.NET_history = `127.0.0.1:${historyServer.address().port}`;

    const account = await createAccountService({ store: accountStore }).listen(0);
    servers.push(account);
    const base = `http://127.0.0.1:${account.address().port}`;
    const cookies = {};
    const call = async (who, method, path, body) => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...(cookies[who] ? { cookie: cookies[who] } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (response.headers.get('set-cookie')) cookies[who] = response.headers.get('set-cookie').split(';')[0];
      return { status: response.status, body: await response.json().catch(() => null) };
    };
    assert.equal((await call('admin', 'POST', '/api/login', { email: admin.email, password: 'admin-password-1' })).status, 200);
    assert.equal((await call('owner', 'POST', '/api/login', { email: owner.email, password: 'owner-password-1' })).status, 200);

    // Not for ordinary accounts, and the internal routes refuse callers without the peer token.
    assert.equal((await call('owner', 'POST', '/api/admin/removal/preview', { robot: 'aero-root-okra-knit' })).status, 403);
    const direct = await fetch(`http://127.0.0.1:${classic.address().port}/internal/admin/purge`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [String(gone.loop._id)], dryRun: false }),
    });
    assert.equal(direct.status, 403);

    // An operator on the server can use the same preview with the internal token instead of a session.
    const internal = (token) => fetch(`${base}/internal/admin/removal/preview`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { 'x-phoenix-internal-token': token } : {}) },
      body: JSON.stringify({ robot: 'aero-root-okra-knit' }),
    });
    assert.equal((await internal()).status, 403);
    const operatorPreview = await internal('removal-fixture-peer-token');
    assert.equal(operatorPreview.status, 200);
    assert.equal((await operatorPreview.json()).confirmWith, 'Aero-Root-Okra-Knit');

    const loops = await call('admin', 'GET', '/api/admin/loops');
    assert.equal(loops.body.loops.length, 2);

    const preview = await call('admin', 'POST', '/api/admin/removal/preview', { robot: 'aero-root-okra-knit' });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.confirmWith, 'Aero-Root-Okra-Knit');
    assert.equal(preview.body.account.loops[0].id, String(gone.loop._id));
    const classicPreview = preview.body.services.find((entry) => entry.service === 'classic');
    const previewStores = classicPreview.stores.map((entry) => entry.name);
    for (const name of ['robots', 'keys', 'person']) assert.ok(previewStores.includes(name), `${name} in ${previewStores}`);
    assert.ok(classicPreview.stores.find((entry) => entry.name === 'robots').removed.events === 1);
    assert.deepEqual(classicPreview.directories, [`backups-${String(gone.loop._id)}`]);
    assert.equal(preview.body.services.find((entry) => entry.service === 'history').stores[0].removed.skillLaunches, 1);
    // A preview changes nothing.
    assert.ok(accountStore.accountByFriendlyId('Aero-Root-Okra-Knit'));

    assert.equal((await call('admin', 'POST', '/api/admin/removal', { robot: 'aero-root-okra-knit', confirm: 'wrong' })).status, 400);
    const removal = await call('admin', 'POST', '/api/admin/removal', { robot: 'aero-root-okra-knit', confirm: 'Aero-Root-Okra-Knit' });
    assert.equal(removal.status, 200, JSON.stringify(removal.body));

    // Gone from the account store (the owner stays), Classic, History and the backup directory...
    assert.equal(accountStore.accountByFriendlyId('Aero-Root-Okra-Knit'), null);
    assert.equal(accountStore.loops.has(gone.loop._id), false);
    assert.ok(accountStore.accounts.has(owner._id));
    assert.equal(new Store(accountStore.file).accountByFriendlyId('Aero-Root-Okra-Knit'), null);
    assert.equal(robotStore.eventsFor('Aero-Root-Okra-Knit').length, 0);
    assert.equal(keyStore.backups.has(gone.loop._id), false);
    assert.equal(new RobotStore({ dir: join(dir, 'classic', 'robots') }).eventsFor('Aero-Root-Okra-Knit').length, 0);
    assert.equal(existsSync(join(dir, 'classic', 'backups', String(gone.loop._id))), false);
    assert.deepEqual(history.skillLaunches.map((launch) => launch.robotID), ['Moth-Radius-Breazeal-Felt']);
    // ...the other robot is untouched...
    assert.ok(accountStore.accountByFriendlyId('Moth-Radius-Breazeal-Felt'));
    assert.equal(robotStore.eventsFor('Moth-Radius-Breazeal-Felt').length, 1);
    assert.ok(keyStore.backups.has(kept.loop._id));
    assert.ok(existsSync(join(dir, 'classic', 'backups', String(kept.loop._id), 'blob')));
    // ...and every service kept a backup first.
    const backups = readdirSync(join(dir, 'removal-backups'));
    assert.ok(backups.some((name) => name.endsWith('-account')));
    assert.ok(backups.some((name) => name.endsWith('-classic')));
    assert.ok(backups.some((name) => name.endsWith('-history')));
    const classicBackup = join(dir, 'removal-backups', backups.find((name) => name.endsWith('-classic')));
    assert.ok(existsSync(join(classicBackup, `backups-${String(gone.loop._id)}`, 'blob')));

    // A second removal of the same robot finds nothing to remove.
    assert.equal((await call('admin', 'POST', '/api/admin/removal/preview', { robot: 'aero-root-okra-knit' })).status, 404);
  } finally {
    for (const server of servers.reverse()) if (server.listening) await new Promise((resolve) => server.close(resolve));
    for (const [name, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
