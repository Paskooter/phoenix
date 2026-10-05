// Actual Gateway/Account/parser HTTP and robot WebSocket lifecycle, all synthetic.
// These tests authorize no native wake and execute no HA or robot operation.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { jwt } from '@phoenix/common';
import { createGateway } from '../src/index.js';
import { GLOBAL_TURN_RULES } from '../src/listenTransaction.js';
import { loadRegistry } from '../src/registry.js';
import { parseRequest } from '../../nlu/src/requestParser.js';

const SECRET = 'synthetic-local-home-signing-secret';
const PEER = 'synthetic-local-home-peer';
const ROBOT = { id: 'synthetic-local-account', friendlyId: 'synthetic-local-robot', accessKeyId: 'synthetic-local-key' };
const NO_DECLARATION = Symbol('no local declaration');
const preference = () => ({ v: 1, capabilities: ['room_context', 'state_queries', 'follow_up', 'routine_shortcuts'],
  shortcuts: [{ id: '11111111-2222-4333-8444-aaaaaaaaaaaa', phrase: 'movie time' }],
  follow_up: { available: false, expires_at_ms: 0 },
});
const message = (type, data) => JSON.stringify({ type, data, msgID: `synthetic-${type}`, ts: Date.now() });

async function eventually(condition) {
  for (let i = 0; i < 200; i++) { if (condition()) return; await delay(5); }
  assert.fail('Synthetic Gateway lifecycle did not settle');
}

async function fixture(t, { sharedSecretOnly = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'phoenix-local-home-'));
  const previousRuntime = process.env.PHOENIX_RUNTIME_DIR;
  process.env.PHOENIX_RUNTIME_DIR = directory;
  const requests = [];
  const live = { identity: ROBOT, active: true };
  const parser = { entered: false, gate: null };
  const account = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://synthetic');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ path: url.pathname, body });
    let result;
    if (url.pathname === '/api/verify') result = { valid: live.active,
      id: live.identity.id, friendlyId: live.identity.friendlyId };
    else if (url.pathname === '/v1/parse') {
      parser.entered = true;
      if (parser.gate) await parser.gate;
      result = { data: parseRequest(body.data) };
    } else if (url.pathname === '/internal/home-assistant/selection') {
      assert.equal(req.headers['x-phoenix-internal-token'], PEER);
      result = { enabled: true, ...preference() };
    } else if (url.pathname === '/internal/home-assistant/command') {
      assert.equal(req.headers['x-phoenix-internal-token'], PEER);
      result = { outcome: 'success', response_type: 'action_done', speech: 'Synthetic cloud answer.' };
    } else { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result));
  });
  await new Promise((resolve) => account.listen(0, '127.0.0.1', resolve));
  const peerUrl = `http://127.0.0.1:${account.address().port}`;
  const skills = await loadRegistry({ indexFile: 'skills-phoenix.json', skillsBase: peerUrl });
  const gateway = await createGateway({ skills, parserURL: peerUrl, historyURL: peerUrl,
    disableAuth: false, hubTokenSecret: SECRET, accountUrl: sharedSecretOnly ? '' : peerUrl,
    recordLaunchHistory: false, recordSpeechHistory: false,
    homeAssistant: { url: peerUrl, token: PEER },
  });
  await gateway.service.listen(0, '127.0.0.1');
  const url = `ws://127.0.0.1:${gateway.service.server.address().port}/v1/listen`;
  t.after(async () => {
    gateway.robotActions.close();
    for (const socket of gateway.wss.clients) socket.terminate();
    await new Promise((resolve) => gateway.wss.close(resolve));
    gateway.service.server.closeAllConnections();
    await new Promise((resolve) => gateway.service.server.close(resolve));
    account.closeAllConnections();
    await new Promise((resolve) => account.close(resolve));
    if (previousRuntime === undefined) delete process.env.PHOENIX_RUNTIME_DIR;
    else process.env.PHOENIX_RUNTIME_DIR = previousRuntime;
    rmSync(directory, { recursive: true, force: true });
  });
  const activity = () => JSON.parse(readFileSync(join(directory, 'deployment', 'hub.json'), 'utf8'));
  const cloud = () => requests.filter((request) => request.path.startsWith('/internal/home-assistant/'));
  async function open(identity = ROBOT, secret = SECRET) {
    const frames = [];
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${jwt.sign(identity, secret)}`,
      'x-jibo-robotid': 'synthetic-spoofed-robot', 'x-jibo-transid': 'synthetic-spoofed-turn' } });
    socket.on('error', () => {});
    socket.on('message', (data) => frames.push(JSON.parse(data.toString())));
    await once(socket, 'open');
    return { socket, frames };
  }
  function sendContext(socket, identity = ROBOT, local = preference()) {
    socket.send(message('CONTEXT', {
      general: { accountID: identity.id, robotID: identity.friendlyId, release: '13.2.0', householdID: 'synthetic-spoofed-household' },
      runtime: { loop: { users: [] } }, skill: {},
      ...(local === NO_DECLARATION ? {} : { phoenix_local_home: local }),
    }));
  }
  async function voice(text, { identity = ROBOT, local = preference() } = {}) {
    const out = await open(identity);
    out.socket.send(message('LISTEN', { mode: 'CLIENT_ASR', lang: 'en-US', hotphrase: true, rules: [...GLOBAL_TURN_RULES] }));
    sendContext(out.socket, identity, local);
    out.socket.send(message('CLIENT_ASR', { text }));
    await eventually(() => out.frames.some((frame) => frame.final));
    return out;
  }
  return { gateway, live, requests, cloud, parser, activity, open, voice, sendContext, url };
}

test('verified real sockets return only final native SDK-compatible hints; cloud beta remains available without a declaration', async (t) => {
  const f = await fixture(t);
  for (const [text, kind] of [['turn on the study light', 'command'], ['is the study light on', 'query'], ['movie time', 'routine']]) {
    const out = await f.voice(text);
    const result = out.frames.find((frame) => frame.type === 'LISTEN');
    assert.deepEqual(out.frames.map((frame) => frame.type), ['SOS', 'EOS', 'LISTEN']);
    assert.deepEqual(result.data.match, { skillID: '@be/home-assistant', launch: true, onRobot: true });
    assert.equal(result.final, true);
    assert.equal(result.data.asr.text, text);
    assert.equal(result.data.nlu.entities.phoenix_local_home.text, text);
    assert.equal(result.data.nlu.entities.phoenix_local_home.route.kind, kind);
    assert.deepEqual(f.cloud(), []);
    await eventually(() => f.activity().active.voice === 0);
    assert.equal(out.socket.readyState, WebSocket.OPEN); // native handoff settles the transaction, not the socket.
    out.socket.close();
    await once(out.socket, 'close');
  }
  const cloud = await f.voice('turn on the study light', { local: NO_DECLARATION });
  assert.equal(cloud.frames.at(-1).type, 'SKILL_ACTION');
  assert.deepEqual(f.cloud().map((request) => request.path), ['/internal/home-assistant/selection', '/internal/home-assistant/command']);
  assert.deepEqual(f.cloud().at(-1).body, { identity: ROBOT, text: 'turn on the study light', language: 'en', route: { kind: 'command' } });
  cloud.socket.close();
});

test('signature plus exact live Account identity is required; declarations/context/tracing do not supply it', async (t) => {
  const f = await fixture(t);
  f.live.identity = { ...ROBOT, id: 'different-live-account' };
  const mismatch = await f.voice('ask Home Assistant to start custom fixture');
  assert.equal(mismatch.frames.find((frame) => frame.type === 'LISTEN').data.match, null);
  assert.deepEqual(f.cloud(), []);
  mismatch.socket.close();
  f.live.identity = ROBOT;
  const legacyClaims = await f.voice('ask Home Assistant to start custom fixture', {
    identity: { id: ROBOT.id, friendlyId: ROBOT.friendlyId },
  });
  assert.equal(legacyClaims.frames.find((frame) => frame.type === 'LISTEN').data.match, null);
  assert.deepEqual(f.cloud(), []);
  legacyClaims.socket.close();
  f.live.active = false;
  const rejected = new WebSocket(f.url, { headers: { Authorization: `Bearer ${jwt.sign(ROBOT, SECRET)}` } });
  rejected.on('error', () => {});
  const [, inactive] = await once(rejected, 'unexpected-response');
  assert.equal(inactive.statusCode, 401);
  inactive.resume(); rejected.terminate();
  f.live.active = true;
  const verifyCount = f.requests.filter((request) => request.path === '/api/verify').length;
  const forged = new WebSocket(f.url, { headers: { Authorization: `Bearer ${jwt.sign(ROBOT, 'wrong-synthetic-secret')}` } });
  forged.on('error', () => {});
  const [, invalid] = await once(forged, 'unexpected-response');
  assert.equal(invalid.statusCode, 401);
  invalid.resume(); forged.terminate();
  assert.equal(f.requests.filter((request) => request.path === '/api/verify').length, verifyCount);
  assert.deepEqual(f.cloud(), []);
});

test('shared-secret legacy mode cannot authorize local routing and cannot silently call cloud HA', async (t) => {
  const f = await fixture(t, { sharedSecretOnly: true });
  const out = await f.voice('ask Home Assistant to start custom fixture');
  assert.equal(out.frames.find((frame) => frame.type === 'LISTEN').data.match, null);
  assert.deepEqual(f.cloud(), []);
  assert.ok(f.requests.every((request) => request.path !== '/api/verify'));
  out.socket.close();
});

test('server ASR audio uses the real voice lifecycle and releases Hub activity at local handoff', async (t) => {
  const f = await fixture(t);
  let sos, eos, finish;
  const observed = { audio: 0, stops: 0, hotphrase: false };
  f.gateway.components.asrProvider = (config) => {
    observed.hotphrase = config.hotphrase;
    return { onStartOfSpeech(callback) { sos = callback; }, onEndOfSpeech(callback) { eos = callback; },
      start() { return new Promise((resolve) => { finish = resolve; }); },
      provideAudio(chunk) { observed.audio += chunk.length; sos(); eos(); finish({ text: 'turn on the study light', confidence: 0.9 }); },
      stop() { observed.stops++; }, getLastIncremental() { return null; },
    };
  };
  const out = await f.open();
  out.socket.send(message('LISTEN', { lang: 'en-US', hotphrase: true, rules: [...GLOBAL_TURN_RULES] }));
  f.sendContext(out.socket);
  await eventually(() => !!finish);
  assert.equal(f.activity().active.voice, 1);
  out.socket.send(Buffer.alloc(3200));
  await eventually(() => out.frames.some((frame) => frame.final));
  assert.equal(observed.audio, 3200);
  assert.equal(observed.hotphrase, true);
  assert.equal(observed.stops, 1);
  assert.deepEqual(out.frames.map((frame) => frame.type), ['SOS', 'EOS', 'LISTEN']);
  assert.equal(out.frames.at(-1).data.match.skillID, '@be/home-assistant');
  assert.deepEqual(f.cloud(), []);
  await eventually(() => f.activity().active.voice === 0);
  out.socket.close();
});

test('closing the voice socket during native parsing prevents a local handoff or cloud dispatch', async (t) => {
  const f = await fixture(t);
  let releaseParser;
  f.parser.gate = new Promise((resolve) => { releaseParser = resolve; });
  const out = await f.open();
  out.socket.send(message('LISTEN', { mode: 'CLIENT_ASR', lang: 'en-US', rules: [...GLOBAL_TURN_RULES] }));
  f.sendContext(out.socket);
  out.socket.send(message('CLIENT_ASR', { text: 'is the study light on' }));
  await eventually(() => f.parser.entered);
  assert.equal(f.activity().active.voice, 1);
  out.socket.close(); await once(out.socket, 'close');
  releaseParser();
  await eventually(() => f.activity().active.voice === 0);
  assert.deepEqual(out.frames.map((frame) => frame.type), ['SOS', 'EOS']);
  assert.deepEqual(f.cloud(), []);
});
