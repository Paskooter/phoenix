import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { voiceTurnTelemetryProof } from '@phoenix/common';
import { Store } from '../src/store.js';
import { createAccountService } from '../src/index.js';
import { fetchAsrStatus, safeAsrStatus } from '../src/admin/asrStatusRoutes.js';

test('ASR status projection drops upstream identity, content, paths and raw errors', () => {
  const safe = safeAsrStatus({ mode: 'google', transcript: 'hidden text',
    parakeet: { state: 'down', since: 123, recheckMs: 10000, url: 'http://private.invalid' },
    google: { configured: true, unavailable: 'credentials', model: 'chirp_3', location: 'us', activeStreams: 1,
      projectId: 'hidden project', credentialsFile: '/hidden/key.json', lastFailure: { kind: 'credentials', at: 123, message: 'hidden error' },
      usage: { month: '2026-10', day: '2026-10-08', usedSeconds: 12, limitSeconds: 33600, dayUsedSeconds: 12, dayLimitSeconds: 3360,
        reservedSeconds: 31, problem: null, exhausted: null, file: '/hidden/usage.json' } } });
  assert.equal(JSON.stringify(safe).includes('hidden'), false); assert.equal(JSON.stringify(safe).includes('private.invalid'), false);
  assert.equal(safe.google.usage.reservedSeconds, 31);
  assert.equal(safeAsrStatus({ mode: 'unknown' }), null);
  const hostile = safeAsrStatus({ mode: 'auto', google: { model: 'hidden text', location: 'hidden location', unavailable: 'hidden error', activeStreams: -1,
    usage: { month: 'hidden month', day: 'hidden day', usedSeconds: Infinity, problem: 'hidden error' } } });
  assert.equal(JSON.stringify(hostile).includes('hidden'), false); assert.equal(hostile.google.activeStreams, null);
});

test('status proxy fails safely when Hub configuration or response is unavailable', async () => {
  assert.equal(await fetchAsrStatus({ env: {}, fetchImpl: () => { throw new Error('must not fetch'); } }), null);
  assert.equal(await fetchAsrStatus({ env: { NET_hub: '127.0.0.1:9', HUB_TOKEN_SECRET: 'synthetic-secret' },
    fetchImpl: async () => new Response('hidden upstream error', { status: 502 }) }), null);
});

test('admin ASR route requires an admin session and proves the fixed Hub hop', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'phx-admin-asr-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const secret = 'synthetic-asr-status-secret'; let requests = 0;
  const hub = http.createServer((req, res) => {
    requests += 1; assert.equal(req.url, '/v1/admin/asr');
    const timestamp = req.headers['x-phoenix-voice-turn-timestamp']; const nonce = req.headers['x-phoenix-voice-turn-nonce'];
    assert.equal(req.headers['x-phoenix-voice-turn-proof'], voiceTurnTelemetryProof(secret, { method: 'GET', target: req.url, timestamp, nonce }));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ mode: 'auto', google: null, parakeet: { state: 'up', since: 123, recheckMs: null, url: 'hidden' }, transcript: 'hidden' }));
  });
  await new Promise((r) => hub.listen(0, '127.0.0.1', r)); t.after(() => new Promise((r) => hub.close(r)));
  const previousHub = process.env.NET_hub; const previousSecret = process.env.HUB_TOKEN_SECRET;
  process.env.NET_hub = `127.0.0.1:${hub.address().port}`; process.env.HUB_TOKEN_SECRET = secret;
  t.after(() => { if (previousHub === undefined) delete process.env.NET_hub; else process.env.NET_hub = previousHub;
    if (previousSecret === undefined) delete process.env.HUB_TOKEN_SECRET; else process.env.HUB_TOKEN_SECRET = previousSecret; });
  const store = new Store(join(directory, 'store.json')); const service = createAccountService({ store });
  const server = await service.listen(0, '127.0.0.1'); t.after(() => service.server.close());
  const base = `http://127.0.0.1:${server.address().port}`; let cookie;
  async function call(path, body) {
    const response = await fetch(`${base}${path}`, { method: body ? 'POST' : 'GET',
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0]; return response;
  }
  assert.equal((await call('/api/admin/asr')).status, 401);
  assert.equal((await call('/api/signup', { email: 'asr-admin@example.test', password: 'a-long-synthetic-password' })).status, 200);
  assert.equal((await call('/api/admin/asr')).status, 403); assert.equal(requests, 0);
  [...store.accounts.values()].find((account) => account.email === 'asr-admin@example.test').isAdmin = true; store.flush();
  const response = await call('/api/admin/asr?upstream=http://untrusted.invalid'); assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { mode: 'auto', google: null, parakeet: { state: 'up', since: 123, recheckMs: null } });
  assert.equal(requests, 1);
});
