// Real-browser verification flow, using temporary accounts and an in-memory
// mail sink. No production service, mailbox, or robot is contacted.
// Puppeteer/Chrome are supplied by the sibling jibo-web-sim, as in portal-smoke.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

process.env.PHOENIX_ENV_FILE = '/dev/null';
process.env.ETCO_account_secureCookies = 'false';
const require = createRequire(join(process.env.SIM_DIR || '/home/shell/jibo-web-sim', 'package.json'));
const puppeteer = require('puppeteer');
const { createAccountService, Store } = await import('../packages/account/src/index.js');
const { createOwnerAccount } = await import('../packages/account/src/model.js');
const dir = mkdtempSync(join(tmpdir(), 'phx-email-browser-'));
const store = new Store(join(dir, 'store.json'));
const sent = [];
let now = Date.now();
const server = await createAccountService({
  store,
  identityProviders: {
    portalUrl: 'https://portal.fixture.test',
    emailVerification: { async send(to, options) { sent.push({ to, options }); } },
  },
  emailVerificationNow: () => now,
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const chromeRoot = join(process.env.HOME, '.cache/puppeteer/chrome');
const executablePath = readdirSync(chromeRoot).map((version) => join(chromeRoot, version, 'chrome-linux64/chrome'))
  .find(existsSync);
let browser;
const out = process.env.EMAIL_VERIFICATION_SMOKE_OUT ? resolve(process.env.EMAIL_VERIFICATION_SMOKE_OUT) : null;
if (out) mkdirSync(out, { recursive: true });

const tokenUrl = (mail) => `${base}/verify-email${new URL(mail.options.url).hash}`;
const visible = (page, selector) => page.waitForSelector(selector, { visible: true, timeout: 10000 });
async function login(page, email) {
  await page.bringToFront();
  await page.goto(`${base}/app`, { waitUntil: 'networkidle0' });
  await page.$eval('#auth-form', (form) => form.reset());
  await page.type('#auth-form input[name=email]', email);
  await page.type('#auth-form input[name=password]', 'ValidPass1');
  await page.click('#auth-submit');
  await visible(page, '#shell');
}

try {
  browser = await puppeteer.launch({ headless: true, executablePath, protocolTimeout: 15000, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => { errors.push(error.message); console.error('PAGE ERROR', error.message); });
  await page.setViewport({ width: 390, height: 844 });
  await page.goto(`${base}/app`, { waitUntil: 'networkidle0' });
  await visible(page, '#auth-resend');
  console.log('PASS resend is available on a fresh sign-in screen');
  await page.click('[data-tab=signup]');
  await page.type('#auth-form input[name=email]', 'new@fixture.test');
  await page.type('#auth-form input[name=firstName]', 'New');
  await page.type('#auth-form input[name=password]', 'ValidPass1');
  await page.click('#auth-submit');
  await page.waitForFunction(() => document.getElementById('auth-error')?.textContent.includes('Check your inbox'));
  assert.equal(sent.length, 1);
  assert.equal(store.accountByEmail('new@fixture.test').isActive, false);
  console.log('PASS signup sends email and waits for verification before sign-in');

  const verify = await browser.newPage();
  verify.on('pageerror', (error) => errors.push(error.message));
  await verify.setViewport({ width: 390, height: 844 });
  await verify.goto(tokenUrl(sent[0]), { waitUntil: 'networkidle0' });
  assert.equal(new URL(verify.url()).hash, '', 'the bearer token is scrubbed from browser history');
  assert.equal(store.accountByEmail('new@fixture.test').emailVerified, undefined, 'opening a link does not consume it');
  await verify.click('#verification-confirm');
  await verify.waitForFunction(() => document.getElementById('verification-title')?.textContent === 'Email verified');
  assert.equal(store.accountByEmail('new@fixture.test').emailVerified, true);
  console.log('PASS explicit confirmation verifies the address without exposing the token in server URLs');
  await login(page, 'new@fixture.test');
  assert.equal(await page.$eval('#email-verification-banner', (el) => el.hidden), true);
  await page.goto(`${base}/app#/profile`, { waitUntil: 'networkidle0' });
  await visible(page, '[data-email-status]');
  assert.equal(await page.$eval('[data-email-status]', (el) => el.textContent.trim()), 'Verified');
  console.log('PASS verified status is shown on Account');

  await page.evaluate(() => fetch('/api/logout', { method: 'POST' }));
  createOwnerAccount(store, { email: 'existing@fixture.test', password: 'ValidPass1', firstName: 'Existing' });
  await login(page, 'existing@fixture.test');
  await visible(page, '#email-verification-banner');
  await page.waitForFunction(() => !document.querySelector('#email-verification-banner [data-verification-resend]')?.disabled);
  assert.match(await page.$eval('#email-verification-banner', (el) => el.textContent), /Your email is not verified/);
  assert.match(await page.$eval('#who-email-status', (el) => el.textContent), /not verified/);
  console.log('PASS existing unverified accounts see the persistent warning');
  await page.click('#email-verification-banner [data-verification-resend]');
  await page.waitForFunction(() => document.querySelector('#email-verification-banner [data-verification-resend]')?.textContent.startsWith('Resend in'));
  assert.equal(sent.length, 2);
  const blocked = await page.evaluate(async () => {
    const result = await fetch('/api/me/email-verification/resend', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    return result.status;
  });
  assert.equal(blocked, 429);
  assert.equal(sent.length, 2);
  await page.click('#email-verification-banner a');
  await visible(page, '[data-email-verification]');
  assert.equal(await page.$eval('[data-email-status]', (el) => el.textContent.trim()), 'Not verified');
  assert.equal(await page.$eval('[data-email-verification] [data-verification-resend]', (el) => el.disabled), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile layout fits the screen');
  if (out) {
    await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
    await page.screenshot({ path: join(out, 'unverified-mobile.png'), fullPage: true });
  }
  console.log('PASS Account resend shares the cooldown and cannot spam mail');

  const oldLink = tokenUrl(sent[1]);
  now += 61000;
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => !document.querySelector('[data-email-verification] [data-verification-resend]')?.disabled);
  await page.click('[data-email-verification] [data-verification-resend]');
  await page.waitForFunction(() => document.querySelector('[data-email-verification] [data-verification-resend]')?.textContent.startsWith('Resend in'));
  assert.equal(sent.length, 3);
  await verify.bringToFront();
  await verify.goto(oldLink, { waitUntil: 'networkidle0' });
  await verify.click('#verification-confirm');
  await verify.waitForFunction(() => document.getElementById('verification-message')?.textContent.includes('invalid or has expired'));
  assert.notEqual(store.accountByEmail('existing@fixture.test').emailVerified, true);
  await verify.goto(tokenUrl(sent[2]), { waitUntil: 'networkidle0' });
  await verify.click('#verification-confirm');
  await verify.waitForFunction(() => document.getElementById('verification-title')?.textContent === 'Email verified');
  await page.bringToFront();
  await page.waitForFunction(() => document.querySelector('[data-email-status]')?.textContent.trim() === 'Verified');
  assert.equal(await page.$eval('[data-email-status]', (el) => el.textContent.trim()), 'Verified');
  assert.equal(await page.$eval('#email-verification-banner', (el) => el.hidden), true);
  await page.setViewport({ width: 1440, height: 1000 });
  if (out) await page.screenshot({ path: join(out, 'verified-desktop.png'), fullPage: true });
  assert.deepEqual(errors, [], 'the browser reports no JavaScript errors');
  console.log('PASS only the newest link works; verification clears the warning');
} catch (error) {
  console.error('BROWSER CHECK FAILED', error.message);
  throw error;
} finally {
  if (browser) await browser.close();
  server.closeAllConnections?.();
  await new Promise((done) => server.close(done));
  rmSync(dir, { recursive: true, force: true });
}
