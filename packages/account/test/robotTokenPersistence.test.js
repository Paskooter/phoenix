import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { createAccountService } from '../src/index.js';
import { createOwnerAccount, mintSetupToken } from '../src/model.js';

test('ReconnectRobot preserves a token after failed deletion and permits one durable retry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-synthetic-token-'));
  const file = join(dir, 'store.json');
  const store = new Store(file);
  const owner = createOwnerAccount(store, { email: 'token-owner@synthetic.invalid', password: 'synthetic-password' });
  const token = mintSetupToken(store, owner._id);
  const server = await createAccountService({ store }).listen(0);
  const request = () => fetch(`http://127.0.0.1:${server.address().port}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'OOBE_20161026.ReconnectRobot', connection: 'close' },
    body: JSON.stringify({ token: token._id }),
  });
  const flush = store.flush.bind(store);
  try {
    store.flush = () => { throw new Error('synthetic persistence failure'); };
    const failed = await request();
    await failed.arrayBuffer();
    assert.equal(failed.status, 500);
    assert.deepEqual(store.tokens.get(token._id), token, 'failed remove must retain the committed token in memory');
    assert.deepEqual(new Store(file).tokens.get(token._id), token, 'failed remove must retain the committed token on disk');
    store.flush = flush;
    const retry = await request();
    assert.equal(retry.status, 200);
    assert.deepEqual(await retry.json(), { result: 'Command accepted' });
    assert.equal(store.tokens.has(token._id), false);
    assert.equal(new Store(file).tokens.has(token._id), false);
    const replay = await request();
    assert.equal(replay.status, 404);
    assert.equal((await replay.json()).__type, 'TOKEN_NOT_FOUND');
  } finally {
    store.flush = flush;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
