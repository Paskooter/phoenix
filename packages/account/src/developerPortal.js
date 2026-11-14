import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMarkdown, escapeHtml as esc } from './developerMarkdown.js';
import { jsonLdScript } from './seo.js';
import { STARTER_DIR, STARTER_FILES, starterFiles, starterZip, SKILL_KIT_FILES, skillKitZip } from './developerStarter.js';

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const SOURCE = 'https://github.com/Paskooter/phoenix';

// One Developers area. These sections are the documentation menu, the landing
// page and the breadcrumbs, so a page is always found in the same place.
export const DEVELOPER_SECTIONS = Object.freeze([
  { id: 'start', title: 'Get started', summary: 'What you can make for Jibo today, and working projects to start from.' },
  { id: 'themes', title: 'Themes', summary: 'Change how Jibo’s menus look: colours, pictures, fonts and layout.' },
  { id: 'skills', title: 'Skills', summary: 'Build data-only cards, buttons and speech with the Skill SDK and runnable starter.',
    open: 'Build skills in JavaScript with the skill kit, then try them on your own Jibo.',
    closed: 'Native apps for Jibo. Jibo’s current software supports native local test builds; the native skill guide and starters are not published on this site yet.' },
  { id: 'publish', title: 'Publish to the Skill Store', summary: 'Apply once, submit each version for review, then choose when owners can find it.' },
  { id: 'test', title: 'Test on your Jibo', summary: 'Try your work on your own Jibo, and get back to Default at any time.' },
  { id: 'reference', title: 'Reference and API', summary: 'Exact manifest fields, API versions, limits and the upload contract.' },
  { id: 'policies', title: 'Policies', summary: 'What you may publish, how to describe it, and the service’s terms.' },
  { id: 'support', title: 'Support', summary: 'Where to ask for help, and what to include so someone can answer.' },
]);

const page = (path, section, title, source, description, extra = {}) => Object.freeze({ path, section, title, source, description, ...extra });
// Registry order within a section is menu order. Only these fixed sources can become routes.
const PAGES = Object.freeze([
  page('/developers', 'start', 'Overview', 'docs/developers/index.md', 'Build themes for Jibo, test them on your own robot and publish them to the Skill Store: guides, templates, reference and help in one place.', { metaTitle: 'Build for Jibo' }),
  page('/developers/skill-sdk', 'skills', 'Skill SDK', 'docs/developers/skill-sdk.md', 'Build and submit a third-party touchscreen skill: architecture, manifests, permissions, local checks and exact-bundle review.'),
  page('/developers/skill-example', 'skills', 'Hello Jibo example', 'docs/developers/skill-example.md', 'Download a runnable complete Hello Jibo starter, with skill.json, computer preview and tests.'),
  page('/developers/touchscreen-apps', 'skills', 'Touchscreen apps', 'docs/developers/touchscreen-apps.md', 'Design cards, speech and button navigation for Jibo with the data-only declarative skill format.'),
  page('/developers/skill-api', 'reference', 'Skill API reference', 'docs/developers/skill-api.md', 'Exact declarative manifest fields, actions, limits, supported APIs and publisher and administrator HTTP contracts.'),
  page('/developers/templates', 'start', 'Templates', 'docs/developers/templates.md', 'Start from Ember or Orbit, the original open theme templates, or from a starter that shows one feature.'),
  page('/developers/themes', 'themes', 'Start a theme', 'docs/developers/themes.md', 'Make your first Jibo menu theme with the Phoenix theme kit: copy a template, change the menus, check and pack.'),
  page('/developers/themes/surfaces', 'themes', 'Theme surfaces', 'docs/themes/SURFACES.md', 'Every surface a Jibo theme can replace, and the controls that always stay native.'),
  page('/developers/themes/releasing', 'themes', 'Theme releases', 'docs/themes/PUBLISHING.md', 'Package, upload and update a Jibo theme: upload limits, refusals and interrupted uploads.'),
  page('/developers/publishing', 'publish', 'Publishing guide', 'docs/developers/publishing.md', 'Publisher approval, app identities, uploads, review and public Skill Store listings, step by step.', { metaTitle: 'Publish to the Skill Store' }),
  page('/developers/review', 'publish', 'How review works', 'docs/BUNDLE-REVIEW.md', 'How each submitted Skill Store version is reviewed before publication, and the review API operator tools use.'),
  page('/developers/test', 'test', 'Test on your Jibo', 'docs/developers/testing.md', 'Try a theme on your own Jibo, return to Default, and what local test builds of skills need.'),
  page('/developers/themes/testing', 'test', 'Test a theme', 'docs/themes/TESTING.md', 'The local check, accessibility checklist and hardware checklist for a Jibo theme.'),
  page('/developers/themes/reference', 'reference', 'Theme reference', 'docs/THEMES.md', 'Manifest fields, assets, icon roles, limits and commands for Jibo menu themes.', { metaTitle: 'Theme manifest reference' }),
  page('/developers/themes/api', 'reference', 'Theme API fields', 'docs/themes/REFERENCE.md', 'Theme API versions 1 to 4, their extension fields and the eye and face asset rules.'),
  page('/developers/versions', 'reference', 'Software & APIs', 'docs/developers/versions.md', 'How authoring tools, theme APIs and the software installed on Jibo fit together.', { metaTitle: 'Software and API versions' }),
  page('/developers/policies', 'policies', 'Release checklist', 'docs/developers/policies.md', 'Rights, attribution, permissions and an honest listing: check these before every release.'),
  page('/developers/support', 'support', 'Get help', 'docs/developers/support.md', 'Get help with authoring or publishing a project for Jibo, and what to include in a support ticket.'),
]);
const SKILL_PAGES = Object.freeze([
  page('/developers/skills', 'skills', 'Build a skill', 'docs/SKILLS.md', 'Build a JavaScript skill for Jibo with the skill kit, then test it on your own Jibo and confirm the install on his screen.'),
  page('/developers/skills/workflow', 'skills', 'Skill workflow', 'docs/skills/WORKFLOW.md', 'Choose a starter, then check, pack, install on your own Jibo, test and debug your skill.'),
  page('/developers/skills/cookbook', 'skills', 'Skill cookbook', 'docs/skills/COOKBOOK.md', 'Short recipes using the runnable skill starters.'),
  page('/developers/skills/troubleshooting', 'skills', 'Skill troubleshooting', 'docs/skills/TROUBLESHOOTING.md', 'Understand skill kit messages and test-build refusals.'),
  page('/developers/skills/reference', 'reference', 'Skill manifests', 'docs/skills/MANIFESTS.md', 'Skill project, app.json and test container fields.'),
  page('/developers/skills/context', 'reference', 'App context', 'docs/skills/CONTEXT.md', 'Skill lifecycle, app context and service handles.'),
  page('/developers/skills/sdk', 'reference', 'Jibo APIs', 'docs/skills/SDK.md', 'The Jibo APIs available to skills: screens, speech, listening, motion and more.'),
]);
// The older data-only skill format stays an internal implementation for existing
// Skill Store releases. Once the skill guide is published, its authoring pages
// leave the documentation and send visitors to the guide instead.
const DATA_ONLY_PAGES = Object.freeze(['/developers/skill-sdk', '/developers/skill-example', '/developers/touchscreen-apps', '/developers/skill-api']);
// Links that leave the documentation, shown on the landing page.
const SECTION_LINKS = Object.freeze({
  publish: [{ href: '/developers/console', label: 'Open the publisher dashboard', away: true }],
  policies: [{ href: '/terms', label: 'Terms' }, { href: '/privacy', label: 'Privacy' }, { href: '/security', label: 'Security' }],
});
const sectionIndex = id => DEVELOPER_SECTIONS.findIndex(s => s.id === id);
const SKILL_KIT_DOWNLOAD = '/developers/downloads/jibo-skill-kit.zip';
// The landing page's overview is generated from this registry, so its content
// changes with this file as well as with its own Markdown.
const REGISTRY = 'packages/account/src/developerPortal.js';

export function developerPages({ projectDir = PROJECT } = {}) {
  const present = p => existsSync(join(projectDir, p.source)) && (p.path !== '/developers/skill-example'
    || STARTER_FILES.every(file => existsSync(join(projectDir, STARTER_DIR, file))));
  let pages = PAGES.filter(present);
  // A source merge is not permission to launch the held skill documentation.
  // Only fixed source paths can become routes, and the release opt-in is explicit.
  // The guide links its kit download, so every fixed kit file must be present too.
  if (process.env.PHOENIX_DEVELOPER_SKILLS_ENABLED === 'true' && SKILL_PAGES.every(present)
    && SKILL_KIT_FILES.every(file => existsSync(join(projectDir, file)))) {
    pages = pages.filter(p => !DATA_ONLY_PAGES.includes(p.path));
    pages.push(...SKILL_PAGES);
  }
  return pages.map((p, order) => ({ p, order })).sort((a, b) => sectionIndex(a.p.section) - sectionIndex(b.p.section) || a.order - b.order).map(x => x.p);
}

/**
 * The time each source last changed, from the commits that record it. A copy
 * without Git history gets no dates: never the startup time or a guess.
 */
function sourceDates(projectDir, sources) {
  const dates = new Map();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const deadline = Date.now() + 5000;
  for (const file of new Set(sources)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      // Stop at the first change to this file. Walking the full repository
      // history can time out even after Git has printed every date we need.
      const date = execFileSync('git', ['-C', projectDir, 'log', '-1', '--no-renames', '--format=%cI', '--', file],
        { encoding: 'utf8', env, timeout: remaining, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const time = Date.parse(date);
      if (Number.isFinite(time)) dates.set(file, new Date(time).toISOString());
    } catch { /* No history, unavailable Git, or the shared lookup budget expired. */ }
  }
  return dates;
}

// Older pages may name the held native guide. Until its release opt-in registers
// that page, the link points to the published explanation of local test builds.
const HELD_GUIDE_FALLBACK = '/developers/test#skills-local-test-builds';

function documentLink(href, source, pages) {
  if (href.startsWith('#')) return href;
  const path = href.split('#')[0];
  if (SKILL_PAGES.some(p => p.path === path) && !pages.some(p => p.path === path)) {
    return pages.some(p => p.path === HELD_GUIDE_FALLBACK.split('#')[0]) ? HELD_GUIDE_FALLBACK : null;
  }
  if (/^(?:\/|https?:)/.test(href)) return href;
  const [file, fragment] = href.split('#');
  const normalized = posix.normalize(posix.join(posix.dirname(source), file));
  const target = pages.find(p => p.source === normalized);
  if (target) return target.path + (fragment ? '#' + fragment : '');
  if (['themes/README.md', 'docs/OPERATIONS.md', 'docs/RUNBOOK.md', 'tools/skill-kit/README.md'].includes(normalized)) return `${SOURCE}/blob/main/${normalized}${fragment ? '#' + fragment : ''}`;
  return null;
}

const DATE_FORMAT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const sectionOf = p => DEVELOPER_SECTIONS.find(s => s.id === p.section);
const away = '<span class="dev-away" aria-hidden="true">↗</span>';
const RESERVED_IDS = [...DEVELOPER_SECTIONS.flatMap(s => [`nav-${s.id}`, `area-${s.id}`, `area-${s.id}-title`])];

function navigation(pages, current, skillsOpen) {
  return DEVELOPER_SECTIONS.map(section => {
    const own = pages.filter(p => p.section === section.id);
    const links = own.map(p => `<li><a href="${p.path}"${p.path === current ? ' aria-current="page"' : ''}>${esc(p.title)}</a></li>`);
    if (section.id === 'publish') links.push(`<li><a class="dev-nav-away" href="/developers/console">Publisher dashboard ${away}</a></li>`);
    const note = section.id === 'skills' && !skillsOpen && !own.length ? '<p class="dev-nav-note">Skill guides are not published yet.</p>' : '';
    if (!links.length && !note) return '';
    return `<div class="dev-nav-group"><p class="dev-nav-title" id="nav-${section.id}">${esc(section.title)}</p>${note}${links.length ? `<ul aria-labelledby="nav-${section.id}">${links.join('')}</ul>` : ''}</div>`;
  }).join('');
}

function landingAreas(pages, skillsOpen) {
  return `<div class="dev-area-grid">${DEVELOPER_SECTIONS.map(section => {
    const links = pages.filter(p => p.section === section.id && p.path !== '/developers').map(p => ({ href: p.path, label: p.title }));
    links.push(...(SECTION_LINKS[section.id] || []));
    if (section.id === 'skills' && !skillsOpen && !links.length) links.push({ href: '/developers/versions#skill-authoring', label: 'When skills open' });
    const summary = section.id === 'skills' && !skillsOpen && !links.length ? section.closed : skillsOpen && section.open || section.summary;
    return `<section class="dev-area" id="area-${section.id}" aria-labelledby="area-${section.id}-title"><h2 class="dev-area-title" id="area-${section.id}-title">${esc(section.title)}</h2><p>${esc(summary)}</p>${links.length ? `<ul>${links.map(l => `<li><a href="${esc(l.href)}">${esc(l.label)}${l.away ? ' ' + away : ''}</a></li>`).join('')}</ul>` : ''}</section>`;
  }).join('')}</div>`;
}

function structuredData(page, { origin, brandName, heading, modified }) {
  if (!origin) return '';
  const url = origin + page.path, site = `${origin}/#website`;
  const crumbs = [{ name: brandName, item: `${origin}/` }, { name: 'Developers', item: `${origin}/developers` }];
  if (page.path !== '/developers') crumbs.push({ name: page.title, item: url });
  const graph = [{ '@type': 'BreadcrumbList', itemListElement: crumbs.map((c, n) => ({ '@type': 'ListItem', position: n + 1, ...c })) }];
  if (page.path === '/developers') graph.unshift({ '@type': 'WebSite', '@id': site, name: brandName, url: `${origin}/` });
  else graph.unshift({ '@type': 'TechArticle', '@id': `${url}#article`, headline: heading, description: page.description, url, inLanguage: 'en',
    isPartOf: { '@id': site }, ...(modified ? { dateModified: modified } : {}),
    author: { '@type': 'Organization', name: 'Phoenix', url: SOURCE },
    publisher: { '@type': 'Organization', '@id': `${origin}/#organization`, name: brandName, url: `${origin}/` } });
  return jsonLdScript({ '@context': 'https://schema.org', '@graph': graph });
}

function shell(page, pages, article, headings, { origin, brandName, modified, skillsOpen }) {
  if (page.path === '/developers/templates') {
    const cards = /(<h2 id="ember">[\s\S]*?)(?=<h2 id="make-the-project-yours">)/.exec(article);
    if (cards) {
      const parts = cards[1].split(/(?=<h2 id="orbit">)/);
      article = article.replace(cards[1], '<div class="dev-template-grid">' + parts.map((part, n) => `<section class="dev-template-card"><img src="/developers/assets/${n ? 'orbit' : 'ember'}-preview.png" alt="${n ? 'Orbit sliding-card' : 'Ember native-button'} template artwork" width="360" height="360">${part}</section>`).join('') + '</div>');
    }
  }
  // The paragraph that says who a page is for opens with "Who this is for:".
  article = article.replace(/<p>(<strong>Who this is for:<\/strong>)/, '<p class="dev-audience">$1');
  const landing = page.path === '/developers';
  const heading = headings.find(h => h.level === 1);
  const section = sectionOf(page);
  const title = `${page.metaTitle || page.title} · Developers — Phoenix`;
  const updated = modified ? `<time datetime="${esc(modified)}">${esc(DATE_FORMAT.format(new Date(modified)))}</time>` : '';
  let rest = article;
  if (landing) {
    const lede = /^<h1[^>]*>[\s\S]*?<\/h1>\n?<p>([\s\S]*?)<\/p>\n?/.exec(article);
    rest = lede ? article.slice(lede[0].length) : article.replace(/^<h1[^>]*>[\s\S]*?<\/h1>\n?/, '');
    const audience = /^<p class="dev-audience">[\s\S]*?<\/p>\n?/.exec(rest);
    if (audience) rest = rest.slice(audience[0].length);
    const start = skillsOpen ? '/developers/skills' : '/developers/skill-sdk';
    const commands = skillsOpen
      ? '<span class="dev-code-comment"># Make a skill from the hello starter</span>\nnode tools/skill-kit/cli.mjs new my-skill\n\n<span class="dev-code-comment"># Check it, then try it on your Jibo</span>\nnode tools/skill-kit/cli.mjs check my-skill\nnode tools/skill-kit/cli.mjs install my-skill --robot my-jibo'
      : '<span class="dev-code-comment"># Make a runnable starter</span>\nnode tools/skill-kit/cli.mjs new ./hello-jibo\n\n<span class="dev-code-comment"># Check and test on your computer</span>\nnode tools/skill-kit/cli.mjs check ./hello-jibo\nnode tools/skill-kit/cli.mjs test ./hello-jibo';
    const next = skillsOpen ? `<a href="${SKILL_KIT_DOWNLOAD}">Download the skill kit <span aria-hidden="true">→</span></a>` : '<a href="/developers/skill-example">Open the complete example <span aria-hidden="true">→</span></a>';
    rest = `<section class="dev-hero" aria-labelledby="${esc(heading.id)}"><div class="dev-hero-copy"><p class="dev-label">PHOENIX DEVELOPERS</p><h1 id="${esc(heading.id)}">${esc(heading.text)}</h1><p class="dev-lede">${lede ? lede[1] : ''}</p>${audience ? audience[0] : ''}<div class="dev-actions"><a class="btn btn-primary" href="${start}">Start a skill <span aria-hidden="true">→</span></a><a class="btn btn-ghost" href="/developers/console">Publisher dashboard ${away}</a></div></div><div class="dev-workbench"><div class="dev-workbench-head"><span>Your first skill</span><span>LOCAL AUTHORING</span></div><pre tabindex="0" role="region" aria-label="Skill kit commands"><code>${commands}</code></pre>${next}</div></section>${landingAreas(pages, skillsOpen)}${rest}`;
  }
  const contents = headings.filter(h => h.level === 2);
  if (!landing && contents.length) {
    const links = contents.map(h => `<a href="#${esc(h.id)}">${esc(h.text)}</a>`).join('');
    rest = rest.replace('</h1>', `</h1><details class="dev-mobile-toc"><summary>On this page</summary><nav aria-label="Article contents">${links}</nav></details>`);
  }
  const pageIndex = pages.findIndex(p => p.path === page.path);
  const adjacent = [pages[pageIndex - 1], pages[pageIndex + 1]];
  const crumbs = [`<li><a href="/developers"${landing ? ' aria-current="page"' : ''}>Developers</a></li>`];
  if (!landing && section.title !== page.title) crumbs.push(`<li><a href="/developers#area-${section.id}">${esc(section.title)}</a></li>`);
  if (!landing) crumbs.push(`<li><span aria-current="page">${esc(page.title)}</span></li>`);
  return `<!doctype html>
<html lang="en" data-title-template="${esc(page.metaTitle || page.title)} · Developers — %s"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(page.description)}"><meta name="robots" content="index, follow"><meta name="color-scheme" content="dark light">
<link rel="canonical" href="%SITE_URL%${page.path}">
<meta property="og:type" content="${landing ? 'website' : 'article'}"><meta property="og:site_name" content="Phoenix"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(page.description)}"><meta property="og:url" content="%SITE_URL%${page.path}"><meta property="og:image" content="%SITE_URL%/assets/og.png"><meta property="og:image:type" content="image/png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">${!landing && modified ? `<meta property="article:modified_time" content="${esc(modified)}">` : ''}<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(page.description)}"><meta name="twitter:image" content="%SITE_URL%/assets/og.png">
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/developers.css"><script src="/developers.js" defer></script>
${structuredData(page, { origin, brandName, heading: heading?.text || page.title, modified })}</head><body class="developer-page">
<a class="skip-link" href="#dev-main">Skip to content</a>
<header class="dev-header"><div class="dev-header-inner"><a class="dev-wordmark" href="/" data-brand="wordmark">Phoenix</a><span class="dev-header-divider" aria-hidden="true">/</span><a class="dev-section" href="/developers">Developers</a><nav aria-label="Site"><a class="dev-store" href="/apps">Skill Store</a><a class="dev-publish" href="/developers/console" aria-label="Publisher dashboard"><span class="dev-wide">Publisher dashboard</span><span class="dev-narrow" aria-hidden="true">Dashboard</span> ${away}</a><button type="button" id="dev-theme" aria-label="Switch color theme">◐</button></nav></div></header>
<div class="dev-layout">
<aside class="dev-sidebar" aria-label="Documentation menu"><details class="dev-menu" open><summary>Developer documentation</summary><div class="dev-menu-body"><nav aria-label="Developer documentation">${navigation(pages, page.path, skillsOpen)}</nav><div class="dev-sidebar-bottom"><span class="dev-label">SKILL &amp; THEME KITS</span><p>Authoring · Node.js 20+</p><a href="/developers/versions">Compatibility guide <span aria-hidden="true">→</span></a></div></div></details></aside>
<div class="dev-center"><div class="dev-toolbar"><nav class="dev-breadcrumb" aria-label="Breadcrumb"><ol>${crumbs.join('')}</ol></nav><search class="dev-search" hidden><label for="dev-search-input" class="sr-only">Search documentation</label><input id="dev-search-input" type="search" placeholder="Search documentation" autocomplete="off"><div id="dev-search-results" hidden><p id="dev-search-status" role="status" aria-live="polite"></p><ul></ul></div></search></div>
<main id="dev-main" tabindex="-1" class="${landing ? 'dev-landing' : 'dev-document'}">
${landing ? '' : `<div class="dev-article-meta"><span>${esc(section.title.toUpperCase())}</span>${updated ? `<span class="dev-updated">Updated ${updated}</span>` : ''}</div>`}
<div class="dev-prose">${rest}</div>
<nav class="dev-pagination" aria-label="Next documentation page">${adjacent.map((p, n) => p ? `<a href="${p.path}"><span>${n ? 'NEXT' : 'PREVIOUS'}</span>${esc(p.title)} <span aria-hidden="true">${n ? '→' : '←'}</span></a>` : '<span></span>').join('')}</nav>
</main><footer class="dev-footer"><p>Build thoughtfully. Make it yours.</p><nav aria-label="Developer footer"><a href="/">Home</a><a href="/apps">Skill Store</a><a href="/developers/support">Get help</a><a href="/terms">Terms</a><a href="/privacy">Privacy</a><a href="/security">Security</a></nav></footer></div>
${!landing && contents.length ? `<aside class="dev-toc" aria-label="Page contents"><p class="dev-label">ON THIS PAGE</p><nav aria-label="On this page">${contents.map(h => `<a href="#${esc(h.id)}">${esc(h.text)}</a>`).join('')}</nav><a class="dev-toc-source" href="${SOURCE}">Phoenix source ↗</a></aside>` : ''}
</div></body></html>`;
}

function contextualContent(page, source, pages, projectDir) {
  if (page.path === '/developers/skill-example') {
    for (const file of starterFiles(projectDir).filter(f => ['skill.json', 'index.js', 'test.mjs'].includes(f.path))) {
      const language = file.path.endsWith('.json') ? 'json' : 'js';
      source += `\n\n## ${file.path}\n\n~~~${language}\n${file.bytes.toString('utf8')}~~~\n`;
    }
  }
  const skillsOpen = pages.some(p => p.path === '/developers/skills');
  // Each replacement below has a regression test that fails if its anchor text drifts.
  // With the skill guide published there is one way to build a skill: its guide and its kit.
  const section = (heading, body) => { source = source.replace(new RegExp(`## ${heading}[\\s\\S]*?(?=\\n##|$)`), `## ${heading}\n\n${body}\n`); };
  if (skillsOpen && page.path === '/developers') {
    source = source.replace('Build a skill, a touchscreen app or a theme. Start with working source, test on your computer, then submit your version for review.',
      'Build a skill or a theme. Start with working source, check it on your computer, then try it on your own Jibo.');
    source = source.replace('**Who this is for:** anyone who wants to make something for Jibo, from a first touchscreen skill or theme to a published Skill Store listing.',
      '**Who this is for:** anyone who wants to make something for Jibo: a skill to try on your own Jibo, or a theme to share through the Skill Store.');
    section('Build a skill', `Write a skill in JavaScript with the [skill kit](${SKILL_KIT_DOWNLOAD}). Start from a working starter, check and pack it on your computer, then install it on your own Jibo as a test build and confirm it on his screen. The [skill guide](/developers/skills) walks through every step, and the [skill cookbook](/developers/skills/cookbook) has short recipes.\n\nPublishing skills to the Skill Store isn't available yet. Themes can be published today.\n\n[Software and API versions](/developers/versions)`);
  }
  if (skillsOpen && page.path === '/developers/skills') {
    source = source.replace('Download the skill kit from the Phoenix Developers site and unzip it', `[Download the skill kit](${SKILL_KIT_DOWNLOAD}) and unzip it`);
  }
  if (skillsOpen && page.path === '/developers/test') {
    section('Skills: local test builds', `Jibo's current software already supports test builds of skills; no later update is needed. On Jibo, turn on **Allow test builds** in **Settings → Developer testing** and confirm it. Each install then needs your tap on his screen: read what the skill can do and the full-access page, then tap **Install full-access test**. A skill runs with the same full access as Jibo's built-in skills, so test only code you trust.\n\nStart with the [skill guide](/developers/skills) and [download the skill kit](${SKILL_KIT_DOWNLOAD}). Run its \`info\` command first: your Jibo must report Test Build protocol 1 and \`native\` in \`localKinds\`. The theme upload form is not a way to install a skill.\n\n[Skill workflow](/developers/skills/workflow) · [Skill troubleshooting](/developers/skills/troubleshooting)`);
  }
  if (page.path === '/developers/templates') {
    const descriptions = { paper: 'Light palette without images', signals: 'Complete ordinary-menu icon map', terrace: 'Background, per-menu fonts and bounded geometry', 'cut-paper': 'Original neutral paint on the native eye mesh' };
    const extras = Object.entries(descriptions).flatMap(([name, description]) => {
      const file = join(projectDir, 'tools/theme-kit/templates', name, 'theme.json');
      if (!existsSync(file)) return [];
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      if (![1, 2, 3, 4].includes(manifest.themeApi)) return [];
      return [{ name, api: manifest.themeApi, description }];
    });
    if (extras.length) {
      const table = extras.map(t => `| \`${t.name}\` | ${t.api} | ${t.description} |`).join('\n');
      const apiGuide = pages.some(p => p.path === '/developers/themes/api') ? '/developers/themes/api' : '/developers/versions#theme-apis';
      const section = `## More theme starters\n\nChoose a focused example for the feature you want to learn. Every pack still needs the matching API support from Jibo.\n\n| Starter | Theme API | What it demonstrates |\n| --- | --- | --- |\n${table}\n\nUse the same scaffold command with the starter's name:\n\n\`\`\`sh\nnode tools/theme-kit/cli.mjs new notebook --from paper --author "Your name"\n\`\`\`\n\n[Theme API fields](${apiGuide})\n\n`;
      source = source.replace('## Skill templates', section + '## Skill templates');
    }
    if (skillsOpen) {
      source = source.replace(/## Declarative skill starter[\s\S]*?(?=\n##|$)/, '');
      section('Skill templates', `The [skill kit](${SKILL_KIT_DOWNLOAD}) has four starters: **hello** (the default), **touch-ui**, **voice** and **network-service**. Every starter is the same kind of project, and Jibo's current software installs each one as a test build on your own Jibo after you confirm it on his screen.\n\n[Choose a starter](/developers/skills/workflow#scaffold-a-starter) · [Skill cookbook](/developers/skills/cookbook)`);
    }
  }
  if (skillsOpen && page.path === '/developers/versions') {
    section('Skill authoring', `Build skills with the [skill guide](/developers/skills) and its [kit](${SKILL_KIT_DOWNLOAD}). The kit runs on Node.js 20 or newer on your computer; your skill runs on Jibo's Node 6.5, so write it for that older runtime. Jibo's current software installs skills as test builds after you confirm them on his screen. Check that your Jibo's \`info\` reports Test Build protocol 1 and \`native\` in \`localKinds\`; a software version number alone is not a capability check.`);
  }
  if (skillsOpen && page.path === '/developers/publishing') {
    source = source.replace('**Who this is for:** authors who are ready to share a theme or declarative app with other Jibo owners through the Skill Store.',
      '**Who this is for:** authors who are ready to share a theme with other Jibo owners through the Skill Store. Publishing skills to the Skill Store isn\'t available yet; [try your skill on your own Jibo](/developers/skills) instead.');
    source = source.replace(/## 4\. Upload a skill or theme\n\n[\s\S]*?For a theme:\n\n/, '## 4. Upload a theme\n\n');
    source = source.replace('This picker accepts theme packs only.',
      'This picker accepts theme packs only. Skills made with the [skill kit](/developers/skills) are not uploaded here; test them on your own Jibo.');
    source = source.replace('Run the starter\'s tests and preview before upload. A compatible Jibo can install a reviewed public skill through the Skill Store; robot approval and installed status are separate steps. The local **Allow test builds** switch does not enable this declarative format. Native local tests require a separately advertised device capability and physical approval; this kit does not install them.',
      'Check a theme on your own Jibo before you list it; the [theme testing checklist](/developers/themes/testing) covers what to look at. Skills are tested on your own Jibo with the [skill kit](/developers/skills/workflow).');
  }
  return source;
}

const HEADERS = { 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' };

/**
 * Routes for the Developers area. `origin` and `brandName` are read when a
 * page is first rendered, so structured data follows the served instance.
 */
export function developerRoutes({ prepare, projectDir = PROJECT, origin = () => '', brandName = () => 'Phoenix' }) {
  const pages = developerPages({ projectDir }), routes = {}, rendered = new Map();
  const skillsOpen = pages.some(p => p.path === '/developers/skills');
  let dates = null;
  const modified = p => {
    dates ||= sourceDates(projectDir, [...pages.map(x => x.source), REGISTRY]);
    const values = [p.source, ...(p.path === '/developers' ? [REGISTRY] : [])].map(file => dates.get(file)).filter(Boolean).sort();
    return values.at(-1) || null;
  };
  function content(p) {
    if (!rendered.has(p.path)) {
      const source = contextualContent(p, readFileSync(join(projectDir, p.source), 'utf8'), pages, projectDir);
      const article = renderMarkdown(source, { resolveLink: href => documentLink(href, p.source, pages), reservedIds: RESERVED_IDS });
      rendered.set(p.path, { source, ...article });
    }
    return rendered.get(p.path);
  }
  for (const p of pages) {
    let cached;
    routes['GET ' + p.path] = ({ res }) => {
      if (!cached) {
        const article = content(p);
        cached = prepare(Buffer.from(shell(p, pages, article.html, article.headings, { origin: origin(), brandName: brandName(), modified: modified(p), skillsOpen })));
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...HEADERS }); res.end(cached);
    };
  }
  // The publisher dashboard keeps its existing Skill Store console UI; this is
  // its stable address inside Developers. Signed-out visitors sign in there.
  const moved = (status, location, label) => ({ res }) => {
    res.writeHead(status, { location, 'content-type': 'text/html; charset=utf-8', 'cache-control': status === 301 ? 'public, max-age=3600' : 'no-store', 'x-robots-tag': 'noindex', 'x-content-type-options': 'nosniff' });
    res.end(`<!doctype html><title>${esc(label)}</title><a href="${esc(location)}">${esc(label)}</a>`);
  };
  routes['GET /developers/console'] = moved(302, '/apps#publisher', 'Open the publisher dashboard');
  routes['GET /developer'] = moved(301, '/developers', 'Developers');
  for (const name of ['ember', 'orbit']) {
    let image;
    routes[`GET /developers/assets/${name}-preview.png`] = ({ res }) => {
      if (!image) image = readFileSync(join(projectDir, 'themes', name, 'assets/preview.png'));
      res.writeHead(200, { 'content-type': 'image/png', ...HEADERS }); res.end(image);
    };
  }
  // The already-published starter ZIP keeps its address and bytes, guide or not.
  if (STARTER_FILES.every(file => existsSync(join(projectDir, STARTER_DIR, file)))) {
    let archive;
    routes['GET /developers/downloads/hello-jibo.zip'] = ({ res }) => {
      archive ||= starterZip(projectDir);
      res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="hello-jibo.zip"', 'content-length': archive.length, ...HEADERS });
      res.end(archive);
    };
  }
  // Served only with the published skill guide: the same opt-in, fixed sources and kit files.
  if (skillsOpen) {
    let archive;
    routes['GET ' + SKILL_KIT_DOWNLOAD] = ({ res }) => {
      archive ||= skillKitZip(projectDir);
      res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="jibo-skill-kit.zip"', 'content-length': archive.length, ...HEADERS });
      res.end(archive);
    };
    // Not cached, so turning the guide off again restores these pages at once.
    for (const path of DATA_ONLY_PAGES) routes['GET ' + path] = moved(302, '/developers/skills', 'Build a skill');
  }
  let index;
  routes['GET /developers/search.json'] = ({ res }) => {
    if (!index) index = Buffer.from(JSON.stringify(pages.map(p => ({ path: p.path, title: p.title, text: content(p).source.replace(/[`#*|>]/g, '').replace(/\s+/g, ' ').slice(0, 50000) }))));
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'x-robots-tag': 'noindex', ...HEADERS }); res.end(index);
  };
  return { routes, entries: () => pages.map(p => ({ path: p.path, ...(modified(p) ? { lastmod: modified(p) } : {}) })) };
}
