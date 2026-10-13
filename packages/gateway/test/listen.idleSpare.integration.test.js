import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { createGateway } from '../src/index.js';
import * as listen from '../src/listenTransaction.js';
import { recentVoiceTurns, recentLogs } from '@phoenix/common';

const idleMs = listen.IDLE_SPARE_TIMEOUT_MS ?? 10_000;

test('real spare closes 1000 with no ERROR; active, proactive and reconnect sockets survive independently', { timeout: idleMs + 8000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'idle-spare-wire-'));
  const prior = process.env.PHOENIX_RUNTIME_DIR;
  process.env.PHOENIX_RUNTIME_DIR = directory;
  const gateway = await createGateway({ disableAuth: true, skills: [], parserURL: 'http://127.0.0.1:9',
    historyURL: 'http://127.0.0.1:9', recordLaunchHistory: false, recordSpeechHistory: false });
  t.after(async () => {
    for (const ws of gateway.wss.clients) ws.terminate();
    await new Promise(resolve => gateway.service.server.close(resolve));
    if (prior === undefined) delete process.env.PHOENIX_RUNTIME_DIR; else process.env.PHOENIX_RUNTIME_DIR = prior;
    rmSync(directory, { recursive: true, force: true });
  });
  await gateway.service.listen(0, '127.0.0.1');
  const root = `ws://127.0.0.1:${gateway.service.server.address().port}`;
  const open = async (id, path = '/v1/listen') => {
    const ws = new WebSocket(root + path, { headers: { 'x-jibo-transid': id } });
    const frames = [];
    ws.on('message', data => frames.push(JSON.parse(data)));
    await once(ws, 'open');
    return { ws, frames };
  };
  const state = () => JSON.parse(readFileSync(join(directory, 'deployment', 'hub.json')));
  const spare = await open('synthetic-idle-spare');
  const closed = once(spare.ws, 'close');
  const active = await open('synthetic-active-spare-label');
  const proactive = await open('synthetic-proactive', '/v1/proactive');
  const sos = once(active.ws, 'message');
  active.ws.send(JSON.stringify({ type: 'LISTEN', data: { lang: 'en-US', mode: 'CLIENT_NLU' } }));
  active.ws.send(JSON.stringify({ type: 'CONTEXT', data: { general: { lang: 'en', release: '1.9.0' }, runtime: {}, skill: {} } }));
  await sos;
  assert.equal(state().active.voice, 3);
  spare.ws.ping(); // WebSocket liveness is not a turn request.
  await delay(idleMs + 150);
  assert.equal(spare.ws.readyState, WebSocket.CLOSED, 'an unused real socket must not wait for the 60 s terminal deadline');
  const [code, reason] = await closed;
  assert.equal(code, 1000);
  assert.equal(reason.toString(), 'idle-spare');
  assert.deepEqual(spare.frames, []);
  assert.equal(active.ws.readyState, WebSocket.OPEN);
  assert.equal(proactive.ws.readyState, WebSocket.OPEN);
  assert.equal(state().active.voice, 2, 'only the spare releases its deployment reservation');
  active.ws.send(JSON.stringify({ type: 'CLIENT_NLU', data: { intent: null, rules: [], entities: {} } }));
  for (let i = 0; i < 100 && !active.frames.some(frame => frame.final); i++) await delay(10);
  assert.equal(active.frames.at(-1).type, 'LISTEN');
  assert.equal(active.frames.at(-1).final, true);
  const next = await open('synthetic-reconnect');
  next.ws.send(JSON.stringify({ type: 'CLIENT_NLU', data: { intent: null, rules: [], entities: {} } }));
  for (let i = 0; i < 100 && !next.frames.some(frame => frame.final); i++) await delay(10);
  assert.equal(next.frames.at(-1).type, 'LISTEN');
  assert.equal(state().active.voice, 1, 'the untouched proactive socket is the only remaining reservation');
  const logs = recentLogs({ ns: 'gateway.listen', limit: 1000 }).events;
  const marker = logs.find(row => row.transId === 'synthetic-idle-spare' && row.msg === 'voice_turn_idle_spare');
  assert.ok(marker);
  assert.equal(recentVoiceTurns({ turnId: marker.turnId }).turns[0].outcome, 'idle_spare');
  assert.equal(logs.filter(row => row.transId === 'synthetic-idle-spare' && ['transaction failed', 'voice_turn_socket_close'].includes(row.msg)).length, 0);
  t.diagnostic(JSON.stringify({ closeCode: code, reason: reason.toString(), idleMs: marker.idleMs, spareFrames: spare.frames.length,
    activeFinal: active.frames.at(-1).type, reconnectFinal: next.frames.at(-1).type, activeReservations: state().active.voice }));
});
