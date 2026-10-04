import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRobotAnnouncementAdapter } from '../src/integrations/homeAssistant/robotAdapter.js';

const identity = { id: 'synthetic-robot', accessKeyId: 'synthetic-key', friendlyId: 'synthetic-friendly-robot' };

test('unconfigured reverse transport fails closed without inventing speech success', async () => {
  const adapter = createRobotAnnouncementAdapter({ env: {} });
  assert.deepEqual(await adapter.status(identity), { online: false, busy: false, announcements_supported: false });
  assert.deepEqual(await adapter.announce({ identity, deadline: Date.now() + 1000 }), { outcome: 'error', code: 'robot_offline' });
});

test('real adapter uses private peer identity, never retries, and refuses unconfirmed success', async t => {
  let reply = { outcome: 'success', confirmed: true };
  let requests = 0;
  const server = http.createServer(async (request, response) => {
    requests++;
    assert.equal(request.headers['x-phoenix-internal-token'], 'synthetic-peer-token');
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.deepEqual(body.identity, identity);
    assert.equal(request.url, '/internal/home-assistant/robot-action/announce');
    if (reply === null) { request.socket.destroy(); return; }
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(reply));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const adapter = createRobotAnnouncementAdapter({ env: {}, url: `127.0.0.1:${server.address().port}`, token: 'synthetic-peer-token' });
  const announce = () => adapter.announce({ identity, requestId: '11111111-1111-4111-8111-111111111111',
    text: 'Synthetic speech.', deadline: Date.now() + 1000 });
  assert.deepEqual(await announce(), { outcome: 'success', confirmed: true });
  for (const value of [{ outcome: 'success' }, { outcome: 'success', confirmed: false }, { delivered: true }, null]) {
    reply = value;
    const before = requests;
    assert.deepEqual(await announce(), { outcome: 'uncertain', code: 'confirmation_lost' });
    assert.equal(requests, before + 1, 'uncertain delivery must never retry');
  }
});

test('expired actions and credential-bearing URLs make no network requests', async () => {
  let requests = 0;
  const fetchImpl = async () => { requests++; throw new Error('unexpected request'); };
  const adapter = createRobotAnnouncementAdapter({ env: {}, url: 'http://127.0.0.1:9', token: 'synthetic-peer', fetchImpl });
  assert.deepEqual(await adapter.announce({ identity, deadline: Date.now() - 1 }), { outcome: 'error', code: 'expired' });
  assert.deepEqual(await adapter.announce({ identity, deadline: Date.now() + 46_000 }), { outcome: 'error', code: 'invalid_request' });
  const invalid = createRobotAnnouncementAdapter({ env: {}, url: 'http://user:password@127.0.0.1:9', token: 'synthetic-peer', fetchImpl });
  assert.deepEqual(await invalid.status(identity), { online: false, busy: false, announcements_supported: false });
  assert.equal(requests, 0);
});

test('supplied volume is explicitly unsupported before any private transport work', async () => {
  let requests = 0;
  const adapter = createRobotAnnouncementAdapter({ env: {}, url: 'http://127.0.0.1:9', token: 'synthetic-peer',
    fetchImpl: async () => { requests++; throw new Error('unexpected request'); } });
  for (const volume of [0, 0.3, 1, 2, null, undefined]) {
    assert.deepEqual(await adapter.announce({ identity, text: 'Synthetic speech.', deadline: Date.now() + 1000, volume }),
      { outcome: 'error', code: 'unsupported_volume' });
  }
  assert.equal(requests, 0);
});
