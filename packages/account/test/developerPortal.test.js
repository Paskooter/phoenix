import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderMarkdown, safeDocumentationUrl } from '../src/developerMarkdown.js';
import { developerRoutes, DEVELOPER_SECTIONS } from '../src/developerPortal.js';

import { staticRoutes, developerPages, copyKit, hasSkillGuide, missingGuideReason } from './fixtures/developer-content.mjs';

function env(values, fn) {
  const old = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
function get(handler) {
  assert.equal(typeof handler, 'function');
  const res = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(bytes) { this.body = Buffer.from(bytes).toString(); } };
  handler({ req: { headers: {} }, res }); return res;
}
const enabled = fn => env({ PHOENIX_SKILL_STORE_ENABLED: 'true', PHOENIX_DEVELOPER_SKILLS_ENABLED: undefined, PHOENIX_PAGES_DIR: undefined }, fn);
// Local fixtures only: the release opt-in stays unset everywhere else.
const nativeGuideEnabled = fn => env({ PHOENIX_SKILL_STORE_ENABLED: 'true', PHOENIX_DEVELOPER_SKILLS_ENABLED: 'true', PHOENIX_PAGES_DIR: undefined }, fn);


test('markdown: raw markup, code and hostile link syntax cannot execute', () => {
  const source = '# <img src=x onerror=alert(1)>\n\n<script>alert(1)</script>\n\n[bad](javascript:alert) [data](data:text/html,hi) [escape](//evil.example)\n\n```html\n</code></pre><script>evil()</script>\n```\n\n![bad](https://evil.example/private.png)';
  const { html } = renderMarkdown(source);
  assert.ok(!/<(?:script|img|iframe)\b/i.test(html));
  assert.ok(!html.includes('href="javascript:') && !html.includes('href="data:'));
  assert.match(html, /&lt;script&gt;/); assert.match(html, /<pre[^>]*><code/);
  assert.ok(!html.includes('src="https://evil.example'));
});

test('markdown: links accept only explicit site paths, anchors and http(s) URLs', () => {
  for (const bad of ['javascript:x', 'data:image/png;base64,x', '//evil.example', '/\\evil', 'file:///etc/passwd', '../secret.md', 'https://user:pass@evil.example', 'https://example.com/" onclick="x']) assert.equal(safeDocumentationUrl(bad), null, bad);
  for (const good of ['/developers/themes#start', '#a', 'https://github.com/Paskooter/phoenix']) assert.equal(safeDocumentationUrl(good), good);
});

test('markdown: headings, duplicate anchors, tables, lists, emphasis and code are semantic', () => {
  const { html, headings } = renderMarkdown('# Title\n\n## Hello `world`\n\n**Bold** and *emphasis* with `a < b`.\n\n## Hello `world`\n\n| Field | Value |\n| --- | --- |\n| `x` | yes |\n\n1. First\n2. Second\n\n- One\n- Two\n\n> Note');
  assert.deepEqual(headings.map(h => h.id), ['title', 'hello-world', 'hello-world-2']);
  for (const tag of ['<table>', '<th scope="col">', '<ol>', '<ul>', '<blockquote>', '<strong>', '<em>', '<code>']) assert.ok(html.includes(tag), tag);
});

test('markdown: colliding generated and explicit heading slugs stay unique', () => {
  const { headings } = renderMarkdown('# A\n\n## A\n\n## A-2\n\n## dev-main');
  assert.deepEqual(headings.map(h => h.id), ['a', 'a-2', 'a-2-2', 'dev-main-2']);
});

test('developer routes: skill publication requires explicit opt-in, the complete reference set and the kit', () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'phx-developer-skill-'));
  mkdirSync(join(projectDir, 'docs/skills'), { recursive: true });
  const skillPaths = pages => pages.filter(p => p.path.startsWith('/developers/skills')).map(p => p.path);
  const download = 'GET /developers/downloads/jibo-skill-kit.zip';
  try {
    env({ PHOENIX_DEVELOPER_SKILLS_ENABLED: 'true' }, () => {
      assert.deepEqual(skillPaths(developerPages({ projectDir })), []);
      writeFileSync(join(projectDir, 'docs/SKILLS.md'), '# Start a skill\n\nPublic overview text.');
      assert.deepEqual(skillPaths(developerPages({ projectDir })), []);
      for (const name of ['MANIFESTS', 'CONTEXT', 'SDK', 'COOKBOOK', 'WORKFLOW', 'TROUBLESHOOTING']) {
        writeFileSync(join(projectDir, 'docs/skills/' + name + '.md'), '# ' + name + '\n\nPublic reference text.');
      }
      // The guide links its kit download: all seven sources alone publish nothing.
      assert.deepEqual(skillPaths(developerPages({ projectDir })), []);
      assert.equal(developerRoutes({ prepare: b => b, projectDir }).routes[download], undefined);
      copyKit(projectDir);
      const paths = skillPaths(developerPages({ projectDir }));
      assert.equal(paths.length, 7); assert.ok(paths.includes('/developers/skills/reference'));
      const { routes } = developerRoutes({ prepare: b => b, projectDir });
      assert.match(get(routes['GET /developers/skills/reference']).body, /Public reference text/);
      const zip = get(routes[download]);
      assert.equal(zip.status, 200); assert.equal(zip.headers['content-type'], 'application/zip');
      assert.match(zip.headers['content-disposition'], /^attachment; filename="jibo-skill-kit\.zip"$/);
      // Any missing kit file closes the guide and its download again.
      rmSync(join(projectDir, 'tools/theme-kit/themeFormat.cjs'));
      assert.deepEqual(skillPaths(developerPages({ projectDir })), []);
      assert.equal(developerRoutes({ prepare: b => b, projectDir }).routes[download], undefined);
      copyKit(projectDir);
      assert.equal(skillPaths(developerPages({ projectDir })).length, 7);
    });
    // Only the exact value "true" opens it: unset, "false" and lookalikes stay closed.
    for (const value of [undefined, 'false', '', 'TRUE', '1', 'yes']) env({ PHOENIX_DEVELOPER_SKILLS_ENABLED: value }, () => {
      assert.deepEqual(skillPaths(developerPages({ projectDir })), [], String(value));
      const { routes } = developerRoutes({ prepare: b => b, projectDir });
      assert.equal(routes['GET /developers/skills/reference'], undefined);
      assert.equal(routes[download], undefined);
    });
  } finally { rmSync(projectDir, { recursive: true, force: true }); }
});

test('developer routes: merged fixed references and templates render without exposing held skill content', () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'phx-developer-content-'));
  const docs = join(projectDir, 'docs');
  mkdirSync(join(docs, 'themes'), { recursive: true }); mkdirSync(join(docs, 'skills'));
  cpSync(new URL('../../../docs/developers', import.meta.url), join(docs, 'developers'), { recursive: true });
  cpSync(new URL('../../../docs/THEMES.md', import.meta.url), join(docs, 'THEMES.md'));
  for (const name of ['REFERENCE', 'SURFACES', 'TESTING', 'PUBLISHING']) writeFileSync(join(docs, 'themes', name + '.md'), '# Theme ' + name + '\n\nExtended theme documentation.');
  for (const name of ['MANIFESTS', 'CONTEXT', 'SDK', 'COOKBOOK', 'WORKFLOW', 'TROUBLESHOOTING']) writeFileSync(join(docs, 'skills', name + '.md'), '# Skill ' + name + '\n\nHeldSkillSentinel.');
  writeFileSync(join(docs, 'SKILLS.md'), '# Start a skill\n\nHeldSkillSentinel.');
  writeFileSync(join(docs, 'skills/secret.md'), '# Never public\n\nUnknownSourceSentinel.');
  copyKit(projectDir);
  for (const [name, themeApi] of [['paper', 1], ['signals', 1], ['terrace', 4], ['cut-paper', 3]]) {
    const folder = join(projectDir, 'tools/theme-kit/templates', name); mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'theme.json'), JSON.stringify({ themeApi }));
  }
  try {
    env({ PHOENIX_DEVELOPER_SKILLS_ENABLED: undefined }, () => {
      const { routes } = developerRoutes({ prepare: b => b, projectDir });
      const search = get(routes['GET /developers/search.json']).body;
      assert.ok(!search.includes('HeldSkillSentinel') && !search.includes('UnknownSourceSentinel'));
      assert.match(get(routes['GET /developers/themes/api']).body, /Extended theme documentation/);
      const templates = get(routes['GET /developers/templates']).body;
      for (const name of ['paper', 'signals', 'terrace', 'cut-paper']) assert.ok(templates.includes(name));
      assert.match(templates, /Native skill templates are not published on this site yet/);
      assert.equal(routes['GET /developers/skills/secret'], undefined);
    });
    env({ PHOENIX_DEVELOPER_SKILLS_ENABLED: 'true' }, () => {
      const { routes } = developerRoutes({ prepare: b => b, projectDir });
      assert.match(get(routes['GET /developers']).body, /Build a skill/);
      assert.match(get(routes['GET /developers/templates']).body, /network-service/);
      assert.ok(!get(routes['GET /developers/templates']).body.includes('Native skill templates are not published'));
      assert.ok(!get(routes['GET /developers/search.json']).body.includes('UnknownSourceSentinel'));
    });
  } finally { rmSync(projectDir, { recursive: true, force: true }); }
});

// Jibo's current software already supports native local test builds; only the
// native guide's publication on this site is held. No developer surface may
// say local testing waits for a later Jibo software release.
const WAITS_FOR_JIBO_RELEASE = [
  /\b(?:opens?|available)\b[^.]{0,60}\bwith (?:the |a )?(?:next |later |future )?(?:compatible )?Jibo software\b/i,
  /\bJibo software (?:release|update) that supports local test builds\b/i,
];
const sectionHtml = (html, id) => { const from = html.indexOf(`id="${id}"`); assert.ok(from >= 0, 'missing #' + id); return html.slice(from, html.indexOf('<h2', from)); };

test('developer copy: native local test builds need current Jibo software, not a future release', () => enabled(() => {
  const routes = staticRoutes(), offenders = [];
  const check = (where, text) => { const pattern = WAITS_FOR_JIBO_RELEASE.find(p => p.test(text)); if (pattern) offenders.push(`${where}: ${text.match(pattern)[0]}`); };
  for (const page of developerPages()) {
    const html = get(routes['GET ' + page.path]).body;
    check(page.path, html);
    assert.doesNotMatch(html, /href="\/developers\/skills(?:\/|")/, page.path + ' links no held native guide route');
  }
  check('search index', get(routes['GET /developers/search.json']).body);
  for (const section of DEVELOPER_SECTIONS) if (section.closed) check(`${section.id} closed summary`, section.closed);
  // The dormant Skills menu note appears only when no skill page exists.
  const projectDir = mkdtempSync(join(tmpdir(), 'phx-developer-closed-'));
  try {
    mkdirSync(join(projectDir, 'docs/developers'), { recursive: true });
    cpSync(new URL('../../../docs/developers/index.md', import.meta.url), join(projectDir, 'docs/developers/index.md'));
    const landing = get(developerRoutes({ prepare: b => b, projectDir }).routes['GET /developers']).body;
    assert.match(landing, /<p class="dev-nav-note">/, 'the dormant Skills menu note is rendered');
    check('dormant Skills landing', landing);
  } finally { rmSync(projectDir, { recursive: true, force: true }); }
  assert.deepEqual(offenders, []);
  const testing = sectionHtml(get(routes['GET /developers/test']).body, 'skills-local-test-builds');
  for (const text of ['current software already supports native local test builds', '<strong>Allow test builds</strong>', '<strong>Settings → Developer testing</strong>',
    '<strong>Install full-access test</strong>', 'The native skill guide and its starters are not published on this site yet', 'reviewed and installed through the Skill Store']) assert.ok(testing.includes(text), text);
  const templates = sectionHtml(get(routes['GET /developers/templates']).body, 'skill-templates');
  assert.match(templates, /Native skill templates are not published on this site yet/);
  assert.match(templates, /href="\/developers\/test#skills-local-test-builds"/);
}));

test('developer routes: public portal is store-scoped and held skill reference stays absent', () => enabled(() => {
  const routes = staticRoutes();
  for (const page of developerPages()) assert.equal(get(routes['GET ' + page.path]).status, 200, page.path);
  assert.equal(routes['GET /developers/skills'], undefined);
  assert.equal(routes['GET /developers/skills/reference'], undefined);
  assert.equal(routes['GET /developers/downloads/jibo-skill-kit.zip'], undefined);
  assert.equal(routes['GET /developers/downloads/native-skill-kit.zip'], undefined);
  assert.equal(routes['GET /docs/SKILLS.md'], undefined);
  assert.equal(routes['GET /developers/../../package.json'], undefined);
  env({ PHOENIX_SKILL_STORE_ENABLED: undefined }, () => assert.equal(staticRoutes()['GET /developers'], undefined));
}));

test('developer routes: reference comes from markdown, has contents and unique anchors', () => enabled(() => {
  const html = get(staticRoutes()['GET /developers/themes/reference']).body;
  assert.match(html, /<table>/); assert.match(html, /theme\.json/); assert.match(html, /On this page/);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]); assert.equal(new Set(ids).size, ids.length);
  assert.ok(!/<script(?![^>]*src=)[^>]*>/.test(html), 'no inline scripts');
  assert.ok(!/ style=| on(?:click|load|error)=/.test(html), 'no inline styling or handlers');
}));

test('developer routes: every local link and fragment resolves to a registered target', () => enabled(() => {
  const routes = staticRoutes();
  for (const page of developerPages()) {
    const html = get(routes['GET ' + page.path]).body;
    for (const [, raw] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      if (/^https?:/.test(raw)) continue;
      const url = new URL(raw.replaceAll('&amp;', '&'), 'http://local' + page.path);
      if (url.pathname === '/apps') continue; // Hosted Store is a separate integration layer.
      assert.ok(routes['GET ' + url.pathname], page.path + ' → ' + raw);
      if (url.hash) {
        // /apps is a client-side console route.
        if (url.pathname === '/apps') continue;
        const target = url.pathname === page.path ? html : get(routes['GET ' + url.pathname]).body;
        assert.ok(target.includes('id="' + decodeURIComponent(url.hash.slice(1)) + '"'), page.path + ' → missing ' + raw);
      }
    }
  }
}));

test('developer routes: search indexes only registered public content and sends no private fields', () => enabled(() => {
  const res = get(staticRoutes()['GET /developers/search.json']);
  assert.match(res.headers['content-type'], /application\/json/);
  const rows = JSON.parse(res.body); assert.equal(rows.length, developerPages().length);
  for (const row of rows) { assert.deepEqual(Object.keys(row).sort(), ['path', 'text', 'title']); assert.ok(row.path.startsWith('/developers')); }
  assert.ok(!rows.some(r => r.path.startsWith('/developers/skills')));
}));

// These run the real guide/kit from this checkout or explicit sibling inputs;
// the release opt-in is set only inside the test process.
const GUIDE_PATHS = ['/developers/skills', '/developers/skills/workflow', '/developers/skills/cookbook', '/developers/skills/troubleshooting',
  '/developers/skills/reference', '/developers/skills/context', '/developers/skills/sdk'];
test('skill guide enabled: all seven pages render, every local link and fragment resolves, and search covers them', { skip: !hasSkillGuide && missingGuideReason }, () => nativeGuideEnabled(() => {
  const routes = staticRoutes(), pages = developerPages();
  assert.deepEqual(pages.filter(p => p.path.startsWith('/developers/skills')).map(p => p.path).sort(), [...GUIDE_PATHS].sort());
  for (const page of pages) {
    const res = get(routes['GET ' + page.path]), html = res.body;
    assert.equal(res.status, 200, page.path);
    assert.equal((html.match(/<h1\b/g) || []).length, 1, page.path);
    for (const [, raw] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      if (/^https?:/.test(raw)) continue;
      const url = new URL(raw.replaceAll('&amp;', '&'), 'http://local' + page.path);
      if (url.pathname === '/apps') continue; // Hosted Store is a separate integration layer.
      assert.ok(routes['GET ' + url.pathname], page.path + ' → ' + raw);
      if (url.hash && url.pathname !== '/apps') {
        const target = url.pathname === page.path ? html : get(routes['GET ' + url.pathname]).body;
        assert.ok(target.includes('id="' + decodeURIComponent(url.hash.slice(1)) + '"'), page.path + ' → missing ' + raw);
      }
    }
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]); assert.equal(new Set(ids).size, ids.length, page.path + ' unique ids');
    assert.doesNotMatch(html, /not published on this site yet/, page.path + ' no unpublished wording once the guide is enabled');
  }
  const rows = JSON.parse(get(routes['GET /developers/search.json']).body);
  for (const path of GUIDE_PATHS) assert.ok(rows.some(r => r.path === path), path + ' is searchable');
  // One guide in the menu: plain labels, no second skill format beside it.
  const landing = get(routes['GET /developers']).body;
  for (const label of ['Build a skill', 'Skill workflow', 'Skill cookbook', 'Skill troubleshooting', 'Skill manifests', 'App context', 'Jibo APIs']) assert.ok(landing.includes('>' + label + '<'), label);
  for (const label of ['Skill SDK', 'Jibo SDK', 'Hello Jibo example', 'Touchscreen apps', 'Skill API reference']) assert.ok(!landing.includes('>' + label + '<'), label);
  assert.match(landing, /Build skills in JavaScript with the skill kit, then try them on your own Jibo\./);
}));

test('skill guide enabled: contextual replacements link the one guide and kit download, never the old copy', { skip: !hasSkillGuide && missingGuideReason }, () => nativeGuideEnabled(() => {
  const routes = staticRoutes(), body = path => get(routes['GET ' + path]).body;
  const KIT = 'href="/developers/downloads/jibo-skill-kit.zip"';
  const landing = body('/developers');
  assert.match(landing, /<p class="dev-lede">Build a skill or a theme\. Start with working source, check it on your computer, then try it on your own Jibo\.<\/p>/);
  assert.match(landing, /<strong>Who this is for:<\/strong> anyone who wants to make something for Jibo: a skill to try on your own Jibo, or a theme to share through the Skill Store\./);
  const build = sectionHtml(landing, 'build-a-skill').replace(/&#39;/g, "'");
  for (const text of [KIT, 'href="/developers/skills">skill guide</a>', 'href="/developers/skills/cookbook"', "Publishing skills to the Skill Store isn't available yet", 'Themes can be published today']) assert.ok(build.includes(text), text);
  assert.match(body('/developers/skills'), /<a href="\/developers\/downloads\/jibo-skill-kit\.zip">Download the skill kit<\/a> and unzip it/);
  const testing = sectionHtml(body('/developers/test'), 'skills-local-test-builds');
  for (const text of ['current software already supports test builds of skills', '<strong>Allow test builds</strong>', '<strong>Settings → Developer testing</strong>',
    '<strong>Install full-access test</strong>', 'same full access as Jibo', 'href="/developers/skills"', KIT, 'href="/developers/skills/workflow"'])
    assert.ok(testing.replace(/&#39;/g, "'").includes(text), text);
  const templates = sectionHtml(body('/developers/templates'), 'skill-templates');
  assert.ok(templates.includes(KIT)); assert.match(templates, /four starters: <strong>hello<\/strong> \(the default\)/);
  assert.match(templates, /href="\/developers\/skills\/workflow#scaffold-a-starter"/);
  assert.doesNotMatch(body('/developers/templates'), /id="declarative-skill-starter"|hello-jibo/);
  const versions = sectionHtml(body('/developers/versions'), 'skill-authoring');
  assert.match(versions, /href="\/developers\/skills">skill guide<\/a>/); assert.ok(versions.includes(KIT));
  assert.match(versions, /Node 6\.5/);
  const publishing = body('/developers/publishing');
  assert.match(publishing, /share a theme with other Jibo owners through the Skill Store\. Publishing skills to the Skill Store isn(?:'|&#39;)t available yet/);
  assert.match(publishing, /<h2 id="4-upload-a-theme">4\. Upload a theme<\/h2>/);
  assert.match(publishing, /Skills made with the <a href="\/developers\/skills">skill kit<\/a> are not uploaded here/);
  assert.match(publishing, /Check a theme on your own Jibo before you list it/);
  assert.doesNotMatch(publishing, /phskill|Skill SDK|declarative/);
  // No enabled surface may claim local testing waits for a later Jibo release.
  const offenders = [];
  for (const page of developerPages()) for (const pattern of WAITS_FOR_JIBO_RELEASE) if (pattern.test(body(page.path))) offenders.push(page.path);
  if (WAITS_FOR_JIBO_RELEASE.some(p => p.test(get(routes['GET /developers/search.json']).body))) offenders.push('search index');
  assert.deepEqual(offenders, []);
}));

test('developer routes: canonical metadata uses configured origin and sitemap lists public docs', () => enabled(() => env({ PHOENIX_SITE_URL: 'https://synthetic.example' }, () => {
  const routes = staticRoutes();
  for (const page of developerPages()) {
    const html = get(routes['GET ' + page.path]).body;
    assert.ok(html.includes('href="https://synthetic.example' + page.path + '"'));
    assert.match(html, /twitter:card/); assert.ok(!html.includes('%SITE_URL%'));
    assert.ok(get(routes['GET /sitemap.xml']).body.includes('/developers'));
  }
})));

test('developer routes: operator landing override wins without changing repository content', () => enabled(() => {
  const before = readFileSync(new URL('../portal/index.html', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'phx-developer-pages-'));
  writeFileSync(join(dir, 'developers.html'), '<html><head><title>Operator</title></head><body>Operator developer page</body></html>');
  try { env({ PHOENIX_PAGES_DIR: dir }, () => assert.match(get(staticRoutes()['GET /developers']).body, /Operator developer page/)); }
  finally { rmSync(dir, { recursive: true, force: true }); }
  assert.deepEqual(readFileSync(new URL('../portal/index.html', import.meta.url)), before);
}));
