import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { createSettingsInternalService } = await import('../src/index.js');
const { createSettingsProviders } = await import('../src/settingsProviders.js');
const { Store } = await import('../src/store.js');

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
  res.end(body);
}

function request(port, transactionId) {
  const body = JSON.stringify({ loopId: 'loop-1', transId: transactionId });
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/',
      headers: {
        'content-type': 'application/json',
        'x-amz-target': 'Settings_20171219.GetSettings',
        'x-amz-credentials': JSON.stringify({ id: 'boundary-test-user' }),
        'content-length': Buffer.byteLength(body), connection: 'close',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null });
      });
    });
    req.once('error', reject);
    req.end(body);
  });
}

for (const failure of [
  { name: 'missing statusCode', payload: { error: true, code: 'HUB_MISSING_STATUS', message: 'status omitted' } },
  { name: 'status below Boom minimum', payload: { error: true, code: 'HUB_INVALID_STATUS', message: 'invalid status', statusCode: 399 } },
]) {
  test(`Hub ${failure.name} is request-fatal but does not kill the Settings listener`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'phx-hub-boundary-'));
    let hubRequests = 0;
    const account = await listen((req, res) => {
      if (req.url.startsWith('/isLoopMember')) return json(res, 200, { result: true });
      if (req.url.startsWith('/loopPopulated')) return json(res, 200, { robotFriendlyId: 'robot-boundary' });
      return json(res, 404, { error: true });
    });
    const hub = await listen((_req, res) => {
      if (hubRequests++ === 0) return json(res, 200, failure.payload);
      return json(res, 200, {
        skills: [{ id: 'report-skill', settings: { view: {
          type: 'switch', valueDefinition: { target: 'person', key: 'flag', default: false },
        } } }],
      });
    });
    let service;
    try {
      const store = new Store(join(dir, 'store.json'));
      const providers = createSettingsProviders({
        store,
        env: {
          NET_settings_account: `127.0.0.1:${account.port}`,
          NET_settings_hub: `127.0.0.1:${hub.port}`,
        },
      });
      providers.person = {
        getAccountProperties: async () => ({ flag: { value: true } }),
        getLoopProperties: async () => ({}),
      };
      providers.lasso = { getCredential: async () => ({ credentialExists: false }) };
      service = await createSettingsInternalService({ store, settingsProviders: providers }).listen(0);

      const failed = await request(service.address().port, 'boundary-failure');
      assert.equal(failed.status, 500);
      assert.equal(failed.body.statusCode, 500);
      assert.equal(failed.body.error, 'Internal Server Error');
      const recovered = await request(service.address().port, 'boundary-followup');
      assert.equal(recovered.status, 200);
      assert.equal(recovered.body[0].data.flag.value, true);
      assert.equal(hubRequests, 2);
    } finally {
      if (service) await close(service);
      await close(hub.server);
      await close(account.server);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
