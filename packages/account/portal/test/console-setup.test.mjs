import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openConsole } from './console-browser-fixture.mjs';

async function open(t, options) {
  const env = await openConsole(options);
  t.after(async () => { await env.close(); assert.deepEqual(env.errors, []); });
  return env;
}

test('setup-screen cue uses this server name and never skips the credential check', async (t) => {
  const { page, navigate } = await open(t);
  // The configured public site may differ from the browser's loopback host.
  await page.route('**/app?**', async (route) => {
    const response = await route.fetch();
    const html = (await response.text()).replace(/(<link rel="canonical" href=")[^"]+/, '$1https://robots.example.test/app');
    await route.fulfill({ response, body: html });
  });
  await navigate('#/add');
  const text = await page.locator('#app').innerText();
  assert.ok(text.includes('Go to robots.example.test to get started'), 'matches the setup screen’s configured server suffix');
  assert.ok(text.includes('Go to the Jibo app on your phone to get started'));
  assert.match(text, /choose Yes/);
  assert.match(text, /choose No/);
  assert.ok(!text.includes('Go to jibo.io'));
  await page.getByRole('button', { name: 'Yes', exact: true }).click();
  assert.equal(await page.getByRole('link', { name: 'Check and prepare this Jibo' }).getAttribute('href'), '#/claim');
  assert.match(await page.locator('#app').innerText(), /A setup screen doesn’t prove the credentials are gone/);
  await page.route('**/api/robots', (route) => route.fulfill({ contentType: 'application/json', body: '[]' }));
  await navigate('#/robot');
  const empty = await page.locator('#app').innerText();
  assert.ok(empty.includes('First check whether Jibo has been pointed at this server'));
  assert.ok(empty.includes('Go to robots.example.test to get started'));
  assert.ok(empty.includes('Go to the Jibo app on your phone to get started'));
});

for (const viewport of [{ width: 390, height: 844 }, { width: 360, height: 740 }, { width: 1440, height: 900 }]) {
  for (const kind of ['setup', 'wifi']) {
    test(`${viewport.width}x${viewport.height} ${kind}: QR frames are square, full-size and tap advances`, async (t) => {
      const { page, navigate } = await open(t, { viewport });
      const codes = ['1/3\nHome network', '2/3\nA sample password', '3/3\nA sample setup code'];
      await page.route(`**/api/robots/${kind === 'setup' ? 'setup' : 'wifi'}`, (route) => route.fulfill({
        contentType: 'application/json', body: JSON.stringify({ token: 'sample-setup-token', qr: { codes } }),
      }));
      await page.route('**/api/robots/setup/status?*', (route) => route.fulfill({
        contentType: 'application/json', body: JSON.stringify({ complete: false, expired: false }),
      }));
      await navigate(kind === 'setup' ? '#/add/new' : '#/robot/loop-0/wifi');
      await page.locator('input[name="ssid"]').fill('Home network');
      await page.locator('input[name="password"]').fill('A sample password');
      await page.getByRole('button', { name: kind === 'setup' ? 'Show setup code' : 'Show Wi-Fi code', exact: true }).click();
      const first = page.locator('.qr-codes svg').first();
      await first.waitFor();
      await first.evaluate((node) => node.scrollIntoView({ block: 'center' }));
      const geometry = await page.locator('.qr-codes').evaluate((holder) => ({
        overflow: document.documentElement.scrollWidth > innerWidth,
        frames: [...holder.querySelectorAll('svg')].filter((node) => node.getBoundingClientRect().width > 0).map((node) => {
          const r = node.getBoundingClientRect();
          return { width: r.width, height: r.height, left: r.left, right: r.right, top: r.top, bottom: r.bottom,
            visible: [...[.05, .5, .95]].every((part) => holder.contains(document.elementFromPoint(r.left + r.width * part, r.top + r.height * part))),
            white: node.querySelector('rect')?.getAttribute('fill') === '#fff' };
        }),
      }));
      assert.equal(geometry.overflow, false, 'no horizontal page overflow');
      assert.equal(await page.locator('.qr-codes svg').count(), 1, 'only one code exists on every screen');
      assert.equal(geometry.frames.length, 1, 'one visible code on every screen');
      assert.equal(await page.getByText('Code 1 of 3', { exact: true }).count(), 1);
      for (const frame of geometry.frames) {
        assert.ok(Math.abs(frame.width - frame.height) < 1, JSON.stringify(frame));
        assert.ok(frame.width >= (viewport.width < 600 ? viewport.width - 32 : 300), JSON.stringify(frame));
        assert.ok(frame.left >= 0 && frame.right <= viewport.width && frame.top >= 0 && frame.bottom <= viewport.height, JSON.stringify(frame));
        assert.ok(frame.visible, 'QR code is not covered by fixed navigation');
        assert.ok(frame.white, 'the SVG retains its white quiet zone in dark mode');
      }
      const original = await first.innerHTML();
      await first.click();
      assert.notEqual(await first.innerHTML(), original, 'tap advances the visible frame');
      assert.equal(await page.getByText('Code 2 of 3', { exact: true }).count(), 1);
      await first.click();
      await first.click();
      assert.equal(await first.innerHTML(), original, 'every frame remains reachable and wraps');
      if (process.env.CONSOLE_SETUP_EVIDENCE) {
        const out = process.env.CONSOLE_SETUP_EVIDENCE;
        await mkdir(out, { recursive: true });
        const name = `${viewport.width}-${kind}`;
        await page.screenshot({ path: `${out}/${name}.png` });
        await writeFile(`${out}/${name}.json`, JSON.stringify({ viewport, kind, geometry }, null, 2));
      }
    });
  }
}
