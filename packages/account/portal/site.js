// Phoenix — public site behaviour: landing page and legal pages.
//
// Progressive enhancement throughout. Every string and list this file renders
// is already present in the HTML as authored defaults, so the page is complete
// without JavaScript; this adds motion, the live pipeline demo, and the
// operator's own branding on top.

import { initBrand, initTheme } from '/brand.js';
import { pipelineStageLabels, renderSiteList } from '/site-render.js';

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

  // Each run of the loop owns a generation; bumping it stops that run at its
  // next step. A boolean would not do: a page restored from the back/forward
  // cache resumes the old run's timers, and it must not type alongside the new one.
  let generation = 0;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // Pause the loop while the tab is hidden — a background tab running a timer
  // loop forever is rude, and browsers throttle it into nonsense anyway.
  let hidden = document.hidden;
  document.addEventListener('visibilitychange', () => { hidden = document.hidden; });

  async function loop(run) {
    const cancelled = () => run !== generation;
    const idle = async () => { while (hidden && !cancelled()) await wait(250); };
    const type = async (el, textValue, speed) => {
      el.textContent = '';
      for (const ch of textValue) {
        if (cancelled()) return;
        el.textContent += ch;
        await wait(speed);
      }
    };

    while (!cancelled()) {
      await idle();
      // Reset.
      stages.forEach((s) => s.classList.remove('active', 'done'));
      stages.forEach((s) => { const ms = s.querySelector('.stage-ms'); if (ms) ms.textContent = ''; });
      out?.classList.remove('on');
      if (reply) reply.textContent = '';
      if (caret) caret.hidden = false;

      await type(said, utterance, 34);
      if (cancelled()) return;
      if (caret) caret.hidden = true;
      await wait(320);

      for (const stage of stages) {
        if (cancelled()) return;
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

  let started = false;
  const start = () => {
    started = true;
    generation += 1;
    loop(generation);
  };
  // Start once the card is actually on screen.
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && !started) start();
    }, { threshold: 0.25 });
    io.observe(pipe);
  } else {
    start();
  }
  addEventListener('pagehide', () => { generation += 1; });
  addEventListener('pageshow', (event) => { if (event.persisted && started) start(); });
  return brand;
}

/* ==========================================================================
   Branded lists
   ========================================================================== */

/**
 * Re-render the list slots from branding.json with the same markup the
 * account service renders into the page it serves (site-render.js). Served by
 * the account service, this repaints what is already there; served as static
 * files, it is how an operator's own lists get in. A list the config does not
 * define keeps the authored default.
 */
function renderBrandedContent(brand) {
  for (const host of document.querySelectorAll('[data-list]')) {
    const html = renderSiteList(host.dataset.list, brand);
    if (html) host.innerHTML = html;
  }

  // Pipeline stage labels in the hero card follow the same config.
  const labels = pipelineStageLabels(brand);
  if (labels) {
    const nodes = document.querySelectorAll('[data-pipe] .pipe-stage .stage-label');
    nodes.forEach((node, i) => { if (labels[i]) node.textContent = labels[i]; });
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
