import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { startCalendarConsole } from './fixtures/calendar-console-fixture.mjs';

let browser, skip = 'Playwright is not installed';
before(async () => {
  let playwright;
  try { playwright = await import('playwright'); } catch { return; }
  for (const executablePath of [process.env.CHROME_BIN, undefined]) {
    if (executablePath === '' || (executablePath && !existsSync(executablePath))) continue;
    try { browser = await playwright.chromium.launch({ ...(executablePath ? { executablePath } : {}), args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server'] }); break; }
    catch (error) { skip = error.message.split('\n')[0]; }
  }
});
after(async () => browser?.close());
const codes = ['1/3\nexample-one', '2/3\nexample-two', '3/3\nexample-three'];
async function open(t, mode, width, output = codes) {
  if (!browser) { t.skip(skip); return null; }
  const running = await startCalendarConsole({ scenario: 'empty' });
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  await context.addCookies([running.cookie]);
  let calls = 0;
  const errors = [];
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== running.url) return route.abort();
    if (url.pathname === '/app.js') {
      const app = readFileSync(new URL('../portal/app.js', import.meta.url), 'utf8');
      return route.fulfill({ contentType: 'text/javascript', body: app + '\nwindow.mountWifiFixture = () => { stopPoll(); document.getElementById("app").replaceChildren(robotWifiPanel({loopId:"fixture-loop",name:"Example"})); };' });
    }
    if (route.request().method() === 'POST' && ['/api/robots/setup', '/api/robots/wifi'].includes(url.pathname)) {
      calls++;
      return route.fulfill({ json: { token: 'Fixture', qr: { codes: output } } });
    }
    if (url.pathname === '/api/robots/setup/status') return route.fulfill({ json: { complete: false } });
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (e) => errors.push(e.message));
  t.after(async () => { await context.close(); await running.close(); assert.deepEqual(errors, []); });
  await page.goto(running.url + '/app#/add/new');
  await page.locator('input[name=ssid]').waitFor();
  if (mode === 'wifi') await page.evaluate(() => window.mountWifiFixture());
  return { page, calls: () => calls };
}
async function submit(page, values) {
  await page.locator('input[name=ssid]').fill('Example-Net');
  await page.locator('input[name=password]').fill('example-password');
  await page.locator('form').evaluate((form, fields) => {
    form.addEventListener('formdata', (event) => {
      for (const [key, value] of Object.entries(fields)) event.formData.set(key, value);
    }, { once: true });
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  }, values);
}
for (const mode of ['setup', 'wifi']) {
  for (const width of [390, 1440]) test(`${mode} at ${width}px shows one code, progress and tap advances every code`, async (t) => {
    const f = await open(t, mode, width); if (!f) return;
    await submit(f.page, {});
    await f.page.locator('.qr-codes svg').first().waitFor();
    assert.equal(await f.page.locator('.qr-frame').count(), 1);
    assert.equal(await f.page.locator('.qr-frame svg').count(), 1);
    const first = await f.page.locator('.qr-frame').innerHTML();
    for (let n = 1; n <= 3; n++) {
      assert.equal(await f.page.getByText(`Code ${n} of 3`, { exact: true }).count(), 1);
      assert.equal(await f.page.getByText('Show Jibo each code. Tap the code to show the next one.', { exact: true }).count(), 1);
      if (n > 1) assert.notEqual(await f.page.locator('.qr-frame').innerHTML(), first);
      await f.page.locator('.qr-codes').click();
      assert.equal(await f.page.locator('.qr-frame').count(), 1);
    }
    assert.equal(await f.page.locator('.qr-frame').innerHTML(), first);
    assert.equal(await f.page.getByText('Code 1 of 3', { exact: true }).count(), 1);
    assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  });
  test(`${mode}: single code has no progress or advance hint`, async (t) => {
    const f = await open(t, mode, 1440, [codes[0]]); if (!f) return;
    await submit(f.page, {});
    await f.page.locator('.qr-codes svg').waitFor();
    assert.equal(await f.page.locator('.qr-frame').count(), 1);
    assert.equal(await f.page.getByText(/Code \d of/).count(), 0);
    assert.equal(await f.page.getByText(/Tap the code/).count(), 0);
  });
  test(`${mode}: blank network name shows the same actionable message on button submit`, async (t) => {
    const f = await open(t, mode, 390); if (!f) return;
    await f.page.getByRole('button', { name: mode === 'setup' ? 'Show setup code' : 'Show Wi-Fi code', exact: true }).click();
    await f.page.getByText('Enter your Wi-Fi network name.', { exact: true }).waitFor({ timeout: 3000 });
    assert.equal(f.calls(), 0);
  });
  test(`${mode}: validates literal Wi-Fi values before a request and shows server errors`, async (t) => {
    const f = await open(t, mode, 390); if (!f) return;
    const cases = [
      [{ ssid: '' }, 'Enter your Wi-Fi network name.'],
      [{ ssid: 'é'.repeat(16) + 'a' }, 'That Wi-Fi name is too long for Jibo. Wi-Fi names are at most 32 characters, fewer with accents or emoji.'],
      [{ password: 'p'.repeat(7) }, 'Wi-Fi passwords are 8 to 63 characters. Leave it blank only for an open network.'],
      [{ password: 'p'.repeat(64) }, 'Wi-Fi passwords are 8 to 63 characters. Leave it blank only for an open network.'],
      [{ ssid: 'Example\nNet' }, "Wi-Fi names and passwords can't contain line breaks."],
      [{ password: 'example\npassword' }, "Wi-Fi names and passwords can't contain line breaks."],
      ...(mode === 'setup' ? [[{ dns1: '192.0.2.53' }, 'Check the static network settings: IP address, subnet mask and gateway must be valid addresses.']] : []),
    ];
    // FormData converts malformed UTF-16 to scalar strings. Check the shared
    // validator before that browser conversion as well as the actual form path.
    assert.equal(await f.page.evaluate(async () => {
      const { wifiDetailsError } = await import('/wifi-details.js');
      return wifiDetailsError({ ssid: 'Example\ud800', password: 'example-password' });
    }), "That Wi-Fi name or password has a character Jibo can't use. Retype it and try again.");
    for (const [values, message] of cases) {
      await submit(f.page, values);
      await f.page.getByText(message, { exact: true }).first().waitFor();
      assert.equal(f.calls(), 0, 'invalid details never leave the browser');
    }
    await f.page.route('**/api/robots/' + mode, (route) => route.fulfill({ status: 400, json: { error: 'Example server refusal' } }));
    await submit(f.page, {});
    await f.page.getByText('Example server refusal', { exact: true }).waitFor();
  });
}
