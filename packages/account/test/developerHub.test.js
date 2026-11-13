// The unified Developers area: one entry point with clear sections, reachable
// from the site's header and footer, and readable by search engines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { staticRoutes, developerPages } from './fixtures/developer-content.mjs';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const ORIGIN = 'https://synthetic.example';
const SECTIONS = ['Get started', 'Themes', 'Skills', 'Publish to the Skill Store', 'Test on your Jibo', 'Reference and API', 'Policies', 'Support'];

function env(values, fn) {
  const old = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
const enabled = (fn, extra = {}) => env({ PHOENIX_SKILL_STORE_ENABLED: 'true', PHOENIX_DEVELOPER_SKILLS_ENABLED: undefined, PHOENIX_PAGES_DIR: undefined, PHOENIX_BRANDING_FILE: undefined, PHOENIX_SITE_URL: undefined, ...extra }, fn);
function get(handler) {
  assert.equal(typeof handler, 'function', 'route is registered');
  const res = { headers: {}, writeHead(status, headers = {}) { this.status = status; this.headers = headers; }, end(bytes = '') { this.body = Buffer.from(bytes).toString(); } };
  handler({ req: { headers: {}, path: '/' }, res }); return res;
}
const between = (html, start, end) => { const from = html.indexOf(start); assert.ok(from >= 0, 'missing ' + start); const to = html.indexOf(end, from); return html.slice(from, to < 0 ? undefined : to); };
const attr = (html, pattern) => (pattern.exec(html) || [])[1];
const jsonLd = html => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => JSON.parse(m[1]));
const graph = html => jsonLd(html).flatMap(d => d['@graph'] || [d]);
const unescape = s => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const git = (cwd, args, date) => spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, HOME: cwd, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'synthetic@example.invalid', GIT_COMMITTER_NAME: 'Synthetic', GIT_COMMITTER_EMAIL: 'synthetic@example.invalid', ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) } });
const hasGit = git(REPO, ['--version']).status === 0;

test('developers: one entry point groups every required section in the documentation menu and on the landing page', () => enabled(() => {
  const routes = staticRoutes();
  const html = get(routes['GET /developers']).body;
  const menu = between(html, '<nav aria-label="Developer documentation">', '</nav>');
  assert.deepEqual([...menu.matchAll(/class="dev-nav-title"[^>]*>([^<]+)</g)].map(m => unescape(m[1])), SECTIONS);
  const main = between(html, '<main', '</main>');
  assert.deepEqual([...main.matchAll(/<h2 class="dev-area-title"[^>]*>([^<]+)</g)].map(m => unescape(m[1])), SECTIONS);
  for (const page of developerPages()) {
    assert.equal(menu.split(`href="${page.path}"`).length - 1, 1, page.path + ' appears once in the menu');
  }
}));

test('developers: breadcrumbs name the section once and never repeat a crumb', () => enabled(() => {
  const routes = staticRoutes();
  for (const page of developerPages()) {
    const crumbs = [...between(get(routes['GET ' + page.path]).body, '<nav class="dev-breadcrumb"', '</nav>').matchAll(/<li>(?:<a[^>]*>|<span[^>]*>)([^<]+)</g)].map(m => unescape(m[1]));
    assert.equal(crumbs[0], 'Developers', page.path);
    assert.equal(new Set(crumbs).size, crumbs.length, `${page.path}: ${crumbs.join(' / ')}`);
    if (page.path !== '/developers') assert.equal(crumbs.at(-1), page.title, page.path);
  }
}));

test('developers: the publisher dashboard is one click from every developer page and keeps its existing UI', () => enabled(() => {
  const routes = staticRoutes();
  const entry = get(routes['GET /developers/console']);
  assert.equal(entry.status, 302);
  assert.equal(entry.headers.location, '/apps#publisher');
  assert.match(entry.headers['x-robots-tag'], /noindex/);
  assert.match(entry.headers['cache-control'], /no-store/);
  const alias = get(routes['GET /developer']);
  assert.equal(alias.status, 301); assert.equal(alias.headers.location, '/developers');
  for (const page of developerPages()) {
    const header = between(get(routes['GET ' + page.path]).body, '<header class="dev-header"', '</header>');
    assert.match(header, /<a class="dev-publish" href="\/developers\/console"[^>]*>[\s\S]*Publisher dashboard/, page.path);
  }
  assert.match(between(get(routes['GET /developers']).body, '<main', '</main>'), /href="\/developers\/console"/);
  env({ PHOENIX_SKILL_STORE_ENABLED: undefined }, () => {
    const off = staticRoutes();
    assert.equal(off['GET /developers/console'], undefined); assert.equal(off['GET /developer'], undefined);
  });
}));

// Regression guard (passes before and after): no existing developer URL may become a 404.
test('developers: every developer URL that existed before the unified area still answers', () => enabled(() => {
  const routes = staticRoutes();
  for (const path of ['/developers', '/developers/themes', '/developers/themes/reference', '/developers/themes/api', '/developers/themes/surfaces', '/developers/themes/testing', '/developers/themes/releasing', '/developers/templates', '/developers/publishing', '/developers/policies', '/developers/versions', '/developers/support', '/developers/search.json', '/developers/assets/ember-preview.png', '/developers/assets/orbit-preview.png', '/developers.css', '/developers.js']) {
    assert.equal(get(routes['GET ' + path]).status, 200, path);
  }
}));

test('robots: /developers and its assets are explicitly allowed while the console entry and private routes stay disallowed', () => enabled(() => {
  const robots = get(staticRoutes()['GET /robots.txt']).body;
  assert.match(robots, /^Allow: \/developers$/m);
  const code = `import sys,json,urllib.robotparser,re
r=sys.stdin.read();p=urllib.robotparser.RobotFileParser();p.parse(r.splitlines())
public=['/developers','/developers/themes/reference','/developers/test','/developers/assets/ember-preview.png','/developers.css','/developers.js','/developers/search.json','/theme.css','/assets/og.png','/apps','/apps.js']
private=['/developers/console','/app','/admin','/api/skill-store/publisher','/member-photos/a']
rules=[]
for line in r.splitlines():
 k,_,v=line.partition(':');v=v.strip()
 if k.lower() in ['allow','disallow']:rules.append((k.lower()=='allow',v))
def anchored(path):
 matches=[(len(v.replace('$','')),allow) for allow,v in rules if re.match('^'+re.escape(v).replace('\\\\$','$').replace('\\\\*','.*'),path)]
 return max(matches,default=(0,True))[1]
for label,fn in [('prefix',lambda s:p.can_fetch('*','${ORIGIN}'+s)),('anchored',anchored)]:
 for path in public:assert fn(path),(label,path,'public blocked')
 for path in private:assert not fn(path),(label,path,'private allowed')
print('ok')`;
  const result = spawnSync('python3', ['-c', code], { input: robots, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  // Robots rules are not access control: the console pages themselves also say noindex.
  const routes = staticRoutes();
  for (const path of ['/app', '/admin', '/activate', '/reset', '/invite']) assert.match(get(routes['GET ' + path]).body, /<meta name="robots" content="noindex, nofollow"/, path);
  const entry = get(routes['GET /developers/console']);
  assert.match(entry.headers['x-robots-tag'], /noindex/);
}, { PHOENIX_SITE_URL: ORIGIN }));

test('sitemap: each developer page carries the last change date of its own source, and none without history', { skip: !hasGit && 'git is not available' }, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'phx-devhub-dates-'));
  try {
    for (const name of ['repo', 'plain']) {
      const dir = join(scratch, name);
      mkdirSync(join(dir, 'docs'), { recursive: true });
      cpSync(join(REPO, 'docs/developers'), join(dir, 'docs/developers'), { recursive: true });
      cpSync(join(REPO, 'docs/themes'), join(dir, 'docs/themes'), { recursive: true });
      for (const file of ['docs/THEMES.md', 'docs/BUNDLE-REVIEW.md']) cpSync(join(REPO, file), join(dir, file));
    }
    const repo = join(scratch, 'repo');
    assert.equal(git(repo, ['-c', 'init.defaultBranch=main', 'init', '-q']).status, 0);
    assert.equal(git(repo, ['add', '-A']).status, 0);
    assert.equal(git(repo, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'first'], '2026-09-01T10:00:00Z').status, 0);
    writeFileSync(join(repo, 'docs/developers/publishing.md'), readFileSync(join(repo, 'docs/developers/publishing.md'), 'utf8') + '\nA later synthetic edit.\n');
    assert.equal(git(repo, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-am', 'second'], '2026-10-05T08:30:00Z').status, 0);
    enabled(() => {
      const routes = staticRoutes({ developerProjectDir: repo });
      const xml = get(routes['GET /sitemap.xml']).body;
      assert.match(xml, /<loc>https:\/\/synthetic\.example\/developers\/publishing<\/loc><lastmod>2026-10-05T08:30:00\.000Z<\/lastmod>/);
      assert.match(xml, /<loc>https:\/\/synthetic\.example\/developers\/support<\/loc><lastmod>2026-09-01T10:00:00\.000Z<\/lastmod>/);
      assert.ok(!xml.includes('/developers/console'), 'the redirect entry is not a page');
      assert.match(get(routes['GET /developers/publishing']).body, /Updated <time datetime="2026-10-05T08:30:00\.000Z">5 October 2026<\/time>/);
    }, { PHOENIX_SITE_URL: ORIGIN });
    enabled(() => {
      const routes = staticRoutes({ developerProjectDir: join(scratch, 'plain') });
      const xml = get(routes['GET /sitemap.xml']).body;
      assert.match(xml, /\/developers\/publishing<\/loc>/);
      assert.ok(![...xml.matchAll(/\/developers[^<]*<\/loc>(<lastmod>)?/g)].some(m => m[1]), 'no invented date without history');
      assert.ok(!get(routes['GET /developers/publishing']).body.includes('Updated <time'));
    }, { PHOENIX_SITE_URL: ORIGIN });
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test('sitemap: the shipped portal lists every developer page once with the date git records for its source', { skip: !hasGit && 'git is not available' }, () => enabled(() => {
  const xml = get(staticRoutes()['GET /sitemap.xml']).body;
  for (const page of developerPages()) assert.equal(xml.split(`<loc>${ORIGIN}${page.path}</loc>`).length - 1, 1, page.path);
  const recorded = git(REPO, ['log', '-1', '--format=%cI', '--', 'docs/developers/support.md']).stdout.trim();
  if (recorded) assert.ok(xml.includes(`<loc>${ORIGIN}/developers/support</loc><lastmod>${new Date(recorded).toISOString()}</lastmod>`));
}, { PHOENIX_SITE_URL: ORIGIN }));

test('metadata: every developer page has its own title, description, canonical and OpenGraph, one h1 and says who it is for', () => enabled(() => {
  const routes = staticRoutes(), titles = new Set(), descriptions = new Set();
  for (const page of developerPages()) {
    const html = get(routes['GET ' + page.path]).body;
    const title = attr(html, /<title>([^<]+)<\/title>/), description = attr(html, /<meta name="description" content="([^"]+)"/);
    assert.ok(title && !titles.has(title), page.path + ' title unique'); titles.add(title);
    assert.ok(description && !descriptions.has(description), page.path + ' description unique'); descriptions.add(description);
    assert.equal(attr(html, /<link rel="canonical" href="([^"]+)"/), ORIGIN + page.path);
    assert.equal(attr(html, /<meta property="og:url" content="([^"]+)"/), ORIGIN + page.path);
    assert.equal(attr(html, /<meta property="og:site_name" content="([^"]+)"/), 'Phoenix');
    assert.equal(attr(html, /<meta property="og:type" content="([^"]+)"/), page.path === '/developers' ? 'website' : 'article');
    assert.match(html, /<meta name="robots" content="index, follow">/);
    assert.equal((html.match(/<h1\b/g) || []).length, 1, page.path + ' has one h1');
    const audience = attr(between(html, '<main', '</main>'), /<p class="dev-audience">([\s\S]*?)<\/p>/);
    assert.ok(audience && unescape(audience.replace(/<[^>]+>/g, '')).trim().length > 20, page.path + ' says who it is for');
  }
}, { PHOENIX_SITE_URL: ORIGIN }));

test('structured data: WebSite on the landing page, TechArticle on documents, BreadcrumbList everywhere, none without an origin', () => {
  enabled(() => {
    const routes = staticRoutes();
    for (const page of developerPages()) {
      const html = get(routes['GET ' + page.path]).body;
      const nodes = graph(html), crumbs = nodes.find(n => n['@type'] === 'BreadcrumbList');
      assert.ok(!/<script type="application\/ld\+json">[^<]*<(?!\/script>)/.test(html), 'markup inside JSON-LD is escaped');
      assert.ok(crumbs, page.path + ' breadcrumbs');
      assert.deepEqual(crumbs.itemListElement.map(i => i.position), crumbs.itemListElement.map((_, n) => n + 1));
      assert.equal(crumbs.itemListElement[0].item, ORIGIN + '/');
      assert.equal(crumbs.itemListElement.at(-1).item, ORIGIN + page.path);
      if (page.path === '/developers') {
        assert.ok(nodes.some(n => n['@type'] === 'WebSite' && n.url === ORIGIN + '/' && n['@id'] === ORIGIN + '/#website'));
      } else {
        const article = nodes.find(n => n['@type'] === 'TechArticle');
        assert.ok(article, page.path + ' TechArticle');
        assert.equal(article.url, ORIGIN + page.path);
        assert.equal(article.headline, unescape(attr(html, /<h1[^>]*>([\s\S]*?)<\/h1>/).replace(/<[^>]+>/g, '')));
        assert.equal(article.inLanguage, 'en'); assert.equal(article.isPartOf['@id'], ORIGIN + '/#website');
      }
    }
  }, { PHOENIX_SITE_URL: ORIGIN });
  enabled(() => {
    const routes = staticRoutes();
    for (const page of developerPages()) assert.ok(!get(routes['GET ' + page.path]).body.includes('application/ld+json'), page.path + ' claims no hosted identity');
  });
});

test('site navigation: repository pages link Developers in header and footer, visible without JavaScript', () => {
  // Built while the Store is enabled and served later, as a running service or preview does.
  const routes = enabled(() => staticRoutes());
  {
    for (const path of ['/', '/terms', '/privacy', '/security']) {
      const html = get(routes['GET ' + path]).body;
      for (const [label, scope] of [['header', between(html, '<nav class="site-nav"', '</nav>')], ['mobile', between(html, '<nav class="mobile-nav"', '</nav>')], ['footer', between(html, '<footer', '</footer>')]]) {
        const developers = [...scope.matchAll(/<a href="\/developers"([^>]*)>([^<]*)<\/a>/g)];
        assert.equal(developers.length, 1, `${path} ${label} links Developers once`);
        assert.equal(developers[0][2], 'Developers');
        assert.ok(!/\shidden\b/.test(developers[0][1]), `${path} ${label} Developers link is visible`);
        // Store navigation and its private UI are not integrated by this card.
      }
    }
  }
  // A self-hosted install without the Store keeps its navigation exactly as before.
  const plain = env({ PHOENIX_SKILL_STORE_ENABLED: undefined, PHOENIX_PAGES_DIR: undefined }, () => staticRoutes());
  enabled(() => {
    for (const path of ['/', '/terms']) {
      const html = get(plain['GET ' + path]).body;
      for (const [, attrs] of html.matchAll(/<a href="\/(?:developers|apps)"([^>]*)>/g)) assert.match(attrs, /\shidden\b/, path + ' store links stay hidden');
    }
  });
});

test('content: every Markdown link in a developer source becomes a link, including bare URLs', () => enabled(() => {
  const routes = staticRoutes();
  for (const page of developerPages()) {
    const html = get(routes['GET ' + page.path]).body;
    const prose = between(html, '<div class="dev-prose">', '<nav class="dev-pagination"');
    assert.ok(!prose.includes('&lt;http'), page.path + ' prints no raw <https://…> text');
    const source = readFileSync(join(REPO, page.source), 'utf8').replace(/(```|~~~)[\s\S]*?\1/g, '').replace(/`[^`\n]*`/g, '');
    for (const [, label] of source.matchAll(/(?<!!)\[([^\]\n]+)\]\([^\s)]+\)/g)) {
      const text = label.replace(/[*`]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      assert.ok(prose.includes(`>${text}</a>`), `${page.path}: "${label}" is rendered as a link`);
    }
  }
}));

test('content: the duplicate API4 guide is gone and the theme guide describes review before publication', () => {
  assert.equal(existsSync(join(REPO, 'docs/THEMES-API4.md')), false);
  const guide = readFileSync(join(REPO, 'docs/THEMES.md'), 'utf8');
  const submit = guide.split('\n## Submit to the Skill Store')[1]?.split('\n## ')[0];
  assert.ok(submit, 'the submission section is named for the Skill Store');
  assert.doesNotMatch(submit, /successful response returns a signed release wrapper/);
  assert.match(submit, /pending submission/); assert.match(submit, /operator reviews/);
});

// Regression guard (passes before and after): public pages never carry internal narration or private paths.
test('hygiene: developer pages contain no internal narration, private paths or unsubstituted placeholders', () => enabled(() => {
  const routes = staticRoutes();
  for (const page of developerPages()) {
    const html = get(routes['GET ' + page.path]).body;
    assert.doesNotMatch(html, /\b(?:lanes?|briefs?|workers?)\b/i, page.path);
    assert.doesNotMatch(html, /phoenix-private|\/home\/|%SITE_URL%/, page.path);
  }
}, { PHOENIX_SITE_URL: ORIGIN }));

test('search: the client index covers the new pages and is never indexed as a page itself', () => enabled(() => {
  const res = get(staticRoutes()['GET /developers/search.json']);
  assert.match(res.headers['x-robots-tag'] || '', /noindex/);
  const rows = JSON.parse(res.body);
  assert.deepEqual(rows.map(r => r.path), developerPages().map(p => p.path));
  for (const path of ['/developers/test', '/developers/review']) assert.ok(rows.some(r => r.path === path), path);
}));
