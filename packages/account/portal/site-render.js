// Phoenix — markup for the public site's branded lists, shared by the browser
// and the account service.
//
// The landing page carries its default lists (features, the pipeline stages,
// status metrics, FAQ, install steps, footer columns) inline in the HTML. An
// operator can replace any of them from branding.json. These functions turn a
// list from that config into the same markup the page ships with, so:
//
//   - the account service can render an instance's own lists into the HTML it
//     serves (link previews, crawlers and no-JS visitors see the right page, and
//     nobody sees the default copy flash first), and
//   - site.js renders exactly the same thing in the browser when the site is
//     served as static files by a reverse proxy instead.
//
// Everything here is a pure string function with no DOM access, so it runs in
// both places. Every value from the config is escaped, and every link goes
// through safeBrandUrl: branding is operator input, not markup.

import { pick, safeBrandUrl } from './brand.js';

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, '&quot;');
}

const text = (value) => (typeof value === 'string' || typeof value === 'number' ? String(value) : '');

// Line art, 24x24, stroked with currentColor so it inherits the accent.
export const SITE_ICONS = {
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

export function iconSvg(name, size = 20, strokeWidth = 1.6) {
  const d = SITE_ICONS[name] || SITE_ICONS.chip;
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" aria-hidden="true">`
    + `<path d="${d}" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" /></svg>`;
}

const CHEVRON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" class="chev" aria-hidden="true">'
  + '<path d="m6 9 6 6 6-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>';

/** An external link opens in a new tab and carries no opener; a portal path does not. */
function linkHtml(href, label) {
  if (!safeBrandUrl(href)) return `<span>${escapeHtml(label)}</span>`;
  const external = /^https?:/i.test(href);
  return `<a href="${escapeAttr(href)}"${external ? ' target="_blank" rel="noopener"' : ''}>${escapeHtml(label)}</a>`;
}

/**
 * The list slots the page exposes: `data-list` name → the config path it reads
 * and how one item is drawn. An item missing its required text is skipped
 * rather than drawn empty.
 */
export const SITE_LISTS = {
  features: {
    path: 'features.items',
    item: (f) => text(f?.title) && `<article class="feature" data-reveal>`
      + `<div class="feature-icon">${iconSvg(f.icon)}</div>`
      + `<h3>${escapeHtml(f.title)}</h3><p>${escapeHtml(text(f.body))}</p></article>`,
  },
  flow: {
    path: 'pipeline.stages',
    item: (s) => text(s?.label) && `<article class="flow-step" data-reveal>`
      + `<h3>${escapeHtml(s.label)}</h3><p>${escapeHtml(text(s.detail))}</p></article>`,
  },
  metrics: {
    path: 'status.metrics',
    item: (m) => text(m?.value) && `<article class="metric" data-reveal>`
      + `<div class="metric-value"><span class="grad">${escapeHtml(text(m.value))}</span>`
      + (text(m.of) ? `<span class="metric-of">${escapeHtml(text(m.of))}</span>` : '')
      + `</div><p class="metric-label">${escapeHtml(text(m.label))}</p>`
      + (text(m.detail) ? `<p class="metric-detail">${escapeHtml(text(m.detail))}</p>` : '')
      + `</article>`,
  },
  caveats: {
    path: 'status.caveats',
    item: (line) => text(line) && `<li>${escapeHtml(text(line))}</li>`,
  },
  faq: {
    path: 'faq.items',
    item: (f) => text(f?.q) && `<details data-reveal><summary><span>${escapeHtml(f.q)}</span>${CHEVRON}</summary>`
      + `<div class="answer"><p>${escapeHtml(text(f.a))}</p></div></details>`,
  },
  steps: {
    // `prompt` defaults to "$"; an empty string drops it (a phrase to say to
    // the robot is not a shell command). `copy: false` drops the copy button.
    path: 'install.steps',
    item: (s) => {
      if (!text(s?.command)) return '';
      const prompt = typeof s.prompt === 'string' ? s.prompt.slice(0, 4) : '$';
      return `<div class="cmd-step"><div class="cmd-label">${escapeHtml(text(s.label))}</div>`
        + `<div class="cmd-line">`
        + (prompt ? `<span class="prompt">${escapeHtml(prompt)}</span>` : '')
        + `<code>${escapeHtml(text(s.command))}</code>`
        + (s.copy === false ? ''
          : `<button class="copy-btn" type="button" aria-label="Copy command">${iconSvg('copy', 14, 1.7)}</button>`)
        + `</div></div>`;
    },
  },
  'footer-cols': {
    path: 'footer.columns',
    item: (col) => text(col?.title) && `<div class="footer-col"><h4>${escapeHtml(col.title)}</h4><ul>`
      + (Array.isArray(col.links) ? col.links : [])
        .filter((link) => text(link?.label))
        .map((link) => `<li>${linkHtml(link.href, link.label)}</li>`).join('')
      + `</ul></div>`,
  },
};

/**
 * The markup for one list slot, or null when the config does not define that
 * list (or defines nothing drawable), in which case the authored default stays.
 */
export function renderSiteList(name, brand) {
  const spec = SITE_LISTS[name];
  const items = spec && pick(brand, spec.path);
  if (!Array.isArray(items) || !items.length) return null;
  const html = items.map((item) => spec.item(item) || '').join('');
  return html || null;
}

/** Pipeline stage labels for the hero's demo card, in order, or null. */
export function pipelineStageLabels(brand) {
  const stages = pick(brand, 'pipeline.stages');
  if (!Array.isArray(stages)) return null;
  return stages.map((stage) => text(stage?.label));
}
