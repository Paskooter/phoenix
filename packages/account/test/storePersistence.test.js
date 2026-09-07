import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync, chmodSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';

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
      store.flush();
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

test('rejected Account snapshots preserve committed bytes and clean their own temporary file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-account-save-failure-'));
  try {
    const file = join(dir, 'account.json');
    const store = new Store(file);
    store.accounts.set('robot', { _id: 'robot' });
    store.flush();
    const committed = readFileSync(file);
    store.accounts.get('robot').invalid = 1n;
    assert.throws(() => store.flush(), TypeError);
    assert.deepEqual(readFileSync(file), committed);
    assert.deepEqual(readdirSync(dir), ['account.json']);
    delete store.accounts.get('robot').invalid;

    // A directory at a separate target forces a real rename failure, even
    // when tests run as root. The previously committed snapshot stays intact.
    const blocked = join(dir, 'blocked.json');
    mkdirSync(blocked);
    store.file = blocked;
    assert.throws(() => store.flush(), error => ['EISDIR', 'ENOTEMPTY', 'EEXIST'].includes(error.code));
    assert.deepEqual(readFileSync(file), committed);
    assert.deepEqual(readdirSync(dir).sort(), ['account.json', 'blocked.json']);
    store.file = file;
    store.flush();
    assert.deepEqual(new Store(file).accounts.get('robot'), { _id: 'robot' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
