// Relay upstream deadline regressions, re-ported from the September week review
// (fix/week-review-hardening bbe5dfbb/34cc9064). Every account, credential, token
// and URL below is synthetic test data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TTLCache } from '../src/cache.js';
import { createRelay } from '../src/relay.js';

test('relay answers 502 when a provider outlives its deadline, and aborts the provider signal', async () => {
  let seenSignal;
  const relay = createRelay({
    name: 'SyntheticRelay',
    ttlSeconds: 60,
    cache: new TTLCache(),
    validate: () => ({}),
    key: () => 'synthetic',
    timeoutMs: 20,
    fetchExternal: (_input, _log, _req, { signal } = {}) => {
      seenSignal = signal;
      return new Promise(() => {}); // ignores the signal entirely
    },
  });
  const res = {
    writableEnded: false,
    writeHead(status) { this.status = status; },
    setHeader() {},
    end(body) { this.body = body; this.writableEnded = true; },
  };
  const req = { method: 'GET', once() {}, removeListener() {} };
  await relay({ req, res, url: new URL('http://data.invalid/v1/synthetic?skipCache=1') });
  assert.equal(res.status, 502);
  assert.match(String(res.body), /SyntheticRelay request timed out after 20ms/);
  assert.ok(seenSignal?.aborted, 'the provider signal is aborted at the deadline');
});
