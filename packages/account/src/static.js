// Static file serving for the portal (packages/account/portal) — the public
// site, the legal pages and the console.
//
// Routes are registered explicitly rather than by path globbing, so the set of
// files this service will hand out is visible in one list. Small, no-build,
// vanilla files: read once and cached in memory.
//
// The same files are laid out to be served directly by a reverse proxy instead,
// with only /api proxied back here; see deploy/nginx/.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_DIR = dirname(fileURLToPath(import.meta.url));
const PORTAL_DIR = join(SOURCE_DIR, '../portal');
// A deliberately small, fixed set of installation helpers is published beside
// the portal.  Keep this root derived from this module, rather than from the
// current working directory, so a systemd service cannot accidentally serve a
// different checkout after an operator changes WorkingDirectory.
const PROJECT_DIR = join(SOURCE_DIR, '../../..');

/**
 * The instance's own public origin, e.g. `https://jibo.io`.
 *
 * Open Graph and Twitter card scrapers do NOT resolve relative URLs: a root-relative
 * `og:image` yields no preview at all on Discord, Facebook, Slack or iMessage. The pages
 * therefore carry a `%SITE_URL%` placeholder that is substituted here at serve time, so
 * one set of files works for any deployment without a build step. Unset (the self-hosted
 * default) the placeholder collapses to a relative URL, which still renders correctly in
 * a browser -- only the social preview needs the absolute form.
 */
function siteUrl() {
  const raw = process.env.PHOENIX_SITE_URL || '';
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    // The value is interpolated into HTML.  Accept only a normal origin so a
    // malformed deployment setting cannot become markup, a javascript: URL,
    // or a query/fragment injection sink.
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
      || parsed.pathname !== '/' || parsed.search || parsed.hash) return '';
    return parsed.origin;
  } catch {
    return '';
  }
}

function applyPlaceholders(buffer) {
  return Buffer.from(buffer.toString('utf8').split('%SITE_URL%').join(siteUrl()));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.woff2': 'font/woff2',
};

/** Text types get placeholder substitution; binaries are served byte-for-byte. */
const SUBSTITUTED = new Set(['.html', '.xml', '.webmanifest', '.txt']);

function serve(file, type) {
  const path = join(PORTAL_DIR, file);
  const contentType = type || MIME[extname(file)] || 'application/octet-stream';
  const substitute = SUBSTITUTED.has(extname(file));
  let cached = null;
  return ({ res }) => {
    if (cached === null) {
      cached = existsSync(path) ? readFileSync(path) : false;
      if (cached !== false && substitute) cached = applyPlaceholders(cached);
    }
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
 * Serve a file from OUTSIDE the portal directory (an operator's own page).
 *
 * Unlike serve(), the path is absolute and read fresh on a miss rather than assumed to
 * exist at startup, so an operator can add a page without restarting. Placeholders are
 * substituted exactly as for built-in pages, so an operator page gets the same
 * `%SITE_URL%` treatment.
 */
function serveExternal(absolutePath, type, extraHeaders = {}) {
  const contentType = type || MIME[extname(absolutePath)] || 'application/octet-stream';
  const substitute = SUBSTITUTED.has(extname(absolutePath));
  let cached = null;
  return ({ res }) => {
    if (cached === null) {
      cached = existsSync(absolutePath) ? readFileSync(absolutePath) : false;
      if (cached !== false && substitute) cached = applyPlaceholders(cached);
    }
    if (cached === false) { res.writeHead(404, { 'content-type': 'text/plain' }); return void res.end('not found'); }
    res.writeHead(200, {
      'content-type': contentType,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      ...extraHeaders,
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
    'app.js', 'pwa.js', 'site.js', 'brand.js', 'qr.js', 'map.js',
    // vendored
    'vendor/leaflet.js', 'vendor/leaflet.css',
    // assets and metadata
    'assets/favicon.svg', 'assets/og.png', 'robots.txt', 'sitemap.xml', 'manifest.webmanifest',
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
    // Root scope is intentional: the worker owns only the console app shell,
    // but its Push click handler must be able to open /app from any page.
    'GET /sw.js': serve('sw.js'),
    'GET /admin': serve('app.html'),
    // Mail actions intentionally enter the same static console shell. The
    // browser exchanges the single-use code with the same-origin API, so a
    // reverse proxy never needs to expose a token-bearing dynamic GET route.
    'GET /activate': serve('app.html'),
    'GET /reset': serve('app.html'),
    'GET /confirmemailreset': serve('app.html'),

    // Operator-configurable branding.
    'GET /branding.json': serveBranding(),

    // Public, fixed-path migration assets. These are not a directory mapping:
    // adding a file under scripts/ never makes it Internet-visible by accident.
    // The shell helper fetches these exact support files when it was downloaded
    // by itself, instead of assuming the customer has a source checkout.
    'GET /robot-ota-repoint.sh': serveExternal(
      join(PROJECT_DIR, 'scripts/robot-ota-repoint.sh'), 'text/plain; charset=utf-8'),
    'GET /robot-client/node.js': serveExternal(
      join(PROJECT_DIR, 'scripts/robot-client/node.js'), 'text/plain; charset=utf-8'),
    'GET /robot-client/isrg-root-x1.pem': serveExternal(
      join(PROJECT_DIR, 'scripts/robot-client/isrg-root-x1.pem'), 'application/x-pem-file'),
  };

  for (const f of files) routes[`GET /${f}`] = serve(f);

  // Operator pages: extra HTML an instance serves that the project does not ship.
  //
  // A public instance needs content the generic project cannot carry -- a setup guide
  // naming its own hostnames, legal text describing a service someone actually
  // operates. Rather than fork the portal, point PHOENIX_PAGES_DIR at a directory of
  // .html files; each becomes a route at its own basename, and one named the same as a
  // built-in REPLACES it. Nothing is read from that directory unless it is configured,
  // so the default install is unchanged.
  const pagesDir = process.env.PHOENIX_PAGES_DIR;
  if (pagesDir && existsSync(pagesDir)) {
    for (const entry of readdirSync(pagesDir)) {
      if (!entry.endsWith('.html')) continue;
      const name = entry.slice(0, -'.html'.length);
      const handler = serveExternal(join(pagesDir, entry));
      routes[`GET /${name}`] = handler;
      routes[`GET /${entry}`] = handler;
      if (name === 'index') routes['GET /'] = handler;
    }
  }

  return routes;
}
