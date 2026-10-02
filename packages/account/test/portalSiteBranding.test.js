// The public site as the account service serves it: an instance's branding is
// rendered into the page before it leaves the server (link previews, crawlers
// and no-JS visitors see the instance, and nothing flashes), the sitemap names
// the operator's pages, and a mistyped page address gets the site's 404 page
// while every API client keeps the JSON envelope.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'phx-site-branding-'));
process.env.ETCO_account_dataFile = join(dir, 'store.json');

const { renderBrandedHtml } = await import('../src/brandRender.js');
const { renderSiteList } = await import('../portal/site-render.js');
const { staticRoutes, portalNotFound } = await import('../src/static.js');
const { createAccountService } = await import('../src/index.js');

const PORTAL = join(dirname(fileURLToPath(import.meta.url)), '../portal');
const DEFAULTS = JSON.parse(readFileSync(join(PORTAL, 'branding.json'), 'utf8'));
const INDEX = readFileSync(join(PORTAL, 'index.html'), 'utf8');

/** Run fn with environment variables set, restoring them afterwards. */
function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  try { return fn(); } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

/** Invoke a static route handler with a minimal req/res pair. */
function get(handler, path = '/', accept = 'text/html') {
  const res = {
    status: null,
    headers: null,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(chunk) { this.body = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? ''); },
  };
  handler({ req: { path, headers: { accept } }, res });
  return res;
}

let server;
let base;
before(async () => {
  server = await createAccountService().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

test('text, links and optional slots render with operator values escaped', () => {
  const html = '<html data-title-template="%s — the cloud" data-brand-description><head><title>Phoenix — the cloud</title>'
    + '<meta name="description" content="old" /><meta property="og:description" content="old" />'
    + '<meta property="og:site_name" content="Phoenix" /><meta property="og:title" content="Phoenix — the cloud" />'
    + '</head><body><h1 data-brand="hero.title">Default hero</h1>'
    + '<a data-brand="nav.guide" data-brand-attr="href:links.guide" data-brand-optional hidden></a>'
    + '<a data-brand="nav.missing" data-brand-optional hidden></a>'
    + '<a class="btn" href="/app" data-brand-attr="href:links.primaryCta"><span>Go</span></a>'
    + '<a href="#how" data-brand-attr="href:links.bad">Bad</a></body></html>';
  const out = renderBrandedHtml(html, {
    name: 'Jibo <Cloud>',
    description: 'A "quoted" & <b>bold</b> description',
    hero: { title: '<script>alert(1)</script>' },
    nav: { guide: 'Setup guide' },
    links: { guide: '/guide', primaryCta: '/guide', bad: 'javascript:alert(1)' },
  });

  assert.match(out, /<h1 data-brand="hero.title">&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/h1>/);
  assert.ok(!out.includes('<script>'), 'operator text is never markup');
  assert.match(out, /<a data-brand="nav.guide" data-brand-attr="href:links.guide" data-brand-optional href="\/guide">Setup guide<\/a>/);
  assert.match(out, /<a data-brand="nav.missing" data-brand-optional hidden><\/a>/, 'an undefined optional slot stays hidden');
  assert.match(out, /<a class="btn" href="\/guide" data-brand-attr="href:links.primaryCta"><span>Go<\/span><\/a>/,
    'an element with child markup keeps its children and gets its link');
  assert.match(out, /<a href="#how" data-brand-attr="href:links.bad">Bad<\/a>/, 'a javascript: link is refused');
  assert.match(out, /<title>Jibo &lt;Cloud&gt; — the cloud<\/title>/);
  assert.match(out, /<meta property="og:title" content="Jibo &lt;Cloud&gt; — the cloud" \/>/);
  assert.match(out, /<meta property="og:site_name" content="Jibo &lt;Cloud&gt;" \/>/);
  const escaped = 'A &quot;quoted&quot; &amp; &lt;b&gt;bold&lt;/b&gt; description';
  assert.ok(out.includes(`<meta name="description" content="${escaped}" />`));
  assert.ok(out.includes(`<meta property="og:description" content="${escaped}" />`));
});

test('configured lists render with the shared markup; unconfigured lists keep their default', () => {
  const html = '<div class="grid-cards" data-list="features"><article class="feature"><div class="feature-icon">'
    + '<svg><path d="M0"/></svg></div><h3>Default feature</h3></article></div>'
    + '<ul data-list="caveats"><li>Default caveat</li></ul>'
    + '<div class="terminal-body" data-list="steps"><div class="cmd-step">Default step</div></div>';
  const out = renderBrandedHtml(html, {
    features: { items: [{ icon: 'shield', title: 'Not <sold>', body: 'Kept here.' }, { body: 'no title, skipped' }] },
    install: { steps: [{ label: 'Then say', command: 'Hey Jibo, check for updates', prompt: '', copy: false }] },
  });
  assert.ok(!out.includes('Default feature'));
  assert.ok(out.includes('<h3>Not &lt;sold&gt;</h3><p>Kept here.</p>'));
  assert.ok(!out.includes('no title, skipped'));
  assert.ok(out.includes('<li>Default caveat</li>'), 'caveats were not configured');
  assert.ok(out.includes('<code>Hey Jibo, check for updates</code>'));
  assert.ok(!out.includes('copy-btn') && !out.includes('class="prompt"'), 'a phrase to say has no prompt or copy button');
  assert.ok(out.endsWith('</div>'), 'the host element is closed exactly once');
});

test('branded footer links are checked, and external ones open in a new tab', () => {
  const html = renderSiteList('footer-cols', { footer: { columns: [{ title: 'Links', links: [
    { label: 'Script', href: 'javascript:alert(1)' },
    { label: 'Source', href: 'https://github.com/Paskooter/phoenix' },
    { label: 'Terms', href: '/terms' },
  ] }] } });
  assert.ok(html.includes('<li><span>Script</span></li>'));
  assert.ok(html.includes('<a href="https://github.com/Paskooter/phoenix" target="_blank" rel="noopener">Source</a>'));
  assert.ok(html.includes('<a href="/terms">Terms</a>'));
});

test('FAQ actions follow the instance link and keep branding text and URLs safe', () => {
  const html = renderSiteList('faq', {
    links: { discord: 'https://discord.gg/instance-community', unsafe: 'javascript:alert(1)' },
    faq: { items: [
      { q: 'Plain question', a: 'Plain answer' },
      { q: 'Need help?', a: 'Ask other owners.', cta: { label: 'Join <our> community', hrefFrom: 'links.discord' } },
      { q: 'Unsafe link?', a: 'No script.', cta: { label: 'Unsafe', hrefFrom: 'links.unsafe' } },
      { q: 'Missing link?', a: 'No destination.', cta: { label: 'Missing', hrefFrom: 'links.missing' } },
    ] },
  });
  assert.ok(html.includes('<p>Plain answer</p></div></details>'), 'plain FAQ items retain their markup');
  assert.ok(html.includes('<a href="https://discord.gg/instance-community" class="btn btn-ghost btn-sm" target="_blank" rel="noopener">Join &lt;our&gt; community</a>'));
  assert.ok(!html.includes('javascript:') && !html.includes('<our>'));
  assert.ok(html.includes('<span>Unsafe</span>') && html.includes('<span>Missing</span>'));
});

test('the shipped landing page renders completely and idempotently from its own defaults', () => {
  const once = renderBrandedHtml(INDEX, DEFAULTS);
  assert.equal(renderBrandedHtml(once, DEFAULTS), once, 'rendering a rendered page changes nothing');

  // Every text slot the defaults define is rendered server-side. A slot that
  // gains child markup would silently fall back to the browser pass.
  const pick = (path) => path.split('.').reduce((value, key) => value?.[key], DEFAULTS);
  const slots = [...INDEX.matchAll(/data-brand="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(slots.length > 30);
  for (const path of new Set(slots)) {
    const value = pick(path);
    if (typeof value !== 'string') continue;
    const escaped = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    assert.ok(new RegExp(`data-brand="${path.replace(/\./g, '\\.')}"[^>]*>${escaped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<`).test(once),
      `slot ${path} is rendered`);
  }
  // The shipped footer and its branding agree: three columns either way.
  assert.equal((once.match(/class="footer-col"/g) || []).length, 3);

  for (const file of ['app.html', 'terms.html', 'privacy.html', 'security.html', '404.html']) {
    const source = readFileSync(join(PORTAL, file), 'utf8');
    const rendered = renderBrandedHtml(source, DEFAULTS);
    assert.equal(renderBrandedHtml(rendered, DEFAULTS), rendered, `${file} renders idempotently`);
    assert.equal(rendered.split('<').length, source.split('<').length, `${file} gains or loses no tags`);
  }
});

test('the account service serves the instance page, its sitemap and robots file', () => {
  const instance = join(dir, 'instance');
  mkdirSync(join(instance, 'pages'), { recursive: true });
  writeFileSync(join(instance, 'branding.json'), JSON.stringify({
    description: 'A public revival.',
    hero: { title: 'Instance hero' },
  }));
  writeFileSync(join(instance, 'pages', 'guide.html'),
    '<html data-title-template="Guide — %s"><head><title>Guide</title></head>'
    + '<body><span data-brand="wordmark">Default</span></body></html>');

  withEnv({
    PHOENIX_BRANDING_FILE: join(instance, 'branding.json'),
    PHOENIX_PAGES_DIR: join(instance, 'pages'),
    PHOENIX_SITE_URL: 'https://robots.example',
  }, () => {
    const routes = staticRoutes();

    const home = get(routes['GET /']);
    assert.equal(home.status, 200);
    assert.ok(home.body.includes('<span data-brand="hero.title">Instance hero</span>'));
    assert.ok(home.body.includes('<meta property="og:description" content="A public revival." />'));
    assert.ok(home.body.includes('<link rel="canonical" href="https://robots.example/" />'));
    assert.ok(home.body.includes(`<h3>${DEFAULTS.features.items[0].title}</h3>`), 'lists fall back to the defaults');

    const privacy = get(routes['GET /privacy']);
    assert.ok(!privacy.body.includes('A public revival.'), 'a page with its own description keeps it');

    const guide = get(routes['GET /guide']);
    assert.ok(guide.body.includes('<span data-brand="wordmark">Phoenix</span>'), 'operator pages are branded too');
    assert.ok(guide.body.includes('<title>Guide — Phoenix</title>'));

    const branding = JSON.parse(get(routes['GET /branding.json']).body);
    assert.equal(branding.hero.title, 'Instance hero');
    assert.equal(branding.features.items.length, DEFAULTS.features.items.length);

    const sitemap = get(routes['GET /sitemap.xml']).body;
    assert.ok(sitemap.includes('<loc>https://robots.example/</loc>'));
    assert.ok(sitemap.includes('<loc>https://robots.example/guide</loc>'), 'the operator guide is listed');
    assert.equal((sitemap.match(/\/terms<\/loc>/g) || []).length, 1, 'a page is never listed twice');
    assert.ok(!sitemap.includes('%SITE_URL%'));

    assert.match(get(routes['GET /robots.txt']).body, /^Sitemap: https:\/\/robots\.example\/sitemap\.xml$/m);
  });
});

test('a mistyped page gets the 404 page; every other unmatched request keeps the JSON envelope', async () => {
  const page = await fetch(`${base}/no-such-page`, { headers: { accept: 'text/html,application/xhtml+xml' } });
  assert.equal(page.status, 404);
  assert.match(page.headers.get('content-type'), /^text\/html/);
  assert.match(await page.text(), /<p class="code grad">404<\/p>/);

  for (const [path, accept] of [['/no-such-page', 'application/json'], ['/no-such-page', '*/*'], ['/api/no-such-route', 'text/html']]) {
    const res = await fetch(`${base}${path}`, { headers: { accept } });
    assert.equal(res.status, 404, `${path} (${accept})`);
    const body = await res.json();
    assert.equal(body.type, 'ERROR');
    assert.equal(body.data.message, `URL not found: ${path}`);
  }

  // The catch-all is last: real pages and API routes are unaffected.
  assert.equal((await fetch(`${base}/`, { headers: { accept: 'text/html' } })).status, 200);
  assert.equal((await fetch(`${base}/api/me`)).status, 401);

  const handler = portalNotFound();
  assert.throws(() => get(handler, '/x', 'application/json'), (error) => error.statusCode === 404);
});
