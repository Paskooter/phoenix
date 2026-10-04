import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import * as fs from 'node:fs';
import { jwt } from '@phoenix/common';
import { createGateway } from '../src/index.js';
import { createRobotAnnouncementAdapter } from '../../account/src/integrations/homeAssistant/robotAdapter.js';
import { RobotActionReservations } from '../src/robotActionReservations.js';

const SECRET = 'synthetic-native-announcement-secret';
const PEER = 'synthetic-private-peer-token';
const ROBOT_A = { id: 'synthetic-robot-a-account', accessKeyId: 'synthetic-robot-a-key', friendlyId: 'synthetic-robot-a' };
const ROBOT_B = { id: 'synthetic-robot-b-account', accessKeyId: 'synthetic-robot-b-key', friendlyId: 'synthetic-robot-b' };
const sign = (identity) => jwt.sign({ ...identity, exp: Math.floor(Date.now() / 1000) + 60 }, SECRET);

async function eventually(condition, message) {
  for (let i = 0; i < 400; i++) { if (await condition()) return; await delay(5); }
  assert.fail(message);
}

async function fixture(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'synthetic-native-announcement-'));
  const priorRuntime = process.env.PHOENIX_RUNTIME_DIR;
  process.env.PHOENIX_RUNTIME_DIR = directory;
  overrides.setupRuntime?.(directory);
  const live = new Map([[ROBOT_A.accessKeyId, ROBOT_A], [ROBOT_B.accessKeyId, ROBOT_B]]);
  const permissions = new Map();
  const verification = { gate: null, entered: false };
  const authorization = { gate: null, entered: false, calls: 0 };
  const account = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://fixture');
    if (url.pathname === '/internal/home-assistant/robot-action/authorize') {
      authorization.calls++;
      assert.equal(request.headers['x-phoenix-internal-token'], PEER);
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (authorization.gate) { authorization.entered = true; await authorization.gate; }
      const code = permissions.get(input.identity.id);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(code ? { allowed: false, code } : { allowed: true }));
      return;
    }
    if (verification.gate) { verification.entered = true; await verification.gate; }
    const key = url.searchParams.get('accessKeyId');
    const identity = live.get(key);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(identity ? { valid: true, id: identity.id, friendlyId: identity.friendlyId } : { valid: false }));
  });
  await new Promise(resolve => account.listen(0, '127.0.0.1', resolve));
  const gateway = await createGateway({ disableAuth: false, hubTokenSecret: SECRET,
    accountUrl: `http://127.0.0.1:${account.address().port}`, accountVerifyTimeoutMs: 1000,
    parserURL: 'http://127.0.0.1:9', historyURL: 'http://127.0.0.1:9', skills: [],
    recordLaunchHistory: false, recordSpeechHistory: false,
    ...overrides, robotActions: { peerToken: PEER, heartbeatMs: 2000, ...overrides.robotActions },
  });
  await gateway.service.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${gateway.service.server.address().port}`;
  const socketBase = base.replace('http:', 'ws:');
  const adapter = createRobotAnnouncementAdapter({ url: base, token: PEER });
  t.after(async () => {
    gateway.robotActions.close();
    for (const socket of gateway.wss.clients) socket.terminate();
    await new Promise(resolve => gateway.wss.close(resolve));
    gateway.service.server.closeAllConnections();
    await new Promise(resolve => gateway.service.server.close(resolve));
    account.closeAllConnections();
    await new Promise(resolve => account.close(resolve));
    if (priorRuntime === undefined) delete process.env.PHOENIX_RUNTIME_DIR;
    else process.env.PHOENIX_RUNTIME_DIR = priorRuntime;
    rmSync(directory, { recursive: true, force: true });
  });
  const state = () => JSON.parse(readFileSync(join(directory, 'deployment', 'hub.json'), 'utf8'));
  const connect = async (identity = ROBOT_A, { activeRequestId = null, busy = activeRequestId !== null,
    token = sign(identity) } = {}) => {
    const socket = new WebSocket(`${socketBase}/v1/robot-actions`, { headers: { Authorization: `Bearer ${token}` } });
    socket.on('error', () => {});
    const welcome = nextFrame(socket);
    await once(socket, 'open');
    const serverReady = await welcome;
    assert.equal(serverReady.type, 'ready');
    assert.ok(Number.isSafeInteger(serverReady.server_time_ms));
    socket.send(JSON.stringify({ v: 1, type: 'ready', capabilities: ['announce'], busy,
      active_request_id: activeRequestId }));
    await eventually(() => gateway.robotActions.status(identity).online, 'receiver did not become ready');
    return socket;
  };
  const announce = (identity = ROBOT_A, extras = {}) => {
    const requestId = randomUUID();
    return { identity, requestId, authorizationId: `11111111-1111-4111-8111-111111111111:${requestId}`,
      text: 'Synthetic test announcement.', deadline: Date.now() + 3000, ...extras };
  };
  return { gateway, base, socketBase, adapter, state, directory, live, permissions, verification, authorization, connect, announce };
}

async function rejectUpgrade(url, token) {
  const socket = new WebSocket(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  socket.on('error', () => {});
  const [, response] = await once(socket, 'unexpected-response');
  const status = response.statusCode;
  response.resume(); socket.terminate();
  return status;
}

const nextFrame = async (socket) => JSON.parse((await once(socket, 'message', { signal: AbortSignal.timeout(5000) }))[0].toString('utf8'));
const result = (socket, frame, overrides = {}) => socket.send(JSON.stringify({ v: 1, type: 'action_result',
  request_id: frame.request_id, outcome: 'completed', confirmed: true, ...overrides }));

test('native upgrade requires live matching robot claims; receiver cannot claim another identity', async t => {
  const f = await fixture(t);
  const quiet = f.state().lastActivityAt;
  for (const token of [null, sign({ id: ROBOT_A.id }), sign({ ...ROBOT_A, id: ROBOT_B.id }),
    sign({ ...ROBOT_A, friendlyId: ROBOT_B.friendlyId }), jwt.sign(ROBOT_A, SECRET)]) {
    assert.equal(await rejectUpgrade(`${f.socketBase}/v1/robot-actions`, token), 401);
  }
  const native = await f.connect();
  const closed = once(native, 'close');
  native.send(JSON.stringify({ v: 1, type: 'status', busy: false, active_request_id: null, identity: ROBOT_B }));
  assert.equal((await closed)[0], 4002);
  assert.equal(f.state().lastActivityAt, quiet, 'failed native upgrades are not voice work');
  for (const type of ['__proto__', 'constructor', 'toString']) {
    const malformed = await f.connect();
    const rejected = once(malformed, 'close');
    malformed.send(JSON.stringify({ v: 1, type }));
    assert.equal((await rejected)[0], 4002, 'unknown frame types must not reach inherited JavaScript properties');
  }
  for (const frame of [
    { v: 1, type: 'status', busy: false },
    { v: 1, type: 'status', busy: true, active_request_id: 'invalid' },
    { v: 1, type: 'status', busy: false, active_request_id: randomUUID() },
  ]) {
    const malformed = await f.connect();
    const rejected = once(malformed, 'close');
    malformed.send(JSON.stringify(frame));
    assert.equal((await rejected)[0], 4002, 'an active marker must be explicit, valid and busy');
  }
  assert.equal(f.state().lastActivityAt, quiet);
});

test('new channel fails closed in auth-disabled mode while legacy voice still works', async t => {
  const f = await fixture(t, { disableAuth: true });
  assert.equal(await rejectUpgrade(`${f.socketBase}/v1/robot-actions`, sign(ROBOT_A)), 503);
  const voice = new WebSocket(`${f.socketBase}/v1/listen`);
  await once(voice, 'open');
  assert.equal(f.state().active.voice, 1);
  const reply = nextFrame(voice);
  voice.send('invalid JSON');
  await reply;
  await eventually(() => f.state().active.voice === 0, 'legacy voice count did not finish');
  voice.terminate();
});

test('private adapter cannot dispatch without peer token and exact socket identity', async t => {
  const f = await fixture(t);
  await f.connect();
  for (const token of [undefined, 'incorrect-peer']) {
    const response = await fetch(`${f.base}/internal/home-assistant/robot-action/announce`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { 'x-phoenix-internal-token': token } : {}) },
      body: JSON.stringify(f.announce()),
    });
    assert.equal(response.status, 403);
  }
  assert.deepEqual(await f.adapter.status({ ...ROBOT_A, id: ROBOT_B.id }), { online: false, busy: false, announcements_supported: false });
  assert.deepEqual(await f.adapter.announce(f.announce({ ...ROBOT_A, id: ROBOT_B.id })), { outcome: 'error', code: 'robot_offline' });
  f.live.delete(ROBOT_A.accessKeyId);
  assert.deepEqual(await f.adapter.announce(f.announce()), { outcome: 'error', code: 'unverified_robot' });
  assert.equal(f.gateway.robotActions.jobs.size, 0);
});

test('actual socket spoken completion is required; UUIDs never redispatch', async t => {
  const f = await fixture(t);
  const native = await f.connect();
  const input = f.announce();
  let incoming = nextFrame(native);
  let operation = f.adapter.announce(input);
  const frame = await incoming;
  assert.deepEqual(frame, { v: 1, type: 'announce', request_id: input.requestId, text: input.text,
    deadline_ms: input.deadline });
  assert.equal(Object.hasOwn(frame, 'volume'), false, 'beta speech uses the current native volume');
  assert.equal(Object.hasOwn(frame, 'authorizationId'), false, 'private Account authorization must not reach the robot');
  assert.equal(f.state().active['robot-action'], 1);
  assert.deepEqual(await f.adapter.announce(f.announce()), { outcome: 'error', code: 'busy' });
  result(native, frame);
  assert.deepEqual(await operation, { outcome: 'success', confirmed: true });
  assert.equal(f.state().active['robot-action'], 0);
  assert.deepEqual(await f.adapter.announce(input), { outcome: 'error', code: 'duplicate_request' });
  incoming = nextFrame(native); operation = f.adapter.announce(f.announce());
  const unconfirmed = await incoming;
  result(native, unconfirmed, { confirmed: false });
  assert.deepEqual(await operation, { outcome: 'uncertain', code: 'confirmation_lost' });
});

test('supplied volume rejects before authorization, reservation, activity or native dispatch', async t => {
  const f = await fixture(t);
  const native = await f.connect();
  let announces = 0;
  native.on('message', data => { if (JSON.parse(data.toString()).type === 'announce') announces++; });
  const quiet = f.state().lastActivityAt;
  for (const volume of [0, 0.3, 1, 2, null]) {
    const response = await fetch(`${f.base}/internal/home-assistant/robot-action/announce`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-phoenix-internal-token': PEER },
      body: JSON.stringify(f.announce(ROBOT_A, { volume })),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { outcome: 'error', code: 'unsupported_volume' });
  }
  assert.deepEqual(await f.gateway.robotActions.announce(f.announce(ROBOT_A, { volume: undefined })),
    { outcome: 'error', code: 'unsupported_volume' });
  assert.equal(announces, 0);
  assert.equal(f.authorization.calls, 0);
  assert.equal(f.gateway.robotActions.jobs.size, 0);
  assert.equal(f.gateway.robotActions.seenRequests.size, 0, 'unsupported volume cannot consume request IDs');
  assert.equal(f.gateway.robotActions.reservations.entries.size, 0);
  assert.equal(new RobotActionReservations({ runtimeDir: f.directory }).entries.size, 0);
  assert.deepEqual(f.state().active, {});
  assert.equal(f.state().lastActivityAt, quiet);
});

test('final Account authorization rejects household transfer or permission changes during identity lookup', async t => {
  const f = await fixture(t);
  const native = await f.connect();
  let announced = false;
  native.on('message', data => { if (JSON.parse(data.toString('utf8')).type === 'announce') announced = true; });
  const quiet = f.state().lastActivityAt;
  for (const code of ['revoked', 'permission_disabled']) {
    let release;
    f.verification.entered = false;
    f.verification.gate = new Promise(resolve => { release = resolve; });
    const operation = f.adapter.announce(f.announce());
    await eventually(() => f.verification.entered, 'Gateway identity verification was not held');
    // The Account id/key/friendly identity is unchanged. Only the live owner
    // binding or reverse permission changes while the lookup is in flight.
    f.permissions.set(ROBOT_A.id, code);
    f.verification.gate = null; release();
    assert.deepEqual(await operation, { outcome: 'error', code });
    assert.equal(announced, false);
    assert.equal(f.gateway.robotActions.jobs.size, 0);
    assert.equal(f.state().lastActivityAt, quiet);
    f.permissions.delete(ROBOT_A.id);
  }
});

test('two robots remain isolated; native busy, stale status, invalid input and expiry never execute', async t => {
  const f = await fixture(t, { robotActions: { peerToken: PEER, statusMaxAgeMs: 1500, heartbeatMs: 2000 } });
  const nativeA = await f.connect(); const nativeB = await f.connect(ROBOT_B);
  nativeA.send(JSON.stringify({ v: 1, type: 'status', busy: true, active_request_id: null }));
  await eventually(() => f.gateway.robotActions.status(ROBOT_A).busy, 'native busy was not observed');
  assert.deepEqual(await f.adapter.announce(f.announce()), { outcome: 'error', code: 'busy' });
  const incoming = nextFrame(nativeB);
  const operation = f.adapter.announce(f.announce(ROBOT_B));
  const frame = await incoming;
  result(nativeB, frame, { outcome: 'rejected', confirmed: false, code: 'busy' });
  assert.deepEqual(await operation, { outcome: 'error', code: 'busy' });
  for (const extras of [{ text: 'x'.repeat(301) }, { text: 'invalid\u0000text' },
    { deadline: Date.now() + 46_000 }, { requestId: 'invented-non-uuid' }, { authorizationId: 'invalid-ledger' },
    { authorizationId: '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222' }]) {
    assert.deepEqual(await f.adapter.announce(f.announce(ROBOT_B, extras)), { outcome: 'error', code: 'invalid_request' });
  }
  assert.deepEqual(await f.adapter.announce(f.announce(ROBOT_B, { deadline: Date.now() - 1 })), { outcome: 'error', code: 'expired' });
  await delay(1600);
  assert.deepEqual(await f.adapter.status(ROBOT_B), { online: false, busy: false, announcements_supported: false });
  assert.deepEqual(await f.adapter.announce(f.announce(ROBOT_B)), { outcome: 'error', code: 'robot_offline' });
});

test('voice excludes reverse jobs and interrupts announced speech only after native stop ack', async t => {
  const f = await fixture(t);
  const native = await f.connect();
  const voice = new WebSocket(`${f.socketBase}/v1/listen`, { headers: { Authorization: `Bearer ${sign(ROBOT_A)}` } });
  await once(voice, 'open');
  assert.deepEqual(await f.adapter.announce(f.announce()), { outcome: 'error', code: 'busy' });
  const voiceReply = nextFrame(voice); voice.send('invalid JSON'); await voiceReply;
  await eventually(() => !f.gateway.robotActions.status(ROBOT_A).busy, 'voice reservation did not settle');
  voice.terminate();
  const incoming = nextFrame(native);
  const operation = f.adapter.announce(f.announce());
  const frame = await incoming;
  const cancellation = nextFrame(native);
  let opened = false;
  const nextVoice = new WebSocket(`${f.socketBase}/v1/listen`, { headers: { Authorization: `Bearer ${sign(ROBOT_A)}` } });
  nextVoice.on('open', () => { opened = true; });
  const voiceOpened = once(nextVoice, 'open');
  assert.deepEqual(await cancellation, { v: 1, type: 'cancel', request_id: frame.request_id, reason: 'voice' });
  assert.equal(opened, false, 'voice started before native speech stopped');
  assert.equal(f.state().active['robot-action'], 1);
  result(native, frame, { outcome: 'uncertain', confirmed: false, code: 'interrupted' });
  assert.deepEqual(await operation, { outcome: 'uncertain', code: 'interrupted' });
  await voiceOpened;
  assert.equal(f.state().active['robot-action'], 0);
  const nextReply = nextFrame(nextVoice); nextVoice.send('invalid JSON'); await nextReply;
  nextVoice.terminate();
});

test('lost connection preserves admission until native idle after deadline; reconnect never replays', async t => {
  const f = await fixture(t);
  const native = await f.connect();
  const incoming = nextFrame(native);
  const input = f.announce(ROBOT_A, { deadline: Date.now() + 800 });
  const operation = f.adapter.announce(input);
  await incoming;
  native.terminate();
  assert.deepEqual(await operation, { outcome: 'uncertain', code: 'confirmation_lost' });
  assert.equal(f.state().active['robot-action'], 1, 'unknown speech completion must keep deployment waiting');
  const replacement = await f.connect(ROBOT_A, { activeRequestId: input.requestId });
  let replayed = false;
  replacement.on('message', data => { if (JSON.parse(data.toString()).type === 'announce') replayed = true; });
  assert.deepEqual(await f.adapter.announce(input), { outcome: 'error', code: 'duplicate_request' });
  assert.equal((await f.adapter.status(ROBOT_A)).busy, true);
  await eventually(() => f.gateway.robotActions.jobs.get(ROBOT_A.id)?.deadlineExpired, 'native deadline was not reached');
  assert.equal(f.state().active['robot-action'], 1, 'expiry alone cannot prove native speech stopped');
  replacement.send(JSON.stringify({ v: 1, type: 'status', busy: false, active_request_id: null }));
  await eventually(() => f.state().active['robot-action'] === 0, 'fresh native idle did not release unknown speech');
  assert.equal(replayed, false);
});

test('a hung native deadline stop blocks deployment and subsequent voice until physical idle', async t => {
  const f = await fixture(t, { robotActions: { voiceInterruptTimeoutMs: 30 } });
  const native = await f.connect();
  const incoming = nextFrame(native);
  const operation = f.adapter.announce(f.announce(ROBOT_A, { deadline: Date.now() + 800 }));
  const frame = await incoming;
  native.send(JSON.stringify({ v: 1, type: 'status', busy: true, active_request_id: frame.request_id }));
  const cancellation = nextFrame(native);
  assert.deepEqual(await operation, { outcome: 'uncertain', code: 'timeout' });
  assert.equal((await cancellation).reason, 'deadline');
  assert.equal(f.state().active['robot-action'], 1);
  assert.equal(await rejectUpgrade(`${f.socketBase}/v1/listen`, sign(ROBOT_A)), 503);
  assert.equal(f.state().active['robot-action'], 1);
  assert.equal(f.state().active.voice, 0);
  assert.deepEqual(await f.adapter.announce(f.announce()), { outcome: 'error', code: 'busy' });
  native.send(JSON.stringify({ v: 1, type: 'status', busy: false, active_request_id: null }));
  await eventually(() => f.state().active['robot-action'] === 0, 'confirmed idle did not release deployment admission');
  assert.equal(f.gateway.robotActions.jobs.size, 0);
});

test('retained native speech restores one quarantine during drain and survives reconnect without replay', async t => {
  const f = await fixture(t);
  const input = f.announce();
  const drainFile = join(f.directory, 'deployment', 'drain.json');
  writeFileSync(drainFile, JSON.stringify({ version: 1, id: 'recovery-drain', expiresAt: Date.now() + 5000 }));
  const native = await f.connect(ROBOT_A, { activeRequestId: input.requestId });
  assert.equal(f.state().active['robot-action'], 1);
  assert.equal(f.state().drainId, 'recovery-drain');
  assert.equal(f.gateway.robotActions.jobs.get(ROBOT_A.id).recovered, true);
  const quiet = f.state().lastActivityAt;
  let replayed = false;
  const watchReplay = data => { if (JSON.parse(data.toString()).type === 'announce') replayed = true; };
  native.on('message', watchReplay);
  for (let i = 0; i < 3; i++) {
    native.send(JSON.stringify({ v: 1, type: 'status', busy: true, active_request_id: input.requestId }));
    assert.equal((await f.adapter.status(ROBOT_A)).busy, true);
    await delay(55);
    assert.equal(f.state().active['robot-action'], 1);
    assert.equal(f.state().lastActivityAt, quiet, 'unchanged retained work is not new activity');
  }
  native.terminate();
  await eventually(() => !f.gateway.robotActions.sessionFor(ROBOT_A), 'old native socket did not disconnect');
  assert.equal(f.state().active['robot-action'], 1);
  const replacement = await f.connect(ROBOT_A, { activeRequestId: input.requestId });
  replacement.on('message', watchReplay);
  assert.equal(f.state().active['robot-action'], 1, 'reconnection cannot count known speech twice');
  assert.equal(f.state().lastActivityAt, quiet);
  result(replacement, { request_id: input.requestId }, { outcome: 'rejected', confirmed: false, code: 'busy' });
  replacement.send(JSON.stringify({ v: 1, type: 'status', busy: true, active_request_id: null }));
  await delay(20);
  assert.equal(f.state().active['robot-action'], 1, 'neither rejection nor generic busy proves retained speech stopped');
  replacement.send(JSON.stringify({ v: 1, type: 'status', busy: false, active_request_id: null }));
  await eventually(() => f.state().active['robot-action'] === 0, 'fresh native idle did not release recovered execution');
  assert.equal(f.gateway.robotActions.jobs.size, 0);
  assert.deepEqual(await f.adapter.announce(input), { outcome: 'error', code: 'duplicate_request' });
  assert.equal(replayed, false);
  unlinkSync(drainFile);
});

test('recovered speech blocks voice until a correlated native stop acknowledgement', async t => {
  const f = await fixture(t, { robotActions: { voiceInterruptTimeoutMs: 40 } });
  const requestId = randomUUID();
  const native = await f.connect(ROBOT_A, { activeRequestId: requestId });
  const foreignNative = await f.connect(ROBOT_B);
  result(foreignNative, { request_id: requestId }, { outcome: 'uncertain', confirmed: false, code: 'interrupted' });
  await delay(10);
  assert.equal(f.state().active['robot-action'], 1, 'another robot cannot release recovered speech');
  const cancellation = nextFrame(native);
  const rejected = rejectUpgrade(`${f.socketBase}/v1/listen`, sign(ROBOT_A));
  assert.deepEqual(await cancellation, { v: 1, type: 'cancel', request_id: requestId, reason: 'voice' });
  assert.equal(await rejected, 503);
  assert.equal(f.state().active['robot-action'], 1);
  assert.equal(f.state().active.voice, 0);
  native.terminate();
  const replacement = await f.connect(ROBOT_A, { activeRequestId: requestId });
  const nextCancellation = nextFrame(replacement);
  const voice = new WebSocket(`${f.socketBase}/v1/listen`, { headers: { Authorization: `Bearer ${sign(ROBOT_A)}` } });
  let opened = false; voice.on('open', () => { opened = true; });
  const voiceOpened = once(voice, 'open');
  assert.deepEqual(await nextCancellation, { v: 1, type: 'cancel', request_id: requestId, reason: 'voice' });
  assert.equal(opened, false);
  result(replacement, { request_id: requestId }, { outcome: 'uncertain', confirmed: false, code: 'interrupted' });
  await voiceOpened;
  assert.equal(f.state().active['robot-action'], 0);
  assert.equal(f.state().active.voice, 1);
  const reply = nextFrame(voice); voice.send('invalid JSON'); await reply;
  voice.terminate();
});

test('ordinary native busy state remains distinct from recovered announcement activity', async t => {
  const f = await fixture(t);
  const native = await f.connect(ROBOT_A, { busy: true });
  const quiet = f.state().lastActivityAt;
  native.send(JSON.stringify({ v: 1, type: 'status', busy: true, active_request_id: null }));
  await delay(55);
  assert.deepEqual(f.state().active, {});
  assert.equal(f.state().lastActivityAt, quiet);
  assert.equal(f.gateway.robotActions.jobs.size, 0);
  const voice = new WebSocket(`${f.socketBase}/v1/listen`, { headers: { Authorization: `Bearer ${sign(ROBOT_A)}` } });
  await once(voice, 'open');
  assert.equal(f.state().active.voice, 1, 'ordinary skills do not acquire announcement quarantine');
  const reply = nextFrame(voice); voice.send('invalid JSON'); await reply;
  voice.terminate();
});

test('expired native authentication cannot release retained execution with an idle marker', async t => {
  const f = await fixture(t, { robotActions: { heartbeatMs: 100000 } });
  const requestId = randomUUID();
  const expiresAt = (Math.floor(Date.now() / 1000) + 2) * 1000;
  const token = jwt.sign({ ...ROBOT_A, exp: expiresAt / 1000 }, SECRET);
  const native = await f.connect(ROBOT_A, { activeRequestId: requestId, token });
  const closed = once(native, 'close');
  await delay(expiresAt - Date.now() + 10);
  native.send(JSON.stringify({ v: 1, type: 'status', busy: false, active_request_id: null }));
  assert.equal((await closed)[0], 4001);
  assert.equal(f.state().active['robot-action'], 1, 'expired claims cannot serve as native stop proof');
  const replacement = await f.connect(ROBOT_A, { activeRequestId: requestId });
  replacement.send(JSON.stringify({ v: 1, type: 'status', busy: false, active_request_id: null }));
  await eventually(() => f.state().active['robot-action'] === 0, 'fresh authenticated idle did not release retained execution');
});

test('changing recovery IDs retain one reservation and bound transport tombstones', async t => {
  const f = await fixture(t, { robotActions: { maxSeenRequests: 2 } });
  const native = await f.connect();
  const incoming = nextFrame(native);
  const operation = f.adapter.announce(f.announce(ROBOT_A, { deadline: Date.now() + 800 }));
  const original = await incoming;
  const job = f.gateway.robotActions.jobs.get(ROBOT_A.id);
  const quiet = f.state().lastActivityAt;
  let cancels = 0;
  native.on('message', data => { if (JSON.parse(data.toString()).type === 'cancel') cancels++; });
  for (let i = 0; i < 10; i++) {
    const recoveredId = randomUUID();
    native.send(JSON.stringify({ v: 1, type: 'status', busy: true, active_request_id: recoveredId }));
    await eventually(() => job.requestId === recoveredId, 'replacement native marker was not observed');
    assert.equal(f.gateway.robotActions.jobs.get(ROBOT_A.id), job, 'changing UUID cannot release and recreate admission');
    assert.equal(f.gateway.robotActions.jobs.size, 1);
    assert.equal(f.state().active['robot-action'], 1);
    assert.equal(f.state().lastActivityAt, quiet);
    assert.ok(f.gateway.robotActions.seenRequests.size <= 2, 'authenticated markers cannot grow a defensive cache without bound');
  }
  assert.deepEqual(await operation, { outcome: 'uncertain', code: 'confirmation_lost' });
  result(native, original);
  await delay(160);
  assert.equal(f.state().active['robot-action'], 1, 'an old UUID result cannot release replacement recovery');
  assert.equal(cancels, 0, 'the old request deadline cannot cancel a replacement UUID');
  native.send(JSON.stringify({ v: 1, type: 'status', busy: false, active_request_id: null }));
  await eventually(() => f.state().active['robot-action'] === 0, 'fresh physical idle did not release replacement recovery');
});

test('startup restores durable execution while native is entirely offline', async t => {
  const requestId = randomUUID();
  const f = await fixture(t, { robotActions: { voiceInterruptTimeoutMs: 30 }, setupRuntime: directory => {
    assert.equal(new RobotActionReservations({ runtimeDir: directory }).reserve(ROBOT_A, requestId), true);
  } });
  assert.equal(f.state().active['robot-action'], 1);
  assert.equal(f.gateway.robotActions.jobs.get(ROBOT_A.id).session, null);
  assert.deepEqual(await f.adapter.status(ROBOT_A), { online: false, busy: true, announcements_supported: false });
  assert.equal(await rejectUpgrade(`${f.socketBase}/v1/listen`, sign(ROBOT_A)), 503);
  assert.equal(f.state().active['robot-action'], 1);
  const native = await f.connect(ROBOT_A, { activeRequestId: requestId });
  assert.equal(f.state().active['robot-action'], 1, 'reconnect cannot count loaded execution twice');
  native.send(JSON.stringify({ v: 1, type: 'status', busy: false, active_request_id: null }));
  await eventually(() => f.state().active['robot-action'] === 0, 'verified stop proof did not durably clear offline quarantine');
  assert.equal(new RobotActionReservations({ runtimeDir: f.directory }).entries.size, 0);
});

test('corrupt startup state holds guard and voice even when a native peer reports idle', async t => {
  const f = await fixture(t, { robotActions: { voiceInterruptTimeoutMs: 30 }, setupRuntime: directory => {
    const store = new RobotActionReservations({ runtimeDir: directory });
    writeFileSync(store.file, 'invalid synthetic state', { mode: 0o600 });
  } });
  assert.equal(f.state().active['robot-action'], 1);
  await f.connect();
  assert.equal(f.state().active['robot-action'], 1, 'unknown outstanding identities cannot be discarded by one robot idle');
  assert.equal(await rejectUpgrade(`${f.socketBase}/v1/listen`, sign(ROBOT_B)), 503);
  assert.equal(f.state().active['robot-action'], 1);
  assert.equal((await f.adapter.status(ROBOT_A)).announcements_supported, false);
});

test('native completion with failed durable clear returns uncertainty and keeps admission', async t => {
  const f = await fixture(t);
  const native = await f.connect();
  const incoming = nextFrame(native);
  const operation = f.adapter.announce(f.announce());
  const frame = await incoming;
  let fail = true;
  const store = f.gateway.robotActions.reservations;
  store.fs = { ...fs, renameSync(...args) {
    if (fail) throw new Error('synthetic durable clear failure');
    return fs.renameSync(...args);
  } };
  result(native, frame);
  assert.deepEqual(await operation, { outcome: 'uncertain', code: 'confirmation_lost' });
  assert.equal(f.state().active['robot-action'], 1);
  assert.equal(new RobotActionReservations({ runtimeDir: f.directory }).loadFault, true,
    'an unfinished durable write must remain startup quarantine');
  fail = false;
  native.send(JSON.stringify({ v: 1, type: 'status', busy: false, active_request_id: null }));
  await eventually(() => f.state().active['robot-action'] === 0, 'successful durable clear did not release native completion');
  assert.equal(new RobotActionReservations({ runtimeDir: f.directory }).entries.size, 0);
});

test('voice cancels durable preparation while final Account authorization is pending', async t => {
  const f = await fixture(t);
  const native = await f.connect();
  let announces = 0;
  native.on('message', data => { if (JSON.parse(data.toString()).type === 'announce') announces++; });
  let release;
  f.authorization.gate = new Promise(resolve => { release = resolve; });
  const operation = f.adapter.announce(f.announce());
  await eventually(() => f.authorization.entered, 'final authorization was not held after durable preparation');
  assert.equal(new RobotActionReservations({ runtimeDir: f.directory }).entries.size, 1);
  const voice = new WebSocket(`${f.socketBase}/v1/listen`, { headers: { Authorization: `Bearer ${sign(ROBOT_A)}` } });
  await once(voice, 'open');
  f.authorization.gate = null; release();
  assert.deepEqual(await operation, { outcome: 'error', code: 'busy' });
  assert.equal(announces, 0);
  assert.equal(new RobotActionReservations({ runtimeDir: f.directory }).entries.size, 0);
  const reply = nextFrame(voice); voice.send('invalid JSON'); await reply;
  voice.terminate();
});

test('fsync latency cannot dispatch an announcement after its deadline', async t => {
  const f = await fixture(t);
  const native = await f.connect();
  let announces = 0;
  native.on('message', data => { if (JSON.parse(data.toString()).type === 'announce') announces++; });
  const store = f.gateway.robotActions.reservations;
  let delayed = false;
  store.fs = { ...fs, fsyncSync(fd) {
    fs.fsyncSync(fd);
    if (!delayed) { delayed = true; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350); }
  } };
  const input = f.announce(ROBOT_A, { deadline: Date.now() + 300 });
  assert.deepEqual(await f.gateway.robotActions.announce(input), { outcome: 'error', code: 'expired' });
  assert.equal(announces, 0);
  assert.equal(f.gateway.robotActions.jobs.size, 0);
  assert.equal(new RobotActionReservations({ runtimeDir: f.directory }).entries.size, 0);
});

test('failed durable reserve sends no native announcement and retains uncertainty until clear succeeds', async t => {
  const f = await fixture(t);
  const native = await f.connect();
  let announces = 0, fail = true, renamed = false;
  native.on('message', data => { if (JSON.parse(data.toString()).type === 'announce') announces++; });
  const store = f.gateway.robotActions.reservations;
  const opened = new Map();
  store.fs = { ...fs, openSync(path, ...args) { const fd = fs.openSync(path, ...args); opened.set(fd, path); return fd; },
    renameSync(...args) { fs.renameSync(...args); renamed = true; }, fsyncSync(fd) {
      if (fail && renamed && opened.get(fd) === store.directory) throw new Error('synthetic reserve directory fsync failure');
      fs.fsyncSync(fd);
    } };
  assert.deepEqual(await f.adapter.announce(f.announce()), { outcome: 'error', code: 'unavailable' });
  assert.equal(announces, 0);
  assert.equal(f.state().active['robot-action'], 1);
  assert.equal(new RobotActionReservations({ runtimeDir: f.directory }).loadFault, true);
  fail = false;
  native.send(JSON.stringify({ v: 1, type: 'status', busy: false, active_request_id: null }));
  await eventually(() => f.state().active['robot-action'] === 0, 'successful verified idle did not clear failed reserve uncertainty');
  assert.equal(new RobotActionReservations({ runtimeDir: f.directory }).entries.size, 0);
});

test('recovery overflow remains durably quarantined when previously recorded execution ends', async t => {
  const f = await fixture(t);
  f.gateway.robotActions.reservations.maxEntries = 1;
  const idA = randomUUID(), idB = randomUUID();
  const nativeA = await f.connect(ROBOT_A, { activeRequestId: idA });
  await f.connect(ROBOT_B, { activeRequestId: idB });
  assert.equal(f.gateway.robotActions.reservations.healthy, false);
  result(nativeA, { request_id: idA }, { outcome: 'uncertain', confirmed: false, code: 'interrupted' });
  await eventually(() => !f.gateway.robotActions.jobs.has(ROBOT_A.id), 'known stop proof did not clear original execution');
  assert.equal(f.state().active['robot-action'], 1, 'unknown overflow must outlive the original reservation');
  const recovered = new RobotActionReservations({ runtimeDir: f.directory, maxEntries: 1 });
  assert.equal(recovered.entries.size, 0);
  assert.equal(recovered.unknown, true, 'replacement startup cannot forget the unrecorded active peer');
});

test('telemetry latency after admission cannot send an already-expired native frame', async t => {
  let now = Date.now();
  const deadline = now + 1000;
  const f = await fixture(t, { robotActions: { now: () => now } });
  const native = await f.connect();
  let announces = 0, delayed = false;
  native.on('message', data => { if (JSON.parse(data.toString()).type === 'announce') announces++; });
  const activity = f.gateway.robotActions.activity;
  const begin = activity.begin;
  activity.begin = kind => {
    const end = begin(kind);
    if (end && kind === 'robot-action') { delayed = true; now = deadline + 1; }
    return end;
  };
  assert.deepEqual(await f.gateway.robotActions.announce(f.announce(ROBOT_A, { deadline })),
    { outcome: 'error', code: 'expired' });
  assert.equal(delayed, true);
  assert.equal(announces, 0);
  assert.equal(f.state().active['robot-action'], 0);
  assert.equal(new RobotActionReservations({ runtimeDir: f.directory }).entries.size, 0);
});

test('idle sockets, status polls and heartbeats preserve quiet minute; drain blocks dispatch only', async t => {
  const f = await fixture(t);
  const native = await f.connect();
  const quiet = f.state().lastActivityAt;
  for (let i = 0; i < 3; i++) {
    native.send(JSON.stringify({ v: 1, type: 'status', busy: false, active_request_id: null }));
    assert.deepEqual(await f.adapter.status(ROBOT_A), { online: true, busy: false, announcements_supported: true });
    await delay(55);
  }
  assert.deepEqual(f.state().active, {});
  assert.equal(f.state().lastActivityAt, quiet);
  const incoming = nextFrame(native);
  const operation = f.adapter.announce(f.announce());
  const frame = await incoming;
  const drainFile = join(f.directory, 'deployment', 'drain.json');
  writeFileSync(drainFile, JSON.stringify({ version: 1, id: 'synthetic-drain', expiresAt: Date.now() + 5000 }));
  assert.equal(f.state().active['robot-action'], 1);
  result(native, frame);
  assert.deepEqual(await operation, { outcome: 'success', confirmed: true });
  assert.equal(f.state().active['robot-action'], 0);
  assert.deepEqual(await f.adapter.announce(f.announce()), { outcome: 'error', code: 'server_draining' });
  const denied = await fetch(`${f.base}/internal/home-assistant/robot-action/announce`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-phoenix-internal-token': PEER },
    body: JSON.stringify(f.announce()),
  });
  assert.equal(denied.status, 503);
  assert.equal(denied.headers.get('retry-after'), '5');
  assert.deepEqual(await denied.json(), { outcome: 'error', code: 'server_draining' });
  assert.deepEqual(await f.adapter.status(ROBOT_A), { online: true, busy: false, announcements_supported: true });
  assert.equal(f.state().drainId, 'synthetic-drain');
  unlinkSync(drainFile);
});
