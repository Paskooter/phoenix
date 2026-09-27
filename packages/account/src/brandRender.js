// Server-side branding: render an instance's merged branding into the HTML it
// serves.
//
// The portal pages carry the project's default copy inline, and brand.js /
// site.js overwrite it in the browser from /branding.json. On its own that
// means every instance first serves the *project's* page: link previews and
// crawlers that do not run scripts describe a self-hosted install, and a slow
// connection shows the default hero before the instance's replaces it.
//
// When the account service serves the portal, it renders the same substitutions
// before the page leaves the server, using the same rules and the same list
// markup (portal/site-render.js) as the browser. The browser pass still runs
// and is idempotent over this output, so a site served as plain static files by
// a reverse proxy behaves exactly as before.
//
// Only the page's own, known slot markup is touched — `data-brand`,
// `data-brand-attr`, `data-brand-optional`, `data-brand-logo`, `data-list`, the
// hero's stage labels and the head's title/description tags. Anything written
// differently is left for the browser pass rather than guessed at.

import { pick, safeBrandUrl, paletteDeclarations } from '../portal/brand.js';
import { escapeAttr, escapeHtml, pipelineStageLabels, renderSiteList } from '../portal/site-render.js';

const TAG = '[a-zA-Z][a-zA-Z0-9-]*';

// <tag … data-brand="path" …>text only</tag>. Elements with child markup are
// deliberately not matched: in the browser they would lose their children.
const BRANDED_TEXT = new RegExp(`<(${TAG})((?:\\s[^<>]*)?\\sdata-brand="([^"]+)"[^<>]*)>([^<]*)</\\1\\s*>`, 'g');
const OPENING_TAG = new RegExp(`<(${TAG})(\\s[^<>]*)>`, 'g');
const LIST_HOST = new RegExp(`<(${TAG})((?:\\s[^<>]*)?\\sdata-list="([\\w-]+)"[^<>]*)>`, 'g');
const LOGO_HOST = new RegExp(`<(${TAG})((?:\\s[^<>]*)?\\sdata-brand-logo(?=[\\s>/])[^<>]*)>`, 'g');

function unescapeAttr(value) {
  return value.replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function attrValue(attrs, name) {
  const match = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs);
  return match ? unescapeAttr(match[1]) : null;
}

function hasAttr(attrs, name) {
  return new RegExp(`(?:^|\\s)${name}(?=[\\s=/]|$)`).test(attrs);
}

function setAttr(attrs, name, value) {
  const quoted = `"${escapeAttr(value)}"`;
  const existing = new RegExp(`(\\s${name}=)"[^"]*"`);
  if (existing.test(attrs)) return attrs.replace(existing, (whole, prefix) => `${prefix}${quoted}`);
  // Keep a self-closing slash last.
  const selfClosing = /\s*\/$/.exec(attrs);
  return selfClosing
    ? `${attrs.slice(0, selfClosing.index)} ${name}=${quoted}${selfClosing[0]}`
    : `${attrs} ${name}=${quoted}`;
}

function removeAttr(attrs, name) {
  return attrs.replace(new RegExp(`\\s${name}(?:="[^"]*")?(?=[\\s/]|$)`, 'g'), '');
}

const brandText = (value) => (typeof value === 'string' || typeof value === 'number' ? String(value) : null);

/** The attribute half of brand.js applyText: href/src/aria-label, and unhiding optional slots. */
function brandAttributes(attrs, brand) {
  let out = attrs;
  const spec = attrValue(out, 'data-brand-attr');
  if (spec) {
    for (const pair of spec.split(',')) {
      const idx = pair.indexOf(':');
      if (idx < 0) continue;
      const attr = pair.slice(0, idx).trim();
      const value = pick(brand, pair.slice(idx + 1).trim());
      if (typeof value !== 'string' || !value) continue;
      if ((attr === 'href' || attr === 'src') && safeBrandUrl(value)) out = setAttr(out, attr, value);
      else if (attr === 'aria-label') out = setAttr(out, attr, value.slice(0, 500));
    }
  }
  if (hasAttr(out, 'data-brand-optional')) {
    const path = attrValue(out, 'data-brand');
    if (path && brandText(pick(brand, path)) !== null) out = removeAttr(out, 'hidden');
  }
  return out;
}

/** Index of the tag that closes the element whose content starts at `from`, or -1. */
function closingTagIndex(html, tag, from) {
  const re = new RegExp(`<(/?)${tag}(?=[\\s>/])[^>]*>`, 'gi');
  re.lastIndex = from;
  let depth = 1;
  let match;
  while ((match = re.exec(html))) {
    if (match[1]) {
      depth -= 1;
      if (depth === 0) return match.index;
    } else if (!match[0].endsWith('/>')) {
      depth += 1;
    }
  }
  return -1;
}

/** Replace the content of every element an opening-tag pattern finds, when `inner` returns markup. */
function replaceElementContent(html, hostPattern, inner) {
  const re = new RegExp(hostPattern.source, 'g');
  let out = '';
  let last = 0;
  let match;
  while ((match = re.exec(html))) {
    const content = inner(match);
    if (content == null) continue;
    const start = match.index + match[0].length;
    const end = closingTagIndex(html, match[1], start);
    if (end < 0) continue;
    out += html.slice(last, start) + content;
    last = end;
    re.lastIndex = end;
  }
  return out + html.slice(last);
}

function brandHead(html, brand) {
  let out = html;
  // Only a page that opts in (<html data-brand-description>) takes the site
  // description; every other page keeps its own.
  const description = brandText(brand.description);
  if (description && /<html\b[^>]*\sdata-brand-description(?=[\s>=])/.test(out)) {
    out = out.replace(
      /(<meta\s+(?:name="description"|property="og:description"|name="twitter:description")\s+content=")[^"]*(")/g,
      (whole, before, after) => `${before}${escapeAttr(description)}${after}`);
  }
  const name = brandText(brand.name);
  if (name) {
    out = out.replace(/(<meta\s+property="og:site_name"\s+content=")[^"]*(")/g,
      (whole, before, after) => `${before}${escapeAttr(name)}${after}`);
    const template = /<html\b[^>]*\sdata-title-template="([^"]*)"/.exec(out);
    if (template) {
      const title = unescapeAttr(template[1]).replace('%s', name);
      out = out.replace(/<title>[^<]*<\/title>/, () => `<title>${escapeHtml(title)}</title>`);
      out = out.replace(/(<meta\s+(?:property="og:title"|name="twitter:title")\s+content=")[^"]*(")/g,
        (whole, before, after) => `${before}${escapeAttr(title)}${after}`);
    }
  }
  const palette = paletteDeclarations(brand);
  if (palette.length) {
    const style = palette.map(([property, value]) => `${property}: ${value}`).join('; ');
    out = out.replace(/<html\b([^>]*)>/, (whole, attrs) => (/\sstyle="/.test(attrs)
      ? whole : `<html${attrs} style="${escapeAttr(style)}">`));
  }
  return out;
}

/**
 * Render `brand` into one HTML page. Returns the page unchanged when there is
 * no branding to apply.
 */
export function renderBrandedHtml(html, brand) {
  if (!brand || typeof brand !== 'object' || !Object.keys(brand).length) return html;
  let out = brandHead(html, brand);

  out = replaceElementContent(out, LIST_HOST, (match) => renderSiteList(match[3], brand));

  if (typeof brand.logo === 'string' && safeBrandUrl(brand.logo)) {
    const img = `<img src="${escapeAttr(brand.logo)}" alt="${escapeAttr(brandText(brand.name) || 'Logo')}" class="brand-logo-img">`;
    out = replaceElementContent(out, LOGO_HOST, () => img);
  }

  out = out.replace(BRANDED_TEXT, (whole, tag, attrs, path, inner) => {
    const value = brandText(pick(brand, path));
    return `<${tag}${brandAttributes(attrs, brand)}>${value === null ? inner : escapeHtml(value)}</${tag}>`;
  });
  out = out.replace(OPENING_TAG, (whole, tag, attrs) => (
    attrs.includes('data-brand-attr') || attrs.includes('data-brand-optional')
      ? `<${tag}${brandAttributes(attrs, brand)}>` : whole));

  const labels = pipelineStageLabels(brand);
  if (labels) {
    let index = 0;
    out = out.replace(/(<span class="stage-label">)([^<]*)(<\/span>)/g, (whole, open, label, close) => {
      const next = labels[index];
      index += 1;
      return next ? `${open}${escapeHtml(next)}${close}` : whole;
    });
  }
  return out;
}
