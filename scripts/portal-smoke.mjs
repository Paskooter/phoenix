// Real-browser coverage of the public site, current console routes and account lifecycle.
// Uses disposable local Account/Classic stores. No robot or external service is contacted.
// npm run test:portal (CHROME_BIN overrides Playwright's Chromium; HEADFUL=1 shows it).
// PORTAL_SMOKE_OUT optionally saves screenshots outside the fixture's temporary directory.

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const dir = mkdtempSync(join(tmpdir(), 'phx-portal-smoke-'));
process.env.PHOENIX_ENV_FILE = '/dev/null';
process.env.PHOENIX_DATA_DIR = dir;
process.env.ETCO_account_secureCookies = 'false';
process.env.ETCO_account_internalPeerToken = 'portal-smoke-fixture-peer-token';
const { DefaultPort } = await import('../packages/contracts/src/index.js');
for (const service of Object.keys(DefaultPort)) process.env[`NET_${service}`] = 'http://127.0.0.1:9';
const { createAccountService, Store } = await import('../packages/account/src/index.js');
const { createOwnerAccount } = await import('../packages/account/src/model.js');
const { markEmailVerified } = await import('../packages/account/src/emailVerification.js');
const {
  createClassicEntrypoint, createVerifiedClassicCaller, KeyStore, MediaStore,
  PersonStore, RobotStore, JotStore, VoiceTrainingStore, DeviceRegistry, IftttStore,
} = await import('../packages/classic/src/index.js');
const store = new Store(join(dir, 'account.json'));
process.env.ETCO_classic_accountDataFile = store.file;
const output = process.env.PORTAL_SMOKE_OUT ? resolve(process.env.PORTAL_SMOKE_OUT) : null;
if (output) mkdirSync(output, { recursive: true });
const EMAIL = 'portal-owner@fixture.test';
const PASSWORD = 'Fixture-password-1';
const ROBOT = 'Cedar-Cove-Maple-Wren';
let account, classic, browser;
const errors = [];

try {
  account = await createAccountService({ store, smtp: null }).listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${account.address().port}`;
  process.env.NET_account = base;
  classic = await createClassicEntrypoint({
    publicUrl: 'http://classic.fixture.test',
    callerBoundary: createVerifiedClassicCaller({ resolveCredentials: (id) => store.accountByAccessKeyId(id) }),
    notificationFile: join(dir, 'notifications.json'),
    log: { dir: join(dir, 'logs') }, backup: { dir: join(dir, 'backups') },
    keyStore: new KeyStore(join(dir, 'keys.json')), keyBinaryDir: join(dir, 'key-binaries'),
    media: { store: new MediaStore({ directory: join(dir, 'media'), file: join(dir, 'media.json') }) },
    person: { store: new PersonStore({ file: join(dir, 'people.json') }) },
    robotStore: new RobotStore({ dir: join(dir, 'robots') }),
    jot: { store: new JotStore({ file: join(dir, 'jot.json') }), pushRegistry: new DeviceRegistry(join(dir, 'push.json')) },
    voiceTraining: { store: new VoiceTrainingStore({ file: join(dir, 'voice.json') }) },
    ifttt: { store: new IftttStore({ file: join(dir, 'ifttt.json') }) },
    gqa: { attributionFile: join(dir, 'attribution.json') },
  }).listen(0, '127.0.0.1');
  process.env.NET_classic = `http://127.0.0.1:${classic.address().port}`;
  browser = await chromium.launch({
    ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}),
    headless: process.env.HEADFUL !== '1',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server'],
  });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'light' });
  await context.route('**/*', (route) => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);

  async function visit(hash) {
    await page.goto(`${base}/app${hash}`);
    await page.locator('#shell').waitFor({ state: 'visible' });
    await page.locator('#app .page-head').waitFor();
    await page.waitForFunction(() => !document.querySelector('#app .loading-rows'));
    assert.doesNotMatch(await page.locator('#app').innerText(), /This page failed to render/);
  }
  async function fits(label) {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${label} fits the viewport`);
  }
  async function screenshot(name) {
    if (output) await page.screenshot({ path: join(output, `${name}.png`), fullPage: true });
  }
  async function signIn(password) {
    await page.locator('#auth-form input[name=email]').fill(EMAIL);
    await page.locator('#auth-form input[name=password]').fill(password);
    await page.locator('#auth-submit').click();
    await page.locator('#shell').waitFor({ state: 'visible' });
  }

  await page.goto(base);
  await page.locator('h1').waitFor();
  await fits('public site on mobile');
  await screenshot('site-mobile');
  await page.goto(`${base}/app`);
  await page.locator('[data-tab=signup]').click();
  await page.locator('#auth-form input[name=email]').fill(EMAIL);
  await page.locator('#auth-form input[name=firstName]').fill('Fixture');
  await page.locator('#auth-form input[name=password]').fill(PASSWORD);
  await page.locator('#auth-submit').click();
  await page.locator('#shell').waitFor({ state: 'visible' });
  console.log('PASS signup reaches the console');

  await visit('#/add/new');
  await page.locator('#app input[name=ssid]').fill('Fixture Wi-Fi');
  await page.locator('#app input[name=password]').fill('fixture-wifi');
  await page.getByRole('button', { name: 'Show setup code', exact: true }).click();
  await page.locator('.qr-codes svg').first().waitFor();
  await fits('setup QR on mobile');
  const token = [...store.tokens.values()].at(-1);
  assert.ok(token, 'setup token minted');
  const redeemed = await fetch(`${base}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'OOBE.SetupRobot' },
    body: JSON.stringify({ token: token._id, id: ROBOT }),
  });
  assert.equal(redeemed.status, 200, await redeemed.text());
  await page.waitForURL('**/app#/robot');
  await page.getByText(ROBOT, { exact: true }).first().waitFor();
  console.log('PASS QR setup, token redemption and robot listing');

  const owner = store.accountByEmail(EMAIL);
  owner.birthday = 0;
  owner.isAdmin = true;
  markEmailVerified(owner);
  const admin = createOwnerAccount(store, { email: 'portal-admin@fixture.test', password: 'Admin-fixture-1' });
  admin.isAdmin = true;
  store.flush();
  const loop = [...store.loops.values()].find((item) => item.owner === owner._id);
  assert.ok(loop);
  for (const hash of ['#/', '#/loop', '#/settings', '#/profile', '#/robot', `#/robot/${loop._id}`, '#/home-assistant', '#/home-assistant-legacy', '#/gallery', '#/inbox', '#/system', '#/admin', '#/admin/settings', '#/admin/robots', '#/admin/people']) {
    await visit(hash);
    await fits(`${hash} on mobile`);
    if (['#/', '#/loop', '#/profile', '#/admin'].includes(hash)) await screenshot(`mobile-${hash.slice(2) || 'overview'}`);
  }
  const homeRequests = [];
  const recordHomeRequest = (request) => {
    if (request.url().startsWith(`${base}/api/home-assistant`)) homeRequests.push(request.method());
  };
  page.on('request', recordHomeRequest);
  await visit('#/home-assistant');
  assert.match(await page.locator('#app').innerText(), /eight digits/);
  assert.match(await page.locator('#app').innerText(), /directly with Jibo/);
  assert.equal(await page.locator('#app input').count(), 0, 'local setup never asks for credentials in the portal');
  assert.equal(await page.getByRole('link', { name: 'Manage older cloud links' }).getAttribute('href'), '#/home-assistant-legacy');
  assert.deepEqual(homeRequests, [], 'direct guidance does not request a cloud code or connection');
  page.off('request', recordHomeRequest);
  console.log('PASS direct Home Assistant guidance and separate legacy management');
  await visit('#/settings');
  await page.locator('.settings-form label.switch').filter({ has: page.locator('input[name=news]') }).click();
  const saved = page.waitForResponse((response) => response.url() === `${base}/api/settings` && response.request().method() === 'PUT');
  await page.locator('.settings-form button[type=submit]').click();
  assert.equal((await saved).status(), 200);
  await visit('#/settings');
  assert.equal(await page.locator('.settings-form input[name=news]').isChecked(), false);
  console.log('PASS personal report settings persist');

  await visit('#/admin/robots');
  await page.getByText('Adopt a robot by hand', { exact: true }).click();
  await page.locator('.adm-adopt input[name=friendlyId]').fill('Birch-Pond-Robin-Fern');
  await page.locator('.adm-adopt input[name=ownerEmail]').fill(EMAIL);
  await page.getByRole('button', { name: 'Adopt robot', exact: true }).click();
  await page.locator('.adm-adopt pre').waitFor({ state: 'visible' });
  assert.match(await page.locator('.adm-adopt pre').innerText(), /credentials\.json/);
  assert.match(await page.locator('.adm-adopt pre').innerText(), /accessKeyId/);
  console.log('PASS admin adoption shows robot credentials');

  await visit('#/profile');
  assert.equal(await page.locator('input[name=birthdayDate]').inputValue(), '1970-01-01');
  await page.locator('.about-form input[name=firstName]').fill('Updated fixture');
  await page.locator('.about-form button[type=submit]').click();
  await page.waitForFunction(() => document.getElementById('who-name')?.textContent === 'Updated fixture');
  assert.equal(store.accounts.get(owner._id).birthday, 0, 'saving another profile field preserves the epoch birthday');
  for (const width of [768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ colorScheme: width === 1440 ? 'dark' : 'light' });
    for (const hash of ['#/', '#/loop', '#/profile', '#/home-assistant', '#/admin', '#/admin/settings']) {
      await visit(hash);
      await fits(`${hash} at ${width}px`);
      await screenshot(`${width}-${hash.slice(2).replaceAll('/', '-') || 'overview'}`);
    }
  }
  console.log('PASS console routes, responsive layouts and profile editing');

  await visit('#/profile');
  const other = await context.newPage();
  await other.goto(`${base}/app#/profile`);
  await other.locator('#shell').waitFor({ state: 'visible' });
  await page.locator('.setting-line').filter({ has: page.locator('.setting-line-label', { hasText: /^Password$/ }) }).getByRole('button', { name: 'Change…' }).click();
  await page.locator('input[name=currentPassword]').fill(PASSWORD);
  await page.locator('input[name=newPassword]').fill('Replacement-fixture-2');
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  await page.locator('#auth-root').waitFor({ state: 'visible' });
  await other.locator('#auth-root').waitFor({ state: 'visible' });
  assert.match(await page.locator('#auth-error').innerText(), /Sign in with your new password/);
  await signIn('Replacement-fixture-2');
  console.log('PASS password changes return every open tab to sign-in');

  await visit('#/profile');
  await other.reload();
  await other.locator('#shell').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Delete account…', exact: true }).click();
  await page.locator('.delete-form input[name=password]').fill('Replacement-fixture-2');
  await page.getByRole('button', { name: 'Delete my account', exact: true }).click();
  await page.locator('#auth-root').waitFor({ state: 'visible' });
  await other.locator('#auth-root').waitFor({ state: 'visible' });
  assert.equal(store.accounts.has(owner._id), false);
  assert.match(await page.locator('#auth-error').innerText(), /account has been deleted/);
  assert.deepEqual(errors, [], 'no uncaught browser errors');
  console.log('PASS deletion clears every open tab; PORTAL SMOKE: ALL PASS');
} finally {
  if (browser) await browser.close();
  for (const server of [classic, account]) {
    server?.closeAllConnections();
    if (server?.listening) await new Promise((done) => server.close(done));
  }
  rmSync(dir, { recursive: true, force: true });
}
