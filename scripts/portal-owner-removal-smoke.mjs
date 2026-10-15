// Browser coverage of owner removal, using disposable local stores only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { freePort } from '../packages/classic/test/fixtures/signedClassic.js';

process.env.PHOENIX_ENV_FILE = '/dev/null';
process.env.ETCO_account_secureCookies = 'false';
const { DefaultPort } = await import('../packages/contracts/src/index.js');
for (const service of Object.keys(DefaultPort)) process.env[`NET_${service}`] = 'http://127.0.0.1:9';
const { createAccountService, Store } = await import('../packages/account/src/index.js');
const { createLoop, createOwnerAccount } = await import('../packages/account/src/model.js');
const { markEmailVerified } = await import('../packages/account/src/emailVerification.js');
const { createClassicEntrypoint, createVerifiedClassicCaller, KeyStore, PersonStore, RobotStore } = await import('../packages/classic/src/index.js');

async function fixture(t, who) {
  const dir = mkdtempSync(join(tmpdir(), 'phx-removal-browser-'));
  process.env.PHOENIX_DATA_DIR = dir;
  process.env.ETCO_account_internalPeerToken = 'fixture-browser-peer-token';
  const store = new Store(join(dir, 'account.json'));
  process.env.ETCO_classic_accountDataFile = store.file;
  const owner = createOwnerAccount(store, { email: 'owner@fixture.test', password: 'Fixture-password-1' });
  const member = createOwnerAccount(store, { email: 'member@fixture.test', password: 'Fixture-password-1' });
  markEmailVerified(owner);
  markEmailVerified(member);
  const { loop, robot } = createLoop(store, { owner, robotId: 'Cedar-Cove-Maple-Wren' });
  loop.name = 'Living room';
  loop.members.push({ _id: 'fixture-member', accountId: member._id, status: 'accepted' });
  store.flush();
  // Configure both peer endpoints before composing their clients.
  const accountPort = await freePort();
  process.env.NET_account = `http://127.0.0.1:${accountPort}`;
  const classic = await createClassicEntrypoint({
    publicUrl: 'http://classic.fixture.test',
    callerBoundary: createVerifiedClassicCaller({ resolveCredentials: (id) => store.accountByAccessKeyId(id) }),
    robotStore: new RobotStore({ dir: join(dir, 'robots') }), keyStore: new KeyStore(join(dir, 'keys.json')),
    person: { store: new PersonStore({ file: join(dir, 'people.json') }) },
    notificationFile: join(dir, 'notifications.json'), log: { dir: join(dir, 'logs') }, backup: { dir: join(dir, 'backups') },
  }).listen(0, '127.0.0.1');
  process.env.NET_classic = `http://127.0.0.1:${classic.address().port}`;
  const account = await createAccountService({ store }).listen(accountPort, '127.0.0.1');
  const base = `http://127.0.0.1:${account.address().port}`;
  const browser = await chromium.launch({
    ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server'],
  });
  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => account.close(resolve));
    await new Promise((resolve) => classic.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const external = [];
  await context.route('**/*', (route) => {
    if (new URL(route.request().url()).origin === base) return route.continue();
    external.push(route.request().url());
    return route.abort();
  });
  const errors = [];
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/app`);
  await page.locator('#auth-form input[name=email]').fill(`${who}@fixture.test`);
  await page.locator('#auth-form input[name=password]').fill('Fixture-password-1');
  await page.locator('#auth-submit').click();
  await page.locator('#shell').waitFor({ state: 'visible' });
  if (who === 'owner') {
    const holidays = await page.request.get(`${base}/api/robot/holidays?loopId=${encodeURIComponent(loop._id)}`);
    assert.equal(holidays.status(), 200, 'the fixture supplies Account authorization for household settings');
  }
  await page.goto(`${base}/app#/robot/${loop._id}`);
  return { page, store, loop, robot, errors, external, base };
}

test('members cannot see Remove this Jibo and keep their leave option', async (t) => {
  const f = await fixture(t, 'member');
  await f.page.getByText('Only the loop owner can change this Jibo’s settings.', { exact: true }).waitFor();
  assert.equal(await f.page.getByRole('button', { name: 'Remove this Jibo', exact: true }).count(), 0);
  await f.page.goto(`${f.base}/app#/loop`);
  await f.page.getByRole('button', { name: 'Leave…', exact: true }).waitFor();
  assert.equal(await f.page.getByRole('button', { name: 'Remove this Jibo', exact: true }).count(), 0);
  assert.deepEqual(f.errors, []);
});

test('owners remove an offline Jibo through the preview and typed-name dialog', async (t) => {
  const f = await fixture(t, 'owner');
  const action = f.page.locator('#robot-panel-general').getByRole('button', { name: 'Remove this Jibo', exact: true });
  await action.waitFor({ state: 'visible' });
  assert.ok((await action.boundingBox()).width > 0);
  await action.click();
  const dialog = f.page.locator('dialog.removal-modal');
  await dialog.waitFor({ state: 'visible' });
  const input = dialog.locator('input');
  await input.waitFor({ state: 'visible' });
  await f.page.waitForFunction(() => !document.querySelector('dialog.removal-modal input')?.disabled);
  const text = await dialog.innerText();
  assert.match(text, /his household on Phoenix/);
  assert.match(text, /Your account and other people’s accounts stay/);
  assert.match(text, /If this Jibo is still connected to Phoenix, he is signed out and needs to be set up again\./);
  assert.match(text, /backup/i);
  assert.doesNotMatch(text, /firmware|repoint|migrat|other server/i);
  const remove = dialog.getByRole('button', { name: 'Remove this Jibo', exact: true });
  assert.equal(await remove.isDisabled(), true);
  await input.fill('wrong name');
  assert.equal(await remove.isDisabled(), true);
  await input.fill(f.loop.name);
  assert.equal(await remove.isEnabled(), true);
  await remove.click();
  await dialog.getByText(`${f.loop.name} was removed from Phoenix.`, { exact: true }).waitFor();
  assert.doesNotMatch(await dialog.innerText(), /\bnull\b/, 'success state contains no null DOM child');
  assert.equal(f.store.accountByFriendlyId(f.robot.friendlyId), null);
  assert.ok(f.store.accountByEmail('owner@fixture.test'));
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await f.page.getByRole('heading', { name: 'Add your first Jibo', exact: true }).waitFor();
  assert.equal(await f.page.locator('#auth-root').isVisible(), false, 'owner remains signed in');
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.external, []);
});


test('account deletion explains earlier removal backups separately', async (t) => {
  const f = await fixture(t, 'owner');
  await f.page.goto(`${f.base}/app#/profile`);
  await f.page.getByRole('button', { name: 'Delete account…', exact: true }).waitFor();
  await f.page.getByRole('button', { name: 'Delete account…', exact: true }).click();
  const dialog = f.page.locator('dialog');
  await dialog.locator('input[type=password]').waitFor({ state: 'visible' });
  const text = await dialog.innerText();
  assert.match(text, /Backups made for account deletion are deleted within \d+ days/);
  assert.match(text, /Earlier removal backups may also include your account/);
  assert.doesNotMatch(text, /Backup copies that include your account are deleted within/);
  assert.deepEqual(f.errors, []);
});
