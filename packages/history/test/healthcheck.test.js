// R-03 criterion 3: a service whose store is down must not report itself healthy.
//
// Source contract (pinned jiboV2/pegasus@5c0a7390),
// packages/history/src/HistoryService.ts getHealthcheckResponse:
//
//   protected async getHealthcheckResponse(): Promise<network.HttpResponse> {
//       const response: HealthcheckResponse = {
//           status: 'ok',
//           skillLaunchDB: this.skillLaunchDBClient.getState(),
//           speechHistoryDB: this.speechHistoryDBClient.getState()
//       };
//       if (response.skillLaunchDB !== DBClientState.CONNECTED) response.status = 'error';
//       if (config.speechHistory.enabled && response.speechHistoryDB !== DBClientState.CONNECTED) response.status = 'error';
//       return { statusCode: response.status === 'ok' ? 200 : 500, body: response };
//   }
//
// with DBClientState = DISCONNECTED | CONNECTED | CONNECTING | DISCONNECTING | UNKNOWN
// (packages/history/src/common/db/DBClient.ts).
//
// BaseService installs the shared `/healthcheck` route and answers the literal
// `ok` with 200; History is the one service in the reference that overrides it.
// Before this change Phoenix answered 200 `ok` from every service even with its
// store unusable, which is exactly the falsely-healthy state R-03 forbids.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHistoryService, DB_CLIENT_STATE, HistoryStore } from '../src/index.js';

async function withService(store, run) {
  const service = createHistoryService(store);
  await service.listen(0);
  const port = service.server.address().port;
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => service.server.close(resolve));
  }
}

const health = async (base) => {
  const response = await fetch(`${base}/healthcheck`);
  return { status: response.status, body: await response.json().catch(() => null) };
};

test('a healthy store reports the source body and 200', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-history-healthy-'));
  try {
    const store = new HistoryStore(join(dir, 'store.json'));
    store.addSkillLaunch({ robotID: 'robot-a', sessionID: 's1', skillID: 'answer-skill', timestamp: Date.now() });
    await withService(store, async (base) => {
      const result = await health(base);
      assert.equal(result.status, 200);
      // Exactly the source's three members: a consumer parses this body.
      assert.deepEqual(result.body, {
        status: 'ok',
        skillLaunchDB: DB_CLIENT_STATE.CONNECTED,
        speechHistoryDB: DB_CLIENT_STATE.CONNECTED,
      });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a service whose store is unusable answers 500, not a false ok', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-history-broken-'));
  try {
    const file = join(dir, 'store.json');
    // A committed snapshot that cannot be parsed: the store is present but not
    // usable, which startup would have failed on and a running service meets
    // after an external corruption or a partially written file.
    writeFileSync(file, '{ this is not json');
    const store = new HistoryStore(null); // construct cleanly, then point at the broken file
    store.file = file;
    await withService(store, async (base) => {
      const result = await health(base);
      assert.equal(result.status, 500);
      assert.deepEqual(result.body, {
        status: 'error',
        skillLaunchDB: DB_CLIENT_STATE.DISCONNECTED,
        speechHistoryDB: DB_CLIENT_STATE.DISCONNECTED,
      });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unwritable snapshot directory is reported, and the probe leaves no residue', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-history-nowrite-'));
  try {
    // The parent path is a FILE, so the probe's directory creation and open must
    // both fail -- the same way a full or read-only filesystem would.
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'not a directory');
    const store = new HistoryStore(null);
    store.file = join(blocker, 'nested', 'store.json');

    assert.equal(store.probe().state, DB_CLIENT_STATE.DISCONNECTED);
    await withService(store, async (base) => {
      assert.equal((await health(base)).status, 500);
    });

    // A successful probe must not leave its private probe file behind.
    const healthyDir = join(dir, 'healthy');
    mkdirSync(healthyDir);
    const healthy = new HistoryStore(join(healthyDir, 'store.json'));
    assert.equal(healthy.probe().state, DB_CLIENT_STATE.CONNECTED);
    assert.deepEqual(
      (await import('node:fs')).readdirSync(healthyDir),
      [],
      'the probe file is removed even on the success path',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
