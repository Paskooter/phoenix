// NotificationStore atomic replace: each flush writes a unique temporary file
// beside the store, so two processes sharing a store never race on one `.tmp`.
// Synthetic accounts only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { NotificationStore } from '../src/notificationStore.js';

test('NotificationStore flushes through a unique temporary file beside the store', () => {
  const directory = mkdtempSync(join(tmpdir(), 'phoenix-notification-temp-'));
  try {
    const file = join(directory, 'notifications.json');
    const temporaries = [];
    const store = new NotificationStore(file, {
      persistence: {
        writeFile: (path, ...rest) => { temporaries.push(path); return writeFileSync(path, ...rest); },
      },
    });
    store.newToken({ accountId: 'synthetic-temp-account-a' });
    store.newToken({ accountId: 'synthetic-temp-account-b' });
    assert.equal(temporaries.length, 2);
    assert.notEqual(temporaries[0], temporaries[1], 'two flushes never share a temporary pathname');
    for (const path of temporaries) {
      assert.equal(dirname(path), directory);
      assert.notEqual(path, `${file}.tmp`);
      assert.match(path, /\.tmp$/);
    }
    assert.deepEqual(readdirSync(directory), ['notifications.json'], 'no temporary file is left behind');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('two stores sharing a file both commit through their own temporaries', () => {
  const directory = mkdtempSync(join(tmpdir(), 'phoenix-notification-shared-'));
  try {
    const file = join(directory, 'notifications.json');
    const first = new NotificationStore(file);
    const second = new NotificationStore(file);
    first.newToken({ accountId: 'synthetic-shared-a' });
    second.newToken({ accountId: 'synthetic-shared-b' });
    const reloaded = new NotificationStore(file);
    assert.ok(reloaded.findTokenByAccountId('synthetic-shared-b'), 'the last atomic replace is intact');
    assert.deepEqual(readdirSync(directory), ['notifications.json']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
