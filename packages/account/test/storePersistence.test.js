import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync, readdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';

test('compatibility executable retains Home Assistant action tombstones during ordinary saves', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-account-action-compat-'));
  try {
    const file = join(dir, 'account.json');
    const action = {
      _id: 'synthetic-action', installationId: 'synthetic-installation',
      requestId: '00000000-0000-4000-8000-000000000001',
      payloadHash: 'synthetic-payload-hash', state: 'finished',
      result: { status: 'uncertain', code: 'confirmation_lost' },
    };
    writeFileSync(file, JSON.stringify({
      accounts: [{ _id: 'synthetic-owner', nickname: 'Original' }],
      homeAssistantActions: [action],
    }), { mode: 0o600 });
    const store = new Store(file);
    assert.deepEqual(store.homeAssistantActions.get(action._id), action);
    store.accounts.get('synthetic-owner').nickname = 'Updated';
    store.flush();
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).homeAssistantActions, [action]);
    assert.deepEqual(new Store(file).homeAssistantActions.get(action._id), action);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Account saves retain private credentials across replacement and reload', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-account-permissions-'));
  const previousMask = process.umask(0);
  try {
    const parent = join(dir, 'new-parent');
    const file = join(parent, 'account.json');
    const store = new Store(file);
    store.accounts.set('robot', { _id: 'robot', accessKeyId: 'fixture-key', secretAccessKey: 'fixture-secret' });
    store.flush();
    assert.equal(statSync(parent).mode & 0o777, 0o700);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    // A leftover legacy temp file must neither widen the new snapshot nor be
    // overwritten/deleted by this save.
    writeFileSync(`${file}.tmp`, 'unrelated legacy temporary file');
    chmodSync(`${file}.tmp`, 0o666);
    for (const mask of [0o000, 0o002, 0o022, 0o077]) {
      process.umask(mask);
      store.accounts.get('robot').nickname = `mask-${mask}`;
      store.flush({ durable: true });
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.deepEqual(new Store(file).accounts.get('robot'), store.accounts.get('robot'));
    }
    assert.equal(readFileSync(`${file}.tmp`, 'utf8'), 'unrelated legacy temporary file');
    assert.deepEqual(readdirSync(parent).sort(), ['account.json', 'account.json.tmp']);
  } finally {
    process.umask(previousMask);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reopening Account stores removes abandoned UUID temp files without touching the committed snapshot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-account-stale-temp-'));
  try {
    const file = join(dir, 'account.json');
    const store = new Store(file);
    store.accounts.set('robot', { _id: 'robot', accessKeyId: 'synthetic-fixture-key' });
    store.flush();
    const committed = readFileSync(file);
    // A SIGKILL between write and rename leaves this behind; backdate it past the grace period.
    const stale = `${file}.00000000-0000-4000-8000-000000000000.tmp`;
    writeFileSync(stale, '{partial snapshot');
    const old = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(stale, old, old);
    // Not this store's temporary-name shape: never touched.
    const foreign = `${file}.backup.tmp`;
    writeFileSync(foreign, 'operator file');
    utimesSync(foreign, old, old);

    const reopened = new Store(file);
    assert.deepEqual(readFileSync(file), committed, 'startup keeps the committed snapshot');
    assert.equal(existsSync(stale), false, 'startup removes an abandoned Store temporary file');
    assert.equal(existsSync(foreign), true, 'only this store\'s UUID temp names are removed');
    assert.equal(reopened.accounts.get('robot').accessKeyId, 'synthetic-fixture-key');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reopening an Account store leaves a temp file another process may still be writing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-account-live-temp-'));
  try {
    const file = join(dir, 'account.json');
    new Store(file).flush();
    const live = `${file}.11111111-1111-4111-8111-111111111111.tmp`;
    writeFileSync(live, '{in flight');
    new Store(file);
    assert.equal(existsSync(live), true, 'a fresh temporary file is not deleted by a second opener');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejected Account snapshots preserve committed bytes and clean their own temporary file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-account-save-failure-'));
  try {
    const file = join(dir, 'account.json');
    const store = new Store(file);
    store.accounts.set('robot', { _id: 'robot' });
    store.flush();
    const committed = readFileSync(file);
    store.accounts.get('robot').invalid = 1n;
    assert.throws(() => store.flush({ durable: true }), TypeError);
    assert.deepEqual(readFileSync(file), committed);
    assert.deepEqual(readdirSync(dir), ['account.json']);
    delete store.accounts.get('robot').invalid;

    // A directory at a separate target forces a real rename failure, even
    // when tests run as root. The previously committed snapshot stays intact.
    const blocked = join(dir, 'blocked.json');
    mkdirSync(blocked);
    store.file = blocked;
    assert.throws(() => store.flush({ durable: true }), error => ['EISDIR', 'ENOTEMPTY', 'EEXIST'].includes(error.code));
    assert.deepEqual(readFileSync(file), committed);
    assert.deepEqual(readdirSync(dir).sort(), ['account.json', 'blocked.json']);
    store.file = file;
    store.flush();
    assert.deepEqual(new Store(file).accounts.get('robot'), { _id: 'robot' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
