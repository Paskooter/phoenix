import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const STORE_MODULE = pathToFileURL(join(
  fileURLToPath(new URL('../src/notificationStore.js', import.meta.url)),
)).href;

function runStore(directory, source) {
  const env = { ...process.env, TMPDIR: directory };
  delete env.ETCO_classic_notificationFile;
  return spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
  });
}

test('NotificationStore default path is stable across process restart and reuses durable state', () => {
  const directory = mkdtempSync(join(tmpdir(), 'phoenix-notification-default-'));
  try {
    const first = runStore(directory, `
      import { NotificationStore } from ${JSON.stringify(STORE_MODULE)};
      const store = new NotificationStore();
      const token = store.newToken({ accountId: 'restart-account' });
      store.enqueue({ accountId: 'restart-account', payload: { kind: 'restart-check' } });
      if (!token || !store.file.endsWith('/phoenix-notifications.json')) process.exit(2);
    `);
    assert.equal(first.status, 0, first.stderr);

    const second = runStore(directory, `
      import { NotificationStore } from ${JSON.stringify(STORE_MODULE)};
      const store = new NotificationStore();
      const token = store.findTokenByAccountId('restart-account');
      const rows = token ? store.findNotificationsByTokenIds([token._id]) : [];
      if (!token || rows.length !== 1 || rows[0].payload.kind !== 'restart-check') process.exit(3);
    `);
    assert.equal(second.status, 0, second.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
