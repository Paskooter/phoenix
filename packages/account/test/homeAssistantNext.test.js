// Invented accounts only. Real Account persistence and connector WebSockets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createService } from '@phoenix/common';
import { Store } from '../src/store.js';
import { createSession } from '../src/sessions.js';
import { protectPortalRoutes } from '../src/portalCsrf.js';
import { HomeAssistantBroker } from '../src/integrations/homeAssistant/broker.js';
import { homeAssistantRoutes } from '../src/integrations/homeAssistant/routes.js';
import { CAPABILITIES } from '../src/integrations/homeAssistant/protocol.js';

// Harness deadline for a frame that is expected to arrive. No test relies on it
// firing; 1500ms was too tight for a loaded full-suite run with durable fsyncs.
const FRAME_DEADLINE_MS = 10_000;

function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'phoenix-ha-next-'));
  const store = new Store(join(root, 'account.json'));
  for (const id of ['one', 'other']) store.accounts.set(`owner-${id}`, { _id: `owner-${id}`, isActive: true });
  for (const id of ['one', 'second', 'other']) {
    store.accounts.set(`robot-${id}`, { _id: `robot-${id}`, friendlyId: `synthetic-${id}`, accessKeyId: `key-${id}`, isActive: true });
    store.loops.set(`loop-${id}`, { _id: `loop-${id}`, name: `Fixture ${id}`, robot: `robot-${id}`, owner: `owner-${id === 'other' ? 'other' : 'one'}` });
  }
  store.flush();
  const broker = new HomeAssistantBroker(store, options);
  const owner = store.accounts.get('owner-one');
  const identity = (id = 'one') => ({ id: `robot-${id}`, friendlyId: `synthetic-${id}`, accessKeyId: `key-${id}` });
  const link = (ids = ['one']) => broker.exchangeCode(broker.issueCode(owner, ids.map((id) => `synthetic-${id}`)).code);
  t.after(() => { broker.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, store, broker, owner, identity, link };
}

async function listen(t, broker) {
  const service = createService({ name: 'ha-next-test', onUpgrade: (...args) => broker.upgrade(...args) });
  await service.listen(0, '127.0.0.1');
  t.after(() => { for (const socket of broker.wss.clients) socket.terminate(); service.server.closeAllConnections(); service.server.close(); });
  return `http://127.0.0.1:${service.server.address().port}`;
}

async function connect(t, url, credential, capabilities = CAPABILITIES) {
  const socket = new WebSocket(url.replace('http:', 'ws:') + '/api/home-assistant/connect', { headers: { authorization: `Bearer ${credential}` } });
  const frames = []; const waits = new Set();
  socket.on('message', (data) => {
    const frame = JSON.parse(data);
    frames.push(frame);
    for (const wait of waits) if (wait.predicate(frame)) { clearTimeout(wait.timer); waits.delete(wait); wait.resolve(frame); }
  });
  const waitFor = (predicate) => {
    const found = frames.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const wait = { predicate, resolve, timer: setTimeout(() => { waits.delete(wait); reject(new Error('Connector result timeout')); }, FRAME_DEADLINE_MS) };
      waits.add(wait);
    });
  };
  await once(socket, 'open');
  const welcome = await waitFor((frame) => frame.type === 'welcome');
  const send = (frame) => socket.send(JSON.stringify({ v: 1, session_id: welcome.session_id, ...frame }));
  send({ type: 'ready', agent: 'home_assistant', ha_version: '2026.9.4', ...(capabilities === null ? {} : { capabilities }) });
  if (capabilities?.includes('robot_roster')) await waitFor((frame) => frame.type === 'roster');
  else await new Promise((resolve) => setTimeout(resolve, 10));
  t.after(() => { for (const wait of waits) clearTimeout(wait.timer); socket.terminate(); });
  const action = async (frame) => { send({ type: 'robot_action', ...frame }); return (await waitFor((result) => result.type === 'action_result' && result.request_id === frame.request_id)).result; };
  return { socket, frames, welcome, send, waitFor, action };
}

const makeAction = (robotId, overrides = {}) => ({ request_id: randomUUID(), robot_id: robotId,
  action: 'announce', text: 'An invented fixture announcement.', deadline_ms: Date.now() + 5000, ...overrides });
const prefs = (shortcuts = [], follow_up = []) => ({ type: 'preferences', shortcuts, follow_up });
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
// Client and server share one event loop. A frame sent over the loopback
// WebSocket is only read in the poll phase, so a fixed 10ms sleep can fire
// first whenever the loop was blocked (GC, durable fsync, a loaded suite).
// Wait for the server-side effect itself instead; a missing effect still fails.
async function until(predicate, label) {
  const deadline = Date.now() + FRAME_DEADLINE_MS;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('legacy v1 retains one-turn behavior without unsolicited roster or route fields', async (t) => {
  const { broker, link, identity } = fixture(t);
  const linked = link(); const url = await listen(t, broker);
  const client = await connect(t, url, linked.credential, null);
  // A legacy connector gets no roster to confirm `ready`; wait for the server to process it.
  await until(() => broker.sessions.get(linked.installation_id)?.ready === true, 'legacy ready');
  const commandResult = broker.command(identity(), 'turn on the fixture light');
  const command = await client.waitFor((frame) => frame.type === 'command');
  assert.equal('route' in command, false);
  client.send({ type: 'result', request_id: command.request_id, result: { outcome: 'success', response_type: 'action_done', speech: 'Done.' } });
  assert.equal((await commandResult).speech, 'Done.');
  assert.equal(client.frames.some((frame) => frame.type === 'roster'), false);
  assert.deepEqual(broker.selectionDetails(identity()).capabilities, []);
});

test('capability roster is opaque and scoped, with explicit permission persisted only by its owner', async (t) => {
  const { broker, store, owner, link, root } = fixture(t, { robotAdapter: { status: () => ({ online: true, busy: false, announcements_supported: true }) } });
  const linked = link(['one', 'second']); const url = await listen(t, broker);
  const client = await connect(t, url, linked.credential);
  const roster = client.frames.find((frame) => frame.type === 'roster');
  assert.equal(roster.robots.length, 2);
  for (const robot of roster.robots) {
    assert.match(robot.robot_id, /^[0-9a-f-]{36}$/);
    assert.equal(robot.online, true); assert.equal(robot.busy, false); assert.equal(robot.announcements_allowed, false);
    assert.equal(JSON.stringify(robot).includes('synthetic'), false);
    assert.equal(JSON.stringify(robot).includes('owner'), false);
  }
  assert.throws(() => broker.setAnnouncements(store.accounts.get('owner-other'), linked.installation_id, true), /not_found/);
  assert.throws(() => broker.setAnnouncements(owner, linked.installation_id, 'true'), /invalid_permission/);
  broker.setAnnouncements(owner, linked.installation_id, true);
  assert.equal(new Store(join(root, 'account.json')).homeAssistantInstallations.get(linked.installation_id).announcementsEnabled, true);
  assert.equal(broker.status(owner).installations[0].announcementsEnabled, true);
  await client.waitFor((frame) => frame.type === 'roster' && frame.robots.every((robot) => robot.announcements_allowed));
});

test('a full twenty-robot Unicode roster fits the connector frame budget', async (t) => {
  const { broker, store, link } = fixture(t, { robotAdapter: { status: () => ({ online: true, busy: false }) } });
  const ids = ['one', 'second'];
  const names = ['界'.repeat(100), '💡'.repeat(100), '\ud800'.repeat(100), '"\\'.repeat(50)];
  for (let i = 2; i < 20; i++) {
    const id = `roster-${i}`; ids.push(id);
    store.accounts.set(`robot-${id}`, { _id: `robot-${id}`, friendlyId: `synthetic-${id}`, accessKeyId: `key-${id}`, isActive: true });
    store.loops.set(`loop-${id}`, { _id: `loop-${id}`, owner: 'owner-one', robot: `robot-${id}` });
  }
  ids.forEach((id, i) => { store.loops.get(`loop-${id}`).name = names[i % names.length]; });
  store.flush();
  const linked = link(ids); const url = await listen(t, broker); const client = await connect(t, url, linked.credential);
  const roster = client.frames.find((frame) => frame.type === 'roster');
  assert.equal(roster.robots.length, 20);
  assert.ok(Buffer.byteLength(JSON.stringify(roster), 'utf8') <= 8192);
  for (const robot of roster.robots) {
    assert.ok(Array.from(robot.name).length <= 100);
    assert.equal(/[\ud800-\udfff]/gu.test(robot.name), false);
  }
});

test('authenticated preferences authorize only exact routines and fresh per-robot follow-ups, never survive reconnect', async (t) => {
  let now = Date.now();
  const { broker, link, identity } = fixture(t, { now: () => now });
  const linked = link(['one', 'second']); const url = await listen(t, broker);
  const client = await connect(t, url, linked.credential);
  const binding = client.frames.find((frame) => frame.type === 'roster').robots[0].robot_id;
  const id = randomUUID();
  client.send(prefs([{ id, phrase: 'Movie time' }], [{ robot_id: binding, available: true, expires_at_ms: now + 30_000 }]));
  await until(() => broker.selectionDetails(identity()).shortcuts.length > 0, 'preferences');
  const selected = broker.selectionDetails(identity());
  assert.deepEqual(selected.shortcuts, [{ id, phrase: 'Movie time' }]);
  assert.equal(selected.follow_up.available, true);
  assert.equal(broker.selectionDetails(identity('second')).follow_up.available, false);
  assert.equal((await broker.command(identity(), 'a different phrase', 'en', { kind: 'routine', shortcut_id: id })).code, 'invalid_shortcut');
  const pending = broker.command(identity(), '  MOVIE   TIME! ', 'en', { kind: 'routine', shortcut_id: id });
  const command = await client.waitFor((frame) => frame.type === 'command');
  assert.deepEqual(command.route, { kind: 'routine', shortcut_id: id });
  assert.ok(command.deadline_ms <= now + 7500);
  client.send({ type: 'result', request_id: command.request_id, result: { outcome: 'success', response_type: 'action_done', speech: 'Started.' } });
  await pending;
  assert.equal(broker.selectionDetails(identity()).follow_up.available, false);
  client.send(prefs([{ id, phrase: 'Movie time' }], [{ robot_id: binding, available: true, expires_at_ms: now + 30_000 }]));
  await until(() => broker.selectionDetails(identity()).follow_up.available === true, 'renewed follow-up');
  now += 30_001;
  assert.equal((await broker.command(identity(), 'and the fixture lamp', 'en', { kind: 'follow_up' })).code, 'follow_up_expired');
  await connect(t, url, linked.credential);
  assert.deepEqual(broker.selectionDetails(identity()).shortcuts, []);
  assert.equal(broker.selectionDetails(identity()).follow_up.available, false);
});

test('reserved shortcuts, forged robot context hints, and unnegotiated preferences close the connector', async (t) => {
  const { broker, link } = fixture(t); const linked = link(); const url = await listen(t, broker);
  for (const frame of [prefs([{ id: randomUUID(), phrase: 'go to sleep' }]), prefs([{ id: randomUUID(), phrase: 'blue' }]),
    prefs([], [{ robot_id: randomUUID(), available: true, expires_at_ms: Date.now() + 1000 }]),
    prefs(Array.from({ length: 17 }, (_, i) => ({ id: randomUUID(), phrase: `Fixture routine ${i}` })))]) {
    const client = await connect(t, url, linked.credential); const closed = once(client.socket, 'close');
    client.send(frame); assert.equal((await closed)[0], 4003);
  }
  const legacy = await connect(t, url, linked.credential, null); const closed = once(legacy.socket, 'close');
  legacy.send(prefs()); assert.equal((await closed)[0], 4003);
});

test('reverse admission rejects disabled, wrong robot, expired, invalid, offline and busy actions without dispatch', async (t) => {
  const state = { online: true, busy: false, announcements_supported: true }; let deliveries = 0;
  const { broker, owner, link } = fixture(t, { robotAdapter: { status: () => state,
    announce: () => { deliveries++; return { outcome: 'success', confirmed: true }; } } });
  const linked = link(); const url = await listen(t, broker); const client = await connect(t, url, linked.credential);
  const robotId = client.frames.find((frame) => frame.type === 'roster').robots[0].robot_id;
  const denied = makeAction(robotId);
  assert.equal((await client.action(denied)).code, 'permission_disabled');
  broker.setAnnouncements(owner, linked.installation_id, true);
  // Permission changes cannot resurrect a previously rejected request UUID.
  assert.equal((await client.action(denied)).code, 'permission_disabled');
  assert.equal((await client.action(makeAction(randomUUID()))).code, 'invalid_robot');
  assert.equal((await client.action(makeAction(robotId, { deadline_ms: Date.now() - 1 }))).outcome, 'expired');
  for (const change of [{ text: 'x'.repeat(301) }, { deadline_ms: Date.now() + 46_000 }, { action: 'move' }]) {
    assert.equal((await client.action(makeAction(robotId, change))).code, 'invalid_action');
  }
  state.online = false;
  assert.equal((await client.action(makeAction(robotId))).code, 'offline');
  state.online = true; state.busy = true;
  assert.equal((await client.action(makeAction(robotId))).code, 'busy');
  state.busy = false; state.announcements_supported = false;
  assert.equal((await client.action(makeAction(robotId))).code, 'unavailable');
  await broker.broadcastRoster();
  const unsupported = await client.waitFor((frame) => frame.type === 'roster' && frame.robots[0].announcements_supported === false);
  // A live legacy Jibo remains available to room and query features.
  assert.equal(unsupported.robots[0].online, true);
  assert.equal(deliveries, 0);
});

test('any supplied announcement volume rejects before durable admission or native dispatch', async (t) => {
  let deliveries = 0; let statusCalls = 0; let dispatched;
  const { broker, store, owner, link } = fixture(t, { robotAdapter: {
    status: () => { statusCalls++; return { online: true, busy: false, announcements_supported: true }; },
    announce: (request) => { deliveries++; dispatched = request; return { outcome: 'success', confirmed: true }; },
  } });
  const linked = link(); const url = await listen(t, broker); const client = await connect(t, url, linked.credential);
  broker.setAnnouncements(owner, linked.installation_id, true); await settle();
  const robotId = client.frames.find((frame) => frame.type === 'roster').robots[0].robot_id;
  const before = statusCalls;
  for (const volume of [0, null, 0.5, 1, -0.1, 1.1, true, 'unchanged', {}, []]) {
    const result = await client.action(makeAction(robotId, { volume }));
    assert.equal(result.outcome, 'error'); assert.equal(result.code, 'unsupported_volume');
    assert.equal(store.homeAssistantActions.size, 0); assert.equal(deliveries, 0);
    assert.equal(statusCalls, before);
  }
  assert.equal(client.socket.readyState, WebSocket.OPEN);
  const session = broker.sessions.get(linked.installation_id);
  assert.equal((await broker.robotAction(session, makeAction(robotId, { volume: undefined }))).code, 'unsupported_volume');
  assert.equal((await client.action(makeAction(robotId))).outcome, 'success');
  assert.equal(deliveries, 1); assert.equal(Object.hasOwn(dispatched, 'volume'), false);
});

test('persisted v1 hashes retain no-volume deduplication and reject historical volume payloads without replay', async (t) => {
  let deliveries = 0;
  const adapter = { status: () => ({ online: true, busy: false, announcements_supported: true }),
    announce: () => { deliveries++; return { outcome: 'success', confirmed: true }; } };
  const { store, broker, owner, link, root } = fixture(t, { robotAdapter: adapter });
  const linked = link(); broker.setAnnouncements(owner, linked.installation_id, true);
  const binding = store.homeAssistantInstallations.get(linked.installation_id).bindings[0].id;
  const noVolume = makeAction(binding); const withVolume = makeAction(binding, { volume: 0.5 });
  for (const frame of [noVolume, withVolume]) {
    const key = `${linked.installation_id}:${frame.request_id}`;
    // Synthetic persisted records written with the previous v1 canonical
    // format, rather than recomputing them through the new broker.
    const requestHash = createHash('sha256').update(JSON.stringify([
      frame.robot_id, frame.action, frame.text.trim(), frame.volume ?? null, frame.deadline_ms,
    ])).digest('hex');
    store.homeAssistantActions.set(key, { _id: key, installationId: linked.installation_id,
      requestId: frame.request_id, robotId: binding, requestHash, createdAt: Date.now(), deadline: frame.deadline_ms,
      state: 'finished', finishedAt: Date.now(), result: { outcome: 'uncertain', code: 'confirmation_lost', response_type: 'error', speech: '' } });
  }
  store.flush({ durable: true });
  const restored = new HomeAssistantBroker(new Store(join(root, 'account.json')), { robotAdapter: adapter });
  t.after(() => restored.close());
  const url = await listen(t, restored); const client = await connect(t, url, linked.credential);
  assert.equal((await client.action(noVolume)).outcome, 'uncertain');
  assert.equal((await client.action(withVolume)).code, 'unsupported_volume');
  const { volume: ignoredVolume, ...removedVolume } = withVolume;
  assert.equal((await restored.robotAction(restored.sessions.get(linked.installation_id), removedVolume)).code, 'request_id_conflict');
  assert.equal(deliveries, 0); assert.equal(restored.store.homeAssistantActions.size, 2);
});

test('durable admission precedes dispatch, duplicates cannot speak twice, and success requires spoken confirmation', async (t) => {
  let deliveries = 0; let finishSpeech;
  const { broker, owner, link, identity, root } = fixture(t, { robotAdapter: { status: () => ({ online: true, busy: false, announcements_supported: true }),
    announce: (request) => {
      deliveries++;
      const snapshot = JSON.parse(readFileSync(join(root, 'account.json')));
      assert.equal(snapshot.homeAssistantActions[0].state, 'dispatching');
      assert.equal(JSON.stringify(snapshot.homeAssistantActions).includes(request.text), false);
      assert.equal(request.identity.friendlyId, 'synthetic-one');
      assert.equal(Object.hasOwn(request, 'volume'), false);
      assert.deepEqual(broker.authorizeAction(request), { allowed: true });
      assert.deepEqual(broker.authorizeAction({ ...request, volume: null }), { allowed: false, code: 'unsupported_volume' });
      assert.equal(broker.authorizeAction({ ...request, text: 'A replaced fixture message.' }).allowed, false);
      assert.equal(broker.authorizeAction({ ...request, identity: identity('other') }).allowed, false);
      return new Promise((resolve) => { finishSpeech = resolve; });
    } } });
  const linked = link(); const url = await listen(t, broker); const client = await connect(t, url, linked.credential);
  broker.setAnnouncements(owner, linked.installation_id, true);
  const action = makeAction(client.frames.find((frame) => frame.type === 'roster').robots[0].robot_id);
  const session = broker.sessions.get(linked.installation_id);
  const spoken = broker.robotAction(session, action);
  await settle();
  assert.equal((await broker.robotAction(session, action)).code, 'request_in_progress');
  assert.equal((await broker.command(identity(), 'turn on the fixture light')).code, 'busy');
  finishSpeech({ outcome: 'success', confirmed: true });
  assert.equal((await spoken).outcome, 'success');
  assert.equal((await broker.robotAction(session, action)).outcome, 'success');
  assert.equal(broker.authorizeAction({ identity: identity(), requestId: action.request_id, text: action.text, deadline: action.deadline_ms }).allowed, false);
  assert.equal((await broker.robotAction(session, { ...action, text: 'Another fixture message.' })).code, 'request_id_conflict');
  assert.equal(deliveries, 1);
  broker.robotAdapter.announce = () => ({ outcome: 'success' });
  assert.equal((await client.action(makeAction(action.robot_id))).outcome, 'uncertain');
});

test('announcement deadlines settle uncertain, and reconnect or process recovery never replay native work', async (t) => {
  let deliveries = 0; let complete; let now = Date.now();
  const { broker, store, owner, link, root } = fixture(t, { now: () => now,
    robotAdapter: { status: () => ({ online: true, busy: false, announcements_supported: true }),
      // Expiry follows a proven dispatch, independent of filesystem latency.
      announce: () => { deliveries++; now += 5001; return new Promise((resolve) => { complete = resolve; }); } } });
  const linked = link(); const url = await listen(t, broker); const client = await connect(t, url, linked.credential);
  broker.setAnnouncements(owner, linked.installation_id, true);
  const action = makeAction(client.frames.find((frame) => frame.type === 'roster').robots[0].robot_id, { deadline_ms: now + 5000 });
  assert.equal((await client.action(action)).outcome, 'uncertain');
  const next = await connect(t, url, linked.credential);
  assert.equal((await next.action(action)).outcome, 'uncertain');
  complete({ outcome: 'success', confirmed: true }); await settle();
  assert.equal(deliveries, 1);
  const record = [...store.homeAssistantActions.values()][0];
  record.state = 'dispatching'; record.result = null; store.flush();
  const recoveredStore = new Store(join(root, 'account.json'));
  const recovered = new HomeAssistantBroker(recoveredStore, { robotAdapter: broker.robotAdapter });
  t.after(() => recovered.close());
  assert.equal([...recoveredStore.homeAssistantActions.values()][0].result.outcome, 'uncertain');
  const recoveredUrl = await listen(t, recovered);
  const recoveredClient = await connect(t, recoveredUrl, linked.credential);
  assert.equal((await recoveredClient.action(action)).outcome, 'uncertain');
  assert.equal(deliveries, 1);
  assert.equal(recoveredStore.notificationOutbox.size, 0);
});

test('last-moment ownership and permission changes while status is pending prevent native dispatch', async (t) => {
  for (const change of ['permission', 'ownership', 'revocation']) {
    let pendingStatus; let deliveries = 0;
    const { broker, store, owner, link } = fixture(t, { robotAdapter: {
      status: () => pendingStatus ? new Promise((resolve) => { pendingStatus.resolve = resolve; }) : ({ online: true, busy: false, announcements_supported: true }),
      announce: () => { deliveries++; return { outcome: 'success', confirmed: true }; },
    } });
    const linked = link(); const url = await listen(t, broker); const client = await connect(t, url, linked.credential);
    broker.setAnnouncements(owner, linked.installation_id, true); await settle();
    pendingStatus = {};
    const session = broker.sessions.get(linked.installation_id);
    const result = broker.robotAction(session, makeAction(client.frames.find((frame) => frame.type === 'roster').robots[0].robot_id));
    await settle();
    if (change === 'permission') { store.homeAssistantInstallations.get(linked.installation_id).announcementsEnabled = false; store.flush(); }
    if (change === 'ownership') { store.loops.get('loop-one').owner = 'owner-other'; store.flush(); }
    if (change === 'revocation') broker.revoke(store.homeAssistantInstallations.get(linked.installation_id));
    pendingStatus.resolve({ online: true, busy: false, announcements_supported: true });
    assert.equal((await result).outcome, 'error'); assert.equal(deliveries, 0);
    pendingStatus = null;
  }
});

test('final private dispatch authorization rejects permission, session and ownership changes during handoff', async (t) => {
  for (const change of ['permission', 'session', 'ownership']) {
    let request; let conclude;
    const { broker, store, owner, link } = fixture(t, { robotAdapter: {
      status: () => ({ online: true, busy: false, announcements_supported: true }),
      announce: (input) => { request = input; return new Promise((resolve) => { conclude = resolve; }); },
    } });
    const linked = link(); const url = await listen(t, broker); const client = await connect(t, url, linked.credential);
    broker.setAnnouncements(owner, linked.installation_id, true);
    const pending = broker.robotAction(broker.sessions.get(linked.installation_id),
      makeAction(client.frames.find((frame) => frame.type === 'roster').robots[0].robot_id));
    await settle();
    assert.deepEqual(broker.authorizeAction(request), { allowed: true });
    if (change === 'permission') broker.setAnnouncements(owner, linked.installation_id, false);
    if (change === 'session') await connect(t, url, linked.credential);
    if (change === 'ownership') { store.loops.get('loop-one').owner = 'owner-other'; store.flush(); }
    assert.equal(broker.authorizeAction(request).allowed, false);
    conclude({ outcome: 'error', code: 'permission_denied' });
    assert.equal((await pending).outcome, 'error');
  }
});

test('durable store failure cannot start native speech and missing native adapter fails closed', async (t) => {
  let deliveries = 0;
  const { broker, store, owner, link } = fixture(t, { robotAdapter: { status: () => ({ online: true, busy: false, announcements_supported: true }),
    announce: () => { deliveries++; return { outcome: 'success', confirmed: true }; } } });
  const linked = link(); const url = await listen(t, broker); const client = await connect(t, url, linked.credential);
  broker.setAnnouncements(owner, linked.installation_id, true);
  const robotId = client.frames.find((frame) => frame.type === 'roster').robots[0].robot_id;
  const flush = store.flush.bind(store);
  store.flush = () => { throw new Error('Invented storage fault'); };
  assert.equal((await client.action(makeAction(robotId))).code, 'unavailable');
  store.flush = flush;
  let writes = 0;
  store.flush = () => { if (++writes === 2) throw new Error('Invented dispatch-admission storage fault'); flush(); };
  assert.equal((await client.action(makeAction(robotId))).code, 'unavailable');
  store.flush = flush;
  broker.robotAdapter = null;
  assert.equal((await client.action(makeAction(robotId))).code, 'unavailable');
  assert.equal(deliveries, 0);
});

test('owner permission route enforces session, owner scope, strict booleans and same-origin guard', async (t) => {
  const { store, broker, link } = fixture(t); const linked = link();
  const service = createService({ name: 'ha-next-http', routes: protectPortalRoutes(homeAssistantRoutes(store, broker, { peerToken: 'synthetic-next-peer' })) });
  await service.listen(0, '127.0.0.1');
  t.after(() => { service.server.closeAllConnections(); service.server.close(); });
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const set = (headers = {}, value = true) => fetch(base + '/api/home-assistant/installation', { method: 'PUT',
    headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ installationId: linked.installation_id, announcementsEnabled: value }) });
  assert.equal((await set()).status, 401);
  const wrong = createSession(store, { kind: 'user', accountId: 'owner-other' });
  assert.equal((await set({ cookie: `phx_session=${wrong._id}` })).status, 404);
  const owner = createSession(store, { kind: 'user', accountId: 'owner-one' });
  assert.equal((await set({ cookie: `phx_session=${owner._id}`, origin: 'https://forged.example' })).status, 403);
  assert.equal((await set({ cookie: `phx_session=${owner._id}` }, 'true')).status, 400);
  assert.equal((await set({ cookie: `phx_session=${owner._id}`, origin: base })).status, 200);
  assert.equal(store.homeAssistantInstallations.get(linked.installation_id).announcementsEnabled, true);
  const callback = (headers = {}) => fetch(base + '/internal/home-assistant/robot-action/authorize', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ requestId: randomUUID() }),
  });
  assert.equal((await callback()).status, 403);
  const invalid = await callback({ 'x-phoenix-internal-token': 'synthetic-next-peer' });
  assert.equal(invalid.status, 200); assert.equal((await invalid.json()).allowed, false);
});
