// Local-only console browser fixture. Peer-service responses are invented;
// the real disposable Account service serves the portal and report settings.
import { chromium } from 'playwright';
import { startCalendarConsole, FIXTURE_NOW } from '../../test/fixtures/calendar-console-fixture.mjs';

export const VIEWPORTS = {
  phone: { width: 390, height: 844 },
  desktop: { width: 1440, height: 900 },
};

export const CONSOLE_PAGES = [
  ['home', '#/'], ['robots', '#/robot'], ['loops', '#/loop'], ['inbox', '#/inbox'], ['gallery', '#/gallery'],
  ['settings', '#/settings'], ['profile', '#/profile'], ['system', '#/system'], ['tips', '#/tips'],
  ['home-assistant', '#/home-assistant'], ['home-assistant-legacy', '#/home-assistant-legacy'],
  ['add', '#/add'], ['add-new', '#/add/new'], ['claim', '#/claim'],
  ...['general', 'location', 'holidays', 'wifi', 'backup'].map((tab) => [`robot-${tab}`, `#/robot/loop-0/${tab}`]),
  ...['', '/settings', '/robots', '/people', '/voice-turns', '/logs'].map((path) => [`admin${path.replace('/', '-')}`, `#/admin${path}`]),
];

export async function openConsole({ viewport = VIEWPORTS.phone, colorScheme = 'dark', admin = false } = {}) {
  const running = await startCalendarConsole();
  if (admin) running.store.accountByEmail('calendar-owner@example.invalid').isAdmin = true;
  const browser = await chromium.launch({
    ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server'],
  }).catch(async (error) => { await running.close(); throw error; });
  const context = await browser.newContext({ viewport, colorScheme, serviceWorkers: 'block', reducedMotion: 'reduce', hasTouch: viewport.width < 600 });
  // Model a browser without worker support as well as blocking registrations.
  // Playwright's block alone resolves register() but leaves ready pending,
  // which would strand the profile's notification-status card.
  await context.addInitScript(() => { delete Navigator.prototype.serviceWorker; });
  await context.clock.setFixedTime(new Date(FIXTURE_NOW));
  await context.addCookies([running.cookie]);
  const loops = ['Kitchen', 'Study'].map((name, index) => ({
    id: `loop-${index}`, name, owner: running.accountId, robot: `robot-${index}`,
    robotFriendlyId: `JIBO-TEST-${index}`, canManage: true, avatarColor: index ? 'green' : 'blue',
    members: [
      { id: `owner-${index}`, accountId: running.accountId, status: 'accepted', account: { firstName: 'Fixture', email: 'calendar-owner@example.invalid' } },
      { id: `guest-${index}`, accountId: `guest-${index}`, status: 'accepted', account: { firstName: 'Taylor', email: 'taylor@example.invalid' } },
    ],
  }));
  const robots = loops.map((loop, index) => ({
    loopId: loop.id, name: loop.name, loopName: loop.name, friendlyId: loop.robotFriendlyId,
    canManage: true, avatarColor: loop.avatarColor, connection: { connected: !index },
    created: Date.parse(FIXTURE_NOW) - 86400000, lastSeen: Date.parse(FIXTURE_NOW) - 60000,
  }));
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== running.url) return route.abort();
    const json = (data) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
    if (url.pathname === '/api/loop' && route.request().method() === 'GET') return json({ loops });
    if (url.pathname === '/api/robots') return json(robots);
    if (url.pathname === '/api/robot') {
      const loop = loops.find((item) => item.id === url.searchParams.get('loopId')) || loops[0];
      return json({ loop, connection: { connected: true }, getRobot: { payload: { timezone: 'America/Los_Angeles', remoteEnabled: true } } });
    }
    if (url.pathname === '/api/robot/holidays' && route.request().method() === 'GET') return json({
      holidays: [
        { id: 'birthday-fixture', category: 'birthday', memberId: 'owner-0', date: '2026-11-02', isEnabled: true },
        { id: 'new-year-fixture', category: 'public', name: 'New Year’s Day', date: '2027-01-01', isEnabled: true },
      ],
      custom: [{ id: 'custom-fixture', name: 'Adoption day', date: '2026-11-12', isEnabled: true }],
    });
    if (url.pathname === '/api/loop-key/status') return json({ canManageRecovery: true, backupExists: true });
    if (url.pathname === '/api/loop-key/request') return route.fulfill({ status: 503,
      contentType: 'application/json', body: JSON.stringify({ error: 'Bring Jibo online to unlock protected photos.' }) });
    if (url.pathname === '/api/media') return json({ media: [{
      path: `photo-${url.searchParams.get('loopId')}`, loopId: url.searchParams.get('loopId'),
      type: 'image', url: '/api/media/blob/photo', created: Date.parse(FIXTURE_NOW),
    }] });
    if (url.pathname.startsWith('/api/media/blob/')) return route.fulfill({
      contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4XkAAAAASUVORK5CYII=', 'base64'),
    });
    if (url.pathname === '/api/jot') return json({ messages: [{
      sender: running.accountId, created: Date.parse(FIXTURE_NOW), tags: [], content: 'See you this afternoon.',
    }] });
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let navigation = 0;
  const navigate = async (hash) => {
    // Force a new document for independent page audits. A hash-only goto can
    // return while the previous view is still awaiting refreshMe().
    await page.goto(`${running.url}/app?console-audit=${++navigation}${hash}`);
    await page.waitForLoadState('networkidle');
    await page.locator('#app > div').waitFor();
    await page.waitForFunction(() => !document.querySelector('#app .loading-rows'));
    if (hash === '#/settings') await page.locator('.calendar-month[aria-busy="false"]').waitFor();
  };
  return {
    page, context, running, loops, robots, errors, navigate,
    async close() { await context.close(); await browser.close(); await running.close(); },
  };
}
