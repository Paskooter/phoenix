import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccountService, Store } from '../src/index.js';
import { createOwnerAccount } from '../src/model.js';
import { RobotReadClient } from '../src/loopCreation.js';
import { createClassicEntrypoint } from '../../classic/src/index.js';
import { signedLoopHeaders } from './fixtures/signedLoopRequest.js';

test('CreateLoop checks robot read before mutation and emits LoopCreated only after save', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-loop-create-'));
  const store = new Store(join(dir, 'account.json'));
  const owner = createOwnerAccount(store, { email: 'create-owner@synthetic.invalid', password: 'synthetic-password' });
  let mode = 'active'; const requests = [], events = [];
  const peer = http.createServer((req, res) => {
    let text = ''; req.on('data', chunk => text += chunk); req.on('end', () => {
      assert.equal(req.method, 'POST'); assert.equal(req.headers['x-amz-target'], 'Robot_20160225.GetRobot');
      assert.deepEqual(JSON.parse(req.headers['x-amz-credentials']), { isAdmin: true }); requests.push(JSON.parse(text));
      res.setHeader('content-type', mode === 'text' ? 'text/plain' : 'application/json');
      if (mode === 'unavailable') { res.statusCode = 503; return res.end('{}'); }
      res.end(JSON.stringify({ payload: { suspended: mode === 'disabled' || mode === 'text' ? true : mode === 'string' ? 'true' : false } }));
    });
  }); await new Promise(resolve => peer.listen(0, '127.0.0.1', resolve));
  const account = await createAccountService({ store, robotReadClient: new RobotReadClient('http://127.0.0.1:' + peer.address().port), invitationProviders: { eventSender: { send(event) {
    assert(store.loops.has(event.payload.loopId)); assert(store.notificationOutbox.size > 0); events.push(JSON.parse(JSON.stringify(event))); return Promise.reject(new Error('synthetic event unavailable'));
  } } } }).listen(0);
  const previous = process.env.NET_account; process.env.NET_account = 'http://127.0.0.1:' + account.address().port;
  const classic = await createClassicEntrypoint({ notificationFile: join(dir, 'notifications.json'), notificationPollIntervalMs: 60000 }).listen(0);
  try {
    for (const [face, server] of [['account', account], ['classic', classic]]) {
      const base = 'http://127.0.0.1:' + server.address().port;
      for (const currentMode of ['disabled', 'active', 'unavailable', 'string', 'text']) {
        mode = currentMode; const body = { name: 'Synthetic Loop', robotId: 'synthetic-create-' + face + '-' + mode };
        const before = JSON.stringify([...store.loops]); const count = events.length;
        const response = await fetch(base, { method: 'POST', signal: AbortSignal.timeout(5000), headers: signedLoopHeaders(store, base, 'Loop_20160324.CreateLoop', body, owner.accessKeyId), body: JSON.stringify(body) });
        const data = await response.json(); assert.deepEqual(requests.at(-1), { id: body.robotId });
        if (mode === 'disabled') { assert.equal(response.status, 409); assert.equal(data.__type, 'ROBOT_DISABLED'); assert.equal(JSON.stringify([...store.loops]), before); assert.equal(events.length, count); }
        else { assert.equal(response.status, 200); assert.equal(events.length, count + 1); assert.deepEqual(events.at(-1).payload, { loopId: data.id, ownerId: owner._id, robotId: store.loops.get(data.id).robot, eventKey: 'LoopCreated' }); }
      }
    }
  } finally {
    await Promise.all([account, classic, peer].map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })));
    if (previous === undefined) delete process.env.NET_account; else process.env.NET_account = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
