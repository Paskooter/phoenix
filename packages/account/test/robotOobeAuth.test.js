import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, createAccountService } from '../src/index.js';
import { createOwnerAccount, mintSetupToken } from '../src/model.js';
import { signedLoopHeaders } from './fixtures/signedLoopRequest.js';

test('OOBE public authentication uses exact unsigned exceptions and verifies supplied signatures before mutation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-synthetic-oobe-auth-'));
  const store = new Store(join(dir, 'store.json'));
  const owner = createOwnerAccount(store, { email: 'oobe-auth@synthetic.invalid', password: 'synthetic-password' });
  const server = await createAccountService({ store }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const snapshot = () => JSON.stringify({ accounts: [...store.accounts], loops: [...store.loops], tokens: [...store.tokens] });
  try {
    for (const op of ['PrepareRobot', 'ReconnectRobot', 'SetupRobot', 'GetStatus']) {
      for (const mode of ['unsigned', 'wrong-signature', 'inactive', 'signed']) {
        owner.isActive = mode !== 'inactive'; store.flush();
        const token = mintSetupToken(store, owner._id);
        const body = op === 'PrepareRobot' ? {} : { token: token._id, ...(op === 'SetupRobot' ? { id: 'synthetic-auth-robot' } : {}) };
        const target = `OOBE_20161026.${op}`;
        let headers = signedLoopHeaders(store, base, target, body, mode === 'unsigned' ? undefined : owner.accessKeyId);
        if (mode === 'wrong-signature') {
          const key = Object.keys(headers).find(name => name.toLowerCase() === 'authorization');
          headers[key] = headers[key].replace(/Signature=[0-9a-f]+/, 'Signature=' + '0'.repeat(64));
        }
        headers.connection = 'close';
        headers['x-amz-credentials'] = JSON.stringify({ id: owner._id, isAdmin: true });
        const before = snapshot();
        const response = await fetch(base, { method: 'POST', headers, body: JSON.stringify(body) });
        const result = await response.json();
        const anonymousAllowed = ['SetupRobot', 'GetStatus'].includes(op);
        const expected = mode === 'wrong-signature' ? 'SIGNATURE_MISMATCH'
          : mode === 'inactive' ? 'ACCOUNT_NOT_ACTIVE'
          : mode === 'unsigned' && !anonymousAllowed ? 'MISSING_AUTH_HEADER' : null;
        if (expected) {
          assert.equal(result.__type, expected, `${op}/${mode}`);
          assert.equal(response.status, expected === 'ACCOUNT_NOT_ACTIVE' ? 403 : 401);
          assert.equal(snapshot(), before, `${op}/${mode} must not mutate state`);
          assert.deepEqual([...new Store(store.file).tokens], [...store.tokens]);
        } else assert.equal(response.status, 200, `${op}/${mode}: ${JSON.stringify(result)}`);
      }
    }
    const response = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'OOBE_20170101.GetStatus', connection: 'close' }, body: JSON.stringify({ token: 'synthetic' }) });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).__type, 'MISSING_AUTH_HEADER');
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
