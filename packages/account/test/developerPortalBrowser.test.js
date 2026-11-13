import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startDeveloperPreview } from './fixtures/developer-portal-preview.mjs';
import { developerPages } from '../src/developerPortal.js';

let browser, preview;
before(async () => {
  preview = await startDeveloperPreview();
  browser = await chromium.launch({ ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}), headless: true });
});
after(async () => { await browser?.close(); await preview?.close(); });
async function open(t, viewport, { javaScriptEnabled = true, colorScheme = 'dark' } = {}) {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce', javaScriptEnabled, colorScheme });
  const errors = [], refused = [];
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin !== preview.url) { refused.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  t.after(async () => { await context.close(); assert.deepEqual(errors, []); assert.deepEqual(refused, []); });
  return page;
}
const viewports = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } };
for (const [name, viewport] of Object.entries(viewports)) {
  test(`${name}: every documentation page renders real content under strict CSP and fits`, async t => {
    const page = await open(t, viewport);
    for (const doc of developerPages()) {
      const response = await page.goto(preview.url + doc.path);
      assert.equal(response.status(), 200);
      assert.match(response.headers()['content-security-policy'], /script-src 'self'/);
      assert.equal(await page.locator('main h1').count(), 1);
      assert.ok((await page.locator('main').innerText()).length > 300, doc.path);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, doc.path + ' fits');
      if (name === 'phone') {
        const targets = await page.locator('.dev-header a, .dev-header button').evaluateAll(nodes => nodes.map(n => { const r = n.getBoundingClientRect(); return { width: r.width, height: r.height }; }).filter(r => r.width > 0));
        assert.ok(targets.every(r => r.width >= 44 && r.height >= 44), 'phone header controls meet the 44px touch target');
      }
      assert.equal(await page.locator('.dev-search').isVisible(), true);
      assert.equal(await page.locator('main img').evaluateAll(images => images.every(i => i.complete && i.naturalWidth > 0)), true, 'local template artwork loads under CSP');
      if (doc.path === '/developers/templates') assert.equal(await page.locator('.dev-template-card img').count(), 2);
      const active = page.locator('.dev-sidebar nav a[aria-current="page"]');
      assert.equal(await active.getAttribute('href'), doc.path);
      if (name === 'desktop') assert.ok(await active.evaluate(n => n.getBoundingClientRect().width > 0));
      assert.equal(await page.evaluate(() => { const ids = [...document.querySelectorAll('[id]')].map(n => n.id); return ids.length === new Set(ids).size; }), true);
      const last = page.locator('.dev-pagination a').last(); await last.scrollIntoViewIfNeeded();
      assert.equal(await last.evaluate(n => { const r = n.getBoundingClientRect(); return n.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }), true, 'last navigation link is reachable');
    }
  });
  test(`${name}: search works by keyboard, has a real empty state and no markup injection`, async t => {
    const page = await open(t, viewport); await page.goto(preview.url + '/developers');
    const input = page.getByRole('searchbox', { name: 'Search documentation' });
    await input.fill('immutable');
    await page.waitForFunction(() => document.querySelector('#dev-search-results li'));
    assert.match(await page.locator('#dev-search-results').innerText(), /Publishing|Theme reference/);
    await input.press('ArrowDown'); assert.equal(await page.evaluate(() => document.activeElement.closest('#dev-search-results') !== null), true);
    await page.keyboard.press('Escape'); assert.equal(await page.locator('#dev-search-results').isVisible(), false);
    await input.fill('zzzxxyyq'); await page.getByText(/No matching pages/).waitFor();
    await input.fill('<img src=x onerror=alert(1)>'); await page.getByText(/No matching pages/).waitFor();
    assert.equal(await page.locator('#dev-search-results img').count(), 0);
    await input.fill(''); assert.equal(await page.locator('#dev-search-results').isVisible(), false);
  });
}

test('phone: documentation disclosure opens, navigates and respects desktop resizing', async t => {
  const page = await open(t, viewports.phone); await page.goto(preview.url + '/developers');
  const menu = page.locator('.dev-menu'); assert.equal(await menu.getAttribute('open'), null);
  await menu.locator('summary').click(); assert.equal(await menu.locator('a[href="/developers/templates"]').isVisible(), true);
  await menu.locator('a[href="/developers/templates"]').click(); await page.locator('main h1').filter({ hasText: 'A working place to start' }).waitFor();
  assert.equal(await menu.getAttribute('open'), null);
  await page.setViewportSize(viewports.desktop); await page.waitForFunction(() => document.querySelector('.dev-menu').open);
  assert.ok(await menu.locator('a[aria-current]').evaluate(n => n.getBoundingClientRect().width > 0));
});

test('phone: article contents links land below the fixed header', async t => {
  const page = await open(t, viewports.phone); await page.goto(preview.url + '/developers/themes');
  const contents = page.locator('.dev-mobile-toc'); await contents.locator('summary').click();
  await contents.getByRole('link', { name: 'Check and pack' }).click();
  await page.waitForFunction(() => location.hash === '#check-and-pack');
  const r = await page.locator('#check-and-pack').boundingBox();
  assert.ok(r.y >= 64 && r.y < 844, 'the linked heading is visible below the header');
});

for (const [name, viewport] of Object.entries(viewports)) {
  test(`${name}: enabled Store exposes exactly one visible developer entry in the correct site navigation`, async t => {
    const page = await open(t, viewport); await page.goto(preview.url + '/');
    const nav = page.locator(name === 'desktop' ? '.site-nav' : '#mobile-nav');
    if (name === 'phone') await page.getByRole('button', { name: 'Menu', exact: true }).click();
    const link = nav.locator('a[href="/developers"]'); await link.waitFor();
    assert.equal(await link.count(), 1); assert.equal(await link.isVisible(), true);
    assert.ok(await link.evaluate(n => n.getBoundingClientRect().width > 0));
    await link.click(); await page.locator('.dev-hero').waitFor();
  });
}

test('documentation is server rendered with working links when JavaScript is disabled', async t => {
  const page = await open(t, viewports.phone, { javaScriptEnabled: false });
  await page.goto(preview.url + '/developers/themes');
  assert.equal(await page.locator('main h1').innerText(), 'Make your first theme');
  assert.equal(await page.locator('.dev-search').isVisible(), false);
  await page.getByRole('link', { name: 'Read the theme reference', exact: true }).click();
  assert.ok(await page.locator('main table').count() > 0);
});

test('theme toggle switches the visible page and persists the chosen theme', async t => {
  const page = await open(t, viewports.desktop); await page.goto(preview.url + '/developers');
  const before = await page.locator('body').evaluate(n => getComputedStyle(n).backgroundColor);
  await page.getByRole('button', { name: 'Switch color theme' }).click();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  assert.notEqual(await page.locator('body').evaluate(n => getComputedStyle(n).backgroundColor), before);
  await page.reload(); assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
});

// Publisher application/upload behavior belongs to the separate Store layer.
// Here the stable boundary itself must remain an exact no-store redirect.
test('publisher dashboard entry preserves its hosted console destination', async () => {
  const response = await fetch(preview.url + '/developers/console', { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/apps#publisher');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-robots-tag'), 'noindex');
});
