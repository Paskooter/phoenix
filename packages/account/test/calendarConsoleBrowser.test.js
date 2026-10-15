// The console's Calendar section in a real browser: phone and desktop layout,
// the selected day's agenda, keyboard use, time zones, failure states and the
// subscription actions. A disposable Account service serves invented calendars.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FEEDS, FIXTURE_DEVICE_TIME_ZONE, FIXTURE_NOW, LONG_TITLE, startCalendarConsole,
} from './fixtures/calendar-console-fixture.mjs';

const VIEWPORTS = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } };
// Every glyph the console draws comes from its own line-icon set.
const ICON_PATHS = new Set([...readFileSync(new URL('../portal/app.js', import.meta.url), 'utf8')
  .matchAll(/^ {2}[A-Za-z]+: '(M[^']+|m[^']+)',$/gm)].map((match) => match[1]));

let browser;
let skip = 'Playwright is not installed';
before(async () => {
  let playwright;
  try { playwright = await import('playwright'); } catch { return; }
  for (const executablePath of [process.env.CHROME_BIN, undefined]) {
    if (executablePath === '' || (executablePath && !existsSync(executablePath))) continue;
    try {
      browser = await playwright.chromium.launch({
        ...(executablePath ? { executablePath } : {}),
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server'],
      });
      break;
    } catch (error) { skip = error.message.split('\n')[0]; }
  }
});
after(async () => { await browser?.close(); });

/** Opens Personal report settings and waits until the month has drawn its events. */
async function open(t, { viewport = VIEWPORTS.desktop, scenario = 'busy', colorScheme = 'dark', wait = 'month', route } = {}) {
  if (!browser) { t.skip(skip); return null; }
  const running = await startCalendarConsole({ scenario });
  const context = await browser.newContext({
    viewport, colorScheme, reducedMotion: 'reduce', locale: 'en-US', timezoneId: FIXTURE_DEVICE_TIME_ZONE,
    hasTouch: viewport.width <= 600,
  });
  await context.clock.setFixedTime(new Date(FIXTURE_NOW));
  await context.addCookies([running.cookie]);
  // Only the fixture's own origin is reachable (map tiles and the like are refused).
  await context.route('**/*', (request) => new URL(request.request().url()).origin === running.url
    ? request.continue() : request.abort());
  if (route) await route(context);
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const errors = [];
  const calls = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/calendar') && url.pathname !== '/api/settings') return;
    let body = null;
    try { body = request.postDataJSON(); } catch { body = request.postData(); }
    calls.push({ method: request.method(), path: url.pathname, body });
  });
  t.after(async () => {
    await context.close();
    await running.close();
    assert.deepEqual(errors, [], 'no uncaught page errors');
  });
  await page.goto(`${running.url}/app#/settings`);
  await page.locator('fieldset.calendar-fieldset .ical-manager').waitFor();
  if (wait === 'month') await monthReady(page);
  if (wait === 'rows') await page.locator('.ical-subscription').first().waitFor();
  return { page, running, calls };
}

const monthReady = (page) => page.locator('.calendar-month[aria-busy="false"]').waitFor();
const dayCell = (page, key) => page.locator(`.calendar-day[data-date="${key}"]`);
const agendaTitles = (page) => page.locator('.calendar-agenda-title').allInnerTexts();
const agendaHeading = (page) => page.locator('.calendar-agenda-head h4').innerText();
const selectedDate = (page) => page.locator('.calendar-day.selected').getAttribute('data-date');
const focusedDate = (page) => page.evaluate(() => document.activeElement?.closest('.calendar-day')?.dataset.date || null);
const row = (page, label) => page.locator('.ical-subscription').filter({ has: page.locator('strong', { hasText: new RegExp(`^${label}$`) }) });
const text = (value) => value.replace(/\s+/g, ' ').trim();
const fitsWidth = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

async function eventsLoaded(page, action) {
  const response = page.waitForResponse((item) => new URL(item.url()).pathname === '/api/calendar/events');
  await action();
  await response;
  await monthReady(page);
}

test('phone: the month and the selected day’s agenda fit 390px without sideways scrolling', async (t) => {
  const opened = await open(t, { viewport: VIEWPORTS.phone });
  if (!opened) return;
  const { page } = opened;
  assert.equal(await fitsWidth(page), true, 'the page does not scroll sideways');
  const geometry = await page.evaluate(() => {
    const preview = document.querySelector('.ical-preview').getBoundingClientRect();
    const cells = [...document.querySelectorAll('.calendar-day')].map((cell) => cell.getBoundingClientRect());
    const buttons = [...document.querySelectorAll('.calendar-day-button')].map((button) => button.getBoundingClientRect());
    const chips = [...document.querySelectorAll('.calendar-chip, .calendar-more')];
    return {
      cells: cells.length,
      inside: cells.every((cell) => cell.left >= preview.left - 0.5 && cell.right <= preview.right + 0.5),
      overflowing: [...document.querySelectorAll('.ical-manager *')].filter((node) => node.getBoundingClientRect().right > innerWidth + 0.5).length,
      smallestTarget: Math.min(...buttons.map((button) => Math.min(button.width, button.height))),
      visibleChips: chips.filter((chip) => getComputedStyle(chip).display !== 'none').length,
      overflowingDayMarkers: [...document.querySelectorAll('.calendar-day')].flatMap((cell) => {
        const box = cell.getBoundingClientRect();
        return [...cell.querySelectorAll('.calendar-day-dots > *')].filter((marker) => {
          const rect = marker.getBoundingClientRect();
          return rect.left < box.left - 0.5 || rect.right > box.right + 0.5;
        });
      }).length,
    };
  });
  assert.equal(geometry.cells, 42);
  assert.equal(geometry.inside, true, 'every day of the grid is inside the preview');
  assert.equal(geometry.overflowing, 0, 'nothing in the calendar section reaches past the screen edge');
  assert.ok(geometry.smallestTarget >= 44, `every day is a 44px tap target (smallest ${geometry.smallestTarget})`);
  assert.equal(geometry.visibleChips, 0, 'a phone day shows dots, not clipped titles');
  assert.equal(geometry.overflowingDayMarkers, 0, 'busy-day dots and overflow counts stay within their day cells');
  assert.equal(await dayCell(page, '2026-10-14').locator('.calendar-dot').count(), 3);

  // Today is selected, and its agenda lists the day in the calendar's own time zone.
  assert.equal(await agendaHeading(page), 'Wednesday, October 14');
  assert.equal(text(await page.locator('.calendar-agenda-head p').innerText()), 'Today · 3 events');
  assert.deepEqual(await agendaTitles(page), ['Team standup', 'Dentist', 'School pickup']);
  assert.deepEqual((await page.locator('.calendar-agenda-when').allInnerTexts()).map(text),
    ['6:00 – 6:15 AM', '10:00 – 10:45 AM', '3:00 – 3:30 PM']);

  // A tap picks the day and brings its agenda up from under the month.
  await dayCell(page, '2026-10-21').locator('button').tap();
  await page.waitForFunction(() => document.querySelector('.calendar-agenda-head h4')?.textContent === 'Wednesday, October 21');
  assert.equal((await agendaTitles(page)).length, 10, 'a busy day lists every event');
  const top = await page.locator('.calendar-agenda').evaluate((node) => node.getBoundingClientRect().top);
  assert.ok(top < 844 * 0.8, `the agenda is on screen after the tap (top ${top})`);

  // A long title wraps in the agenda instead of being cut off.
  await dayCell(page, '2026-10-22').locator('button').tap();
  const title = page.locator('.calendar-agenda-title', { hasText: 'Quarterly planning' });
  assert.equal(await title.innerText(), LONG_TITLE);
  assert.equal(await title.evaluate((node) => node.scrollWidth <= node.clientWidth), true);
  assert.equal(await fitsWidth(page), true);
});

test('phone: the Save bar stays above the bottom tab bar while the form scrolls', async (t) => {
  const opened = await open(t, { viewport: VIEWPORTS.phone });
  if (!opened) return;
  const { page } = opened;
  // An edit is what brings up the Save bar; then the page scrolls mid-way.
  await page.locator('select[name=units]').selectOption('c');
  await page.evaluate(() => window.scrollTo(0, Math.round((document.documentElement.scrollHeight - innerHeight) / 2)));
  const geometry = await page.evaluate(() => {
    const box = (node) => { const rect = node.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom }; };
    const bar = document.querySelector('.save-bar');
    const button = bar.querySelector('button[type="submit"]');
    const centre = button.getBoundingClientRect();
    const hit = document.elementFromPoint((centre.left + centre.right) / 2, (centre.top + centre.bottom) / 2);
    return {
      bar: box(bar), button: box(button), tabbar: box(document.querySelector('.mobile-tabbar')),
      hitIsButton: hit === button || button.contains(hit),
    };
  });
  assert.ok(geometry.tabbar.top < 844 && geometry.tabbar.bottom > 0, 'the bottom tab bar is on screen');
  assert.ok(geometry.button.top > 0 && geometry.button.bottom < 844, 'the Save button is on screen mid-scroll');
  assert.ok(geometry.button.bottom <= geometry.tabbar.top + 0.5,
    `the Save button is fully above the tab bar (button ends at ${geometry.button.bottom}, tab bar starts at ${geometry.tabbar.top})`);
  assert.ok(geometry.bar.bottom <= geometry.tabbar.top + 0.5, 'the whole Save bar is fully above the tab bar');
  assert.equal(geometry.hitIsButton, true, 'the element at the Save button’s centre is the button itself');
});

test('desktop: the Save bar still sticks to the very bottom of the window', async (t) => {
  const opened = await open(t);
  if (!opened) return;
  const { page } = opened;
  await page.locator('select[name=units]').selectOption('c');
  await page.evaluate(() => window.scrollTo(0, Math.round((document.documentElement.scrollHeight - innerHeight) / 2)));
  const geometry = await page.evaluate(() => {
    const bar = document.querySelector('.save-bar');
    const button = bar.querySelector('button[type="submit"]');
    const centre = button.getBoundingClientRect();
    const hit = document.elementFromPoint((centre.left + centre.right) / 2, (centre.top + centre.bottom) / 2);
    return {
      barBottom: bar.getBoundingClientRect().bottom, innerHeight,
      tabbarShown: getComputedStyle(document.querySelector('.mobile-tabbar')).display !== 'none',
      hitIsButton: hit === button || button.contains(hit),
    };
  });
  assert.equal(geometry.tabbarShown, false, 'there is no tab bar on the desktop');
  assert.ok(Math.abs(geometry.barBottom - geometry.innerHeight) <= 1,
    `the Save bar still hugs the bottom edge of the window (bar ends at ${geometry.barBottom}, window is ${geometry.innerHeight} tall)`);
  assert.equal(geometry.hitIsButton, true, 'the Save button is still tappable');
});

test('desktop: bars span their days, “+N more” counts what a day hides, and the agenda sits beside the month', async (t) => {
  const opened = await open(t);
  if (!opened) return;
  const { page } = opened;
  assert.equal(await fitsWidth(page), true);
  const box = async (selector) => page.locator(selector).first().evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, width: rect.width };
  });
  const month = await box('.calendar-month');
  const agenda = await box('.calendar-agenda');
  assert.ok(agenda.left >= month.right - 1 && Math.abs(agenda.top - month.top) < 2, 'the agenda is beside the month');

  // The camping trip, Fri 16 to Sun 18, is one bar to the end of its week and continues on Sunday.
  const trip = page.locator('.calendar-chip.bar', { hasText: 'Fall camping trip' });
  assert.equal(await trip.count(), 2);
  const friday = await dayCell(page, '2026-10-16').boundingBox();
  const saturday = await dayCell(page, '2026-10-17').boundingBox();
  const first = await trip.nth(0).boundingBox();
  assert.ok(Math.abs(first.x - friday.x) < 8 && Math.abs(first.x + first.width - (saturday.x + saturday.width)) < 2,
    'the first piece covers Friday and Saturday');
  assert.match(await trip.nth(0).getAttribute('class'), /continues-after/);
  assert.match(await trip.nth(1).getAttribute('class'), /continues-before/);
  const offsite = page.locator('.calendar-chip.bar', { hasText: 'Company offsite' });
  const tuesday = await dayCell(page, '2026-10-27').boundingBox();
  const thursday = await dayCell(page, '2026-10-29').boundingBox();
  const offsiteBox = await offsite.boundingBox();
  assert.ok(Math.abs(offsiteBox.x - tuesday.x) < 8 && Math.abs(offsiteBox.x + offsiteBox.width - (thursday.x + thursday.width)) < 8,
    'the offsite runs Tuesday to Thursday');

  // Today is marked and announced.
  assert.equal(await dayCell(page, '2026-10-14').locator('button').getAttribute('aria-current'), 'date');
  assert.match(await dayCell(page, '2026-10-14').getAttribute('class'), /\btoday\b/);

  // A busy day shows what fits and says how many more there are; the agenda has them all.
  const busy = dayCell(page, '2026-10-21');
  const busyBox = await busy.boundingBox();
  const inBusy = async (selector) => (await Promise.all((await page.locator(selector).all()).map((node) => node.boundingBox())))
    .filter((rect) => rect && rect.x >= busyBox.x - 1 && rect.x + rect.width <= busyBox.x + busyBox.width + 1
      && rect.y >= busyBox.y - 1 && rect.y + rect.height <= busyBox.y + busyBox.height + 1).length;
  const shown = await inBusy('.calendar-chip');
  assert.equal(await inBusy('.calendar-more'), 1);
  const more = page.locator('.calendar-more', { hasText: /^\+\d+ more$/ });
  assert.equal(await more.count(), 1);
  const hidden = Number((await more.innerText()).match(/\d+/)[0]);
  await busy.locator('button').click();
  assert.equal(await agendaHeading(page), 'Wednesday, October 21');
  assert.equal((await agendaTitles(page)).length, shown + hidden, '“+N more” is exactly what the day leaves out');

  // All-day and overnight events say when they run.
  await dayCell(page, '2026-10-17').locator('button').click();
  assert.equal(text(await page.locator('.calendar-agenda-event', { hasText: 'Fall camping trip' }).locator('.calendar-agenda-when').innerText()),
    'All day · Fri, Oct 16 – Sun, Oct 18');
  await dayCell(page, '2026-10-25').locator('button').click();
  assert.equal(text(await page.locator('.calendar-agenda-event', { hasText: 'Late movie night' }).locator('.calendar-agenda-when').innerText()),
    'Oct 24, 10:00 PM – Oct 25, 1:30 AM');
  // A UTC-written event is shown at its time in the calendar's zone, not the browser's.
  await dayCell(page, '2026-10-23').locator('button').click();
  assert.equal(text(await page.locator('.calendar-agenda-event', { hasText: 'Video call with Grandpa' }).locator('.calendar-agenda-when').innerText()),
    '10:00 – 11:00 AM');

  // A paused calendar's events stay out; a failing one is listed with its problem.
  assert.equal(await page.locator('.ical-preview').getByText('Old team retro').count(), 0);
  assert.equal(text(await row(page, 'School').locator('.status-badge').first().innerText()), 'Needs attention');
  assert.equal(text(await row(page, 'School').locator('.ical-subscription-error').innerText()), 'Calendar fetch returned HTTP 404.');
  assert.equal(text(await page.locator('.ical-section-sub').innerText()), '5 calendars · 4 in use · 3 need attention');
});

test('keyboard: arrow keys move the day, Page Up and Page Down change month, and focus stays put', async (t) => {
  const opened = await open(t);
  if (!opened) return;
  const { page } = opened;
  assert.equal(await page.locator('.calendar-day-button[tabindex="0"]').count(), 1, 'the month is one tab stop');
  await page.getByRole('button', { name: 'Next month' }).focus();
  await page.keyboard.press('Tab');
  assert.equal(await focusedDate(page), '2026-10-14', 'Tab from the month controls lands on the selected day');
  const ring = await page.evaluate(() => {
    const style = getComputedStyle(document.activeElement);
    return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
  });
  assert.ok(ring.style !== 'none' && ring.width >= 2, 'the focused day shows a focus ring');
  assert.match(await page.locator('.calendar-day-button:focus').getAttribute('aria-label'), /^Wednesday, October 14, today, 3 events$/);

  const press = async (key, date) => {
    await page.keyboard.press(key);
    await page.waitForFunction((expected) => document.activeElement?.closest('.calendar-day')?.dataset.date === expected, date);
    assert.equal(await selectedDate(page), date, `${key} selects ${date}`);
  };
  await press('ArrowRight', '2026-10-15');
  assert.equal(await agendaHeading(page), 'Thursday, October 15', 'the agenda follows the selected day');
  await press('ArrowDown', '2026-10-22');
  await press('ArrowUp', '2026-10-15');
  await press('ArrowLeft', '2026-10-14');
  await press('Home', '2026-10-11');
  await press('End', '2026-10-17');
  await press('PageDown', '2026-11-17');
  await monthReady(page);
  assert.equal(await page.locator('.calendar-month-label').innerText(), 'November 2026');
  assert.equal(await focusedDate(page), '2026-11-17', 'focus survives the month loading');
  await press('PageUp', '2026-10-17');
  await monthReady(page);
  assert.equal(await page.locator('.calendar-month-label').innerText(), 'October 2026');
  await press('ArrowDown', '2026-10-24');
  await press('ArrowDown', '2026-10-31');
  await press('ArrowRight', '2026-11-01');
  await monthReady(page);
  assert.equal(await page.locator('.calendar-month-label').innerText(), 'November 2026', 'stepping past the last day turns the page');
  await eventsLoaded(page, () => page.getByRole('button', { name: 'Today', exact: true }).click());
  assert.equal(await page.locator('.calendar-month-label').innerText(), 'October 2026');
  assert.equal(await selectedDate(page), '2026-10-14');
});

// Written against what both the old and the new calendar share (the month
// buttons, the month heading and the events request), so it also shows the
// old page losing focus.
test('the month buttons keep keyboard focus while the next month loads', async (t) => {
  const opened = await open(t, { wait: 'rows' });
  if (!opened) return;
  const { page } = opened;
  const month = (name) => page.getByRole('heading', { name, exact: true }).waitFor();
  const events = (action) => Promise.all([
    page.waitForResponse((item) => new URL(item.url()).pathname === '/api/calendar/events'), action()]);
  await month('October 2026');
  const next = page.getByRole('button', { name: 'Next month' });
  await next.focus();
  await events(() => page.keyboard.press('Enter'));
  await month('November 2026');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') || document.activeElement?.tagName),
    'Next month', 'focus stays on Next month');
  await events(() => page.keyboard.press('Enter'));
  await month('December 2026');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') || document.activeElement?.tagName),
    'Next month', 'so pressing it again carries on');
});

test('the subscription actions still call the same calendar API', async (t) => {
  const opened = await open(t);
  if (!opened) return;
  const { page, running, calls } = opened;
  const stored = () => running.store.settings.get(running.accountId).data.icalSubscriptions.subscriptions;
  const toast = (message) => page.locator('#toast', { hasText: message }).waitFor();
  const mutations = () => calls.filter((call) => call.method !== 'GET');

  // Turning a paused calendar back on refreshes the month with its events.
  await eventsLoaded(page, () => page.getByRole('checkbox', { name: 'Use and refresh Old team calendar' }).check());
  assert.deepEqual(mutations().at(-1), { method: 'PUT', path: '/api/calendar/subscriptions/cal-paused', body: { enabled: true } });
  assert.equal(stored().find((item) => item.id === 'cal-paused').enabled, true);
  assert.equal(await row(page, 'Old team calendar').locator('.status-paused').count(), 0);
  await dayCell(page, '2026-10-15').locator('button').click();
  assert.ok((await agendaTitles(page)).includes('Old team retro'));

  await row(page, 'Family').getByRole('button', { name: 'Verify' }).click();
  await toast('Calendar verified');
  assert.deepEqual(mutations().at(-1), { method: 'POST', path: '/api/calendar/subscriptions/cal-family/verify', body: null });

  // Edit fills the form; Update sends the edited link and re-checks it.
  await row(page, 'Holidays').getByRole('button', { name: 'Edit' }).click();
  assert.equal(await page.locator('.ical-add-title').innerText(), 'Edit Holidays');
  assert.equal(await page.getByLabel('iCal subscription URL').inputValue(), FEEDS.holidays);
  assert.equal(await page.getByLabel('Calendar name').inputValue(), 'Holidays');
  assert.match(await row(page, 'Holidays').getAttribute('class'), /is-editing/);
  await page.getByLabel('Calendar name').fill('Public holidays');
  await eventsLoaded(page, () => page.getByRole('button', { name: 'Update calendar link' }).click());
  await toast('Calendar linked');
  assert.deepEqual(mutations().at(-1), {
    method: 'PUT', path: '/api/calendar/subscriptions/cal-holidays', body: { label: 'Public holidays', url: FEEDS.holidays, enabled: true },
  });
  assert.equal(text(await row(page, 'Public holidays').locator('.status-badge').first().innerText()), 'Verified');
  assert.equal(await page.getByRole('button', { name: 'Save calendar link' }).isVisible(), true);

  // Close folds the form away; Add calendar brings it back empty.
  await page.getByRole('button', { name: 'Close' }).click();
  assert.equal(await page.locator('.ical-add').isHidden(), true);
  const add = page.getByRole('button', { name: 'Add calendar' });
  assert.equal(await add.getAttribute('aria-expanded'), 'false');
  await add.click();
  assert.equal(await page.getByLabel('Calendar name').evaluate((node) => node === document.activeElement), true);
  await page.getByLabel('Calendar name').fill('Neighbourhood');
  await page.getByLabel('iCal subscription URL').fill(FEEDS.added);
  await eventsLoaded(page, () => page.getByRole('button', { name: 'Save calendar link' }).click());
  await toast('Calendar linked');
  assert.equal(await page.locator('.ical-add-status').innerText(), 'Verified and ready for the report.');
  assert.deepEqual(mutations().at(-1), {
    method: 'POST', path: '/api/calendar/subscriptions', body: { label: 'Neighbourhood', url: FEEDS.added, enabled: true },
  });
  const added = stored().find((item) => item.label === 'Neighbourhood');
  assert.ok(added);

  // Remove asks first; Cancel keeps the calendar.
  await row(page, 'Neighbourhood').getByRole('button', { name: 'Remove' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  assert.ok(stored().some((item) => item.id === added.id));
  await row(page, 'Neighbourhood').getByRole('button', { name: 'Remove' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
  await toast('Calendar removed');
  await row(page, 'Neighbourhood').waitFor({ state: 'detached' });
  assert.equal(stored().some((item) => item.id === added.id), false);
  assert.deepEqual(mutations().map((call) => `${call.method} ${call.path}`), [
    'PUT /api/calendar/subscriptions/cal-paused',
    'POST /api/calendar/subscriptions/cal-family/verify',
    'PUT /api/calendar/subscriptions/cal-holidays',
    'POST /api/calendar/subscriptions',
    `DELETE /api/calendar/subscriptions/${added.id}`,
  ], 'no other writes, and none to the report settings');
});

// Also written against what both versions share: the link fields and the requests.
test('pressing Enter in a calendar link field saves the link, not the report form', async (t) => {
  const opened = await open(t, { wait: 'rows' });
  if (!opened) return;
  const { page, calls } = opened;
  const add = page.getByRole('button', { name: 'Add calendar' });
  if (await add.count() && await add.isVisible()) await add.click();
  await page.getByLabel('Calendar name').fill('Neighbourhood');
  const url = page.getByLabel('iCal subscription URL');
  await url.fill(FEEDS.added);
  const written = page.waitForResponse((response) => response.request().method() !== 'GET'
    && ['/api/calendar/subscriptions', '/api/settings'].includes(new URL(response.url()).pathname));
  await url.press('Enter');
  await written;
  assert.deepEqual(calls.filter((call) => call.method !== 'GET').map((call) => `${call.method} ${call.path}`),
    ['POST /api/calendar/subscriptions']);
  await row(page, 'Neighbourhood').waitFor();
});

test('time zone: all-day events keep their dates, times follow the zone, and an unknown zone is explained', async (t) => {
  const opened = await open(t);
  if (!opened) return;
  const { page, calls } = opened;
  const zone = page.locator('input[name=calendarTimeZone]');
  assert.equal(text(await page.locator('.ical-zone-now').innerText()), 'Times below are in Pacific Daylight Time (GMT-7).');
  await zone.fill('Pacific/Honolulu');
  await zone.press('Tab');
  await page.locator('.calendar-month-summary', { hasText: 'Pacific/Honolulu' }).waitFor();
  assert.equal(text(await page.locator('.ical-zone-now').innerText()), 'Times below are in Hawaii-Aleutian Standard Time (GMT-10).');
  // All-day events are dates, not instants: they do not slide to the day before.
  for (const [date, count] of [['2026-10-02', 0], ['2026-10-03', 1]]) {
    await dayCell(page, date).locator('button').click();
    const titles = await agendaTitles(page);
    assert.equal(titles.filter((item) => item === 'Grandma’s birthday').length, count, `birthday on ${date}`);
  }
  await dayCell(page, '2026-10-15').locator('button').click();
  assert.equal((await agendaTitles(page)).includes('Fall camping trip'), false, 'the trip still starts on the 16th');
  // Timed events move with the zone: 10 AM in Los Angeles is 7 AM in Honolulu.
  await dayCell(page, '2026-10-14').locator('button').click();
  assert.equal(text(await page.locator('.calendar-agenda-event', { hasText: 'Dentist' }).locator('.calendar-agenda-when').innerText()),
    '7:00 – 7:45 AM');

  await zone.fill('Not/AZone');
  await zone.press('Tab');
  assert.equal(await zone.inputValue(), 'UTC');
  assert.equal(text(await page.locator('.ical-zone-now').innerText()),
    '“Not/AZone” isn’t a time zone this browser knows, so times are shown in UTC.');

  // The zone is still a report setting, saved with the form.
  await zone.fill('America/New_York');
  await zone.press('Tab');
  const saved = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/settings' && response.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Save changes' }).click();
  assert.equal((await saved).status(), 200);
  const put = calls.find((call) => call.method === 'PUT' && call.path === '/api/settings');
  assert.equal(put.body.calendar.timeZone, 'America/New_York');
  assert.equal(put.body.calendar.active, true);
});

test('loading, failure and empty states keep their place and offer a way forward', async (t) => {
  let release;
  const held = new Promise((done) => { release = done; });
  // Teardown hooks run in the order they are added: let a held request go
  // before open() closes the browser, so a failing check cannot hang the run.
  t.after(() => release());
  let mode = 'hold';
  const opened = await open(t, {
    wait: 'none',
    route: (context) => context.route('**/api/calendar/events**', async (request) => {
      if (mode === 'hold') { await held; return request.continue(); }
      if (mode === 'fail') {
        return request.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'calendar store unavailable' }) });
      }
      return request.continue();
    }),
  });
  if (!opened) return;
  const { page } = opened;
  await page.locator('.calendar-month[aria-busy="true"]').waitFor();
  assert.equal(await page.locator('.calendar-month-label').innerText(), 'October 2026', 'the month is named while it loads');
  assert.equal(text(await page.locator('.calendar-agenda-head p').innerText()), 'Loading events…');
  mode = 'fail';
  release();
  await monthReady(page);

  await page.getByRole('button', { name: 'Next month' }).click();
  await page.locator('.ical-preview .notice-error').waitFor();
  assert.match(await page.locator('.ical-preview .notice-error').innerText(), /Could not load the calendar preview\.\s+calendar store unavailable/);
  assert.equal(await page.locator('.calendar-month-label').innerText(), 'November 2026');
  assert.equal(await page.getByRole('button', { name: 'Previous month' }).isVisible(), true, 'the month controls stay');
  mode = 'pass';
  await eventsLoaded(page, () => page.getByRole('button', { name: 'Try again' }).click());
  assert.equal(await page.locator('.ical-preview .notice-error').count(), 0);
  assert.equal(await focusedDate(page), '2026-11-01', 'focus goes to the month that came back');
});

test('with no calendars the form is open; with none verified the month explains why', async (t) => {
  const empty = await open(t, { scenario: 'empty', wait: 'none' });
  if (!empty) return;
  await empty.page.getByText('Your calendar preview starts here').waitFor();
  assert.equal(await empty.page.getByText('No calendars linked').isVisible(), true);
  assert.equal(await empty.page.getByLabel('iCal subscription URL').isVisible(), true);
  assert.equal(await empty.page.getByRole('button', { name: 'Add calendar' }).isVisible(), false);
  assert.equal(await empty.page.getByRole('button', { name: 'Close' }).isVisible(), false, 'nothing to close back to');
  assert.equal(await empty.page.locator('.ical-section-sub').isVisible(), false);

  const unverified = await open(t, { scenario: 'unverified', wait: 'none' });
  await unverified.page.getByText('Calendar preview unavailable').waitFor();
  assert.match(await unverified.page.locator('.ical-preview').innerText(), /At least one subscription must verify successfully/);
  assert.equal(text(await unverified.page.locator('.ical-section-sub').innerText()), '2 calendars · 2 in use · 2 need attention');
});

/**
 * WCAG contrast of each node's text against what is painted behind it:
 * translucent backgrounds are blended down to the first opaque one, and
 * ancestor opacity fades the text. Event chips are laid over their week's
 * day cells rather than inside them, so a chip is measured on its day.
 */
function contrastOfAll(nodes) {
  const parse = (value) => {
    const numbers = value.match(/-?[\d.]+(?:e-?\d+)?/g)?.map(Number) || [];
    if (value.startsWith('color(srgb')) return { rgb: numbers.slice(0, 3).map((n) => n * 255), alpha: numbers[3] ?? 1 };
    return { rgb: numbers.slice(0, 3), alpha: numbers[3] ?? 1 };
  };
  const luminance = ([r, g, b]) => [r, g, b].map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, c, index) => sum + c * [0.2126, 0.7152, 0.0722][index], 0);
  const blend = (top, alpha, bottom) => top.map((value, index) => value * alpha + bottom[index] * (1 - alpha));
  return nodes.map((node) => {
    const layers = [];
    let opacity = 1;
    let base = [255, 255, 255];
    for (let item = node; item; item = item.parentElement) {
      const style = getComputedStyle(item);
      opacity *= Number(style.opacity);
      if (item.classList.contains('calendar-week')) {
        const piece = node.closest('.calendar-chip, .calendar-more');
        const column = Number.parseInt(piece?.style.gridColumnStart || piece?.style.gridColumn || '1', 10) - 1;
        base = parse(getComputedStyle(item.querySelectorAll(':scope > .calendar-day')[column]).backgroundColor).rgb;
        break;
      }
      const background = parse(style.backgroundColor);
      if (background.alpha >= 0.99) { base = background.rgb; break; }
      if (background.alpha > 0) layers.push(background);
    }
    for (const layer of layers.reverse()) base = blend(layer.rgb, layer.alpha, base);
    const text = parse(getComputedStyle(node).color);
    const foreground = blend(text.rgb, text.alpha * opacity, base);
    const [a, b] = [luminance(foreground), luminance(base)].sort((x, y) => y - x);
    return (a + 0.05) / (b + 0.05);
  });
}

for (const colorScheme of ['dark', 'light']) {
  test(`${colorScheme} theme: calendar text is readable (4.5:1)`, async (t) => {
    const opened = await open(t, { colorScheme });
    if (!opened) return;
    const { page } = opened;
    for (const selector of [
      '.ical-subscription-meta', '.ical-subscription-url', '.ical-subscription-error', '.ical-section-sub', '.ical-zone-now',
      '.calendar-month-summary', '.calendar-weekday', '.calendar-day.outside .calendar-day-number', '.calendar-day-number',
      '.calendar-chip.bar .calendar-chip-text', '.calendar-chip.timed .calendar-chip-text', '.calendar-more',
      '.calendar-agenda-when', '.calendar-agenda-meta', '.status-badge',
    ]) {
      const ratios = await page.locator(selector).evaluateAll(contrastOfAll);
      assert.ok(ratios.length, `${selector} is drawn`);
      const lowest = Math.min(...ratios);
      assert.ok(lowest >= 4.5, `${selector}: ${lowest.toFixed(2)}:1`);
    }
  });
}

test('the calendar section draws only the console’s icons and shows no stray values', async (t) => {
  const opened = await open(t);
  if (!opened) return;
  const { page } = opened;
  const section = page.locator('fieldset.calendar-fieldset');
  const paths = await section.locator('svg path').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('d')));
  assert.ok(paths.length > 0);
  assert.deepEqual(paths.filter((d) => !ICON_PATHS.has(d)), [], 'every glyph is one of the console’s line icons');
  assert.equal(await section.locator('img, canvas').count(), 0);
  assert.doesNotMatch(await section.innerText(), /\bnull\b|\bundefined\b|\bNaN\b|firmware|\[object/i);
});
