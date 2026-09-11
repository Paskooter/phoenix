// H-08 — speech + launch history written by the REAL hub over a REAL socket, and surviving a
// process-level SIGKILL restart of the history service.
//
// This is the H-08 proof at the deployed topology: `createGateway` (real WebSocket) ->
// real HTTP history service (child process over ETCO_history_dataFile) -> durable store.
// After the turn the history process is SIGKILLed (no graceful shutdown, nothing flushed on
// exit), a FRESH process is started over the same file, and the records written by the hub are
// read back through the wire. Mirrors packages/history/test/history.durability.test.js (I-03)
// and packages/gateway/test/listen.skillHandoff.test.js (H-04).

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { createGateway } from '../src/index.js';
import { jwt } from '@phoenix/common';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const HISTORY_ENTRY = join(ROOT, 'packages', 'history', 'src', 'index.js');
const SECRET = 'h08-integration-secret';

async function freePort() {
  const srv = http.createServer();
  await new Promise((resolve) => srv.listen(0, resolve));
  const port = srv.address().port;
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

async function request(base, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text === '' ? null : JSON.parse(text) };
}

/** Start the real history entrypoint over `file`, as the deployment does. */
async function startHistoryChild(file) {
  const port = await freePort();
  const child = spawn(process.execPath, [HISTORY_ENTRY], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), ETCO_history_dataFile: file },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stdout.resume();
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      if ((await fetch(`${base}/healthcheck`)).status === 200) {
        return { base, stop: () => new Promise((r) => { if (child.exitCode !== null || child.signalCode !== null) return r(); child.once('close', r); child.kill('SIGKILL'); }) };
      }
    } catch { /* not listening yet */ }
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill('SIGKILL');
  throw new Error(`history child did not start: ${stderr}`);
}

/** A controlled cloud skill that always answers with a session. */
async function startSkillPeer() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ type: 'SKILL_ACTION', msgID: 'peer-action', ts: 1,
      data: { skill: { id: 'source', session: { id: 'hist-session' } }, action: { type: 'JCP' } } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { requests, url: `http://127.0.0.1:${server.address().port}/v1/main`, close: () => new Promise((r) => server.close(r)) };
}

/** One CLIENT_NLU turn over the real gateway WebSocket, resolving on the final frame. */
async function runTurn(gateway, { transId, speaker = 'hist-person' }) {
  const port = gateway.service.server.address().port;
  const frames = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/listen`, {
    headers: { authorization: `Bearer ${jwt.sign({ id: 'account-hist', friendlyId: 'robot-hist' }, SECRET)}`, 'x-jibo-transid': transId },
  });
  ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
  await once(ws, 'open');
  const msg = (type, data) => JSON.stringify({ type, msgID: `m-${type}`, ts: 1700000000000, data });
  ws.send(msg('LISTEN', { lang: 'en-US', mode: 'CLIENT_NLU', hotphrase: false, rules: ['launch'] }));
  ws.send(msg('CONTEXT', {
    general: { accountID: 'account-hist', robotID: 'robot-hist', lang: 'en', release: '1.8.0' },
    runtime: { perception: { speaker, peoplePresent: [] }, dialog: {}, loop: { users: [] } },
    skill: {},
  }));
  ws.send(msg('CLIENT_NLU', { intent: 'launch-intent', rules: ['launch'], entities: {}, external: {} }));
  await Promise.race([
    new Promise((resolve) => { const poll = () => { if (frames.some((f) => f.final)) resolve(); else setTimeout(poll, 2); }; poll(); }),
    new Promise((r) => setTimeout(r, 4000)),
  ]);
  await new Promise((r) => setTimeout(r, 400)); // let the fire-and-forget history writes land
  ws.terminate();
  return frames;
}

const rawStore = async (file) => JSON.parse(await readFile(file, 'utf8'));

test('hub speech + launch records are written over the wire and survive a SIGKILL restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'h08-history-'));
  const file = join(dir, 'store.json');
  let history;
  let second;
  let gateway;
  let peer;
  try {
    history = await startHistoryChild(file);
    peer = await startSkillPeer();
    gateway = await createGateway({
      skills: [{ id: 'source', URL: peer.url, intents: [{ name: 'launch-intent' }] }],
      parserURL: 'http://127.0.0.1:1', historyURL: history.base,
      disableAuth: false, hubTokenSecret: SECRET, accountUrl: '',
      recordLaunchHistory: true, recordSpeechHistory: true, asrProvider: 'none',
    });
    await gateway.service.listen(0);

    const frames = await runTurn(gateway, { transId: 'tid-hist' });
    assert.deepEqual(frames.map((f) => f.type), ['SOS', 'EOS', 'LISTEN', 'SKILL_ACTION']);

    const store1 = await rawStore(file);
    assert.equal(store1.skillLaunches.length, 1, 'the hub wrote one launch row');
    assert.equal(store1.speech.length, 1, 'the hub wrote one speech row');

    const launch = store1.skillLaunches[0];
    assert.deepEqual({
      robotID: launch.robotID, sessionID: launch.sessionID, skillID: launch.skillID,
      intent: launch.intent, personIDs: launch.personIDs,
    }, { robotID: 'robot-hist', sessionID: 'hist-session', skillID: 'source', intent: 'launch-intent', personIDs: ['hist-person'] });

    const speech = store1.speech[0];
    assert.equal(speech.robotID, 'robot-hist');
    assert.equal(speech.accountID, 'account-hist');
    assert.equal(speech.transID, 'tid-hist', 'the hub trace transID rode the speech body');
    assert.equal(speech.audioFileURL, null);
    assert.equal(typeof speech.timestamp, 'number');
    assert.deepEqual(speech.asr, { text: '', confidence: 1 });
    assert.deepEqual(speech.nlu, { intent: 'launch-intent', rules: ['launch'], entities: {}, external: {} });
    assert.deepEqual(speech.match, { skillID: 'source', launch: true, onRobot: false });
    assert.equal(speech.skill.skillID, 'source');
    assert.equal(speech.skill.response.data.skill.session.id, 'hist-session');

    // Process-level durability: SIGKILL the history service (no flush on exit), start a fresh
    // process over the same file, and read the hub's records back through the wire.
    await history.stop();
    history = null;

    second = await startHistoryChild(file);
    const count = await request(second.base, 'POST', '/v1/skill/launch/count', { robotID: 'robot-hist' });
    assert.deepEqual(count.json, { count: 1 }, 'the launch row survives the restart');
    const latest = await request(second.base, 'POST', '/v1/skill/launch/latest', { robotID: 'robot-hist' });
    assert.equal(latest.json.sessionID, 'hist-session');
    assert.deepEqual(latest.json.personIDs, ['hist-person']);

    const updated = await request(second.base, 'PUT', `/v1/speech/${speech.id}`, { nlu: { intent: 'post-restart' } });
    assert.equal(updated.status, 200, 'the speech id minted before the kill still resolves');
    assert.deepEqual(updated.json, { id: speech.id });

    await second.stop();
    second = null;
    const store2 = await rawStore(file);
    const after = store2.speech.find((r) => r.id === speech.id);
    assert.deepEqual(after.asr, { text: '', confidence: 1 }, 'the pre-restart field is preserved (non-erasing update)');
    assert.deepEqual(after.nlu, { intent: 'post-restart' }, 'the post-restart update persisted');
    assert.deepEqual(after.match, { skillID: 'source', launch: true, onRobot: false });
  } finally {
    if (history) await history.stop();
    if (second) await second.stop();
    if (gateway) {
      for (const client of gateway.wss.clients) client.terminate();
      gateway.wss.close();
      gateway.service.server.closeAllConnections?.();
      await new Promise((r) => gateway.service.server.close(r));
    }
    if (peer) await peer.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('recordSpeechHistory defaults off: no speech row is written, the launch row still is', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'h08-history-off-'));
  const file = join(dir, 'store.json');
  let history;
  let gateway;
  let peer;
  try {
    history = await startHistoryChild(file);
    peer = await startSkillPeer();
    gateway = await createGateway({
      skills: [{ id: 'source', URL: peer.url, intents: [{ name: 'launch-intent' }] }],
      parserURL: 'http://127.0.0.1:1', historyURL: history.base,
      disableAuth: false, hubTokenSecret: SECRET, accountUrl: '',
      recordLaunchHistory: true, recordSpeechHistory: false, asrProvider: 'none',
    });
    await gateway.service.listen(0);
    await runTurn(gateway, { transId: 'tid-off' });

    const store = await rawStore(file);
    assert.equal(store.skillLaunches.length, 1);
    assert.equal(store.speech.length, 0, 'the default-off speech sink never posts');
  } finally {
    if (history) await history.stop();
    if (gateway) {
      for (const client of gateway.wss.clients) client.terminate();
      gateway.wss.close();
      gateway.service.server.closeAllConnections?.();
      await new Promise((r) => gateway.service.server.close(r));
    }
    if (peer) await peer.close();
    await rm(dir, { recursive: true, force: true });
  }
});
