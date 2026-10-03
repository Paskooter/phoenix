// Owner setup browser check. Invented records and isolated ephemeral listeners.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { WebSocket } from 'ws';
import { once } from 'node:events';

process.env.PHOENIX_ENV_FILE = '/dev/null';
process.env.ETCO_account_secureCookies = 'false';
const { Store, createAccountService } = await import('../../packages/account/src/index.js');
const { createOwnerAccount } = await import('../../packages/account/src/model.js');
const { markEmailVerified } = await import('../../packages/account/src/emailVerification.js');
const { createSession } = await import('../../packages/account/src/sessions.js');
const root = mkdtempSync(join(tmpdir(), 'phoenix-ha-portal-'));
const store = new Store(join(root, 'account.json'));
const owner = createOwnerAccount(store, { email: 'owner@example.invalid', password: 'Synthetic-password-1' });
markEmailVerified(owner); owner.firstName = 'Fixture';
const robot = { _id: 'synthetic-portal-robot', friendlyId: 'Synthetic-Pilot-Jibo', isActive: true, accessKeyId: 'synthetic-key' };
store.accounts.set(robot._id, robot);
store.loops.set('synthetic-loop', { _id: 'synthetic-loop', owner: owner._id, robot: robot._id,
  name: 'Fixture household', members: [{ account: owner._id, status: 'accepted' }] });
const session = createSession(store, { kind: 'user', accountId: owner._id }); store.flush();
const service = createAccountService({ store, smtp: null });
let browser, connector;
try {
  await service.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${service.server.address().port}`;
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server'] });
  const context = await browser.newContext();
  await context.addCookies([{ name: 'phx_session', value: session._id, url: base }]);
  const page = await context.newPage();
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base + '/app#/home-assistant');
  await page.getByRole('button', { name: 'Generate connection code' }).waitFor();
  await page.locator('input[name=robot]').check();
  await page.getByRole('button', { name: 'Generate connection code' }).click();
  const code = await page.locator('.ha-connection-code').innerText();
  const exchanged = service.homeAssistant.exchangeCode(code);
  connector = new WebSocket(base.replace('http:', 'ws:') + '/api/home-assistant/connect',
    { headers: { authorization: `Bearer ${exchanged.credential}` } });
  const welcomePromise = once(connector, 'message'); await once(connector, 'open');
  const welcome = JSON.parse((await welcomePromise)[0]);
  connector.send(JSON.stringify({ v: 1, type: 'ready', session_id: welcome.session_id, agent: 'home_assistant', ha_version: '2026.8.1' }));
  await page.getByText('Connected', { exact: true }).waitFor({ timeout: 10000 });
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width}px overflow`);
  }
  const closed = once(connector, 'close');
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  assert.equal((await closed)[0], 4001);
  await page.getByText('No Home Assistant installation linked yet.').waitFor();
  assert.deepEqual(errors, []);
  assert.equal(service.homeAssistant.authenticate(`Bearer ${exchanged.credential}`), null);
  assert.ok(!await page.evaluate(() => JSON.stringify(localStorage)).then((text) => text.includes(exchanged.credential)));
  console.log('PASS owner code, live connection, revocation and 390/768/1440px setup page');
} finally {
  connector?.terminate(); await browser?.close(); service.homeAssistant.close();
  service.server.closeAllConnections();
  await new Promise((resolve) => service.server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
