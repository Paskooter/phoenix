import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { waitForAccountReady, ACCOUNT_READY_TIMEOUT_MS } from '../src/accountReadiness.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function peer(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('Account readiness requires HTTP 200, probes only healthcheck, and recovers without a restart', async (t) => {
  let ready = false;
  const requests = [];
  const base = await peer(t, (req, res) => {
    requests.push({ method: req.method, url: req.url });
    res.writeHead(ready ? 200 : 503);
    res.end('readiness fixture');
  });
  let resolved = false;
  const pending = waitForAccountReady(base, { timeoutMs: 2000 }).then(() => { resolved = true; });
  const deadline = performance.now() + 1000;
  while (requests.length < 2 && performance.now() < deadline) await sleep(10);
  assert.ok(requests.length >= 2, 'the real HTTP readiness checks ran');
  assert.equal(resolved, false, 'a reachable HTTP 503 is not ready');
  ready = true;
  await pending;
  assert.equal(resolved, true);
  assert.deepEqual(requests, requests.map(() => ({ method: 'GET', url: '/healthcheck' })));
});

test('one readiness deadline bounds a peer that accepts connections but never responds', async (t) => {
  let hits = 0;
  const base = await peer(t, () => { hits += 1; });
  const start = performance.now();
  await assert.rejects(waitForAccountReady(base, { timeoutMs: 120 }), /deadline exceeded after 120ms/);
  assert.equal(hits, 1);
  assert.ok(performance.now() - start < 900, 'the header wait cannot outlive the startup budget indefinitely');
});

test('redirects are not followed while waiting for Account readiness', async (t) => {
  const paths = [];
  const base = await peer(t, (req, res) => {
    paths.push(req.url);
    if (req.url === '/elsewhere') { res.writeHead(200); res.end('not Account'); }
    else { res.writeHead(302, { location: '/elsewhere' }); res.end(); }
  });
  await assert.rejects(waitForAccountReady(base, { timeoutMs: 150 }), /deadline exceeded/);
  assert.ok(paths.length > 0);
  assert.ok(paths.every(path => path === '/healthcheck'));
});

test('readiness rejects invalid or unbounded deadlines before contacting a peer', async () => {
  assert.ok(ACCOUNT_READY_TIMEOUT_MS > 0 && ACCOUNT_READY_TIMEOUT_MS <= 60_000);
  for (const timeoutMs of [0, -1, 60_001, NaN, Infinity, 0.5]) {
    await assert.rejects(waitForAccountReady('http://127.0.0.1:1', { timeoutMs }), /timeout must be 1\.\.60000ms/);
  }
});
