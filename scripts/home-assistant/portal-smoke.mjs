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
  // Cloud links made with Phoenix 0.2 are managed on their own page.
  await page.goto(base + '/app#/home-assistant-legacy');
  const getCode = page.getByRole('button', { name: 'Get connection code' });
  await getCode.waitFor();
  // An owner's only Jibo is already chosen; choosing it again changes nothing.
  const choice = page.getByRole('checkbox', { name: /Synthetic-Pilot-Jibo/ });
  assert.ok(await choice.isChecked());
  await choice.check();
  await getCode.click();
  const code = await page.locator('.ha-connection-code').innerText();
  assert.match(code, /^[0-9A-F]{4}(?:-[0-9A-F]{4}){4}$/);
  await page.getByText('Waiting for Home Assistant…').waitFor();
  const exchanged = service.homeAssistant.exchangeCode(code);
  connector = new WebSocket(base.replace('http:', 'ws:') + '/api/home-assistant/connect',
    { headers: { authorization: `Bearer ${exchanged.credential}` } });
  const welcomePromise = once(connector, 'message'); await once(connector, 'open');
  const welcome = JSON.parse((await welcomePromise)[0]);
  connector.send(JSON.stringify({ v: 1, type: 'ready', session_id: welcome.session_id, agent: 'home_assistant', ha_version: '2026.8.1' }));
  // The page notices on its own: the setup card confirms, and the link reads Connected.
  await page.getByText('Connected to Home Assistant 2026.8.1').waitFor({ timeout: 10000 });
  await page.locator('.ha-install').getByText('Connected', { exact: true }).waitFor({ timeout: 10000 });
  // The linked installation has no reverse permission until its owner opts in.
  const announcements = page.getByRole('checkbox', { name: /Allow Home Assistant announcements/ });
  const permissionLabel = page.locator('.ha-install label.switch').filter({ hasText: 'Allow Home Assistant announcements' });
  assert.equal(await announcements.isChecked(), false);
  assert.equal(store.homeAssistantInstallations.get(exchanged.installation_id).announcementsEnabled, false);
  await permissionLabel.click();
  await page.getByText('Home Assistant announcements allowed', { exact: true }).waitFor();
  assert.equal(new Store(store.file).homeAssistantInstallations.get(exchanged.installation_id).announcementsEnabled, true);
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width}px overflow`);
  }
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.reload();
  await permissionLabel.waitFor();
  assert.equal(await announcements.isChecked(), true);
  // A failed save restores the previous choice instead of implying permission.
  await page.route('**/api/home-assistant/installation', (route) => route.fulfill({
    status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'forbidden' }),
  }));
  await permissionLabel.click();
  await page.getByText('Could not save announcement permission.', { exact: true }).waitFor();
  assert.equal(await announcements.isChecked(), true);
  assert.equal(store.homeAssistantInstallations.get(exchanged.installation_id).announcementsEnabled, true);
  await page.unroute('**/api/home-assistant/installation');
  await permissionLabel.click();
  await page.getByText('Home Assistant announcements turned off', { exact: true }).waitFor();
  assert.equal(new Store(store.file).homeAssistantInstallations.get(exchanged.installation_id).announcementsEnabled, false);
  // The direct page says an older cloud link remains, names its Jibo, and leads to it.
  await page.goto(base + '/app#/home-assistant');
  const olderLink = page.locator('.ha-older');
  await olderLink.getByText('You still have an older cloud link').waitFor();
  assert.match(await olderLink.innerText(), /Fixture household/);
  await olderLink.getByRole('link', { name: 'Manage older cloud links' }).click();
  await page.waitForURL('**/app#/home-assistant-legacy');
  await permissionLabel.waitFor();
  // Disconnecting asks first; declining keeps the link.
  const disconnect = page.locator('.ha-install').getByRole('button', { name: 'Disconnect' });
  await disconnect.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  assert.ok(service.homeAssistant.authenticate(`Bearer ${exchanged.credential}`));
  const closed = once(connector, 'close');
  await disconnect.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Disconnect' }).click();
  assert.equal((await closed)[0], 4001);
  await page.getByRole('heading', { name: 'Connect Jibo to Home Assistant' }).waitFor();
  // A new code can be withdrawn before Home Assistant uses it.
  await page.getByRole('button', { name: 'Get connection code' }).click();
  const unused = await page.locator('.ha-connection-code').innerText();
  await page.getByRole('button', { name: 'Cancel code' }).click();
  await page.getByRole('button', { name: 'Get connection code' }).waitFor();
  assert.equal(store.homeAssistantCodes.size, 0);
  assert.throws(() => service.homeAssistant.exchangeCode(unused), /invalid_code/);
  // With nothing left to manage, the direct page keeps only a quiet way back.
  await page.goto(base + '/app#/home-assistant');
  await page.getByRole('link', { name: 'Manage older cloud links' }).waitFor();
  assert.equal(await page.locator('.ha-older').count(), 0);
  assert.deepEqual(errors, []);
  assert.equal(service.homeAssistant.authenticate(`Bearer ${exchanged.credential}`), null);
  const storage = await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]));
  assert.ok(!storage.includes(exchanged.credential) && !storage.includes(code) && !storage.includes(unused));
  console.log('PASS owner code, live connection, explicit announcement permission persistence/save failure, older-link notice on the direct page, confirmed revocation, cancelled code and 390/768/1440px setup page');
} finally {
  connector?.terminate(); await browser?.close(); service.homeAssistant.close();
  service.server.closeAllConnections();
  await new Promise((resolve) => service.server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
