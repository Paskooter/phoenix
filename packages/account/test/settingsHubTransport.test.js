import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { Store } = await import('../src/store.js');
const { createSettingsProviders } = await import('../src/settingsProviders.js');

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, address: `127.0.0.1:${server.address().port}` }));
  });
}

function close(peer) {
  return new Promise((resolve) => peer.server.close(resolve));
}

function json(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(body);
}

async function withNetworkPeers(accountHandler, hubHandler, callback) {
  const account = await listen(accountHandler);
  const hub = await listen(hubHandler);
  try {
    const providers = createSettingsProviders({
      store: {},
      env: { NET_settings_account: account.address, NET_settings_hub: hub.address },
    });
    return await callback(providers, account, hub);
  } finally {
    await close(hub);
    await close(account);
  }
}

function context(id, transactionId = `tx-${id}`) {
  return { loopId: `loop-${id}`, userId: 'account-1', transactionId };
}

test('Hub follows source GET redirects with the original header and method', async () => {
  const accountCalls = [];
  const hubCalls = [];
  await withNetworkPeers(
    (req, res) => {
      accountCalls.push({ url: req.url, method: req.method });
      json(res, 200, { robotFriendlyId: 'robot-redirect' });
    },
    (req, res) => {
      hubCalls.push({ url: req.url, method: req.method, transactionId: req.headers['x-jibo-transid'] });
      if (req.url === '/v1/skills/settings/robot-redirect') {
        res.writeHead(302, { location: '/manifest', connection: 'close' });
        res.end();
        return;
      }
      json(res, 200, { skills: [{ id: 'report-skill' }] });
    },
    async (providers) => {
      assert.deepEqual(await providers.hub.getSkillConfigs(context('redirect')), [{ id: 'report-skill' }]);
    },
  );
  assert.deepEqual(accountCalls.map((item) => `${item.method} ${item.url}`), ['GET /loopPopulated?loopId=loop-redirect']);
  assert.deepEqual(hubCalls, [
    { method: 'GET', url: '/v1/skills/settings/robot-redirect', transactionId: 'tx-redirect' },
    { method: 'GET', url: '/manifest', transactionId: 'tx-redirect' },
  ]);
});

test('Hub timeout covers response headers but clears before a delayed body', async () => {
  const previous = process.env.ETCO_server_http_timeout;
  process.env.ETCO_server_http_timeout = '20';
  try {
    await withNetworkPeers(
      (_req, res) => json(res, 200, { robotFriendlyId: 'robot-timeout' }),
      (_req, res) => setTimeout(() => json(res, 200, { skills: [] }), 70),
      async (providers) => {
        const started = Date.now();
        await assert.rejects(
          providers.hub.getSkillConfigs(context('timeout')),
          (error) => error.isBoom === true && error.isServer === true && error.output.statusCode === 504,
        );
        assert.ok(Date.now() - started < 200, 'header timeout is bounded');
      },
    );

    await withNetworkPeers(
      (_req, res) => json(res, 200, { robotFriendlyId: 'robot-body' }),
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
        res.flushHeaders();
        setTimeout(() => res.end('{"skills":[]}'), 70);
      },
      async (providers) => {
        assert.deepEqual(await providers.hub.getSkillConfigs(context('body')), []);
      },
    );
  } finally {
    if (previous === undefined) delete process.env.ETCO_server_http_timeout;
    else process.env.ETCO_server_http_timeout = previous;
  }
});

test('Hub maps an upstream reset to the source gateway-timeout boundary', async () => {
  await withNetworkPeers(
    (_req, res) => json(res, 200, { robotFriendlyId: 'robot-reset' }),
    (req) => req.socket.destroy(),
    async (providers) => {
      await assert.rejects(
        providers.hub.getSkillConfigs(context('reset')),
        (error) => error.isBoom === true && error.isServer === true && error.output.statusCode === 504,
      );
    },
  );
});

test('Hub keeps Wreck smart JSON behavior for a non-JSON content type', async () => {
  await withNetworkPeers(
    (_req, res) => json(res, 200, { robotFriendlyId: 'robot-text' }),
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', connection: 'close' });
      res.end('{"skills":[{"id":"must-not-parse"}]}');
    },
    async (providers) => {
      assert.equal(await providers.hub.getSkillConfigs(context('text')), undefined);
    },
  );
});

test('Hub preserves Boom status coercion and the complete provider error envelope', async () => {
  await withNetworkPeers(
    (_req, res) => json(res, 200, { robotFriendlyId: 'robot-error' }),
    (_req, res) => json(res, 500, { error: true, statusCode: '422abc', code: 'HUB_BAD', message: '' }),
    async (providers) => {
      await assert.rejects(
        providers.hub.getSkillConfigs(context('error')),
        (error) => {
          assert.equal(error.name, 'Error');
          assert.equal(error.message, 'Unprocessable Entity');
          assert.equal(error.isBoom, true);
          assert.equal(error.isServer, false);
          assert.deepEqual(error.data, { code: 'HUB_BAD' });
          assert.deepEqual(error.output, {
            statusCode: 422,
            payload: {
              statusCode: 422,
              error: 'Unprocessable Entity',
              message: 'Unprocessable Entity',
              code: 'HUB_BAD',
            },
            headers: {},
          });
          return true;
        },
      );
    },
  );
});

test('local Hub keeps the Account friendly-id prerequisite and local view shape', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-settings-hub-local-'));
  try {
    const store = new Store(join(dir, 'store.json'));
    store.accounts.set('robot-account', { _id: 'robot-account', friendlyId: 'robot-local' });
    store.loops.set('loop-local', { _id: 'loop-local', robot: 'robot-account' });
    store.settings.set('account-1', { _id: 'account-1', data: { weatherEnabled: { value: 1 } } });
    const providers = createSettingsProviders({ store, env: {} });
    const configs = await providers.hub.getSkillConfigs(context('local'));
    assert.equal(configs.length, 1);
    assert.equal(configs[0].id, 'report-skill');
    assert.equal(configs[0].settings.view.type, 'group');
    // The synthesized local view also carries the report-skill manifest's declared
    // `offerProactively` person setting (default true); the settings service applies a view
    // node's `default` when the stored property is absent, which is what keeps an unset
    // proactive opt-in routing as the reference does.
    assert.deepEqual(configs[0].settings.view.childViews, [
      { type: 'switch', valueDefinition: { target: 'person', key: 'weatherEnabled' } },
      { type: 'switch', valueDefinition: { target: 'person', key: 'offerProactively', default: true } },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
