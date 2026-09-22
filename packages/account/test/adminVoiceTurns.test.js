import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { voiceTurnTelemetryProof } from '@phoenix/common';
import { Store } from '../src/store.js';
import { createAccountService } from '../src/index.js';

const SECRET = 'account-voice-turn-test-secret';
const TURN_ID = '0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d';

let directory;
let hub;
let service;
let base;
const jars = new Map();

async function call(method, path, body, jar = 'admin') {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(jars.get(jar) ? { cookie: jars.get(jar) } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const cookie = response.headers.get('set-cookie');
  if (cookie) jars.set(jar, cookie.split(';')[0]);
  return { status: response.status, body: await response.json().catch(() => null) };
}

test.before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'phx-admin-voice-'));
  hub = http.createServer((req, res) => {
    assert.equal(req.url.startsWith('/v1/admin/voice-turns?'), true);
    const target = new URL(req.url, 'http://hub.internal');
    const timestamp = req.headers['x-phoenix-voice-turn-timestamp'];
    const nonce = req.headers['x-phoenix-voice-turn-nonce'];
    assert.match(timestamp, /^[0-9]{1,16}$/);
    assert.match(nonce, /^[A-Za-z0-9_-]{16,128}$/);
    assert.equal(req.headers['x-phoenix-voice-turn-proof'], voiceTurnTelemetryProof(SECRET, {
      method: req.method,
      target: `${target.pathname}${target.search}`,
      timestamp,
      nonce,
    }));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      turns: [{
        turnId: TURN_ID, startedAt: 100, completedAt: 150, totalMs: 50, outcome: 'skill',
        stages: [{ stage: 'nlu', durationMs: 10, outcome: 'ok', hidden: 'not for browser' }],
        asr: { audioMs: 20, silenceWaitMs: 30, recognizeMs: 40, transcript: 'never expose' },
        robotId: 'also-hidden',
      }],
      retained: 1, maxRetained: 200, retentionMs: 3600000,
      outcomes: ['skill'], stages: ['nlu'], scope: 'gateway-process', arbitraryLog: 'hidden',
    }));
  });
  await new Promise((resolve) => hub.listen(0, '127.0.0.1', resolve));
  process.env.NET_hub = `127.0.0.1:${hub.address().port}`;
  process.env.HUB_TOKEN_SECRET = SECRET;
  const store = new Store(join(directory, 'store.json'));
  service = createAccountService({ store });
  const server = await service.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${server.address().port}`;
  const signedUp = await call('POST', '/api/signup', { email: 'voice-admin@example.test', password: 'a-long-admin-password' });
  assert.equal(signedUp.status, 200);
  store.accountByEmail('voice-admin@example.test').isAdmin = true;
  store.flush();
});

test.after(async () => {
  service.server.close();
  await new Promise((resolve) => hub.close(resolve));
  delete process.env.NET_hub;
  delete process.env.HUB_TOKEN_SECRET;
  await rm(directory, { recursive: true, force: true });
});

test('voice-turn admin API is session-admin-only', async () => {
  assert.equal((await call('GET', '/api/admin/voice-turns', null, 'anonymous')).status, 401);
  assert.equal((await call('POST', '/api/signup', { email: 'voice-user@example.test', password: 'a-long-user-password' }, 'user')).status, 200);
  assert.equal((await call('GET', '/api/admin/voice-turns', null, 'user')).status, 403);
});

test('voice-turn admin API forwards only a privacy-safe telemetry projection', async () => {
  const result = await call('GET', `/api/admin/voice-turns?turnId=${TURN_ID}&stage=nlu`, null);
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.body).sort(), ['maxRetained', 'outcomes', 'retained', 'retentionMs', 'scope', 'stages', 'turns']);
  assert.deepEqual(Object.keys(result.body.turns[0]).sort(), ['asr', 'completedAt', 'outcome', 'stages', 'startedAt', 'totalMs', 'turnId']);
  assert.deepEqual(result.body.turns[0].asr, { audioMs: 20, silenceWaitMs: 30, recognizeMs: 40 });
  assert.equal(JSON.stringify(result.body).includes('never expose'), false);
  assert.equal(JSON.stringify(result.body).includes('also-hidden'), false);
  assert.equal(JSON.stringify(result.body).includes('not for browser'), false);
  assert.equal(JSON.stringify(result.body).includes('hidden'), false);
});
