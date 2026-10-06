// Older cloud link management browser check. Invented records and isolated ephemeral listeners.
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
// A second, unlinked Jibo: the server only issues codes for robots without a link.
const spare = { _id: 'synthetic-spare-robot', friendlyId: 'Synthetic-Spare-Jibo', isActive: true, accessKeyId: 'synthetic-spare-key' };
store.accounts.set(spare._id, spare);
store.loops.set('synthetic-spare-loop', { _id: 'synthetic-spare-loop', owner: owner._id, robot: spare._id,
  name: 'Fixture spare', members: [{ account: owner._id, status: 'accepted' }] });
const session = createSession(store, { kind: 'user', accountId: owner._id }); store.flush();
const service = createAccountService({ store, smtp: null });
let browser, connector;
try {
  await service.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${service.server.address().port}`;
  // A link made with Phoenix 0.2, exactly as its Home Assistant made one: a
  // code from this owner, exchanged for a credential, then a ready connector.
  const issued = service.homeAssistant.issueCode(owner, [robot.friendlyId], 'Home Assistant');
  const exchanged = service.homeAssistant.exchangeCode(issued.code);
  connector = new WebSocket(base.replace('http:', 'ws:') + '/api/home-assistant/connect',
    { headers: { authorization: `Bearer ${exchanged.credential}` } });
  const welcomePromise = once(connector, 'message'); await once(connector, 'open');
  const welcome = JSON.parse((await welcomePromise)[0]);
  connector.send(JSON.stringify({ v: 1, type: 'ready', session_id: welcome.session_id, agent: 'home_assistant', ha_version: '2026.8.1' }));

  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server'] });
  const context = await browser.newContext();
  await context.addCookies([{ name: 'phx_session', value: session._id, url: base }]);
  const page = await context.newPage();
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base + '/app#/home-assistant-legacy');
  await page.locator('.ha-install').getByText('Connected', { exact: true }).waitFor({ timeout: 10000 });
  assert.match(await page.locator('.ha-install').innerText(), /Home Assistant 2026\.8\.1/);
  // Older links are only managed here. Phoenix 0.3 and later can't use a code,
  // so the page offers none, and points new connections to direct pairing.
  assert.equal(await page.getByRole('button', { name: /connection code|Link another Jibo/ }).count(), 0);
  assert.equal(await page.getByRole('link', { name: 'Pair directly' }).getAttribute('href'), '#/home-assistant');
  assert.equal(await page.locator('#nav .nav-item.active').getAttribute('href'), '#/home-assistant');

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

  // A code made before codes were retired can still be withdrawn.
  const leftover = service.homeAssistant.issueCode(owner, [spare.friendlyId], 'Home Assistant');
  await page.reload();
  await page.getByText('A connection code you made earlier hasn’t been used.').waitFor();
  await page.getByRole('button', { name: 'Cancel the code' }).click();
  await page.getByText('Code cancelled', { exact: true }).waitFor();
  assert.equal(store.homeAssistantCodes.size, 0);
  assert.throws(() => service.homeAssistant.exchangeCode(leftover.code), /invalid_code/);

  // Disconnecting asks first; declining keeps the link.
  const disconnect = page.locator('.ha-install').getByRole('button', { name: 'Disconnect' });
  await disconnect.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  assert.ok(service.homeAssistant.authenticate(`Bearer ${exchanged.credential}`));
  const closed = once(connector, 'close');
  await disconnect.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Disconnect' }).click();
  assert.equal((await closed)[0], 4001);
  // Nothing left: the page says so and leads to direct pairing instead.
  await page.getByRole('heading', { name: 'No older cloud links' }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Pair Home Assistant directly' }).getAttribute('href'), '#/home-assistant');
  assert.equal(await page.locator('.ha-install').count(), 0);

  // With nothing left to manage, the direct page keeps only a quiet way back.
  await page.goto(base + '/app#/home-assistant');
  await page.getByRole('link', { name: 'Manage older cloud links' }).waitFor();
  assert.equal(await page.locator('.ha-older').count(), 0);
  assert.deepEqual(errors, []);
  assert.equal(service.homeAssistant.authenticate(`Bearer ${exchanged.credential}`), null);
  const storage = await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]));
  assert.ok(!storage.includes(exchanged.credential) && !storage.includes(issued.code) && !storage.includes(leftover.code));
  console.log('PASS older link status, no new codes, explicit announcement permission persistence/save failure, older-link notice on the direct page, leftover code cancel, confirmed revocation, empty state and 390/768/1440px layout');
} finally {
  connector?.terminate(); await browser?.close(); service.homeAssistant.close();
  service.server.closeAllConnections();
  await new Promise((resolve) => service.server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
