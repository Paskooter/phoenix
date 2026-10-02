import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { createGateway } from '../src/index.js';

test('real voice connections count until transaction completion; drain rejects new upgrades', { timeout: 5000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'hub-deploy-'));
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
  const url = `ws://127.0.0.1:${gateway.service.server.address().port}/v1/listen`;
  const state = () => JSON.parse(readFileSync(join(directory, 'deployment', 'hub.json')));
  const client = new WebSocket(url);
  await once(client, 'open');
  assert.equal(state().active.voice, 1);
  writeFileSync(join(directory, 'deployment', 'drain.json'), JSON.stringify({ version: 1, id: 'fixture', expiresAt: Date.now() + 15000 }));
  const denied = new WebSocket(url);
  const [, response] = await once(denied, 'unexpected-response');
  assert.equal(response.statusCode, 503);
  assert.equal(response.headers['retry-after'], '5');
  response.resume(); denied.on('error', () => {}); denied.terminate();
  assert.equal(state().active.voice, 1, 'claiming a drain never interrupts an admitted turn');
  const result = once(client, 'message');
  client.send('invalid JSON');
  await result;
  for (let i = 0; i < 50 && state().active.voice; i++) await delay(10);
  assert.equal(state().active.voice, 0);
  assert.equal(state().drainId, 'fixture');
  client.terminate();
});
