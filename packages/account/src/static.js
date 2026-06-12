// Static file serving for the portal UI (packages/account/portal). Routes are exact-match in
// createService, so each served file gets an explicit route entry (no path globbing). Small,
// no-build, vanilla files — read once and cached in memory.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORTAL_DIR = join(dirname(fileURLToPath(import.meta.url)), '../portal');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function serve(file) {
  const path = join(PORTAL_DIR, file);
  const type = MIME[extname(file)] || 'application/octet-stream';
  let cached = null;
  return ({ res }) => {
    if (cached === null) cached = existsSync(path) ? readFileSync(path) : false;
    if (cached === false) { res.writeHead(404, { 'content-type': 'text/plain' }); return void res.end('not found'); }
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
    res.end(cached);
  };
}

/** Explicit GET routes for every portal asset; `/` and `/admin` serve index.html. */
export function staticRoutes() {
  const files = ['index.html', 'app.js', 'styles.css', 'qr.js'];
  const routes = {
    'GET /': serve('index.html'),
    'GET /admin': serve('index.html'), // SPA — client routes on the hash
  };
  for (const f of files) routes[`GET /${f}`] = serve(f);
  return routes;
}
