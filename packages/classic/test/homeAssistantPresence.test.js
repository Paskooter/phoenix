import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { signSigV4 } from '@phoenix/common';
import { createClassicEntrypoint, createVerifiedClassicCaller } from '../src/index.js';
import { createRobotAnnouncementAdapter } from '../../account/src/integrations/homeAssistant/robotAdapter.js';

const PEER = 'synthetic-presence-peer-token';
const robot = { _id: 'synthetic-legacy-robot-account', id: 'synthetic-legacy-robot-account',
  accessKeyId: 'SYNTHETICPRESENCEKEY', secretAccessKey: 'synthetic-presence-robot-secret',
  friendlyId: 'synthetic-legacy-robot', isActive: true };
const identity = { id: robot.id, accessKeyId: robot.accessKeyId, friendlyId: robot.friendlyId };

test('legacy online presence requires a real authenticated socket and grants no announcement capability', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'synthetic-classic-presence-'));
  const classic = createClassicEntrypoint({
    callerBoundary: createVerifiedClassicCaller({ resolveCredentials: key => key === robot.accessKeyId ? robot : null }),
    publicUrl: 'https://synthetic-classic.invalid', homeAssistantPresencePeerToken: PEER,
    notificationFile: join(directory, 'notifications.json'), notificationPollIntervalMs: 0,
  });
  await classic.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${classic.server.address().port}`;
  const adapter = createRobotAnnouncementAdapter({ env: {}, classicUrl: base, token: PEER });
  t.after(async () => {
    classic.hub.stopDelivery();
    for (const socket of classic.wss.clients) socket.terminate();
    await new Promise(resolve => classic.wss.close(resolve));
    classic.server.closeAllConnections();
    await new Promise(resolve => classic.server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  const denied = await fetch(`${base}/internal/home-assistant/robot-presence`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identity }),
  });
  assert.equal(denied.status, 403);
  assert.deepEqual(await adapter.status(identity), { online: false, busy: false, announcements_supported: false });
  const body = JSON.stringify({ deviceId: 'synthetic-legacy-device' });
  const headers = signSigV4({ method: 'POST', path: '/', body, headers: {
    Host: new URL(base).host, 'Content-Type': 'application/x-amz-json-1.1',
    'X-Amz-Target': 'Notification_20150505.NewRobotToken',
  }, accessKeyId: robot.accessKeyId, secretAccessKey: robot.secretAccessKey,
  region: 'us-east-1', service: 'notification' }).headers;
  const response = await fetch(`${base}/`, { method: 'POST', headers, body });
  assert.equal(response.status, 200);
  const { token } = await response.json();
  const client = new WebSocket(`${base.replace('http:', 'ws:')}/socket/${token}`);
  await once(client, 'open');
  assert.deepEqual(await adapter.status(identity), { online: true, busy: false, announcements_supported: false });
  assert.deepEqual(await adapter.status({ ...identity, id: 'synthetic-other-account' }),
    { online: false, busy: false, announcements_supported: false });
  client.close(); await once(client, 'close');
  for (let i = 0; i < 50 && classic.hub.sockets.size; i++) await delay(5);
  // Simulate the old persisted connected marker surviving a crashed process.
  // The new presence read uses live OPEN sockets and cannot trust that marker.
  classic.hub.store.markConnected({ accountId: robot.id });
  assert.equal(classic.hub.isConnected(robot.id), true);
  assert.deepEqual(await adapter.status(identity), { online: false, busy: false, announcements_supported: false });
  assert.deepEqual(await adapter.announce({ identity, deadline: Date.now() + 1000 }),
    { outcome: 'error', code: 'robot_offline' });
});

test('presence fails closed without authenticated Classic caller boundary', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'synthetic-classic-presence-disabled-'));
  const classic = createClassicEntrypoint({ homeAssistantPresencePeerToken: PEER,
    notificationFile: join(directory, 'notifications.json'), notificationPollIntervalMs: 0 });
  await classic.listen(0, '127.0.0.1');
  t.after(async () => {
    classic.hub.stopDelivery(); classic.wss.close();
    classic.server.closeAllConnections();
    await new Promise(resolve => classic.server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  const adapter = createRobotAnnouncementAdapter({ env: {}, token: PEER,
    classicUrl: `http://127.0.0.1:${classic.server.address().port}` });
  assert.deepEqual(await adapter.status(identity), { online: false, busy: false, announcements_supported: false });
});
