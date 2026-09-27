import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createAccountService, Store } from '../src/index.js';
import { createLoop, createOwnerAccount } from '../src/model.js';
import { createClassicEntrypoint, createVerifiedClassicCaller, KeyStore, PersonStore, RobotStore } from '../../classic/src/index.js';

test('production-authenticated robot settings preserve ownership and Classic data', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-robot-settings-'));
  const accountStore = new Store(join(dir, 'account.json'));
  const owner = createOwnerAccount(accountStore, { email: 'robot-settings-owner@fixture.test', password: 'owner-password-1' });
  const stranger = createOwnerAccount(accountStore, { email: 'robot-settings-other@fixture.test', password: 'other-password-1' });
  const { loop, robot } = createLoop(accountStore, { owner, robotId: 'robot-settings-fixture' });
  accountStore.flush();
  const priorAccountFile = process.env.ETCO_classic_accountDataFile;
  const priorClassic = process.env.NET_classic;
  const priorAccount = process.env.NET_account;
  const priorPeerToken = process.env.ETCO_account_internalPeerToken;
  process.env.ETCO_classic_accountDataFile = accountStore.file;
  process.env.ETCO_account_internalPeerToken = 'robot-settings-fixture-peer-token';
  let classicServer; let accountServer;
  const keyStore = new KeyStore(join(dir, 'keys.json'));
  try {
    classicServer = await createClassicEntrypoint({
      publicUrl: 'http://classic.fixture.test',
      callerBoundary: createVerifiedClassicCaller({
        resolveCredentials: (accessKeyId) => accountStore.accountByAccessKeyId(accessKeyId),
      }),
      robotStore: new RobotStore({ dir: join(dir, 'robots') }),
      keyStore,
      person: { store: new PersonStore({ file: join(dir, 'person.json') }) },
    }).listen(0);
    process.env.NET_classic = `127.0.0.1:${classicServer.address().port}`;
    accountServer = await createAccountService({ store: accountStore }).listen(0);
    process.env.NET_account = `127.0.0.1:${accountServer.address().port}`;
    const base = `http://127.0.0.1:${accountServer.address().port}`;
    const cookies = {};
    async function call(actor, method, path, body) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...(cookies[actor] ? { cookie: cookies[actor] } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (response.headers.get('set-cookie')) cookies[actor] = response.headers.get('set-cookie').split(';')[0];
      return { status: response.status, body: await response.json().catch(() => null) };
    }
    assert.equal((await call('owner', 'POST', '/api/login', { email: owner.email, password: 'owner-password-1' })).status, 200);
    assert.equal((await call('stranger', 'POST', '/api/login', { email: stranger.email, password: 'other-password-1' })).status, 200);
    assert.equal((await call('stranger', 'PUT', '/api/robot/properties', { loopId: loop._id, remoteEnabled: true })).status, 404);
    assert.equal((await call('stranger', 'POST', '/api/robots/wifi', { loopId: loop._id, ssid: 'Test' })).status, 404);
    const wifi = await call('owner', 'POST', '/api/robots/wifi', { loopId: loop._id, ssid: 'Test', password: 'network-secret' });
    assert.equal(wifi.status, 200);
    assert.equal(accountStore.tokens.get(wifi.body.token)?.loopId, loop._id);
    assert.ok(Array.isArray(wifi.body.qr.codes) && wifi.body.qr.codes.length > 0);
    assert.equal((await call('owner', 'PUT', '/api/robot/color', { loopId: loop._id, color: 'teal' })).status, 200);
    assert.equal((await call('owner', 'PUT', '/api/robot/properties', { loopId: loop._id, remoteEnabled: true })).status, 200);
    assert.equal((await call('owner', 'PUT', '/api/robot/properties', { loopId: loop._id, location: {
      lat: 40.7, lng: -74, city: 'New York', timezone: 'America/New_York',
    } })).status, 200);
    const detail = await call('owner', 'GET', `/api/robot?loopId=${loop._id}`);
    assert.equal(detail.body.robot.friendlyId, robot.friendlyId);
    assert.equal(detail.body.loop.avatarColor, 'teal');
    assert.equal(detail.body.getRobot.payload.remoteEnabled, true);
    assert.equal(detail.body.getRobot.payload.locationOverride.city, 'New York');
    const added = await call('owner', 'PUT', '/api/robot/holidays/custom', {
      loopId: loop._id, name: 'Fixture Day', date: '2026-10-04',
    });
    assert.equal(added.status, 200);
    const listed = await call('owner', 'GET', `/api/robot/holidays?loopId=${loop._id}`);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.custom[0].name, 'Fixture Day');
    assert.equal((await call('stranger', 'GET', `/api/robot/holidays?loopId=${loop._id}`)).status, 404);
    assert.equal((await call('owner', 'DELETE', '/api/robot/holidays/custom', {
      loopId: loop._id, id: added.body.holiday.id,
    })).status, 200);

    const absentBackup = await call('owner', 'GET', `/api/robot/backup-key/status?loopId=${loop._id}`);
    assert.deepEqual(absentBackup.body, { backupExists: false });
    const oldHash = createHash('sha1').update('old passphrase').digest('hex');
    const newHash = createHash('sha1').update('new passphrase').digest('hex');
    const originalCiphertext = Buffer.alloc(48, 7).toString('base64');
    keyStore.backup({ loopId: loop._id, accountId: owner._id,
      encryptedKey: originalCiphertext, passwordHash: oldHash });
    const status = await call('owner', 'GET', `/api/robot/backup-key/status?loopId=${loop._id}`);
    assert.deepEqual(status.body, { backupExists: true });
    assert.equal((await call('stranger', 'GET', `/api/robot/backup-key/status?loopId=${loop._id}`)).status, 404);
    assert.equal((await call('owner', 'POST', '/api/robot/backup-key/current', {
      loopId: loop._id, passwordHash: newHash,
    })).status, 403);
    const current = await call('owner', 'POST', '/api/robot/backup-key/current', {
      loopId: loop._id, passwordHash: oldHash,
    });
    assert.equal(current.body.encryptedKey, originalCiphertext);
    const replacement = Buffer.alloc(48, 8).toString('base64');
    assert.equal((await call('owner', 'POST', '/api/robot/backup-key/change', {
      loopId: loop._id, oldPasswordHash: oldHash, newPasswordHash: newHash, encryptedKey: replacement,
    })).status, 200);
    assert.equal(keyStore.restore(loop._id).encryptedKey, replacement);
    assert.equal(keyStore.restore(loop._id).passwordHash, newHash);
  } finally {
    if (accountServer?.listening) await new Promise((resolve) => accountServer.close(resolve));
    if (classicServer?.listening) await new Promise((resolve) => classicServer.close(resolve));
    if (priorAccountFile === undefined) delete process.env.ETCO_classic_accountDataFile;
    else process.env.ETCO_classic_accountDataFile = priorAccountFile;
    if (priorClassic === undefined) delete process.env.NET_classic;
    else process.env.NET_classic = priorClassic;
    if (priorAccount === undefined) delete process.env.NET_account;
    else process.env.NET_account = priorAccount;
    if (priorPeerToken === undefined) delete process.env.ETCO_account_internalPeerToken;
    else process.env.ETCO_account_internalPeerToken = priorPeerToken;
    rmSync(dir, { recursive: true, force: true });
  }
});
