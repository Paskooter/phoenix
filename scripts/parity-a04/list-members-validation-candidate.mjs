import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAccountService, Store } from '../../packages/account/src/index.js';
import { signedLoopHeaders } from '../../packages/account/test/fixtures/signedLoopRequest.js';

const dir = mkdtempSync(join(tmpdir(), 'phx-a04-list-members-validation-'));
const store = new Store(join(dir, 'store.json'));
const owner = {
  _id: 'a04-validation-owner', email: 'owner@validation.synthetic.invalid', firstName: 'Owner',
  accessKeyId: 'A04VALIDATIONOWNER01', secretAccessKey: 'a04-validation-owner-secret', isActive: true,
};
store.accounts.set(owner._id, owner);
store.flush();
const server = await createAccountService({ store }).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

async function request(id, payload) {
  const raw = JSON.stringify(payload);
  const response = await fetch(`${base}/`, {
    method: 'POST',
    headers: signedLoopHeaders(store, base, 'Loop_20160324.ListLoopMembers', payload, owner.accessKeyId),
    body: raw,
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  let body;
  try { body = JSON.parse(bytes.toString('utf8')); } catch { body = null; }
  return {
    id,
    input: payload,
    status: response.status,
    message: body && body.message,
    error: body && body.error,
    body,
    rawBody: bytes.toString('utf8'),
  };
}

try {
  const rows = [];
  rows.push(await request('empty-object', {}));
  rows.push(await request('empty-filters', { statusList: [], typeList: [] }));
  rows.push(await request('status-accepted', { statusList: ['accepted'] }));
  rows.push(await request('type-incoming', { typeList: ['incoming'] }));
  rows.push(await request('both-filters', { statusList: ['accepted', 'declined'], typeList: ['outgoing'] }));
  rows.push(await request('status-invalid', { statusList: ['bogus'] }));
  rows.push(await request('status-not-array', { statusList: 'accepted' }));
  rows.push(await request('type-invalid', { typeList: ['bogus'] }));
  rows.push(await request('type-not-array', { typeList: 'incoming' }));
  rows.push(await request('top-null', null));
  rows.push(await request('top-array', []));
  rows.push(await request('top-number', 7));
  rows.push(await request('top-string', 'raw'));
  rows.push(await request('unknown-field', { ignored: true }));
  process.stdout.write(`${JSON.stringify({
    node: process.version,
    candidateBase: '4d453eb8a85a0bebcac189a7dc643153d54ba35c',
    rows,
  }, null, 2)}\n`);
} finally {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
}
