import { test as nodeTest, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startDeveloperPreview } from './fixtures/developer-portal-preview.mjs';
import { developerPages, hasSkillGuide, missingGuideReason } from './fixtures/developer-content.mjs';
const test = (name, fn) => nodeTest(name, { skip: !hasSkillGuide && missingGuideReason }, fn);

// A disposable local preview with the skill guide opt-in set only while its
// route table is built. Nothing here changes configuration outside this process.
let browser, preview, pages;
before(async () => {
  if (!hasSkillGuide) return;
  const old = process.env.PHOENIX_DEVELOPER_SKILLS_ENABLED;
  process.env.PHOENIX_DEVELOPER_SKILLS_ENABLED = 'true';
  try { preview = await startDeveloperPreview(); pages = developerPages(); }
  finally { if (old === undefined) delete process.env.PHOENIX_DEVELOPER_SKILLS_ENABLED; else process.env.PHOENIX_DEVELOPER_SKILLS_ENABLED = old; }
  browser = await chromium.launch({ ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}), headless: true });
});
after(async () => { await browser?.close(); await preview?.close(); });
async function open(t, viewport) {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce', colorScheme: 'dark' });
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
const GUIDE = ['/developers/skills', '/developers/skills/workflow', '/developers/skills/cookbook', '/developers/skills/troubleshooting',
  '/developers/skills/reference', '/developers/skills/context', '/developers/skills/sdk'];
const KIT = '/developers/downloads/jibo-skill-kit.zip';

for (const [name, viewport] of Object.entries(viewports)) {
  test(`${name}: enabled skill guide pages and their entry points render under strict CSP and fit`, async t => {
    assert.deepEqual(pages.filter(p => p.path.startsWith('/developers/skills')).map(p => p.path).sort(), [...GUIDE].sort());
    const page = await open(t, viewport);
    for (const path of [...GUIDE, '/developers', '/developers/test', '/developers/templates', '/developers/versions', '/developers/publishing']) {
      const response = await page.goto(preview.url + path);
      assert.equal(response.status(), 200, path);
      assert.match(response.headers()['content-security-policy'], /script-src 'self'/);
      assert.equal(await page.locator('main h1').count(), 1, path);
      assert.ok((await page.locator('main').innerText()).length > 300, path);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, path + ' fits');
      if (path.startsWith('/developers/skills')) {
        const active = page.locator('.dev-sidebar nav a[aria-current="page"]');
        assert.equal(await active.getAttribute('href'), path);
      }
    }
  });

  test(`${name}: the skill kit download link is visible and serves the ZIP`, async t => {
    const page = await open(t, viewport);
    await page.goto(preview.url + '/developers/skills');
    const link = page.locator(`main a[href="${KIT}"]`);
    assert.equal(await link.count(), 1);
    await link.scrollIntoViewIfNeeded();
    assert.equal(await link.isVisible(), true);
    assert.equal(await link.evaluate(n => { const r = n.getBoundingClientRect(); return r.width > 0 && n.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }), true, 'link is unobscured');
    const download = await page.request.get(preview.url + KIT);
    assert.equal(download.status(), 200);
    assert.equal(download.headers()['content-type'], 'application/zip');
    assert.equal((await download.body()).subarray(0, 4).toString('hex'), '504b0304');
  });
}

test('desktop: the documentation menu offers one skill guide, and the older skill pages lead to it', async t => {
  const page = await open(t, viewports.desktop);
  await page.goto(preview.url + '/developers/skills');
  const labels = await page.locator('.dev-sidebar nav ul[aria-labelledby="nav-skills"] a').allInnerTexts();
  assert.deepEqual(labels, ['Build a skill', 'Skill workflow', 'Skill cookbook', 'Skill troubleshooting']);
  assert.equal(await page.locator('main h1').innerText(), 'Build a skill for Jibo');
  // The publisher dashboard still links these addresses; they now open the guide.
  for (const path of ['/developers/skill-sdk', '/developers/skill-example']) {
    await page.goto(preview.url + path);
    assert.equal(new URL(page.url()).pathname, '/developers/skills', path);
    assert.equal(await page.locator('main h1').innerText(), 'Build a skill for Jibo', path);
  }
});
