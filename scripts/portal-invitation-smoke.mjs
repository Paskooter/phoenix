// Real-browser invitation coverage. Uses invented accounts, disposable local
// storage and an in-memory mail sink; never sends email or contacts a robot.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const dir = mkdtempSync(join(tmpdir(), 'phx-invitation-browser-'));
process.env.PHOENIX_ENV_FILE = '/dev/null';
process.env.PHOENIX_DATA_DIR = dir;
process.env.ETCO_account_secureCookies = 'false';
const { createAccountService, Store } = await import('../packages/account/src/index.js');
const { createOwnerAccount, createLoop } = await import('../packages/account/src/model.js');
const { markEmailVerified } = await import('../packages/account/src/emailVerification.js');
const { renderMailTemplate, MAIL_SUBJECTS } = await import('../packages/account/src/smtpMail.js');
const store = new Store(join(dir, 'account.json'));
const sent = [];
const mail = { send(to, options) { sent.push({ to, ...options }); return Promise.resolve(); } };
const service = createAccountService({ store,
  identityProviders: { emailVerification: mail, portalUrl: 'https://portal.fixture.test' },
  invitationProviders: { invitation: mail, invitationExistingUser: mail, portalUrl: 'https://portal.fixture.test' },
});
const server = await service.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${server.address().port}`;
service.identityProviders.portalUrl = base;
service.invitationProviders.portalUrl = base;
const output = process.env.PORTAL_SMOKE_OUT ? resolve(process.env.PORTAL_SMOKE_OUT) : null;
if (output) mkdirSync(output, { recursive: true });
const errors = [];
let browser;
let currentPage;
try {
  const owner = createOwnerAccount(store, { email: 'inviter@fixture.test', password: 'ValidPass1', firstName: 'Fixture', lastName: 'Owner' });
  const existing = createOwnerAccount(store, { email: 'existing@fixture.test', password: 'ValidPass1', firstName: 'Existing' });
  const wrong = createOwnerAccount(store, { email: 'different@fixture.test', password: 'ValidPass1', firstName: 'Different' });
  markEmailVerified(existing); markEmailVerified(wrong);
  const { loop } = createLoop(store, { owner, robotId: 'Fixture-Browser-Invitation-Robot' });
  loop.name = 'Fixture household'; store.flush();
  async function post(path, body, cookie) {
    return fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  }
  const ownerLogin = await post('/api/login', { email: owner.email, password: 'ValidPass1' });
  const ownerCookie = ownerLogin.headers.get('set-cookie').split(';')[0];
  for (const email of ['new@fixture.test', existing.email, 'legacy@fixture.test', 'cancelled@fixture.test']) {
    assert.equal((await post('/api/loop/invite', { loopId: loop._id, email, firstName: 'Invited' }, ownerCookie)).status, 200);
  }
  const inviteLink = (email) => sent.find((entry) => entry.to === email && new URL(entry.url).pathname === '/invite').url;
  const member = (email) => store.loops.get(loop._id).members.find((m) => m.memberProperties?.email === email);
  browser = await chromium.launch({ headless: true,
    ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server'] });
  async function newPage(width = 390) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, colorScheme: 'light' });
    await context.route('**/*', (route) => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    currentPage = page;
    return { context, page };
  }
  async function login(page, email) {
    await page.locator('#auth-form input[name=email]').fill(email);
    await page.locator('#auth-form input[name=password]').fill('ValidPass1');
    await page.locator('#auth-submit').click();
    await page.locator('#shell').waitFor({ state: 'visible' });
  }
  const { page, context } = await newPage();
  await page.goto(inviteLink('new@fixture.test'));
  await page.locator('#auth-form input[name=firstName]').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#auth-form input[name=email]').inputValue(), 'new@fixture.test');
  assert.equal(new URL(page.url()).pathname, '/app');
  assert.equal(new URL(page.url()).search, '');
  await page.locator('#auth-form input[name=firstName]').fill('New');
  await page.locator('#auth-form input[name=password]').fill('ValidPass1');
  await page.locator('#auth-submit').click();
  await page.waitForFunction(() => document.getElementById('auth-error')?.textContent.includes('Check your inbox'));
  const confirmation = sent.find((entry) => entry.to === 'new@fixture.test' && new URL(entry.url).pathname === '/verify-email');
  const verifyPage = await context.newPage();
  const confirmationLink = new URL(confirmation.url);
  await verifyPage.goto(`${base}${confirmationLink.pathname}${confirmationLink.hash}`);
  await verifyPage.locator('#verification-confirm').click();
  await verifyPage.getByRole('heading', { name: 'Email verified', exact: true }).waitFor();
  await page.reload();
  await login(page, 'new@fixture.test');
  await page.getByRole('button', { name: 'Accept invitation', exact: true }).waitFor();
  assert.equal(member('new@fixture.test').status, 'invited', 'following an email does not accept it');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (output) await page.screenshot({ path: join(output, 'invitation-new-recipient.png'), fullPage: true });
  await page.getByRole('button', { name: 'Accept invitation', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('toast')?.textContent.includes('Welcome'));
  assert.equal(member('new@fixture.test').status, 'accepted');
  console.log('PASS new recipient: email, signup, verification, reload, review and explicit acceptance');

  const { page: knownPage } = await newPage(1280);
  await knownPage.goto(inviteLink(existing.email));
  assert.equal(await knownPage.locator('#auth-form input[name=email]').inputValue(), existing.email);
  await login(knownPage, existing.email);
  await knownPage.getByRole('button', { name: 'Accept invitation', exact: true }).waitFor();
  assert.equal(member(existing.email).status, 'invited');
  await knownPage.getByRole('button', { name: 'Accept invitation', exact: true }).click();
  await knownPage.waitForFunction(() => document.getElementById('toast')?.textContent.includes('Welcome'));
  console.log('PASS existing recipient reaches the correct console invitation');

  const { page: wrongPage } = await newPage();
  await wrongPage.goto(`${base}/app`); await login(wrongPage, wrong.email);
  await wrongPage.goto(inviteLink('new@fixture.test'));
  await wrongPage.getByRole('button', { name: 'Switch account', exact: true }).waitFor();
  assert.match(await wrongPage.locator('#app').innerText(), /sent to new@fixture.test/);
  await wrongPage.getByRole('button', { name: 'Switch account', exact: true }).click();
  await wrongPage.locator('#auth-root').waitFor({ state: 'visible' });
  assert.equal(await wrongPage.locator('#auth-form input[name=email]').inputValue(), 'new@fixture.test');
  console.log('PASS wrong account is explained and can switch to the invited account');

  const { page: legacyPage } = await newPage();
  await legacyPage.goto(`${base}/create?email=legacy%40fixture.test&code=${member('legacy@fixture.test').invitationCode}`);
  await legacyPage.locator('#auth-form input[name=firstName]').waitFor({ state: 'visible' });
  assert.equal(await legacyPage.locator('#auth-form input[name=email]').inputValue(), 'legacy@fixture.test');
  assert.equal(new URL(legacyPage.url()).search, '');
  assert.equal(await legacyPage.evaluate(() => sessionStorage.getItem('phoenix.pendingInvitation').includes('code')), false);
  await legacyPage.goto(`${base}/home?email=${encodeURIComponent(existing.email)}`);
  await legacyPage.locator('#auth-form input[name=password]').waitFor();
  assert.equal(await legacyPage.locator('#auth-form input[name=firstName]').isVisible(), false);
  console.log('PASS delivered /create and /home links open the console and scrub legacy codes');

  const cancelled = createOwnerAccount(store, { email: 'cancelled@fixture.test', password: 'ValidPass1' });
  markEmailVerified(cancelled); member(cancelled.email).status = 'removed'; store.flush();
  const { page: cancelledPage } = await newPage();
  await cancelledPage.goto(inviteLink(cancelled.email));
  await cancelledPage.locator('[data-tab=login]').click();
  await login(cancelledPage, cancelled.email);
  await cancelledPage.getByRole('heading', { name: 'Invitation unavailable', exact: true }).waitFor();
  assert.ok(!member(cancelled.email).accountId);
  console.log('PASS cancelled invitations explain recovery without rejoining');

  const preview = await (await newPage()).page;
  const options = { name: 'Fixture Owner', firstName: 'Morgan', email: 'member@fixture.test', originalEmail: 'previous@fixture.test', newEmailAddress: 'new@fixture.test', portalUrl: base, url: `${base}/invite?email=member%40fixture.test&loopId=fixture` };
  const types = ['activation', 'emailVerification', 'invitation', 'invitationExistingUser', 'passwordReset', 'passwordChanged', 'emailReset', 'emailResetComplete'];
  for (const name of types) {
    const template = readFileSync(new URL(`../packages/account/resources/templates/${name}.html`, import.meta.url), 'utf8');
    const rendered = renderMailTemplate(template, options, true);
    assert.doesNotMatch(rendered, /\{[a-zA-Z]+\}|Jibo app|s3.amazonaws.com|support@jibo.com/);
    assert.ok(MAIL_SUBJECTS[name]);
    for (const width of [390, 600]) {
      await preview.setViewportSize({ width, height: 900 });
      await preview.setContent(rendered);
      assert.equal(await preview.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name} fits ${width}px`);
      const links = await preview.locator('a').evaluateAll((anchors) => anchors.map((a) => a.getAttribute('href')));
      assert.equal(links.length, 2); assert.equal(links[0], links[1]);
      if (output) await preview.screenshot({ path: join(output, `email-${name}-${width}.png`), fullPage: true });
    }
  }
  assert.deepEqual(errors, []);
  console.log('PASS all eight email templates at phone and desktop widths; no uncaught browser errors');
} catch (error) {
  console.error('BROWSER ERRORS', errors);
  if (currentPage) console.error('PAGE STATE', currentPage.url(), await currentPage.locator('body').innerText());
  throw error;
} finally {
  await browser?.close();
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
}
