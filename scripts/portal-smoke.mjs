// Browser smoke test for the OOBE portal (G.4). Boots the account service, drives a real
// headless Chrome through: signup -> dashboard -> add-robot -> WiFi form -> QR render, then
// redeems the setup token via the robot AWS-JSON face and asserts the portal polls to complete
// and lists the new robot; finally exercises the admin adopt flow.
//
// Puppeteer + Chrome come from the sibling jibo-web-sim checkout (Phoenix ships no browser dep).
// Run:  node scripts/portal-smoke.mjs       (HEADFUL=1 to watch)

import { existsSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const SIM = process.env.SIM_DIR || '/home/shell/jibo-web-sim';
const require = createRequire(join(SIM, 'package.json'));
const puppeteer = require('puppeteer');

const dir = mkdtempSync(join(tmpdir(), 'phx-portal-smoke-'));
process.env.ETCO_account_dataFile = join(dir, 'store.json');
process.env.ADMIN_PASSWORD = 'smoke-admin';
const { createAccountService } = await import('../packages/account/src/index.js');

let failures = 0;
const check = (name, cond, detail) => { if (cond) console.log('PASS', name); else { failures++; console.log('FAIL', name, detail != null ? `:: ${JSON.stringify(detail).slice(0, 200)}` : ''); } };

function findChrome() {
  const root = `${process.env.HOME}/.cache/puppeteer/chrome`;
  for (const v of (existsSync(root) ? readdirSync(root) : [])) {
    const p = `${root}/${v}/chrome-linux64/chrome`;
    if (existsSync(p)) return p;
  }
  return undefined;
}

const server = await createAccountService().listen(0);
const base = `http://localhost:${server.address().port}`;

const browser = await puppeteer.launch({
  headless: !process.env.HEADFUL,
  executablePath: findChrome(),
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 800 }); // mobile-first
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

  await page.goto(base, { waitUntil: 'networkidle0' });

  // sign up
  await page.waitForSelector('[data-tab="signup"]');
  await page.click('[data-tab="signup"]');
  await page.type('#auth-form input[name="email"]', 'george@jetson.test');
  await page.type('#auth-form input[name="firstName"]', 'George');
  await page.type('#auth-form input[name="password"]', 'spacely-sprockets');
  await page.click('#auth-submit');

  await page.waitForSelector('#add-robot', { timeout: 8000 });
  check('signup -> dashboard reached', true);
  const navText = await page.$eval('#who', (e) => e.textContent).catch(() => '');
  check('nav greets the user', navText === 'George', navText);

  // add a robot
  await page.click('#add-robot');
  await page.waitForSelector('#wifi-form');
  await page.type('#wifi-form input[name="ssid"]', 'JetsonNet');
  await page.type('#wifi-form input[name="password"]', 'orbit-city');
  await page.click('#wifi-form button[type="submit"]');

  await page.waitForSelector('#qr-codes svg', { timeout: 8000 });
  const qrCount = await page.$$eval('#qr-codes svg', (els) => els.length);
  check('QR rendered as SVG in the browser', qrCount >= 1, qrCount);

  // grab the minted token from the live store and redeem it as the robot would
  const { getStore } = await import('../packages/account/src/index.js');
  const store = getStore();
  const token = [...store.tokens.values()].pop();
  check('setup token minted', !!token, token && token._id);
  const redeem = await fetch(`${base}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'OOBE.SetupRobot' },
    body: JSON.stringify({ token: token._id, id: 'castle-cylinder-fig-quilt' }),
  });
  check('robot AWS-JSON setupRobot 200', redeem.status === 200);

  // portal polls (every 2s) -> completes -> returns to dashboard with the robot
  await page.waitForFunction(() => /robots/i.test(document.querySelector('h2')?.textContent || '') && document.querySelector('.robots li'), { timeout: 12000 }).catch(() => {});
  const robotNames = await page.$$eval('.robots li .name', (els) => els.map((e) => e.textContent)).catch(() => []);
  check('portal listed the adopted robot after polling', robotNames.includes('castle-cylinder-fig-quilt'), robotNames);

  // personal report settings editor
  await page.goto(`${base}/#/settings`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#settings-form input[name="news"]', { timeout: 8000 });
  await page.click('#settings-form input[name="news"]'); // toggle news off (was on by default)
  await page.click('#settings-form button[type="submit"]');
  await page.waitForFunction(() => /saved/i.test(document.querySelector('#settings-status')?.textContent || ''), { timeout: 8000 }).catch(() => {});
  const settingsSaved = await page.$eval('#settings-status', (e) => /saved/i.test(e.textContent)).catch(() => false);
  check('settings editor saves', settingsSaved);

  // admin adopt
  await page.goto(`${base}/#/admin`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#admin-login input[name="password"]');
  await page.type('#admin-login input[name="password"]', 'smoke-admin');
  await page.click('#admin-login button[type="submit"]');
  await page.waitForSelector('#admin-panel:not([hidden])', { timeout: 8000 });
  await page.type('#adopt-form input[name="friendlyId"]', 'rosie-robot-maid-xj9');
  await page.click('#adopt-form button[type="submit"]');
  await page.waitForSelector('#adopt-result:not([hidden])', { timeout: 8000 });
  const adoptText = await page.$eval('#adopt-result', (e) => e.textContent);
  check('admin adopt shows credentials.json + repoint command', /accessKeyId/.test(adoptText) && /credentials\.json/.test(adoptText), adoptText.slice(0, 80));

  if (failures) { console.log('--- logs ---'); logs.slice(-20).forEach((l) => console.log('  ', l.slice(0, 160))); }
} finally {
  await browser.close();
  server.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `PORTAL SMOKE: ${failures} FAILURE(S)` : 'PORTAL SMOKE: ALL PASS');
process.exit(failures ? 1 : 0);
