// Static file serving for the portal (packages/account/portal) — the public
// site, the legal pages and the console.
//
// Routes are registered explicitly rather than by path globbing, so the set of
// files this service will hand out is visible in one list. Small, no-build,
// vanilla files: read once and cached in memory.
//
// The same files are laid out to be served directly by a reverse proxy instead,
// with only /api proxied back here; see deploy/nginx/.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORTAL_DIR = join(dirname(fileURLToPath(import.meta.url)), '../portal');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.woff2': 'font/woff2',
};

function serve(file, type) {
  const path = join(PORTAL_DIR, file);
  const contentType = type || MIME[extname(file)] || 'application/octet-stream';
  let cached = null;
  return ({ res }) => {
    if (cached === null) cached = existsSync(path) ? readFileSync(path) : false;
    if (cached === false) { res.writeHead(404, { 'content-type': 'text/plain' }); return void res.end('not found'); }
    res.writeHead(200, {
      'content-type': contentType,
      // Nothing here is content-hashed, so the browser must revalidate rather
      // than serve a stale console after an upgrade.
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    res.end(cached);
  };
}

/**
 * Branding, with an operator override.
 *
 * `branding.json` in the portal directory holds the defaults for every visible
 * string, the logo and the accent colour. An operator who does not want to edit
 * a file inside the checkout can point PHOENIX_BRANDING_FILE at their own JSON;
 * its keys are merged over the defaults, so a partial file only has to name what
 * it changes.
 */
function serveBranding() {
  let cached = null;
  return ({ res }) => {
    if (cached === null) cached = buildBranding();
    res.writeHead(200, {
      'content-type': MIME['.json'],
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    res.end(cached);
  };
}

function buildBranding() {
  const defaults = readJson(join(PORTAL_DIR, 'branding.json')) || {};
  const overridePath = process.env.PHOENIX_BRANDING_FILE;
  if (!overridePath) return Buffer.from(JSON.stringify(defaults));
  const override = readJson(overridePath);
  if (!override) {
    // A configured-but-unreadable override is an operator mistake worth saying
    // out loud, rather than silently serving the defaults.
    console.warn(`[portal] PHOENIX_BRANDING_FILE is set but could not be read: ${overridePath}`);
    return Buffer.from(JSON.stringify(defaults));
  }
  return Buffer.from(JSON.stringify(deepMerge(defaults, override)));
}

function readJson(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch { return null; }
}

/** Objects merge key by key; arrays and scalars are replaced wholesale. */
function deepMerge(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key], value) : value;
  }
  return out;
}

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** Explicit GET routes for every portal asset and page. */
export function staticRoutes() {
  // Vendored third-party assets keep their own directory so it stays obvious
  // what is ours. Leaflet is served from here rather than a CDN: the portal
  // runs on a LAN beside the robot and must not depend on an outside host to
  // render. (Map TILES do come from OpenStreetMap over the internet; the picker
  // degrades to manual latitude/longitude entry when they cannot be reached.)
  const files = [
    // pages
    'index.html', 'app.html', 'terms.html', 'privacy.html', 'security.html', '404.html',
    // styles
    'theme.css', 'site.css', 'console.css',
    // scripts
    'app.js', 'site.js', 'brand.js', 'qr.js', 'map.js',
    // vendored
    'vendor/leaflet.js', 'vendor/leaflet.css',
    // assets and metadata
    'assets/favicon.svg', 'robots.txt', 'sitemap.xml', 'manifest.webmanifest',
  ];

  const routes = {
    // The public site.
    'GET /': serve('index.html'),
    'GET /terms': serve('terms.html'),
    'GET /privacy': serve('privacy.html'),
    'GET /security': serve('security.html'),

    // The console. Both entry points serve the same shell, which routes on the
    // hash; /admin is kept because it is where the admin surface has always
    // lived.
    'GET /app': serve('app.html'),
    'GET /admin': serve('app.html'),

    // Operator-configurable branding.
    'GET /branding.json': serveBranding(),
  };

  for (const f of files) routes[`GET /${f}`] = serve(f);
  return routes;
}
