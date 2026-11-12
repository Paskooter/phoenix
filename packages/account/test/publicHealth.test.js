// Public health check for outside uptime monitors: GET /health on the site.
//
// nginx forwards it to this service and answers 503 whenever the service cannot,
// planned restarts included (deploy/nginx/phoenix-health.conf).
// The body must stay small and free of private data: no host names, versions,
// counts, accounts or household details.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'phx-public-health-'));
process.env.ETCO_account_dataFile = join(dir, 'store.json');

const { Store } = await import('../src/store.js');
const { createAccountService } = await import('../src/index.js');

let server; let base;

before(async () => {
  const store = new Store(process.env.ETCO_account_dataFile);
  server = await createAccountService({ store }).listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

test('GET /health answers a small uncached JSON status without signing in', async () => {
  const res = await fetch(`${base}/health`, { headers: { accept: 'text/html' } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /^application\/json\b/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('set-cookie'), null, 'a health check must not start a session');
  assert.deepEqual(await res.json(), { status: 'ok' });
});

test('HEAD /health succeeds for monitors that only check the status line', async () => {
  const res = await fetch(`${base}/health`, { method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '');
});

test('the existing /healthcheck probe used by the deploy script is unchanged', async () => {
  const res = await fetch(`${base}/healthcheck`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ok');
});

test('nginx reports /health down whenever the service cannot answer, planned restarts included', () => {
  const conf = readFileSync(new URL('../../../deploy/nginx/phoenix-health.conf', import.meta.url), 'utf8');
  assert.match(conf, /error_page 502 503 504 = @phoenix_health_down;/);
  assert.match(conf, /return 503 '\{"status":"down"\}\\n';/);
  assert.doesNotMatch(conf, /try_files|restarting/, 'robots get no answer during a restart, so /health must not say ok');
});
