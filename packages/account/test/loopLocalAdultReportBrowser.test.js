// Loop → Manage → Personal report in a real browser: the owner chooses
// Calendar / Commute / News for an adult without a login, saves, reloads and
// sees the same choices, on a phone and a desktop. Linked adults and children
// get no such editor. The disposable Account service is real (no API mocks);
// the one calendar feed is canned and no other network is reachable. Every
// person, address and event is invented. Screenshots go to
// $LOOP_ADULT_REPORT_SHOTS when it is set.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const VIEWPORTS = { phone: { width: 390, height: 844 }, desktop: { width: 1440, height: 900 } };
const SHOTS = process.env.LOOP_ADULT_REPORT_SHOTS || '';

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
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});
after(async () => { await browser?.close(); });

async function startHousehold() {
  const dir = mkdtempSync(join(tmpdir(), 'phx-loop-adult-report-browser-'));
  process.env.PHOENIX_ENV_FILE = '/dev/null';
  process.env.PHOENIX_DATA_DIR = dir;
  process.env.ETCO_account_secureCookies = 'false';
  process.env.ETCO_account_internalPeerToken = 'loop-adult-report-fixture-peer-token';
  const { DefaultPort } = await import('../../contracts/src/index.js');
  for (const service of Object.keys(DefaultPort)) process.env[`NET_${service}`] = 'http://127.0.0.1:9';
  const { createAccountService, Store } = await import('../src/index.js');
  const { createOwnerAccount, createLoop, newId } = await import('../src/model.js');
  const { markEmailVerified } = await import('../src/emailVerification.js');
  const { createSession } = await import('../src/sessions.js');

  const store = new Store(join(dir, 'account.json'));
  const account = (email, firstName) => {
    const created = createOwnerAccount(store, { email, password: 'Synthetic-password-1', firstName, lastName: 'Example' });
    markEmailVerified(created);
    return created;
  };
  const owner = account('report-owner@example.invalid', 'Morgan');
  const linked = account('report-linked@example.invalid', 'Riley');
  const linkedKid = account('report-linked-kid@example.invalid', 'Jamie');
  const { loop } = createLoop(store, { owner, robotId: 'adult-report-browser-robot' });
  loop.name = 'Maple House';
  const ids = { local: newId(), child: newId(), linked: newId(), linkedChild: newId() };
  const person = (id, fields) => ({ _id: id, enrolled: { face: true, voice: true }, created: Date.UTC(2026, 0, 5), ...fields });
  loop.members.push(
    person(ids.local, {
      status: 'accepted',
      memberProperties: { firstName: 'Robin', lastName: 'Sample', email: null, isChild: false, birthday: Date.UTC(1990, 0, 1) },
    }),
    person(ids.child, { status: 'accepted', memberProperties: { firstName: 'Kit', lastName: 'Fixture', email: null, isChild: true } }),
    person(ids.linked, { accountId: linked._id, status: 'accepted' }),
    person(ids.linkedChild, { accountId: linkedKid._id, status: 'accepted', memberProperties: { isChild: true } }),
  );
  const sessions = { owner: createSession(store, { kind: 'user', accountId: owner._id })._id };
  store.flush();
  const calendarFetcher = async (url) => {
    if (new URL(url).hostname !== 'calendar.example.invalid') throw new Error('network disabled in test');
    return { events: [{ summary: 'Pottery class', start: { dateTime: '2030-01-01T17:00:00Z', timestamp: Date.UTC(2030, 0, 1, 17) } }] };
  };
  const server = await createAccountService({ store, smtp: null, calendarFetcher }).listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, store, loop, ids, linked, sessions,
    record: () => store.settings.get(`loopmember:${loop._id}:${ids.local}`)?.data,
    async close() {
      server.closeAllConnections?.();
      if (server.listening) await new Promise((done) => server.close(done));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function open(t, { viewport, timezoneId }) {
  if (!browser) { t.skip(skip); return null; }
  const house = await startHousehold();
  const context = await browser.newContext({
    viewport, timezoneId, locale: 'en-US', colorScheme: 'light', reducedMotion: 'reduce',
    serviceWorkers: 'block', hasTouch: viewport.width < 600,
  });
  await context.addCookies([{ name: 'phx_session', value: house.sessions.owner, url: house.url }]);
  await context.route('**/*', (route) => (new URL(route.request().url()).origin === house.url ? route.continue() : route.abort()));
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  t.after(async () => {
    await context.close();
    await house.close();
    assert.deepEqual(errors, [], 'no uncaught page errors');
  });
  let loads = 0;
  const load = async () => {
    await page.goto(`${house.url}/app?loop-adult-report=${++loads}#/loop`);
    await page.waitForLoadState('networkidle');
    await page.locator('.people-list .person').first().waitFor();
    await page.waitForFunction(() => !document.querySelector('#app .loading-rows'));
  };
  await load();
  return { page, house, load };
}

const row = (page, id) => page.locator(`.person[data-member="${id}"]`);
async function manage(page, id) {
  await row(page, id).locator('.person-manage-btn').click();
  await row(page, id).locator('.person-panel').waitFor();
}
async function openReport(page, id) {
  await manage(page, id);
  await row(page, id).getByRole('button', { name: 'Edit personal report' }).click();
  await row(page, id).locator('.person-report-form').waitFor();
  return row(page, id).locator('.person-report-form');
}
const switchFor = (form, name) => form.locator(`label.switch:has(input[name="${name}"])`);
async function shot(page, name, target) {
  if (!SHOTS) return;
  await target?.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
}

for (const [label, viewport, timezoneId] of [
  ['phone', VIEWPORTS.phone, 'America/Los_Angeles'],
  ['desktop', VIEWPORTS.desktop, 'Europe/Berlin'],
]) {
  test(`${label}: the owner saves and reopens the report of an adult without a login`, async (t) => {
    const opened = await open(t, { viewport, timezoneId });
    if (!opened) return;
    const { page, house, load } = opened;
    const { ids } = house;

    let form = await openReport(page, ids.local);
    assert.equal(await form.locator('input[name=calendar]').isChecked(), false, 'report defaults to start with');
    await switchFor(form, 'calendar').click();
    await form.locator('input[name=calendarTimeZone]').fill('America/Chicago');
    await switchFor(form, 'commute').click();
    await form.locator('select[name=mode]').selectOption('bicycling');
    await form.locator('input[name=departure]').fill('07:45');
    await form.locator('label.chip:has(input[name=news_science])').click();
    await form.locator('label.chip:has(input[name=news_sports])').click();
    await shot(page, `${label}-1-before-save`, form.locator('fieldset').first());
    await form.getByRole('button', { name: 'Save report' }).click();
    await page.getByText('Saved Robin’s report').waitFor();

    const data = house.record();
    assert.equal(data.calendarEnabled.value, 1);
    assert.equal(data.calendarTimeZone.value, 'America/Chicago');
    assert.equal(data.commuteEnabled.value, 1);
    assert.equal(data.commuteType.value, 2);
    assert.deepEqual(data.commuteTime, { hour: 7, min: 45 });
    assert.equal(data.newsScience.value, 1);
    assert.equal(data.newsSports.value, 0);
    assert.equal(house.store.settings.has(house.linked._id), false, 'the linked adult’s record was not created or touched');

    // A calendar feed through the account iCal path; the owner never sees its address again.
    form = row(page, ids.local).locator('.person-report-form');
    await form.locator('input[aria-label="Calendar name"]').fill('Robin work');
    await form.locator('input[aria-label="iCal subscription URL"]').fill('https://calendar.example.invalid/robin.ics?token=fixture-secret');
    await form.getByRole('button', { name: 'Add calendar' }).click();
    await page.getByText('Calendar saved').waitFor();
    await form.locator('.person-report-feed', { hasText: 'Robin work' }).waitFor();

    // Reload and reopen: the same choices come back.
    await load();
    form = await openReport(page, ids.local);
    assert.equal(await form.locator('input[name=calendar]').isChecked(), true);
    assert.equal(await form.locator('input[name=calendarTimeZone]').inputValue(), 'America/Chicago');
    assert.equal(await form.locator('input[name=commute]').isChecked(), true);
    assert.equal(await form.locator('select[name=mode]').inputValue(), 'bicycling');
    assert.equal(await form.locator('input[name=departure]').inputValue(), '07:45');
    assert.equal(await form.locator('input[name=news_science]').isChecked(), true);
    assert.equal(await form.locator('input[name=news_sports]').isChecked(), false);
    const feed = form.locator('.person-report-feed', { hasText: 'Robin work' });
    await feed.getByText('Verified').waitFor();
    await feed.getByText('calendar.example.invalid · 1 upcoming').waitFor();
    assert.doesNotMatch(await page.content(), /fixture-secret|robin\.ics/);
    await shot(page, `${label}-2-after-reload`, form.locator('.person-report-calendar'));

    // Linked adults and children get no report editor here.
    await manage(page, ids.linked);
    assert.equal(await row(page, ids.linked).locator('.person-report').count(), 0);
    await manage(page, ids.child);
    assert.equal(await row(page, ids.child).locator('.person-report').count(), 0);
    assert.equal(house.store.settings.has(`loopmember:${house.loop._id}:${ids.child}`), false);
    await shot(page, `${label}-3-child-panel`, row(page, ids.child));
  });
}

for (const [label, viewport] of [['phone', VIEWPORTS.phone], ['desktop', VIEWPORTS.desktop]]) {
  test(`${label}: the Unlink dialog says what happens to their personal report, and it is true`, async (t) => {
    const opened = await open(t, { viewport, timezoneId: 'America/New_York' });
    if (!opened) return;
    const { page, house, load } = opened;
    const { ids } = house;
    const dialog = page.locator('dialog.modal');

    // An adult with an account: the owner takes over their report choices.
    await manage(page, ids.linked);
    assert.equal(await row(page, ids.linked).getByRole('button', { name: 'Edit personal report' }).count(), 0);
    await row(page, ids.linked).getByRole('button', { name: 'Unlink account' }).click();
    await dialog.waitFor();
    const adultText = (await dialog.locator('p').innerText()).trim();
    assert.equal(adultText, 'Riley Example stays in the loop. Jibo stops using the report choices saved on their account. '
      + 'You can choose what goes in their personal report here instead.');
    assert.doesNotMatch(await dialog.innerText(), /stop giving them their personal report/);
    await shot(page, `${label}-4-unlink-adult-dialog`, dialog);
    await dialog.getByRole('button', { name: 'Unlink' }).click();
    await page.getByText('Account unlinked').waitFor();

    // What the dialog promised: the owner can now set their report here.
    await load();
    await manage(page, ids.linked);
    await row(page, ids.linked).getByRole('button', { name: 'Edit personal report' }).waitFor();
    await row(page, ids.linked).locator('.person-report').getByText('Riley doesn’t sign in, so you choose').waitFor();
    await shot(page, `${label}-5-after-unlink-report-section`, row(page, ids.linked).locator('.person-report'));

    // A child keeps the standard report; the dialog says so and offers no editor.
    await manage(page, ids.linkedChild);
    await row(page, ids.linkedChild).getByRole('button', { name: 'Unlink account' }).click();
    await dialog.waitFor();
    assert.equal((await dialog.locator('p').innerText()).trim(), 'Jamie Example stays in the loop. '
      + 'Jibo stops using the report choices saved on their account and gives them the standard report.');
    await shot(page, `${label}-6-unlink-child-dialog`, dialog);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await dialog.waitFor({ state: 'detached' });
  });
}
