// G.5 — gateway per-robot auth: verifyAgainstAccount accept/reject matrix against a mock
// account-verify endpoint, plus the verifyClient modes over a real WS upgrade (disableAuth
// bypass, shared-secret-only, account-validated accept, revoked-account reject).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';
import { jwt } from '@phoenix/common';

const { verifyAgainstAccount } = await import('@phoenix/gateway');

const SECRET = 'gw-test-secret';
let accountSrv; let accountUrl; let known = new Set(); let robotFriendly = 'My-Robot';

before(async () => {
  accountSrv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const key = u.searchParams.get('accessKeyId');
    res.writeHead(200, { 'content-type': 'application/json' });
    if (known.has(key)) res.end(JSON.stringify({ valid: true, id: 'acct-1', friendlyId: robotFriendly }));
    else res.end(JSON.stringify({ valid: false }));
  });
  await new Promise((r) => accountSrv.listen(0, r));
  accountUrl = `http://localhost:${accountSrv.address().port}`;
});
after(() => accountSrv.close());

// -- verifyAgainstAccount matrix ----------------------------------------------

test('verifyAgainstAccount: live account accepts', async () => {
  known = new Set(['k1']);
  assert.deepEqual(await verifyAgainstAccount({ accessKeyId: 'k1', friendlyId: 'My-Robot' }, accountUrl), { ok: true });
});

test('verifyAgainstAccount: revoked/unknown account rejects', async () => {
  known = new Set();
  const r = await verifyAgainstAccount({ accessKeyId: 'gone' }, accountUrl);
  assert.match(r.error, /not found or inactive/);
});

test('verifyAgainstAccount: friendlyId mismatch rejects', async () => {
  known = new Set(['k2']);
  const r = await verifyAgainstAccount({ accessKeyId: 'k2', friendlyId: 'Imposter' }, accountUrl);
  assert.match(r.error, /friendlyId mismatch/);
});

test('verifyAgainstAccount: token without an accessKeyId claim is allowed (sim creds)', async () => {
  assert.deepEqual(await verifyAgainstAccount({ id: 'x' }, accountUrl), { ok: true });
});

test('verifyAgainstAccount: unreachable account fails closed', async () => {
  const r = await verifyAgainstAccount({ accessKeyId: 'k1' }, 'http://127.0.0.1:1', { warn() {} });
  assert.match(r.error, /unreachable/);
});

// -- verifyClient over a real WS upgrade --------------------------------------

const sign = (claims) => jwt.sign({ id: 'acct-1', friendlyId: 'My-Robot', accessKeyId: 'k1', ...claims }, SECRET);

async function tryConnect(gwPort, token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${gwPort}/listen`, {
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'x-jibo-transid': 'tid:auth' },
    });
    ws.on('open', () => { ws.close(); resolve({ ok: true }); });
    ws.on('error', () => resolve({ ok: false }));
    ws.on('unexpected-response', (_req, res) => resolve({ ok: false, status: res.statusCode }));
  });
}

const { start: startGateway } = await import('@phoenix/gateway');
async function startGw(port, env) {
  for (const k of ['ETCO_server_hubTokenSecret', 'ETCO_hub_disableAuth', 'ETCO_hub_accountUrl']) delete process.env[k];
  Object.assign(process.env, env);
  return startGateway(port); // start() calls loadConfig() fresh from the env each time
}

test('verifyClient: disableAuth bypasses auth entirely', async () => {
  const gw = await startGw(7531, { ETCO_hub_disableAuth: 'true' });
  try { assert.equal((await tryConnect(7531, null)).ok, true); } finally { gw.wss.close(); gw.service.server.close(); }
});

test('verifyClient: shared-secret-only accepts any validly-signed token (no accountUrl)', async () => {
  const gw = await startGw(7532, { ETCO_server_hubTokenSecret: SECRET });
  try {
    assert.equal((await tryConnect(7532, sign({}))).ok, true, 'valid signature accepted');
    assert.equal((await tryConnect(7532, 'garbage')).ok, false, 'bad token rejected');
  } finally { gw.wss.close(); gw.service.server.close(); }
});

test('verifyClient: with accountUrl, live account accepts and revoked rejects', async () => {
  const gw = await startGw(7533, { ETCO_server_hubTokenSecret: SECRET, ETCO_hub_accountUrl: accountUrl });
  try {
    known = new Set(['k1']);
    assert.equal((await tryConnect(7533, sign({}))).ok, true, 'live account accepted');
    known = new Set(); // revoke
    assert.equal((await tryConnect(7533, sign({}))).ok, false, 'revoked account rejected');
  } finally { gw.wss.close(); gw.service.server.close(); }
});
