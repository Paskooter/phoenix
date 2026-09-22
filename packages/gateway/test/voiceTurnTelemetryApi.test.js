import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createVoiceTurnId,
  logVoiceTurnComplete,
  logVoiceTurnSpan,
  recordVoiceTurnAsrBreakdown,
  recordVoiceTurnStart,
  voiceTurnTelemetryProof,
} from '@phoenix/common';
import { createGateway } from '../src/index.js';

const secret = 'voice-turn-test-secret';
const silentLog = { info() {} };
let nonceNumber = 0;

function telemetryHeaders(target) {
  const timestamp = String(Date.now());
  const nonce = `voice-turn-test-nonce-${String(++nonceNumber).padStart(8, '0')}`;
  return {
    'x-phoenix-voice-turn-proof': voiceTurnTelemetryProof(secret, {
      method: 'GET', target, timestamp, nonce,
    }),
    'x-phoenix-voice-turn-timestamp': timestamp,
    'x-phoenix-voice-turn-nonce': nonce,
  };
}

async function startGateway() {
  const gateway = await createGateway({
    disableAuth: true,
    hubTokenSecret: secret,
    skills: [],
    parserURL: 'http://127.0.0.1:9',
    historyURL: 'http://127.0.0.1:9',
    settingsURL: 'http://127.0.0.1:9',
    recordLaunchHistory: false,
    recordSpeechHistory: false,
  });
  const server = await gateway.service.listen(0, '127.0.0.1');
  return { gateway, base: `http://127.0.0.1:${server.address().port}` };
}

test('the gateway telemetry endpoint requires a server-held proof and returns only structured timing fields', async (t) => {
  const trace = { turnId: createVoiceTurnId(), transId: 'existing-correlation-only' };
  const began = Date.now() - 30;
  recordVoiceTurnStart(trace, began);
  logVoiceTurnSpan(silentLog, trace, 'nlu', began + 10, 'ok');
  recordVoiceTurnAsrBreakdown(trace, { audioMs: 700, silenceWaitMs: 400, recognizeMs: 25, text: 'must not retain this' });
  logVoiceTurnComplete(silentLog, trace, began, 'skill');

  const { gateway, base } = await startGateway();
  t.after(() => { gateway.wss.close(); gateway.service.server.close(); });

  const denied = await fetch(`${base}/v1/admin/voice-turns?turnId=${trace.turnId}`);
  assert.equal(denied.status, 403);

  const path = `/v1/admin/voice-turns?turnId=${trace.turnId}&stage=nlu`;
  const headers = telemetryHeaders(path);
  const allowed = await fetch(`${base}${path}`, { headers });
  assert.equal(allowed.status, 200);
  const page = await allowed.json();
  assert.equal(page.turns.length, 1);
  assert.deepEqual(Object.keys(page.turns[0]).sort(), ['asr', 'completedAt', 'outcome', 'stages', 'startedAt', 'totalMs', 'turnId']);
  assert.deepEqual(page.turns[0].asr, { audioMs: 700, silenceWaitMs: 400, recognizeMs: 25 });
  assert.equal(page.turns[0].stages.length, 1);
  assert.deepEqual(Object.keys(page.turns[0].stages[0]).sort(), ['durationMs', 'endedAt', 'outcome', 'stage', 'startedAt']);
  assert.equal(page.turns[0].stages[0].stage, 'nlu');
  assert.equal(page.turns[0].stages[0].outcome, 'ok');
  assert.equal(page.turns[0].stages[0].startedAt, began + 10);
  assert.equal(typeof page.turns[0].stages[0].endedAt, 'number');
  assert.ok(page.turns[0].stages[0].endedAt >= page.turns[0].stages[0].startedAt);
  assert.equal(JSON.stringify(page).includes('must not retain this'), false);
  assert.equal(JSON.stringify(page).includes('existing-correlation-only'), false);
  assert.equal((await fetch(`${base}${path}`, { headers })).status, 403, 'a valid proof may not be replayed');
});

test('the gateway telemetry endpoint rejects invalid content filters and bounds its limit', async (t) => {
  const { gateway, base } = await startGateway();
  t.after(() => { gateway.wss.close(); gateway.service.server.close(); });
  const invalidId = '/v1/admin/voice-turns?turnId=not-an-id';
  const tooMany = '/v1/admin/voice-turns?limit=101';
  const invalidStage = '/v1/admin/voice-turns?stage=transcript';
  assert.equal((await fetch(`${base}${invalidId}`, { headers: telemetryHeaders(invalidId) })).status, 400);
  assert.equal((await fetch(`${base}${tooMany}`, { headers: telemetryHeaders(tooMany) })).status, 400);
  assert.equal((await fetch(`${base}${invalidStage}`, { headers: telemetryHeaders(invalidStage) })).status, 400);
});
