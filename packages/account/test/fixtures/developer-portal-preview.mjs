// Loopback-only Hub preview: production routes/assets, no private Store imports,
// accounts, robot connections, uploads or publication implementations.
import { createServer } from 'node:http';
import { staticRoutes } from '../../src/static.js';
import { contentProjectDir as defaultContent } from './developer-content.mjs';

export async function startDeveloperPreview({ contentProjectDir = defaultContent } = {}) {
  const old = process.env.PHOENIX_SKILL_STORE_ENABLED;
  process.env.PHOENIX_SKILL_STORE_ENABLED = 'true';
  let routes;
  try { routes = staticRoutes({ developerProjectDir: contentProjectDir }); }
  finally { if (old === undefined) delete process.env.PHOENIX_SKILL_STORE_ENABLED; else process.env.PHOENIX_SKILL_STORE_ENABLED = old; }
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/api/me' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"account":null}');
    }
    const handler = routes[req.method + ' ' + path];
    if (!handler) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
    if (path.startsWith('/developers')) res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'");
    try { handler({ req, res }); }
    catch (error) { res.writeHead(500, { 'content-type': 'text/plain' }); res.end(error.message); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    server, url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
