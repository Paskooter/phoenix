import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, createAccountService } from '../src/index.js';
import { createOwnerAccount } from '../src/model.js';
import { createSession, sessionCookie } from '../src/sessions.js';
import { AddressSearchError, createAddressSearchService } from '../src/portal/addressSearch.js';

const providerRow = { display_name: '1 Main Street, Example City', lat: '42.1', lon: '-71.2' };
const providerResponse = () => new Response(JSON.stringify([providerRow]), {
  status: 200, headers: { 'content-type': 'application/json' },
});

test('address lookup serializes upstream calls, identifies the app, and caches repeat searches', async () => {
  let clock = 1000;
  const starts = [];
  const service = createAddressSearchService({
    now: () => clock,
    wait: async (ms) => { clock += ms; },
    fetcher: async (url, options) => {
      starts.push({ at: clock, url, options });
      return providerResponse();
    },
  });

  const [first, second] = await Promise.all([
    service.search(' 1 Main Street ', 'owner-1'),
    service.search('2 Main Street', 'owner-2'),
  ]);
  assert.equal(starts.length, 2);
  assert.ok(starts[1].at - starts[0].at >= 1100);
  assert.equal(new URL(starts[0].url).hostname, 'nominatim.openstreetmap.org');
  assert.equal(new URL(starts[0].url).searchParams.get('q'), '1 Main Street');
  assert.match(starts[0].options.headers['user-agent'], /Phoenix/);
  assert.equal(starts[0].options.redirect, 'error');
  assert.deepEqual(first, [{ label: providerRow.display_name, lat: 42.1, lng: -71.2 }]);
  assert.deepEqual(second, first);
  assert.deepEqual(await service.search('1 MAIN STREET', 'owner-1'), first);
  assert.equal(starts.length, 2, 'repeat search must use the shared cache');
});

test('address lookup enforces input, per-account and queue bounds', async () => {
  let clock = 1000;
  const service = createAddressSearchService({
    now: () => clock,
    wait: async (ms) => { clock += ms; },
    fetcher: async () => providerResponse(),
  });
  await assert.rejects(service.search('a', 'owner'), (error) => error instanceof AddressSearchError && error.status === 400);
  for (let i = 0; i < 12; i += 1) await service.search('1 Main Street', 'owner');
  await assert.rejects(service.search('1 Main Street', 'owner'), (error) => error.status === 429);
  clock += 60_000;
  assert.equal((await service.search('1 Main Street', 'owner')).length, 1);

  let release;
  let queuedClock = 1000;
  const blocked = createAddressSearchService({
    now: () => queuedClock,
    wait: async (ms) => { queuedClock += ms; },
    fetcher: () => new Promise((resolve) => { release = () => resolve(providerResponse()); }),
  });
  const tasks = [1, 2, 3, 4].map((n) => blocked.search(`${n} Main Street`, `owner-${n}`));
  await assert.rejects(blocked.search('5 Main Street', 'owner-5'), (error) => error.status === 429);
  // Let the first provider response finish; later queued requests receive the
  // same response from this test provider without waiting on the real network.
  await Promise.resolve();
  for (let i = 0; i < 4; i += 1) {
    while (!release) await new Promise((resolve) => setImmediate(resolve));
    const done = release;
    release = null;
    done();
  }
  await Promise.all(tasks);
});

test('bad provider data is rejected and does not poison the cache', async () => {
  let calls = 0;
  const service = createAddressSearchService({
    now: () => 1000,
    wait: async () => {},
    fetcher: async () => {
      calls += 1;
      if (calls === 1) return new Response('{broken-json', { status: 200 });
      return new Response(JSON.stringify([
        { display_name: 'bad', lat: null, lon: null },
        providerRow,
      ]), { status: 200 });
    },
  });
  await assert.rejects(service.search('1 Main Street', 'owner'));
  assert.deepEqual(await service.search('1 Main Street', 'owner'), [
    { label: providerRow.display_name, lat: 42.1, lng: -71.2 },
  ]);
  assert.equal(calls, 2);
});

test('the portal route requires a session and never exposes upstream errors or coordinates from bad input', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'address-search-'));
  const store = new Store(join(dir, 'account.json'));
  const account = createOwnerAccount(store, {
    email: 'owner@example.test', password: 'password123', firstName: 'Owner',
  });
  let calls = 0;
  const addressSearchService = createAddressSearchService({
    fetcher: async () => { calls += 1; return providerResponse(); },
  });
  const app = createAccountService({ store, addressSearchService });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const cookie = sessionCookie(createSession(store, { kind: 'user', accountId: account._id })).split(';')[0];
  const search = (query, headers = {}) => fetch(`${base}/api/address-search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ query }),
  });
  try {
    const anonymous = await search('1 Main Street');
    assert.equal(anonymous.status, 401);
    assert.equal(calls, 0);

    const invalid = await search('x', { cookie });
    assert.equal(invalid.status, 400);
    assert.equal(calls, 0);

    const crossOrigin = await search('1 Main Street', { cookie, origin: 'https://attacker.example' });
    assert.equal(crossOrigin.status, 403);
    assert.equal(calls, 0);

    const valid = await search('1 Main Street', { cookie });
    assert.equal(valid.status, 200);
    assert.equal(valid.headers.get('cache-control'), 'no-store');
    assert.deepEqual((await valid.json()).results, [{ label: providerRow.display_name, lat: 42.1, lng: -71.2 }]);
    assert.equal(calls, 1);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
