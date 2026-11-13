// With the skill guide published, a new creator finds one way to build a skill:
// one guide, one kit download and one command-line kit. The older data-only
// format stays an internal implementation. Existing Store releases and the
// already-published hello-jibo.zip keep working, but no page offers that format
// as a choice. Without the release opt-in, the current pages stay as they are.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { staticRoutes, developerPages, hasSkillGuide, missingGuideReason } from './fixtures/developer-content.mjs';

function env(values, fn) {
  const old = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
const base = { PHOENIX_SKILL_STORE_ENABLED: 'true', PHOENIX_PAGES_DIR: undefined, PHOENIX_BRANDING_FILE: undefined, PHOENIX_SITE_URL: undefined };
const guideOn = fn => env({ ...base, PHOENIX_DEVELOPER_SKILLS_ENABLED: 'true' }, fn);
const guideOff = fn => env({ ...base, PHOENIX_DEVELOPER_SKILLS_ENABLED: undefined }, fn);
function get(handler) {
  assert.equal(typeof handler, 'function', 'route is registered');
  const res = { headers: {}, writeHead(status, headers = {}) { this.status = status; this.headers = headers; }, end(bytes = '') { this.bytes = Buffer.from(bytes); this.body = this.bytes.toString(); } };
  handler({ req: { headers: {}, path: '/' }, res }); return res;
}
const KIT = '/developers/downloads/jibo-skill-kit.zip';
const OLD_PAGES = ['/developers/skill-sdk', '/developers/skill-example', '/developers/touchscreen-apps', '/developers/skill-api'];
const HELLO_ZIP = '/developers/downloads/hello-jibo.zip';
// The already-published starter download: its URL and bytes never change.
const HELLO_ZIP_SHA256 = '4cc152d5ec1da8ac527f4669669856320dcea08e0a61138ff80855544baf9e2b';
const GUIDE = ['/developers/skills', '/developers/skills/workflow', '/developers/skills/cookbook', '/developers/skills/troubleshooting',
  '/developers/skills/reference', '/developers/skills/context', '/developers/skills/sdk'];
// Theme references and the review page describe how existing Store releases
// work (for example how a theme paints data-only Store tiles). They offer no
// way to make a skill, so they may still name the stored formats.
const describesExistingStore = path => path === '/developers/review' || path.startsWith('/developers/themes/');
const COMPETING = /Skill SDK|declarative|data-only|native skill kit|native-skill-kit|--kind\b|\.phskill|hello-jibo|Hello Jibo|touchscreen app/i;
const text = html => html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('guide on: every developer page tells one skill story with one kit download and one CLI', { skip: !hasSkillGuide && missingGuideReason }, () => guideOn(() => {
  const routes = staticRoutes(), pages = developerPages();
  assert.deepEqual(pages.filter(p => p.path.startsWith('/developers/skill')).map(p => p.path).sort(), [...GUIDE].sort());
  const commands = new Set(), downloads = new Set();
  for (const page of pages) {
    const res = get(routes['GET ' + page.path]);
    assert.equal(res.status, 200, page.path);
    for (const [, href] of res.body.matchAll(/href="([^"]+)"/g)) {
      const path = new URL(href.replaceAll('&amp;', '&'), 'http://local' + page.path).pathname;
      assert.ok(!OLD_PAGES.includes(path) && path !== HELLO_ZIP, `${page.path} links ${href}`);
      if (path.startsWith('/developers/downloads/')) downloads.add(path);
    }
    const words = text(res.body);
    for (const [, tool] of words.matchAll(/\bnode (tools\/[\w-]+)\//g)) commands.add(tool);
    if (!describesExistingStore(page.path)) {
      const found = words.match(COMPETING);
      assert.equal(found, null, `${page.path} offers another format: ${found && words.slice(Math.max(0, found.index - 80), found.index + 80)}`);
    }
  }
  assert.deepEqual([...downloads], [KIT], 'exactly one kit download is offered');
  assert.deepEqual([...commands].sort(), ['tools/skill-kit', 'tools/theme-kit'], 'skills use one CLI; themes keep theirs');
  const landing = get(routes['GET /developers']).body;
  const menu = landing.slice(landing.indexOf('<nav aria-label="Developer documentation">'));
  const skills = menu.slice(menu.indexOf('id="nav-skills"'), menu.indexOf('</ul>', menu.indexOf('id="nav-skills"')));
  assert.deepEqual([...skills.matchAll(/href="([^"]+)"/g)].map(m => m[1]), ['/developers/skills', '/developers/skills/workflow', '/developers/skills/cookbook', '/developers/skills/troubleshooting']);
  const hero = landing.slice(landing.indexOf('<section class="dev-hero"'), landing.indexOf('</section>', landing.indexOf('<section class="dev-hero"')));
  assert.match(hero, /href="\/developers\/skills"/);
  assert.match(hero, new RegExp(`href="${KIT}"`));
  const index = JSON.parse(get(routes['GET /developers/search.json']).body);
  for (const path of OLD_PAGES) assert.ok(!index.some(row => row.path === path), path + ' is not searchable');
  for (const row of index) if (!describesExistingStore(row.path)) assert.doesNotMatch(row.text, COMPETING, row.path + ' search text');
  const sitemap = get(routes['GET /sitemap.xml']).body;
  for (const path of OLD_PAGES) assert.ok(!sitemap.includes(path + '<'), path + ' is not in the sitemap');
  const zip = get(routes['GET ' + KIT]);
  assert.equal(zip.status, 200); assert.equal(zip.headers['content-type'], 'application/zip');
  assert.match(zip.headers['content-disposition'], /^attachment; filename="jibo-skill-kit\.zip"$/);
  assert.equal(routes['GET /developers/downloads/native-skill-kit.zip'], undefined, 'no alias for the never-published candidate name');
}));

test('guide on: older data-only pages send visitors to the guide; the published starter ZIP keeps its bytes', { skip: !hasSkillGuide && missingGuideReason }, () => guideOn(() => {
  const routes = staticRoutes();
  for (const path of OLD_PAGES) {
    const res = get(routes['GET ' + path]);
    assert.equal(res.status, 302, path); assert.equal(res.headers.location, '/developers/skills', path);
    assert.match(res.headers['cache-control'], /no-store/, path + ' is not cached, so turning the guide off restores the page');
  }
  const zip = get(routes['GET ' + HELLO_ZIP]);
  assert.equal(zip.status, 200); assert.equal(sha(zip.bytes), HELLO_ZIP_SHA256);
}));

test('guide off: the current skill pages, starter ZIP and dashboard links keep answering; no kit is offered', () => guideOff(() => {
  const routes = staticRoutes();
  for (const path of OLD_PAGES) assert.equal(get(routes['GET ' + path]).status, 200, path);
  assert.equal(sha(get(routes['GET ' + HELLO_ZIP]).bytes), HELLO_ZIP_SHA256);
  for (const path of [...GUIDE, KIT]) assert.equal(routes['GET ' + path], undefined, path);
  for (const page of developerPages()) assert.doesNotMatch(get(routes['GET ' + page.path]).body, /jibo-skill-kit\.zip|href="\/developers\/skills/, page.path);
}));
