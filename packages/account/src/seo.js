// Optional public identity. Without a configured origin there is no hosted
// Organization to claim. Keep operator wording separate from repository defaults.
export function jsonLdScript(data) {
  const json = JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  return `<script type="application/ld+json">${json}</script>`;
}

export function landingStructuredData(html, brand, origin) {
  if (!origin || !/<body\b[^>]*data-page="landing"/.test(html) || /type="application\/ld\+json"/.test(html)) return html;
  const name = typeof brand?.name === 'string' ? brand.name : 'Phoenix';
  const candidates = Array.isArray(brand?.seo?.sameAs) ? brand.seo.sameAs : [brand?.links?.github];
  const sameAs = candidates.filter(value => {
    try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password; } catch { return false; }
  });
  const organization = { '@type': 'Organization', '@id': `${origin}/#organization`, name, url: `${origin}/`, ...(sameAs.length ? { sameAs } : {}) };
  const site = { '@type': 'WebSite', '@id': `${origin}/#website`, name, url: `${origin}/`, publisher: { '@id': organization['@id'] } };
  return html.replace('</head>', () => `${jsonLdScript({ '@context': 'https://schema.org', '@graph': [organization, site] })}\n</head>`);
}

const PRIVATE_PATH = /^\/(?:app|admin|activate|reset|invite|create|home|verify-email|confirmemailreset)(?:\.html)?$|^\/(?:api|member-photos)(?:\/|$)/;
/** Reject external URLs, fragments, console routes and invented last-modified dates. */
export function sitemapEntry(entry, origin) {
  const path = entry?.path;
  if (typeof path !== 'string' || !/^\/[a-zA-Z0-9/_-]*$/.test(path) || path.startsWith('//') || PRIVATE_PATH.test(path)) return null;
  const value = entry.lastmod;
  const lastmod = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value.slice(0,10) ? value : null;
  return { path, xml: `  <url><loc>${origin}${path}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}</url>\n` };
}
