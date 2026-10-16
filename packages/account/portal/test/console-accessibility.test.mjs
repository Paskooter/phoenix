import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { openConsole, VIEWPORTS, CONSOLE_PAGES } from './console-browser-fixture.mjs';

async function open(t, options) {
  const env = await openConsole(options);
  t.after(async () => { await env.close(); assert.deepEqual(env.errors, [], 'no uncaught page errors'); });
  return env;
}
async function shot(page, name) {
  if (!process.env.CONSOLE_A11Y_EVIDENCE) return;
  await mkdir(process.env.CONSOLE_A11Y_EVIDENCE, { recursive: true });
  await page.screenshot({ path: `${process.env.CONSOLE_A11Y_EVIDENCE}/${name}.png` });
}
const focused = (page) => page.evaluate(() => document.activeElement?.id || document.activeElement?.className);

// Blend translucent surfaces and foreground opacity before applying WCAG's
// relative-luminance ratio. These selectors do not paint text on gradients.
function textContrasts(nodes, { includeInert = false } = {}) {
  const parse = (value) => {
    const numbers = value.match(/-?[\d.]+(?:e-?\d+)?/g)?.map(Number) || [];
    return { rgb: numbers.slice(0, 3).map((n) => value.startsWith('color(srgb') ? n * 255 : n), alpha: numbers[3] ?? 1 };
  };
  const blend = (top, alpha, bottom) => top.map((value, i) => value * alpha + bottom[i] * (1 - alpha));
  const luminance = (rgb) => rgb.map((n) => n / 255).map((n) => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4)
    .reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i], 0);
  return nodes.filter((node) => node.getClientRects().length && !node.closest('[hidden]') && (includeInert || !node.closest('[inert]'))).map((node) => {
    const layers = [];
    let base = [255, 255, 255];
    let opacity = 1;
    for (let current = node; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      opacity *= Number(style.opacity);
      const bg = parse(style.backgroundColor);
      if (bg.alpha >= .99) { base = bg.rgb; break; }
      if (bg.alpha > 0) layers.push(bg);
    }
    for (const layer of layers.reverse()) base = blend(layer.rgb, layer.alpha, base);
    const fg = parse(getComputedStyle(node).color);
    const [high, low] = [luminance(blend(fg.rgb, fg.alpha * opacity, base)), luminance(base)].sort((a, b) => b - a);
    return { text: node.textContent.trim().slice(0, 50), ratio: (high + .05) / (low + .05) };
  });
}

test('report settings: switched-off sections are readable but cannot take keyboard input', async (t) => {
  const { page, navigate } = await open(t);
  await navigate('#/settings');
  const commute = page.locator('input[name="commute"]');
  await commute.uncheck();
  await commute.focus();
  await page.keyboard.press('Tab');
  await shot(page, 'phone-inactive-settings');
  assert.equal(await page.evaluate(() => document.activeElement?.name), 'calendar', 'Tab skips controls whose section is switched off');
  const group = page.locator('fieldset').filter({ has: commute });
  // Inert content is intentionally absent from the accessibility tree; test its
  // visual text too, since instructions still need to be readable on screen.
  const opacity = await group.locator('.map-picker').evaluate((node) => Number(getComputedStyle(node).opacity));
  assert.equal(opacity, 1, 'off-section instructions must not be faded out');
  await commute.focus();
  await page.keyboard.press('Space');
  assert.equal(await commute.isChecked(), true);
  await commute.focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.name), 'mode', 'switching on restores its controls');
  assert.equal(await page.locator('select[name="mode"]').inputValue(), 'driving', 'the saved value is retained');
});

for (const colorScheme of ['dark', 'light']) {
  test(`${colorScheme}: navigation, selected choices and notice details have AA text contrast`, async (t) => {
    const { page, navigate } = await open(t, { viewport: VIEWPORTS.desktop, colorScheme, admin: true });
    const low = [];
    for (const [name, hash] of [['home', '#/'], ['settings', '#/settings'], ['home-assistant', '#/home-assistant'], ['system', '#/system'], ['robot-location', '#/robot/loop-0/location'], ['claim', '#/claim'], ['admin-people', '#/admin/people'], ['admin-logs', '#/admin/logs']]) {
      await navigate(hash);
      await shot(page, `${colorScheme}-contrast-${name}`);
      if (name === 'settings') low.push(...(await page.locator('.map-tab.active .map-tab-coords').evaluateAll(textContrasts, { includeInert: true })).filter((item) => item.ratio < 4.5));
      low.push(...(await page.locator('.sidebar-brand .tag, .side-label, .nav-item.active > span, .nav-item:not(.active) .badge, .chip:has(input:checked) > span:last-child, .ha-step-tag.is-time, .pill-accent, .notice-error .field-hint, .back-link, .map-tab.active .map-tab-coords, .chip-btn.is-active, .restart-cmd .prompt, .log-ns-name').evaluateAll(textContrasts)).filter((item) => item.ratio < 4.5));
    }
    await page.setViewportSize(VIEWPORTS.phone);
    await navigate('#/');
    low.push(...(await page.locator('.mobile-tab.active span').evaluateAll(textContrasts)).filter((item) => item.ratio < 4.5));
    assert.deepEqual(low, [], 'all tested normal-size text must reach 4.5:1');
  });
}

test('phone account menu: choosing Account settings closes the drawer before the new view takes focus', async (t) => {
  const { page, navigate } = await open(t);
  await navigate('#/');
  await page.locator('#mobile-menu-btn').click();
  await page.locator('#account-chip').click();
  await page.getByRole('menuitem', { name: 'Account settings' }).click();
  await page.locator('.about-form').waitFor();
  await shot(page, 'phone-account-navigation');
  assert.equal(await page.locator('#mobile-menu-btn').getAttribute('aria-expanded'), 'false', 'account navigation must dismiss the blocking drawer');
  await page.waitForFunction(() => document.activeElement === document.getElementById('app'));
});

test('desktop gallery: keyboard focus reveals the photo selection control', async (t) => {
  const { page, navigate } = await open(t, { viewport: VIEWPORTS.desktop });
  await navigate('#/gallery');
  await page.locator('.media-open').first().focus();
  await page.keyboard.press('Tab');
  await shot(page, 'desktop-gallery-selection');
  const control = page.locator('.media-tile .chip').first();
  assert.equal(await control.evaluate((node) => Number(getComputedStyle(node).opacity)), 1, 'the focused checkbox must not be invisible');
});

test('phone drawer: hidden navigation is skipped, open navigation owns focus, Escape returns it', async (t) => {
  const { page, navigate } = await open(t);
  await navigate('#/');
  await page.locator('.skip-link').focus();
  await page.keyboard.press('Tab');
  await shot(page, 'drawer-closed-focus');
  assert.equal(await focused(page), 'menu-btn', 'Tab must skip the offscreen sidebar');
  await page.locator('#mobile-menu-btn').focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#sidebar').evaluate((node) => node.contains(document.activeElement)), true, 'opening More moves focus into the drawer');
  await shot(page, 'drawer-open');
  const first = page.locator('#sidebar a, #sidebar button').filter({ visible: true }).first();
  const last = page.locator('#sidebar a, #sidebar button').filter({ visible: true }).last();
  await last.focus();
  await page.keyboard.press('Tab');
  assert.equal(await first.evaluate((node) => node === document.activeElement), true, 'Tab wraps within the open drawer');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await last.evaluate((node) => node === document.activeElement), true, 'Shift+Tab wraps within the open drawer');
  await page.keyboard.press('Escape');
  assert.equal(await focused(page), 'mobile-menu-btn');
  await page.setViewportSize(VIEWPORTS.desktop);
  await page.waitForFunction(() => document.getElementById('sidebar').inert === false);
  await page.locator('#nav a').first().focus();
  assert.equal(await page.locator('#nav a').first().evaluate((node) => node === document.activeElement), true, 'desktop navigation is not inert');
});

for (const [size, viewport] of Object.entries(VIEWPORTS)) {
  test(`${size} Add a Jibo: optional guide copy never becomes a stray placeholder`, async (t) => {
    const { page, navigate } = await open(t, { viewport });
    await navigate('#/add');
    await shot(page, `${size}-add-placeholder`);
    const stray = await page.locator('#app > div').evaluate((node) => [...node.childNodes]
      .filter((child) => child.nodeType === Node.TEXT_NODE).map((child) => child.textContent.trim()).filter(Boolean));
    assert.deepEqual(stray, [], 'omitted hosted-only guide copy must not render the text null');
  });
  test(`${size}: the last sidebar destination scrolls clear of account and help cards`, async (t) => {
    const { page, navigate } = await open(t, { viewport, admin: true });
    await navigate('#/');
    if (size === 'phone') await page.locator('#mobile-menu-btn').click();
    const link = page.locator('#nav-admin a');
    await link.scrollIntoViewIfNeeded();
    await shot(page, `${size}-sidebar-last-action`);
    const geometry = await link.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const clip = node.closest('nav').getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, clipTop: clip.top, clipBottom: clip.bottom,
        hit: node.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)) };
    });
    assert.equal(geometry.top >= geometry.clipTop - 1 && geometry.bottom <= geometry.clipBottom + 1 && geometry.hit,
      true, `sidebar scroll must expose the final destination above its footer: ${JSON.stringify(geometry)}`);
  });
  test(`${size}: every console destination fits and exposes names for its controls and images`, async (t) => {
    const { page, navigate } = await open(t, { viewport, admin: true });
    for (const [name, hash] of CONSOLE_PAGES) {
      await navigate(hash);
      if (name === 'robot-holidays') assert.equal(await page.locator('.holiday-add').isVisible(), true, 'audit the populated holiday form, not only its error state');
      if (name === 'robot-backup') assert.equal(await page.locator('.secure-passphrase-form').first().isVisible(), true, 'audit recovery controls, not only their unavailable state');
      const audit = await page.evaluate(() => {
        const visible = (node) => node.getClientRects().length && !node.closest('[hidden], [inert], [aria-hidden="true"]');
        const named = (node) => node.getAttribute('aria-label') || node.getAttribute('aria-labelledby')?.split(/\s+/).some((id) => document.getElementById(id)?.textContent.trim())
          || [...(node.labels || [])].some((label) => label.textContent.trim()) || node.title
          || (node.matches('button,a,summary') && (node.textContent.trim() || [...node.querySelectorAll('img[alt]')].some((image) => image.alt.trim())));
        return {
          fits: document.documentElement.scrollWidth <= innerWidth,
          unnamed: [...document.querySelectorAll('#app input:not([type="hidden"]), #app textarea, #app select, #app button, #app a[href]')].filter(visible).filter((node) => !named(node)).map((node) => node.outerHTML.slice(0, 200)),
          missingAlt: [...document.querySelectorAll('#app img:not([alt])')].filter(visible).length,
          renderError: document.querySelector('#app h2')?.textContent === 'Something went wrong',
        };
      });
      assert.equal(audit.fits, true, `${name}: no document-wide horizontal scrolling`);
      assert.deepEqual(audit.unnamed, [], `${name}: every control has an accessible name`);
      assert.equal(audit.missingAlt, 0, `${name}: images declare meaningful or decorative alt text`);
      assert.equal(audit.renderError, false, `${name}: the page renders`);
    }
  });
  test(`${size}: custom choice controls show an opaque keyboard focus outline`, async (t) => {
    const { page, navigate } = await open(t, { viewport });
    const missing = [];
    for (const [name, hash, input, visual] of [
      ['news', '#/settings', '.chip input', '.chip'],
      ['switch', '#/settings', '.switch input', '.switch .track'],
      ['color', '#/robot/loop-0', '.swatch input', '.swatch-dot'],
      ['checklist', '#/home-assistant', '.ha-step-done input', '.ha-step-done'],
    ]) {
      await navigate(hash);
      await page.keyboard.press('Tab');
      await page.locator(input).first().focus();
      await page.locator(visual).first().scrollIntoViewIfNeeded();
      await shot(page, `${size}-focus-${name}`);
      const ring = await page.locator(visual).first().evaluate((node) => {
        const style = getComputedStyle(node);
        return { style: style.outlineStyle, width: parseFloat(style.outlineWidth), color: style.outlineColor };
      });
      if (ring.style !== 'solid' || ring.width < 2) missing.push({ name, ring });
    }
    assert.deepEqual(missing, [], 'custom choices must show a solid 2px focus ring, not only a translucent glow');
  });
  test(`${size} logs: arrow keys select the next severity radio without leaving the group`, async (t) => {
    const { page, navigate } = await open(t, { viewport, admin: true });
    await navigate('#/admin/logs');
    await page.getByRole('radio', { name: 'All', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await shot(page, `${size}-log-severity`);
    const errors = page.getByRole('radio', { name: 'Errors', exact: true });
    assert.equal(await errors.getAttribute('aria-checked'), 'true', 'Arrow Right selects Errors');
    assert.equal(await errors.evaluate((node) => node === document.activeElement), true);
    assert.equal(await page.locator('.seg [tabindex="0"]').count(), 1, 'the radio group is one tab stop');
    await page.keyboard.press('End');
    assert.equal(await page.getByRole('radio', { name: 'Debug', exact: true }).getAttribute('aria-checked'), 'true');
  });
  test(`${size} account menu: keyboard opens, moves through choices and returns focus`, async (t) => {
    const { page, navigate } = await open(t, { viewport });
    await navigate('#/');
    if (size === 'phone') await page.locator('#mobile-menu-btn').click();
    await page.locator('#account-chip').focus();
    await page.keyboard.press('Enter');
    await shot(page, `${size}-account-menu`);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('role')), 'menuitem', 'opening the menu focuses its first choice');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-theme-toggle')), true);
    await page.keyboard.press('End');
    assert.equal(await focused(page), 'logout');
    await page.keyboard.press('Escape');
    assert.equal(await focused(page), 'account-chip');
    assert.equal(await page.locator('#account-menu').isHidden(), true);
    if (size === 'phone') assert.equal(await page.locator('#mobile-menu-btn').getAttribute('aria-expanded'), 'true', 'Escape closes the nested menu, not its drawer');
  });
  test(`${size}: standalone console controls have 44px targets`, async (t) => {
    const { page, navigate } = await open(t, { viewport, admin: true });
    const undersized = [];
    for (const [name, hash] of CONSOLE_PAGES) {
      await navigate(hash);
      if (['home', 'loops', 'admin-settings', 'admin-logs'].includes(name)) await shot(page, `${size}-targets-${name}`);
      undersized.push(...await page.locator('.btn, .icon-btn, .nav-item, .page-head > .link, .ov-link, .back-link, .chip, .swatch, .switch, .ha-step-done, .map-tab, .subnav :is(a, button), .adm-settings-nav a, .chip-btn, .seg button, .check-row, summary, .ical-enabled, .leaflet-control-zoom a, input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), select, textarea').evaluateAll((nodes) => nodes.filter((node) => node.getClientRects().length && !node.closest('[hidden], [inert]')).flatMap((node) => {
        const { width, height } = node.getBoundingClientRect();
        return width >= 44 && height >= 44 ? [] : [`${node.className}: ${width.toFixed(1)}×${height.toFixed(1)}`];
      })));
    }
    assert.deepEqual(undersized, [], 'standalone controls must offer a 44×44 CSS-pixel hit area');
  });
  test(`${size} navigation: a changed destination announces and focuses the new main view`, async (t) => {
    const { page, navigate } = await open(t, { viewport });
    await navigate('#/');
    const link = page.locator(`${size === 'phone' ? '#mobile-tabbar' : '#nav'} a[href="#/robot"]`);
    await link.focus();
    await page.keyboard.press('Enter');
    await page.locator('.robot-card').first().waitFor();
    await page.waitForFunction(() => document.activeElement === document.getElementById('app'), null, { timeout: 1000 }).catch(() => {});
    await shot(page, `${size}-route-focus`);
    assert.equal(await focused(page), 'app', 'route navigation moves focus to the completed main view');
  });
  test(`${size} gallery: a portrait capture leaves its caption and Close action on screen`, async (t) => {
    const { page, navigate } = await open(t, { viewport });
    await page.route('**/api/media/blob/**', (route) => route.fulfill({
      contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAeAAAAPAAQMAAADXKTjJAAAABlBMVEVGVGxGVGwuwTVfAAAAT0lEQVR4nO3BAQEAAACCIP+vbkhAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADArwHkwAABwQMXIwAAAABJRU5ErkJggg==', 'base64'),
    }));
    await navigate('#/gallery');
    await page.locator('.media-open').first().click();
    await page.locator('.overlay-img').waitFor();
    await shot(page, `${size}-portrait-viewer`);
    const geometry = await page.locator('.overlay').evaluate((node) => {
      const elements = [...node.querySelectorAll('img, p, a:not([hidden]), button:not([hidden])')];
      return elements.map((element) => { const r = element.getBoundingClientRect(); return { tag: element.tagName, top: r.top, bottom: r.bottom, left: r.left, right: r.right }; });
    });
    assert.equal(geometry.every((r) => r.top >= 0 && r.left >= 0 && r.bottom <= viewport.height && r.right <= viewport.width), true,
      `the whole viewer fits without scrolling: ${JSON.stringify(geometry)}`);
  });
  test(`${size} gallery: capture viewer keeps Tab inside until Escape restores the photo button`, async (t) => {
    const { page, navigate } = await open(t, { viewport });
    await navigate('#/gallery');
    const opener = page.locator('.media-open').first();
    await opener.focus();
    await page.keyboard.press('Enter');
    const viewer = page.getByRole('dialog', { name: 'Capture viewer' });
    await viewer.getByRole('link', { name: 'Download' }).waitFor();
    await viewer.getByRole('button', { name: 'Close', exact: true }).focus();
    await page.keyboard.press('Tab');
    await shot(page, `${size}-viewer-focus`);
    assert.equal(await viewer.evaluate((node) => node.contains(document.activeElement)), true, 'focus must not escape behind the modal');
    await page.keyboard.press('Escape');
    assert.equal(await opener.evaluate((node) => node === document.activeElement), true);
  });
}
