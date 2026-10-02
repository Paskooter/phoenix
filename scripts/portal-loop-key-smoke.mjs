// Real Chromium acceptance test, using the Playwright development dependency.
// CHROME_BIN overrides Playwright's Chromium.
// Everything below is isolated fixture state, never a real robot/account.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { randomBytes, createCipheriv, publicEncrypt, constants } from 'node:crypto';
import { Readable } from 'node:stream';
import { classicCall } from '../packages/account/src/portal/classicClient.js';
import { CONTENT_IV_POSITIONS, decryptBackup } from '../packages/account/portal/loop-crypto.js';

process.env.PHOENIX_ENV_FILE = '/dev/null';
process.env.ETCO_account_secureCookies = 'false';
const { createAccountService, Store } = await import('../packages/account/src/index.js');
const { createOwnerAccount, createLoop } = await import('../packages/account/src/model.js');
const { createSession } = await import('../packages/account/src/sessions.js');
const { createClassicEntrypoint, createVerifiedClassicCaller, KeyStore, MediaStore } = await import('../packages/classic/src/index.js');

const dir = mkdtempSync(join(tmpdir(), 'phx-loop-key-browser-'));
process.env.PHOENIX_DATA_DIR = dir;
for (const name of ['notificationFile', 'keyFile', 'personFile', 'jotFile', 'voiceTrainingFile', 'iftttFile', 'pushFile']) {
  process.env[`ETCO_classic_${name}`] = join(dir, name);
}
for (const name of ['backupDir', 'logDir', 'robotDir']) process.env[`ETCO_classic_${name}`] = join(dir, name);
const { DefaultPort } = await import('../packages/contracts/src/index.js');
for (const service of Object.keys(DefaultPort)) process.env[`NET_${service}`] = 'http://127.0.0.1:9';
const store = new Store(join(dir, 'account.json'));
const owner = createOwnerAccount(store, { email: 'browser-owner@fixture.test', password: 'browser-password-1' });
const pairs = [createLoop(store, { owner, robotId: 'privacy-fixture-one', name: 'First Jibo' }),
  createLoop(store, { owner, robotId: 'privacy-fixture-two', name: 'Second Jibo' })];
const keyStore = new KeyStore(join(dir, 'keys.json'));
const mediaStore = new MediaStore({ file: join(dir, 'media.json'), directory: join(dir, 'media') });
const keys = new Map(pairs.map(({ loop }) => [loop._id, randomBytes(32)]));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6R8AAAAASUVORK5CYII=', 'base64');
for (const [i, { loop, robot }] of pairs.entries()) {
  const key = keys.get(loop._id);
  const cipher = createCipheriv('aes-256-cbc', key, Buffer.from(CONTENT_IV_POSITIONS.map((p) => key[p])));
  const body = Buffer.concat([cipher.update(png), cipher.final()]);
  await mediaStore.putObject({ path: `photo-${i}`, type: 'image', accountId: robot._id,
    loopId: loop._id, url: `http://classic.fixture/media/blob/photo-${i}`,
    created: Date.now() - i * 1000, isEncrypted: true, isDeleted: false, thumbs: [] }, Readable.from([body]));
}
const membership = { memberIds: async (id) => store.loops.get(id)?.members.map((m) => m.accountId),
  loop: async (id) => { const row = store.loops.get(id); return row ? { owner: row.owner, robot: row.robot } : null; } };
const mediaLoops = { members: membership.memberIds, accountLoops: async (id) => pairs
  .filter(({ loop }) => loop.members.some((m) => m.accountId === id)).map(({ loop }) => loop._id),
  ownedLoops: async (id) => pairs.filter(({ loop }) => loop.owner === id).map(({ loop }) => loop._id) };
let classic; let account; let browser; let context; let timer; let robotOnline = true; const sharing = new Set();
const priorClassic = process.env.NET_classic;
try {
  classic = await createClassicEntrypoint({ publicUrl: 'http://classic.fixture', keyStore,
    keyMembership: membership, media: { store: mediaStore, loops: mediaLoops },
    callerBoundary: createVerifiedClassicCaller({ resolveCredentials: (id) => store.accountByAccessKeyId(id) }),
  }).listen(0, '127.0.0.1');
  const classicBase = `http://127.0.0.1:${classic.address().port}`;
  process.env.NET_classic = classicBase;
  account = await createAccountService({ store }).listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${account.address().port}`;
  timer = setInterval(() => {
    if (!robotOnline) return;
    for (const request of keyStore.keys.values()) {
      if (request.encryptedKey || sharing.has(request.id)) continue;
      sharing.add(request.id);
      const robot = pairs.find(({ loop }) => loop._id === request.loopId).robot;
      const encryptedKey = publicEncrypt({ key: Buffer.from(request.publicKey, 'base64'), format: 'der', type: 'spki',
        padding: constants.RSA_PKCS1_PADDING }, keys.get(request.loopId)).toString('base64');
      void classicCall({ base: classicBase, account: robot, target: 'Key_20160201.Share',
        body: { id: request.id, encryptedKey } }).catch(() => {}).finally(() => sharing.delete(request.id));
    }
  }, 100);
  browser = await chromium.launch({ headless: true,
    ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server'] });
  context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.route('**/*', (route) => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const page = await context.newPage();
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  const session = createSession(store, { kind: 'user', accountId: owner._id });
  await context.addCookies([{ name: 'phx_session', value: session._id, url: base }]);
  await page.goto(`${base}/app#/gallery`);
  await page.waitForSelector('.media-grid');
  await page.$eval('.media-grid', (el) => el.scrollIntoView({ block: 'center' }));
  await page.waitForFunction(() => document.querySelectorAll('.media-tile img').length === 2
    && [...document.querySelectorAll('.media-tile img')].every((i) => i.naturalWidth > 0), undefined, { timeout: 20000 });
  assert.equal(keyStore.keys.size, 2);
  assert.ok(await page.evaluate(() => [...document.querySelectorAll('.media-tile img')].every((i) => i.src.startsWith('blob:'))));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no mobile horizontal overflow');
  await page.click('.media-open');
  await page.waitForFunction(() => document.querySelector('.overlay-img')?.naturalWidth > 0);
  assert.ok(await page.evaluate(() => document.querySelector('.overlay a[download]').href.startsWith('blob:')));
  await page.evaluate(() => [...document.querySelectorAll('.overlay button')].find((b) => b.textContent === 'Close').click());
  await page.locator('.secure-loop-panels details > summary').first().click();
  await page.type('.secure-loop-panels .secure-passphrase-form input[name=next]', 'fixture recovery passphrase');
  await page.type('.secure-loop-panels .secure-passphrase-form input[name=confirm]', 'fixture recovery passphrase');
  await page.click('.secure-loop-panels .secure-passphrase-form button[type=submit]');
  await page.waitForFunction(() => document.querySelector('.secure-loop-panels').textContent.includes('Recovery protected'));
  assert.equal(keyStore.backups.size, 1);
  const backup = keyStore.restore(pairs[0].loop._id);
  assert.deepEqual(Buffer.from(await decryptBackup(crypto, backup.encryptedKey, 'fixture recovery passphrase')), keys.get(pairs[0].loop._id));
  await page.click('.secure-loop-panels .secure-remember input');
  await page.waitForFunction(async () => {
    const db = await new Promise((resolve) => { const r = indexedDB.open('phoenix-private-keys'); r.onsuccess = () => resolve(r.result); });
    return await new Promise((resolve) => { const r = db.transaction('keys').objectStore('keys').count(); r.onsuccess = () => { resolve(r.result === 1); db.close(); }; });
  });
  const otherTab = await context.newPage();
  await otherTab.goto(`${base}/app#/gallery`);
  await otherTab.waitForSelector('.media-grid');
  await otherTab.$eval('.media-grid', (el) => el.scrollIntoView({ block: 'center' }));
  await otherTab.waitForFunction(() => document.querySelectorAll('.media-tile img').length === 2
    && [...document.querySelectorAll('.media-tile img')].every((i) => i.naturalWidth > 0));
  await page.bringToFront();
  await page.screenshot({ path: '/tmp/phoenix-gallery-key-flow.png', fullPage: true });
  await page.reload();
  await page.waitForSelector('.media-grid');
  await page.$eval('.media-grid', (el) => el.scrollIntoView({ block: 'center' }));
  await page.waitForFunction(() => document.querySelectorAll('.media-tile img').length === 2
    && [...document.querySelectorAll('.media-tile img')].every((i) => i.naturalWidth > 0));
  assert.equal([...keyStore.keys.values()].filter((r) => r.loopId === pairs[0].loop._id).length, 1, 'remembered key avoids a new exchange');
  robotOnline = false;
  await page.evaluate(() => document.getElementById('logout').click());
  await page.waitForFunction(() => !document.getElementById('auth-root').hidden);
  await otherTab.waitForFunction(() => !document.getElementById('auth-root').hidden, undefined, { polling: 100 });
  assert.equal(await otherTab.evaluate(() => document.querySelectorAll('img[src^="blob:"]').length), 0, 'cross-tab sign-out clears decrypted photos');
  assert.equal(await page.evaluate(() => document.querySelectorAll('img[src^="blob:"]').length), 0);
  const rememberedCount = await page.evaluate(async () => {
    const db = await new Promise((resolve) => { const r = indexedDB.open('phoenix-private-keys'); r.onsuccess = () => resolve(r.result); });
    return await new Promise((resolve) => { const r = db.transaction('keys').objectStore('keys').count(); r.onsuccess = () => { resolve(r.result); db.close(); }; });
  });
  assert.equal(rememberedCount, 0, 'logout clears remembered keys');
  await page.evaluate(async () => fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'browser-owner@fixture.test', password: 'browser-password-1' }) }));
  await page.goto(`${base}/app#/gallery`);
  await page.waitForSelector('.secure-loop-panels .secure-recovery form input:not([name])', { state: 'attached' });
  // Unlock while an offline robot exchange is still pending: its eventual
  // timeout must not replace the recovered key or close the rendered gallery.
  await page.locator('.secure-loop-panels details > summary').first().click();
  await page.type('.secure-loop-panels .secure-recovery form input:not([name])', 'fixture recovery passphrase');
  await page.click('.secure-loop-panels .secure-recovery form button[type=submit]');
  await page.waitForFunction(() => document.querySelector('.media-tile img')?.naturalWidth > 0);
  assert.equal(await page.evaluate(() => document.querySelectorAll('.media-tile img').length), 1, 'other loop stays locked');
  await page.evaluate(() => [...document.querySelectorAll('.secure-loop-panels button')]
    .find((b) => b.textContent.includes('Forget this device')).click());
  await page.waitForFunction(() => document.querySelectorAll('.media-tile img').length === 0);
  assert.deepEqual(errors, []);
  console.log('PASS: Chromium mobile gallery, local decryption, full-size/download, first recovery backup, opt-in remember, reload, cross-tab logout, offline recovery and forget');
} catch (error) {
  const pages = context?.pages() || [];
  const page = pages[pages.length - 1];
  if (page) {
    console.log('Browser diagnostic:', await page.evaluate(() => ({ text: document.body.innerText.slice(-1600),
      previews: [...document.querySelectorAll('.secure-media')].map((x) => ({ text: x.textContent, error: x.title })),
      images: [...document.querySelectorAll('.media-tile img')].map((x) => ({ loaded: x.complete, width: x.naturalWidth })) })));
    await page.screenshot({ path: '/tmp/phoenix-gallery-key-flow-failed.png', fullPage: true });
  }
  throw error;
} finally {
  clearInterval(timer);
  await browser?.close();
  account?.closeAllConnections();
  classic?.closeAllConnections();
  if (account?.listening) await new Promise((r) => account.close(r));
  if (classic?.listening) await new Promise((r) => classic.close(r));
  if (priorClassic === undefined) delete process.env.NET_classic; else process.env.NET_classic = priorClassic;
  rmSync(dir, { recursive: true, force: true });
}
