// Synthetic households only. Exercise persisted authorization and real sockets.
import test from 'node:test';
import assert from 'node:assert/strict';
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

function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'phoenix-ha-'));
  const store = new Store(join(root, 'account.json'));
  for (const id of ['one', 'two']) {
    store.accounts.set(`owner-${id}`, { _id: `owner-${id}`, isActive: true });
    store.accounts.set(`robot-${id}`, { _id: `robot-${id}`, friendlyId: `synthetic-${id}`, accessKeyId: `key-${id}`, isActive: true });
    store.loops.set(`loop-${id}`, { _id: `loop-${id}`, owner: `owner-${id}`, robot: `robot-${id}` });
  }
  store.flush();
  const broker = new HomeAssistantBroker(store, options);
  t.after(() => { broker.close(); rmSync(root, { recursive: true, force: true }); });
  const identity = (id = 'one') => ({ id: `robot-${id}`, friendlyId: `synthetic-${id}`, accessKeyId: `key-${id}` });
  const link = (id = 'one') => broker.exchangeCode(broker.issueCode(store.accounts.get(`owner-${id}`), [`synthetic-${id}`]).code);
  return { root, store, broker, identity, link };
}

async function listener(t, broker) {
  const service = createService({ name: 'ha-test', onUpgrade: (...args) => broker.upgrade(...args) });
  await service.listen(0, '127.0.0.1');
  t.after(() => { for (const socket of broker.wss.clients) socket.terminate(); service.server.closeAllConnections(); service.server.close(); });
  return `http://127.0.0.1:${service.server.address().port}`;
}

async function connector(t, url, credential, onCommand = () => {}) {
  const socket = new WebSocket(url.replace('http:', 'ws:') + '/api/home-assistant/connect', { headers: { authorization: `Bearer ${credential}` } });
  const welcomePr = once(socket, 'message');
  await once(socket, 'open');
  const welcome = JSON.parse((await welcomePr)[0]);
  const send = (frame) => socket.send(JSON.stringify({ v: 1, session_id: welcome.session_id, ...frame }));
  socket.on('message', (bytes) => { const frame = JSON.parse(bytes); if (frame.type === 'command') onCommand(frame, send, socket); });
  send({ type: 'ready', agent: 'home_assistant', ha_version: '2026.9.4' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  t.after(() => socket.terminate());
  return { socket, send, welcome };
}

test('linking requires the owner, codes are single use and expire, raw secrets never persist', (t) => {
  let now = Date.now();
  const { store, broker, root } = fixture(t, { now: () => now });
  const owner = store.accounts.get('owner-one');
  assert.throws(() => broker.issueCode(owner, ['synthetic-two']), /robot_not_owned/);
  const expired = broker.issueCode(owner, ['synthetic-one']);
  now += 600001;
  assert.throws(() => broker.exchangeCode(expired.code), /invalid_code/);
  now = Date.now();
  const issued = broker.issueCode(owner, ['synthetic-one']);
  const linked = broker.exchangeCode(issued.code);
  assert.throws(() => broker.exchangeCode(issued.code), /invalid_code/);
  const serialized = readFileSync(store.file, 'utf8');
  assert.ok(!serialized.includes(issued.code.replaceAll('-', '')));
  assert.ok(!serialized.includes(linked.credential));
  const loaded = new HomeAssistantBroker(new Store(join(root, 'account.json')));
  assert.ok(loaded.authenticate(`Bearer ${linked.credential}`));
  loaded.close();
});

test('household isolation, forged IDs and deleted robots fail closed', (t) => {
  const { store, broker, identity, link } = fixture(t);
  link();
  assert.ok(broker.selection(identity()));
  assert.equal(broker.selection(identity('two')), null);
  for (const forged of [{ ...identity(), id: 'robot-two' }, { ...identity(), friendlyId: 'synthetic-two' },
    { ...identity(), accessKeyId: 'key-two' }, { id: 'robot-one', friendlyId: 'synthetic-one' }]) {
    assert.throws(() => broker.selection(forged), /unverified_robot/);
  }
  store.accounts.get('robot-one').isDeleted = true;
  assert.throws(() => broker.selection(identity()), /unverified_robot/);
});

test('ownership transfer revokes immediately and transfer back cannot resurrect credentials', (t) => {
  const { store, broker, link } = fixture(t);
  const linked = link();
  store.loops.get('loop-one').owner = 'owner-two'; store.flush();
  store.loops.get('loop-one').owner = 'owner-one'; store.flush();
  assert.equal(broker.authenticate(`Bearer ${linked.credential}`), null);
  assert.equal(broker.status(store.accounts.get('owner-one')).installations.length, 0);
});

test('offline commands are definite nonexecution; lost results are uncertain; no reconnect replay', async (t) => {
  const { broker, link, identity } = fixture(t, { commandTimeoutMs: 80 });
  const linked = link();
  assert.equal((await broker.command(identity(), 'turn on kitchen light')).code, 'offline');
  const url = await listener(t, broker);
  let deliveries = 0;
  const first = await connector(t, url, linked.credential, (_frame, _send, socket) => { deliveries++; socket.close(); });
  const result = await broker.command(identity(), 'turn on kitchen light');
  assert.equal(result.outcome, 'uncertain');
  await connector(t, url, linked.credential, () => deliveries++);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(deliveries, 1);
  assert.equal(broker.pending.size, 0);
});

test('correlation, deadline, duplicate result and stale-session isolation over real WebSockets', async (t) => {
  const { broker, link, identity } = fixture(t, { commandTimeoutMs: 80 });
  const url = await listener(t, broker);
  const linked = link();
  let request;
  const connected = await connector(t, url, linked.credential, (frame, send) => {
    request = frame;
    send({ type: 'result', request_id: 'unrelated', result: { outcome: 'success', response_type: 'action_done', speech: 'Forged' } });
    send({ type: 'result', request_id: frame.request_id, result: { outcome: 'partial', response_type: 'action_done', speech: 'One worked', success_count: 1, failed_count: 1 } });
  });
  const result = await broker.command(identity(), 'turn on kitchen lights');
  assert.equal(result.outcome, 'partial'); assert.equal(result.speech, 'One worked');
  assert.ok(request.deadline_ms > Date.now() - 80);
  assert.notEqual(request.robot_id, identity().id);
  connected.send({ type: 'result', request_id: request.request_id, result: { outcome: 'success', response_type: 'action_done', speech: 'Duplicate' } });
  assert.equal(broker.pending.size, 0);
  // A silent connector times out without any action retry.
  await connector(t, url, linked.credential);
  assert.equal((await broker.command(identity(), 'turn off kitchen lights')).outcome, 'uncertain');
});

test('revocation closes a connector and rejects its credential', async (t) => {
  const { broker, link } = fixture(t);
  const url = await listener(t, broker); const linked = link();
  const { socket } = await connector(t, url, linked.credential);
  const closed = once(socket, 'close');
  broker.revoke(broker.store.homeAssistantInstallations.get(linked.installation_id));
  assert.equal((await closed)[0], 4001);
  assert.equal(broker.authenticate(`Bearer ${linked.credential}`), null);
});

test('HTTP owner and private peer boundaries reject forged household/context/tracing headers', async (t) => {
  const { store, broker, identity, link } = fixture(t);
  const service = createService({ name: 'ha-http', routes: protectPortalRoutes(homeAssistantRoutes(store, broker, { peerToken: 'synthetic-peer' })) });
  await service.listen(0, '127.0.0.1');
  t.after(() => { service.server.closeAllConnections(); service.server.close(); });
  const url = `http://127.0.0.1:${service.server.address().port}`;
  const call = (path, body, headers = {}) => fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await call('/api/home-assistant/codes', { robotIds: ['synthetic-one'] })).status, 401);
  const session = createSession(store, { kind: 'user', accountId: 'owner-two' });
  assert.equal((await call('/api/home-assistant/codes', { robotIds: ['synthetic-one'], ownerId: 'owner-one' },
    { cookie: `phx_session=${session._id}` })).status, 403);
  link();
  const forged = { identity: identity(), householdId: 'loop-one', context: { general: { accountID: 'owner-one' } } };
  assert.equal((await call('/internal/home-assistant/selection', forged, { 'x-jibo-robotid': 'synthetic-one' })).status, 403);
  assert.equal((await call('/internal/home-assistant/selection', { ...forged, identity: identity('two') },
    { 'x-phoenix-internal-token': 'synthetic-peer' })).status, 200);
  const result = await call('/internal/home-assistant/selection', { ...forged, identity: identity('two') },
    { 'x-phoenix-internal-token': 'synthetic-peer' });
  assert.deepEqual(await result.json(), { enabled: false });
  const ownerSession = createSession(store, { kind: 'user', accountId: 'owner-one' });
  assert.equal((await call('/api/home-assistant/codes', { robotIds: ['synthetic-one'] },
    { cookie: `phx_session=${ownerSession._id}`, origin: 'https://forged.example' })).status, 403);
});
