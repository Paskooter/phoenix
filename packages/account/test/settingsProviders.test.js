import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { Store } = await import('../src/store.js');
const { createSettingsProviders } = await import('../src/settingsProviders.js');

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

test('default Settings provider graph uses source NET peer paths and headers', async () => {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    calls.push({ method: req.method, path: url.pathname, query: [...url.searchParams], target: req.headers['x-amz-target'], transId: req.headers['x-jibo-transid'] });
    if (url.pathname === '/isLoopMember') return json(res, 200, { result: true });
    if (url.pathname === '/loopPopulated') return json(res, 200, { robotFriendlyId: 'robot-1' });
    if (url.pathname === '/v1/skills/settings/robot-1') return json(res, 200, { skills: [{ id: 'report-skill', settings: { view: {} } }] });
    if (url.pathname === '/v1/credential') return json(res, 200, { credentialExists: true });
    if (url.pathname === '/') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const payload = JSON.parse(raw);
      if (req.headers['x-amz-target'] === 'Person_20160801.GetLoopProperties') {
        assert.deepEqual(payload, { keys: ['loopFlag'], loopId: 'loop-1' });
        return json(res, 200, { loopFlag: { value: false } });
      }
      assert.deepEqual(payload, { keys: ['accountFlag'] });
      return json(res, 200, { accountFlag: { value: true } });
    }
    return json(res, 404, { message: 'missing test route' });
  });
  const dir = mkdtempSync(join(tmpdir(), 'phx-settings-providers-'));
  try {
    await new Promise((resolve) => server.listen(0, resolve));
    const peer = `localhost:${server.address().port}`;
    const providers = createSettingsProviders({
      store: new Store(join(dir, 'store.json')),
      env: {
        NET_settings_account: peer,
        NET_settings_hub: peer,
        NET_settings_person: peer,
        NET_settings_lasso: peer,
      },
    });
    const context = { loopId: 'loop-1', userId: 'acct-1', transactionId: 'tx-1' };
    await providers.account.checkUserBelongsToLoop(context);
    assert.equal(await providers.account.getFriendlyId(context), 'robot-1');
    assert.deepEqual(await providers.hub.getSkillConfigs(context), [{ id: 'report-skill', settings: { view: {} } }]);
    assert.deepEqual(await providers.person.getAccountProperties(context, ['accountFlag']), { accountFlag: { value: true } });
    assert.deepEqual(await providers.person.getLoopProperties(context, ['loopFlag']), { loopFlag: { value: false } });
    assert.deepEqual(await providers.lasso.getCredential(context, {
      skillId: 'report-skill', serviceName: 'google', serviceAccountName: 'calendar', scopes: ['read'],
    }), { credentialExists: true });
    assert.deepEqual(providers.configuration.missingPeers, []);
    assert.deepEqual(calls.map(({ method, path }) => `${method} ${path}`), [
      'GET /isLoopMember',
      'GET /loopPopulated',
      'GET /loopPopulated',
      'GET /v1/skills/settings/robot-1',
      'POST /',
      'POST /',
      'GET /v1/credential',
    ]);
    assert.equal(calls[3].transId, 'tx-1');
    assert.equal(calls[4].target, 'Person_20160801.GetAccountProperties');
    assert.equal(calls[5].target, 'Person_20160801.GetLoopProperties');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unconfigured peer prerequisites are exposed in provider configuration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-settings-providers-'));
  try {
    const providers = createSettingsProviders({ store: new Store(join(dir, 'store.json')), env: {} });
    assert.deepEqual(providers.configuration.missingPeers, ['account', 'hub', 'person', 'lasso']);
    assert.equal(providers.configuration.account, 'account-store');
    assert.equal(providers.configuration.hub, 'account-settings-store');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
