import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { fetchVoiceTurnPage } from '../src/admin/voiceTurnRoutes.js';
import { adminOpsRoutes } from '../src/admin/adminRoutes.js';
import { Store } from '../src/store.js';

const env = { NET_hub: '127.0.0.1:9', HUB_TOKEN_SECRET: 'synthetic-secret' };
const spare = { turnId: '0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d',
  startedAt: 100, completedAt: 10100, totalMs: 10000, outcome: 'idle_spare', stages: [], asr: null };
const page = { turns: [spare], outcomes: ['idle_spare'], retained: 1, maxRetained: 10000, retentionMs: 86400000 };

test('Account retains the idle-spare classification in the safe voice projection', async () => {
  const result = await fetchVoiceTurnPage({ env, fetchImpl: async () => new Response(JSON.stringify(page)) });
  assert.equal(result.ok, true);
  assert.deepEqual(result.page.turns, [spare]);
  assert.deepEqual(result.page.outcomes, ['idle_spare']);
});

test('admin voice summary excludes idle spares from turn counts and response latency', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'voice-spare-admin-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new Store(join(directory, 'store.json'));
  const real = { ...spare, turnId: '1a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d', outcome: 'listen', totalMs: 50 };
  const routes = adminOpsRoutes(store, {
    env: { ...env, PHOENIX_DATA_DIR: directory }, requireAdmin: () => true,
    control: () => ({ available: false }),
    fetchImpl: async url => String(url).includes('/v1/admin/voice-turns')
      ? new Response(JSON.stringify({ ...page, turns: [spare, real] })) : new Response('{}', { status: 503 }),
  });
  const result = await routes['GET /api/admin/overview']({ req: {}, res: {} });
  assert.equal(result.voice.turns, 1);
  assert.equal(result.voice.failed, 0);
  assert.equal(result.voice.medianMs, 50);
  assert.equal(result.voice.p90Ms, 50);
});

test('the portal labels an idle spare as quiet, not in progress or answered', () => {
  const source = readFileSync(new URL('../portal/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('const VOICE_OUTCOME_LABELS =');
  const end = source.indexOf('\nfunction voiceStageLabel', start);
  assert.ok(start > 0 && end > start);
  const context = vm.createContext({ spare });
  const result = vm.runInContext(`${source.slice(start, end)}\nJSON.stringify(voiceOutcome(spare))`, context);
  assert.deepEqual(JSON.parse(result), { label: 'Idle spare', tone: 'quiet' });
});
