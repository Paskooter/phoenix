// Phoenix — branding runtime, shared by the marketing site, the legal pages and
// the console.
//
// Every visible string on the public site is addressable by a dot path into
// branding.json. The HTML carries the default text inline, so the page is
// complete and readable before this module runs (and with JavaScript off
// entirely); this only overwrites what an operator has actually customised.
//
//   <h1 data-brand="hero.title">Your Jibo stopped talking in 2019.</h1>
//   <a data-brand="nav.cta" data-brand-attr="href:links.console">Open console</a>
//
// Repeating content (features, FAQ, metrics, footer columns) is rendered from
// the same config by the page that owns it, via getBrand().

const BRAND_URL = '/branding.json';

let pending = null;
let cached = null;

/** Resolve a dot path — `hero.title`, `footer.columns` — against the config. */
export function pick(obj, path) {
  if (!obj || !path) return undefined;
  return String(path).split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

/**
 * Load branding.json once per page. A missing or malformed file is not an
 * error worth breaking the page over: the HTML already carries every default,
 * so we fall back to an empty config and everything renders as authored.
 */
export function loadBrand() {
  if (cached) return Promise.resolve(cached);
  if (pending) return pending;
  pending = fetch(BRAND_URL, { headers: { accept: 'application/json' } })
    .then((res) => (res.ok ? res.json() : {}))
    .catch(() => ({}))
    .then((data) => {
      cached = data && typeof data === 'object' ? data : {};
      return cached;
    });
  return pending;
}

/** The config, if it has already loaded. Callers that cannot await use this. */
export function getBrandSync() { return cached; }

/**
 * Bind every `data-brand` element under `root`.
 *
 * - `data-brand="path"` replaces the element's text.
 * - `data-brand-attr="href:path, aria-label:other.path"` sets attributes.
 *
 * A path that is absent from the config leaves the authored markup alone, so
 * a partial override file only has to name the handful of things it changes.
 */
export function applyText(root, brand) {
  if (!brand) return;
  for (const el of root.querySelectorAll('[data-brand]')) {
    const value = pick(brand, el.dataset.brand);
    if (typeof value === 'string' || typeof value === 'number') {
      el.textContent = String(value);
      // An optional slot ships hidden and empty: the project has no page for it, but an
      // instance that defines the string wants it shown. Without this an operator can
      // set nav.guide and still see nothing, which reads as the config being ignored.
      if (el.hasAttribute('data-brand-optional')) el.removeAttribute('hidden');
    }
  }
  for (const el of root.querySelectorAll('[data-brand-attr]')) {
    for (const pair of el.dataset.brandAttr.split(',')) {
      const idx = pair.indexOf(':');
      if (idx < 0) continue;
      const attr = pair.slice(0, idx).trim();
      const value = pick(brand, pair.slice(idx + 1).trim());
      if (typeof value === 'string' && value) el.setAttribute(attr, value);
    }
  }
}

/**
 * Apply an operator's accent colour. Only the two brand hues are overridable;
 * everything else in the palette is derived, so a single hex is enough to
 * re-skin the product without anyone having to understand the token set.
 */
export function applyPalette(brand) {
  if (!brand) return;
  const root = document.documentElement;
  const hex = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
  if (typeof brand.accent === 'string' && hex.test(brand.accent)) {
    root.style.setProperty('--accent', brand.accent);
    root.style.setProperty('--accent-soft', withAlpha(brand.accent, 0.13));
    root.style.setProperty('--accent-line', withAlpha(brand.accent, 0.30));
    root.style.setProperty('--accent-glow', withAlpha(brand.accent, 0.22));
  }
  if (typeof brand.accentWarm === 'string' && hex.test(brand.accentWarm)) {
    root.style.setProperty('--accent-warm', brand.accentWarm);
  }
}

/** #rgb / #rrggbb to rgba(), so one configured hex can drive the soft variants. */
function withAlpha(hex, alpha) {
  let h = hex.slice(1);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/**
 * Swap the built-in mark for an operator's own image. The config holds a URL,
 * never markup — an instance's branding file should never be able to inject
 * script into every page that reads it.
 */
export function applyLogo(brand) {
  if (!brand || typeof brand.logo !== 'string' || !brand.logo) return;
  for (const slot of document.querySelectorAll('[data-brand-logo]')) {
    const img = document.createElement('img');
    img.src = brand.logo;
    img.alt = brand.name || 'Logo';
    img.className = 'brand-logo-img';
    slot.replaceChildren(img);
  }
}

/** Title and meta description, for tabs, bookmarks and link previews. */
export function applyMeta(brand) {
  if (!brand) return;
  const name = typeof brand.name === 'string' ? brand.name : null;
  if (name) {
    const tpl = document.documentElement.dataset.titleTemplate;
    document.title = tpl ? tpl.replace('%s', name) : name;
    for (const el of document.querySelectorAll('meta[property="og:site_name"]')) {
      el.setAttribute('content', name);
    }
  }
  if (typeof brand.description === 'string' && brand.description) {
    for (const sel of ['meta[name="description"]', 'meta[property="og:description"]',
      'meta[name="twitter:description"]']) {
      const el = document.querySelector(sel);
      if (el) el.setAttribute('content', brand.description);
    }
  }
}

/** Everything a page normally wants, in one call. */
export async function initBrand(root = document) {
  const brand = await loadBrand();
  applyPalette(brand);
  applyText(root, brand);
  applyLogo(brand);
  applyMeta(brand);
  return brand;
}

/* ==========================================================================
   Theme
   ========================================================================== */

const THEME_KEY = 'phoenix.theme';
const THEMES = ['system', 'dark', 'light'];

export function getTheme() {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return THEMES.includes(stored) ? stored : 'system';
  } catch { return 'system'; }
}

export function setTheme(theme) {
  const next = THEMES.includes(theme) ? theme : 'system';
  const root = document.documentElement;
  if (next === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', next);
  try { localStorage.setItem(THEME_KEY, next); } catch { /* private mode */ }
  root.dispatchEvent(new CustomEvent('themechange', { detail: { theme: next } }));
  return next;
}

/**
 * Wire up every `[data-theme-toggle]` button on the page. Cycles
 * system → dark → light, and labels itself with what it will do next so the
 * control is never ambiguous.
 */
export function initTheme() {
  const icons = {
    system: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 0v18',
    dark: 'M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z',
    light: 'M12 4V2m0 20v-2m8-8h2M2 12h2m13.66-5.66 1.41-1.41M4.93 19.07l1.41-1.41m0-11.32L4.93 4.93m14.14 14.14-1.41-1.41M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  };
  const labels = { system: 'Match system theme', dark: 'Dark theme', light: 'Light theme' };

  const paint = () => {
    const theme = getTheme();
    for (const btn of document.querySelectorAll('[data-theme-toggle]')) {
      btn.setAttribute('aria-label', labels[theme]);
      btn.setAttribute('title', labels[theme]);
      const path = btn.querySelector('path');
      if (path) path.setAttribute('d', icons[theme]);
    }
  };

  for (const btn of document.querySelectorAll('[data-theme-toggle]')) {
    btn.addEventListener('click', () => {
      const order = ['system', 'dark', 'light'];
      setTheme(order[(order.indexOf(getTheme()) + 1) % order.length]);
      paint();
    });
  }
  paint();
}
