// Phoenix — public site behaviour: landing page and legal pages.
//
// Progressive enhancement throughout. Every string and list this file renders
// is already present in the HTML as authored defaults, so the page is complete
// without JavaScript; this adds motion, the live pipeline demo, and the
// operator's own branding on top.

import { initBrand, initTheme, pick } from '/brand.js';

/* ==========================================================================
   Legacy hash routes
   ========================================================================== */

// The console used to live at "/" with hash routes. Anyone holding an old
// bookmark — /#/loop, /#/gallery — lands here now, so forward them before the
// page paints rather than showing them marketing copy they did not ask for.
// Landing-page anchors (#product, #faq) have no leading slash and are ignored.
function forwardLegacyHash() {
  const hash = location.hash;
  if (!hash.startsWith('#/')) return;
  if (document.body.dataset.page !== 'landing') return;
  location.replace(`/app${hash}`);
}

forwardLegacyHash();
// A visitor already on this page who follows an old '#/...' link changes only
// the fragment, so the module never re-runs. Catch that case too.
addEventListener('hashchange', forwardLegacyHash);

/* ==========================================================================
   Header, navigation, reveal
   ========================================================================== */

function initHeader() {
  const header = document.querySelector('.site-header');
  if (!header) return;
  const onScroll = () => header.classList.toggle('scrolled', window.scrollY > 8);
  onScroll();
  addEventListener('scroll', onScroll, { passive: true });
}

function initMobileNav() {
  const toggle = document.querySelector('.nav-toggle');
  const nav = document.getElementById('mobile-nav');
  if (!toggle || !nav) return;

  const close = () => {
    nav.classList.remove('open');
    toggle.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
  };
  toggle.addEventListener('click', () => {
    const open = nav.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
    // Lock the page behind the drawer, or the content scrolls under it.
    document.body.style.overflow = open ? 'hidden' : '';
  });
  nav.addEventListener('click', (e) => { if (e.target.closest('a')) close(); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  // A resize past the breakpoint leaves the drawer open over a desktop layout.
  matchMedia('(min-width: 881px)').addEventListener('change', close);
}

function initReveal() {
  const targets = document.querySelectorAll('[data-reveal]');
  if (!targets.length) return;
  if (!('IntersectionObserver' in window)) {
    targets.forEach((el) => el.classList.add('revealed'));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('revealed');
      io.unobserve(entry.target);
    }
  }, { rootMargin: '0px 0px -12% 0px', threshold: 0.08 });

  // Children of a [data-reveal-group] cascade rather than arriving together.
  for (const group of document.querySelectorAll('[data-reveal-group]')) {
    [...group.children].forEach((child, i) => {
      if (child.hasAttribute('data-reveal')) {
        child.style.setProperty('--reveal-delay', `${Math.min(i * 70, 420)}ms`);
      }
    });
  }
  targets.forEach((el) => io.observe(el));
}

/** Underline the nav item for the section currently on screen. */
function initScrollSpy(linkSelector) {
  const links = [...document.querySelectorAll(linkSelector)];
  if (!links.length || !('IntersectionObserver' in window)) return;

  const byId = new Map();
  for (const link of links) {
    const id = (link.getAttribute('href') || '').split('#')[1];
    const section = id && document.getElementById(id);
    if (section) byId.set(section, link);
  }
  if (!byId.size) return;

  const visible = new Set();
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) visible.add(entry.target);
      else visible.delete(entry.target);
    }
    // When several sections are on screen, the highest one wins.
    const top = [...visible].sort((a, b) => a.offsetTop - b.offsetTop)[0];
    for (const [section, link] of byId) link.classList.toggle('current', section === top);
  }, { rootMargin: '-25% 0px -60% 0px' });

  for (const section of byId.keys()) io.observe(section);
}

/** Pointer-following spotlight on the feature cards. */
function initSpotlight() {
  if (matchMedia('(hover: none)').matches) return;
  for (const card of document.querySelectorAll('.feature')) {
    card.addEventListener('pointermove', (e) => {
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${e.clientX - r.left}px`);
      card.style.setProperty('--my', `${e.clientY - r.top}px`);
    });
  }
}

/** Copy-to-clipboard on the install commands. */
function initCopy() {
  for (const btn of document.querySelectorAll('.copy-btn')) {
    btn.addEventListener('click', async () => {
      const code = btn.parentElement?.querySelector('code');
      if (!code) return;
      try {
        await navigator.clipboard.writeText(code.textContent.trim());
        btn.classList.add('copied');
        btn.setAttribute('aria-label', 'Copied');
        setTimeout(() => {
          btn.classList.remove('copied');
          btn.setAttribute('aria-label', 'Copy command');
        }, 1600);
      } catch {
        // Clipboard is unavailable over plain HTTP on some browsers. Select the
        // text instead so the reader can copy it by hand.
        const range = document.createRange();
        range.selectNodeContents(code);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    });
  }
}

/* ==========================================================================
   Session awareness
   ========================================================================== */

// If the visitor already has a session, the header should offer the console
// rather than a sign-in form. Marketing pages stay reachable either way: a
// self-hosted product whose front page redirects logged-in owners away can
// never show them what it says about itself.
async function initSession() {
  let account = null;
  try {
    const res = await fetch('/api/me', { headers: { accept: 'application/json' } });
    if (res.ok) account = (await res.json()).account || null;
  } catch { /* the service may not be running; the site still works */ }

  for (const el of document.querySelectorAll('[data-signed-in]')) el.hidden = !account;
  for (const el of document.querySelectorAll('[data-signed-out]')) el.hidden = !!account;
  if (!account) return;

  const name = account.firstName || account.email || '';
  for (const el of document.querySelectorAll('[data-account-name]')) el.textContent = name;
}

/* ==========================================================================
   Hero pipeline demo
   ========================================================================== */

// A looping trace of one utterance through the real stages, with the stage
// names and copy coming from branding.json. The timings are illustrative and
// labelled as a demonstration in the markup — this is not instrumentation.
function initPipeline(brand) {
  const pipe = document.querySelector('[data-pipe]');
  if (!pipe) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    // Show the finished state rather than an empty frame.
    pipe.querySelectorAll('.pipe-stage').forEach((s) => s.classList.add('done'));
    pipe.querySelector('.pipe-out')?.classList.add('on');
    const said = pipe.querySelector('.said');
    if (said) said.textContent = said.dataset.full || said.textContent;
    pipe.querySelector('.caret')?.remove();
    return;
  }

  const stages = [...pipe.querySelectorAll('.pipe-stage')];
  const out = pipe.querySelector('.pipe-out');
  const said = pipe.querySelector('.said');
  const caret = pipe.querySelector('.caret');
  const reply = pipe.querySelector('.reply');
  const utterance = said?.dataset.full || 'Hey Jibo, what does my day look like?';
  const answer = reply?.dataset.full || 'You have two meetings, and it is 8 degrees out.';

  let cancelled = false;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // Pause the loop while the tab is hidden — a background tab running a timer
  // loop forever is rude, and browsers throttle it into nonsense anyway.
  let hidden = document.hidden;
  document.addEventListener('visibilitychange', () => { hidden = document.hidden; });
  const idle = async () => { while (hidden && !cancelled) await wait(250); };

  async function type(el, textValue, speed) {
    el.textContent = '';
    for (const ch of textValue) {
      if (cancelled) return;
      el.textContent += ch;
      await wait(speed);
    }
  }

  async function loop() {
    while (!cancelled) {
      await idle();
      // Reset.
      stages.forEach((s) => s.classList.remove('active', 'done'));
      stages.forEach((s) => { const ms = s.querySelector('.stage-ms'); if (ms) ms.textContent = ''; });
      out?.classList.remove('on');
      if (reply) reply.textContent = '';
      if (caret) caret.hidden = false;

      await type(said, utterance, 34);
      if (cancelled) return;
      if (caret) caret.hidden = true;
      await wait(320);

      for (const stage of stages) {
        if (cancelled) return;
        stage.classList.add('active');
        const dwell = Number(stage.dataset.ms || 260);
        await wait(dwell);
        const ms = stage.querySelector('.stage-ms');
        // Jitter the reported figure a little so it reads as a live trace
        // rather than a static graphic.
        if (ms) ms.textContent = `${Math.round(dwell * (0.82 + Math.random() * 0.3))} ms`;
        stage.classList.remove('active');
        stage.classList.add('done');
      }

      out?.classList.add('on');
      if (reply) await type(reply, answer, 26);
      await wait(3600);
    }
  }

  // Only run while the card is actually on screen.
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && cancelled === false && !pipe.dataset.running) {
        pipe.dataset.running = '1';
        loop();
      }
    }, { threshold: 0.25 });
    io.observe(pipe);
  } else {
    loop();
  }
  addEventListener('pagehide', () => { cancelled = true; });
  return brand;
}

/* ==========================================================================
   Branded lists
   ========================================================================== */

const el = (tag, attrs = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null) continue;
    node.append(kid);
  }
  return node;
};

// Line art, 24x24, stroked with currentColor so it inherits the accent.
const ICONS = {
  conversation: 'M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.9-.9L3 20.5l1.6-4.6A8.4 8.4 0 0 1 3.6 11.5a8.4 8.4 0 0 1 9-8.4 8.4 8.4 0 0 1 8.4 8.4Z',
  library: 'M4 19.5V6a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 1.5ZM8 4v12M4 19.5A2 2 0 0 1 6 18h13',
  household: 'M3 10.5 12 3l9 7.5M5 9.5V20h14V9.5M9.5 20v-5.5h5V20',
  revival: 'M12 3v10m0-10 3.5 3.5M12 3 8.5 6.5M4 13a8 8 0 1 0 16 0',
  shield: 'M12 3 4.5 6v6c0 4.5 3.2 7.8 7.5 9 4.3-1.2 7.5-4.5 7.5-9V6L12 3Zm-2.6 8.8 2 2 3.8-3.8',
  open: 'M8 6H5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3M14 3h7v7M10.5 13.5 21 3',
  lock: 'M6 10.5V8a6 6 0 0 1 12 0v2.5M5 10.5h14a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-8.5a1 1 0 0 1 1-1Z',
  copy: 'M9 9h10v12H9zM5 15V3h10v2',
  chip: 'M8 4h8a4 4 0 0 1 4 4v8a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V8a4 4 0 0 1 4-4ZM9 9h6v6H9zM12 4V1m0 22v-3M4 12H1m22 0h-3',
};

const icon = (name, size = 20) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name] || ICONS.chip);
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.6');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
};

const chevron = () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('class', 'chev');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'm6 9 6 6 6-6');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.8');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
};

/**
 * Re-render a list from branding.json. The markup already holds the default
 * items, so for an unmodified instance this paints exactly what was there;
 * for a customised one it is how the operator's own copy gets in.
 */
function renderList(selector, path, brand, build) {
  const host = document.querySelector(selector);
  const items = pick(brand, path);
  if (!host || !Array.isArray(items) || !items.length) return;
  host.replaceChildren(...items.map(build));
}

function renderBrandedContent(brand) {
  renderList('[data-list="features"]', 'features.items', brand, (item) =>
    el('article', { class: 'feature', 'data-reveal': true },
      el('div', { class: 'feature-icon' }, icon(item.icon)),
      el('h3', { text: item.title }),
      el('p', { text: item.body })));

  renderList('[data-list="flow"]', 'pipeline.stages', brand, (stage) =>
    el('article', { class: 'flow-step', 'data-reveal': true },
      el('h3', { text: stage.label }),
      el('p', { text: stage.detail })));

  renderList('[data-list="metrics"]', 'status.metrics', brand, (m) =>
    el('article', { class: 'metric', 'data-reveal': true },
      el('div', { class: 'metric-value' },
        el('span', { class: 'grad', text: m.value }),
        m.of ? el('span', { class: 'metric-of', text: m.of }) : null),
      el('p', { class: 'metric-label', text: m.label }),
      m.detail ? el('p', { class: 'metric-detail', text: m.detail }) : null));

  renderList('[data-list="caveats"]', 'status.caveats', brand, (line) => el('li', { text: line }));

  renderList('[data-list="faq"]', 'faq.items', brand, (item) => {
    const summary = el('summary', {}, el('span', { text: item.q }), chevron());
    return el('details', {}, summary, el('div', { class: 'answer' }, el('p', { text: item.a })));
  });

  renderList('[data-list="steps"]', 'install.steps', brand, (step) =>
    el('div', { class: 'cmd-step' },
      el('div', { class: 'cmd-label', text: step.label }),
      el('div', { class: 'cmd-line' },
        el('span', { class: 'prompt', text: '$' }),
        el('code', { text: step.command }),
        el('button', { class: 'copy-btn', type: 'button', 'aria-label': 'Copy command' }, icon('copy', 14)))));

  renderList('[data-list="footer-cols"]', 'footer.columns', brand, (col) =>
    el('div', { class: 'footer-col' },
      el('h4', { text: col.title }),
      el('ul', {}, (col.links || []).map((link) =>
        el('li', {}, el('a', { href: link.href, text: link.label }))))));

  // Pipeline stage labels in the hero card follow the same config.
  const stages = pick(brand, 'pipeline.stages');
  if (Array.isArray(stages)) {
    const nodes = document.querySelectorAll('[data-pipe] .pipe-stage .stage-label');
    nodes.forEach((node, i) => { if (stages[i]?.label) node.textContent = stages[i].label; });
  }
}

/* ==========================================================================
   Boot
   ========================================================================== */

async function main() {
  initHeader();
  initMobileNav();
  initTheme();

  const brand = await initBrand();
  renderBrandedContent(brand);

  // Anything rendered above has to be wired after it exists in the document.
  initReveal();
  initSpotlight();
  initCopy();
  initScrollSpy('.site-nav a[href*="#"]');
  initScrollSpy('.toc a');
  initPipeline(brand);
  initSession();
}

main();
