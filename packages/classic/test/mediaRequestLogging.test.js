// Synthetic, offline requests through the real Classic router, caller boundary,
// Account adapter and common HTTP logger. The Account fetch boundary is the only peer double.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createService, recentLogs } from '@phoenix/common';
import { createClassicRouter } from '../src/router.js';
import { createVerifiedClassicCaller } from '../src/caller.js';
import { accountMediaLoops, makeMediaHandler } from '../src/media.js';
import { signedFetch, syntheticAccount } from './fixtures/signedClassic.js';

const ACCOUNT = syntheticAccount('synthetic-media-account');
const LOOP = 'synthetic-media-loop';
const UNAVAILABLE = '{"__type":"ACCOUNT_SERVICE_UNAVAILABLE","message":"Account service not available"}';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const missingLoop = () => new Response(JSON.stringify({
  statusCode: 404, error: 'Not Found', message: 'Loop not found',
}), { status: 404 });

async function fixture(t, fetcher) {
  let reads = 0;
  const store = { get records() { reads++; return new Map(); } };
  const loops = accountMediaLoops({
    base: 'http://synthetic-private-account.invalid', token: 'synthetic-private-peer-token', fetcher,
  });
  const callerBoundary = createVerifiedClassicCaller({
    resolveCredentials: key => key === ACCOUNT.accessKeyId ? ACCOUNT : null,
  });
  const service = createService({ name: 'classic', routes: createClassicRouter([
    { match: /^media/i, handler: makeMediaHandler({ store, loops, callerBoundary }) },
  ], { callerBoundary }) });
  const server = await service.listen(0, '127.0.0.1');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    reads: () => reads,
    cursor: recentLogs({ limit: 1 }).cursor,
  };
}

async function list(base, { headers = {}, body = { loopIds: [LOOP] }, target = 'Media_20160725.List' } = {}) {
  const res = await signedFetch(`${base}/`, {
    credentials: ACCOUNT,
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': target, ...headers },
    body: JSON.stringify(body),
  });
  return {
    status: res.status, type: res.headers.get('x-amzn-errortype'),
    contentType: res.headers.get('content-type'), length: res.headers.get('content-length'),
    raw: await res.text(),
  };
}

function assertUnavailable(response) {
  assert.deepEqual(response, {
    status: 503, type: 'ACCOUNT_SERVICE_UNAVAILABLE',
    contentType: 'application/x-amz-json-1.1', length: String(Buffer.byteLength(UNAVAILABLE)),
    raw: UNAVAILABLE,
  });
}

function assertTriplet(rows, reason, status) {
  const peer = rows.filter(row => row.event === 'media_account_lookup_failed');
  const media = rows.filter(row => row.event === 'media_request_failed');
  const http = rows.filter(row => row.msg === 'request failed');
  assert.equal(peer.length, 1, 'exactly one peer failure per request');
  assert.equal(media.length, 1, 'exactly one Media failure per request');
  assert.equal(http.length, 1, 'the real common HTTP failure record must be present');
  assert.equal(typeof peer[0].transId, 'string', 'the lookup warning needs a request-scoped correlation');
  assert.match(peer[0].transId, UUID);
  assert.equal(media[0].transId, peer[0].transId, 'Media failure must retain the peer correlation');
  assert.equal(http[0].transId, peer[0].transId, 'HTTP failure must retain the peer correlation');
  assert.equal(peer[0].operation, 'members');
  assert.equal(peer[0].reason, reason);
  assert.equal(peer[0].status, status);
  assert.equal(peer[0].level, 'warn');
  assert.equal(media[0].status, 503);
  assert.equal(media[0].errorCode, 'ACCOUNT_SERVICE_UNAVAILABLE');
  assert.equal(media[0].operation, 'list');
  assert.equal(http[0].status, 503);
  return peer[0].transId;
}

test('Media.List correlates overlapping missing-loop warning, failure and HTTP response without conflating requests', { timeout: 5_000 }, async t => {
  let calls = 0;
  let secondEntered;
  const overlap = new Promise(resolve => { secondEntered = resolve; });
  const f = await fixture(t, async () => {
    calls++;
    if (calls === 1) await overlap;
    else secondEntered();
    return missingLoop();
  });
  const responses = await Promise.all([list(f.base), list(f.base)]);
  responses.forEach(assertUnavailable);
  assert.equal(calls, 2, 'each request must perform its own membership check, without retries');
  assert.equal(f.reads(), 0, 'an unresolved membership must never read media');
  const rows = recentLogs({ since: f.cursor, limit: 100 }).events;
  const warnings = rows.filter(row => row.event === 'media_account_lookup_failed');
  assert.equal(warnings.length, 2);
  for (const warning of warnings) {
    assert.equal(typeof warning.transId, 'string', 'lookup warning must gain a generated request correlation');
  }
  const ids = new Set(warnings.map(row => row.transId));
  assert.equal(ids.size, 2, 'identical callers and bodies still require distinct request correlations');
  for (const id of ids) {
    assertTriplet(rows.filter(row => row.transId === id), 'loop_not_found', 404);
  }
  assert.equal(rows.length, 10, 'two request records plus the failure triplet for each request');
});

function assertAllowlisted(rows) {
  const baseKeys = ['t', 'seq', 'level', 'ns', 'msg', 'transId'];
  const fields = {
    'classic request': ['target', 'op', 'matched', 'authenticated'],
    'media request': ['op'],
    'media account lookup failed': ['event', 'operation', 'reason', 'status'],
    'media request failed': ['event', 'operation', 'status', 'errorCode'],
    'media request rejected': ['event', 'operation', 'status', 'errorCode'],
    'request failed': ['status', 'method', 'route', 'operation'],
  };
  for (const row of rows) {
    assert.ok(Object.hasOwn(fields, row.msg), 'only bounded, known Media diagnostics are permitted');
    const allowed = new Set([...baseKeys, ...fields[row.msg]]);
    for (const [key, value] of Object.entries(row)) {
      assert.ok(allowed.has(key), `unexpected diagnostic field: ${key}`);
      assert.ok(['string', 'number', 'boolean'].includes(typeof value), 'no structured payloads in diagnostics');
      if (typeof value === 'string') assert.ok(value.length <= 80, `unbounded diagnostic field: ${key}`);
    }
    assert.match(row.transId, UUID);
  }
}

test('Media diagnostics reject hostile trace, target, identity, body and exception values', async t => {
  const clientId = 'c0ffee00-1111-4222-8333-444444444444';
  const turnId = 'badc0ffe-1111-4222-8333-444444444444';
  const headers = {
    'x-jibo-transid': clientId,
    'x-phoenix-turn-id': turnId,
    'x-jibo-robotid': 'synthetic-private-robot',
    'x-jibo-logging-config': JSON.stringify({ classic: 'debug' }),
    'x-amz-credentials': JSON.stringify({ id: 'synthetic-private-forwarded-account', isAdmin: true }),
    'x-request-id': 'synthetic-private-request-id',
  };
  for (const mode of ['missing loop', 'transport failure', 'oversized trace with suppressed logging']) await t.test(mode, async t => {
    const transportFailure = mode === 'transport failure';
    const calls = [];
    const f = await fixture(t, async (url, init) => {
      calls.push({ url, init });
      if (transportFailure) {
        const error = new TypeError('https://synthetic-private-host/household?token=synthetic-private-secret');
        error.stack = 'synthetic-private-stack';
        throw error;
      }
      return new Response(JSON.stringify({
        statusCode: 404, error: 'Not Found', message: 'Loop not found',
        account: 'synthetic-private-response-account', text: 'synthetic-private-response-text',
      }), { status: 404 });
    });
    const response = await list(f.base, {
      headers: mode.startsWith('oversized') ? {
        ...headers, 'x-jibo-transid': 'synthetic-private-trace'.repeat(128),
        'x-jibo-logging-config': JSON.stringify({ classic: 'error' }),
      } : headers,
      target: 'Media_syntheticPrivatePrefix.LiSt',
      body: {
        loopIds: ['synthetic-private-loop'], accountId: 'synthetic-private-body-account',
        text: 'synthetic-private-speech', password: 'synthetic-private-password',
        url: 'https://synthetic-private-host/household?token=synthetic-private-secret',
      },
    });
    assertUnavailable(response);
    assert.equal(calls.length, 1, 'diagnostics must not add a membership retry');
    assert.equal(new URL(calls[0].url).searchParams.get('loopId'), 'synthetic-private-loop');
    assert.deepEqual(calls[0].init.headers, { 'x-phoenix-internal-token': 'synthetic-private-peer-token' });
    assert.equal(f.reads(), 0);
    const rows = recentLogs({ since: f.cursor, limit: 100 }).events;
    const id = assertTriplet(rows, transportFailure ? 'transport_error' : 'loop_not_found', transportFailure ? undefined : 404);
    assert.notEqual(id, clientId, 'even a UUID-shaped caller trace must never be reused');
    assert.notEqual(id, turnId);
    const serialized = JSON.stringify(rows);
    assert.doesNotMatch(serialized, /synthetic/i, 'no request, peer, body or identity value may reach diagnostics');
    assert.ok(!serialized.includes(clientId) && !serialized.includes(turnId));
    assertAllowlisted(rows);
    assert.equal(rows.length, 5, 'caller turn headers must not add a voice-span log');
  });
});

test('malformed Media targets keep their existing response without logging caller-selected target or operation text', async t => {
  for (const target of ['Media_20160725.syntheticPrivateOperation', 'Media_syntheticPrivateDotless']) {
    await t.test(target.includes('.') ? 'unknown operation' : 'dotless target', async t => {
      let calls = 0;
      const f = await fixture(t, async () => { calls++; return missingLoop(); });
      const response = await list(f.base, { target, headers: {
        'x-jibo-transid': 'synthetic-private-trace',
      } });
      assert.equal(response.status, 400);
      assert.equal(calls, 0);
      assert.equal(f.reads(), 0);
      if (target.includes('.')) {
        assert.equal(response.type, 'ValidationException');
        assert.equal(response.raw, JSON.stringify({ __type: 'ValidationException', message: 'unknown media operation: syntheticPrivateOperation' }));
      } else {
        assert.equal(response.type, 'UnknownOperationException');
        assert.equal(response.raw, JSON.stringify({ __type: 'UnknownOperationException', message: `no classic service for target ${target}` }));
      }
      const rows = recentLogs({ since: f.cursor, limit: 100 }).events;
      assert.doesNotMatch(JSON.stringify(rows), /synthetic/i);
      for (const row of rows) assert.match(row.transId, UUID);
    });
  }
});

test('Media correlation leaves successful, forbidden and invalid List responses and membership checks unchanged', async t => {
  let calls = 0;
  let member = true;
  const f = await fixture(t, async () => {
    calls++;
    return new Response(JSON.stringify({ members: member ? [ACCOUNT._id] : ['synthetic-private-other-account'] }));
  });
  const allowed = await list(f.base);
  assert.equal(allowed.status, 200);
  assert.equal(allowed.type, null);
  assert.equal(allowed.raw, '[]');
  assert.equal(calls, 1);
  assert.equal(f.reads(), 1);

  member = false;
  const denied = await list(f.base);
  assert.equal(denied.status, 403);
  assert.equal(denied.type, 'MEDIA_MUST_BE_MEMBER');
  assert.equal(denied.raw, '{"__type":"MEDIA_MUST_BE_MEMBER","message":"You must be a member of the loop to list or create media"}');
  assert.equal(calls, 2, 'a request correlation is not a membership cache');
  assert.equal(f.reads(), 1, 'a nonmember must not read media');

  const invalid = await list(f.base, { body: { loopIds: [''] } });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.type, 'ValidationException');
  assert.equal(invalid.raw, '{"__type":"ValidationException","message":"Invalid or missing loopIds"}');
  assert.equal(calls, 2);
  assert.equal(f.reads(), 1);
  const rows = recentLogs({ since: f.cursor, limit: 100 }).events;
  assertAllowlisted(rows);
  assert.equal(new Set(rows.map(row => row.transId)).size, 3);
  assert.doesNotMatch(JSON.stringify(rows), /synthetic/i);
});

test('Media diagnostics bound an untrusted peer status without serializing it or granting membership', async t => {
  const f = await fixture(t, async () => ({
    ok: false,
    status: { toJSON: () => assert.fail('a peer value must never be serialized into diagnostics') },
  }));
  assertUnavailable(await list(f.base));
  assert.equal(f.reads(), 0);
  const rows = recentLogs({ since: f.cursor, limit: 100 }).events;
  assertTriplet(rows, 'http_error', undefined);
  assertAllowlisted(rows);
});
