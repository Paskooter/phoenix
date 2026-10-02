import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough, Readable } from 'node:stream';
import { accountMediaLoops, MediaStore, mediaBlobRoutes, makeMediaHandler } from '../src/media.js';
import { VERIFIED_CALLER } from '../src/caller.js';

test('Media resolves loop authority only through the authenticated Account peer', async () => {
  const calls = [];
  const peer = accountMediaLoops({
    base: 'http://account.internal:9011',
    token: 'fixture-peer-token',
    fetcher: async (url, init) => {
      calls.push({ url: String(url), init });
      const path = new URL(url).pathname;
      if (path === '/loopMembers') return new Response(JSON.stringify({ members: ['member-1'] }));
      if (path === '/listAssociatedLoops') return new Response(JSON.stringify({ 'member-1': ['loop-1'] }));
      if (path === '/ownedLoops') return new Response(JSON.stringify({ loops: ['loop-owner-1'] }));
      return new Response('', { status: 404 });
    },
  });

  assert.deepEqual(await peer.members('loop-1'), ['member-1']);
  assert.deepEqual(await peer.accountLoops('member-1'), ['loop-1']);
  assert.deepEqual(await peer.ownedLoops('member-1'), ['loop-owner-1']);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].init.headers['x-phoenix-internal-token'], 'fixture-peer-token');
  assert.match(calls[0].url, /\/loopMembers\?loopId=loop-1$/);
  assert.equal(calls[1].init.method, 'POST');
  assert.equal(calls[1].init.headers['content-type'], 'application/json');
  assert.equal(calls[1].init.body, JSON.stringify({ accountsIds: ['member-1'] }));
  assert.match(calls[2].url, /\/ownedLoops\?accountId=member-1$/);
});

test('Media fails closed when its Account peer rejects or malforms a response', async () => {
  const peer = accountMediaLoops({
    base: 'http://account.internal',
    token: 'fixture-peer-token',
    fetcher: async () => new Response(JSON.stringify({ unexpected: true }), { status: 200 }),
  });
  assert.equal(await peer.members('loop-1'), undefined);
  assert.equal(await peer.accountLoops('member-1'), undefined);
  assert.equal(await peer.ownedLoops('member-1'), undefined);
});

test('Media reports distinct Account failure reasons without household or transport details', async (t) => {
  const cases = [
    { name: 'missing loop', status: 404, body: { statusCode: 404, error: 'Not Found', message: 'Loop not found' }, reason: 'loop_not_found' },
    { name: 'missing route', status: 404, body: { message: 'private-fixture-route' }, reason: 'http_error' },
    { name: 'peer authentication', status: 401, body: { error: 'private-fixture-token' }, reason: 'http_error' },
    { name: 'peer unavailable', status: 503, body: { message: 'private-fixture-host' }, reason: 'http_error' },
    { name: 'malformed JSON', status: 200, raw: 'private-fixture-body', reason: 'invalid_json' },
    { name: 'malformed shape', status: 200, body: { members: 'private-fixture-member' }, reason: 'invalid_response' },
    { name: 'timeout', error: new DOMException('private-fixture-url', 'TimeoutError'), reason: 'timeout' },
    { name: 'body timeout', status: 200, bodyError: new DOMException('private-fixture-url', 'AbortError'), reason: 'timeout' },
    { name: 'connection failure', error: new TypeError('private-fixture-url'), reason: 'transport_error' },
  ];
  for (const fixture of cases) await t.test(fixture.name, async () => {
    const messages = [];
    const peer = accountMediaLoops({
      base: 'http://private-fixture-host', token: 'private-fixture-token',
      log: { warn: (message, fields) => messages.push({ message, ...fields }) },
      fetcher: async () => {
        if (fixture.error) throw fixture.error;
        if (fixture.bodyError) return { ok: true, status: fixture.status, json: async () => { throw fixture.bodyError; } };
        return new Response(fixture.raw ?? JSON.stringify(fixture.body), { status: fixture.status });
      },
    });
    assert.equal(await peer.members('private-fixture-loop'), undefined, 'failure must not grant membership');
    assert.deepEqual(messages, [{
      message: 'media account lookup failed', event: 'media_account_lookup_failed',
      operation: 'members', reason: fixture.reason,
      ...(fixture.status === undefined ? {} : { status: fixture.status }),
    }]);
    assert.doesNotMatch(JSON.stringify(messages), /private-fixture/);
  });
});

function captureLog() {
  const messages = [];
  const log = Object.fromEntries(['info', 'warn', 'error'].map(level => [level,
    (message, fields) => messages.push({ level, message, ...fields })]));
  return { log, messages };
}

test('a missing Account loop explains a Media.List 503 in the request log and stays fail-closed', async () => {
  const { log, messages } = captureLog();
  const loops = accountMediaLoops({
    base: 'http://private-fixture-host', token: 'private-fixture-token',
    log: { warn: () => assert.fail('the request logger should receive the peer diagnostic') },
    fetcher: async () => new Response(JSON.stringify({
      statusCode: 404, error: 'Not Found', message: 'Loop not found',
    }), { status: 404 }),
  });
  const handler = makeMediaHandler({ store: {}, loops, callerBoundary: true });
  const sink = responseSink();
  const completed = sink.result();
  await handler({ req: verifiedRequest('private-fixture-account'), res: sink.res,
    body: { loopIds: ['private-fixture-loop'] }, op: 'List', log });
  const result = await completed;
  assert.equal(result.statusCode, 503);
  assert.equal(JSON.parse(result.body).__type, 'ACCOUNT_SERVICE_UNAVAILABLE');
  assert.equal(messages.find(row => row.event === 'media_account_lookup_failed')?.reason, 'loop_not_found');
  assert.deepEqual(messages.find(row => row.event === 'media_request_failed'), {
    level: 'error', message: 'media request failed', event: 'media_request_failed',
    operation: 'list', status: 503, errorCode: 'ACCOUNT_SERVICE_UNAVAILABLE',
  });
  assert.doesNotMatch(JSON.stringify(messages), /private-fixture/);
});

test('orphan thumbnail rejection is visible without storing bytes or leaking media identifiers', async () => {
  const { log, messages } = captureLog();
  const store = {
    maxBytes: 1024, find: () => null, findByThumbPath: () => null,
    writeBlob: () => assert.fail('an orphan thumbnail must not be stored'),
  };
  const handler = makeMediaHandler({ store, callerBoundary: true, baseFor: 'https://api.example.test',
    loops: { members: () => ['private-fixture-account'] } });
  const req = { ...verifiedRequest('private-fixture-account'), headers: {
    'x-loop-id': 'private-fixture-loop', 'x-path': 'private-fixture-thumb',
    'x-type': 'thumb', 'x-reference': 'private-fixture-parent',
  } };
  const sink = responseSink();
  const completed = sink.result();
  await handler({ req, res: sink.res, op: 'Create', log });
  const result = await completed;
  assert.equal(result.statusCode, 404);
  assert.equal(JSON.parse(result.body).__type, 'REFERENCE_NOT_FOUND');
  assert.deepEqual(messages.find(row => row.event === 'media_request_failed'), {
    level: 'warn', message: 'media request rejected', event: 'media_request_failed',
    operation: 'create', status: 404, errorCode: 'REFERENCE_NOT_FOUND', type: 'thumb',
  });
  assert.doesNotMatch(JSON.stringify(messages), /private-fixture/);
});

test('Media logs a storage failure code without its private path or exception message', async () => {
  const { log, messages } = captureLog();
  const store = {
    maxBytes: 1024, find: () => null, findByThumbPath: () => null, created: () => 1,
    putObject: async () => { throw Object.assign(new Error('private-fixture-path'), { code: 'ENOSPC' }); },
  };
  const handler = makeMediaHandler({ store, callerBoundary: true, baseFor: 'https://api.example.test',
    loops: { members: () => ['private-fixture-account'] } });
  const req = { ...verifiedRequest('private-fixture-account'), headers: {
    'x-loop-id': 'private-fixture-loop', 'x-path': 'private-fixture-photo', 'x-type': 'image',
  } };
  const sink = responseSink();
  const completed = sink.result();
  await handler({ req, res: sink.res, op: 'Create', log });
  const result = await completed;
  assert.equal(result.statusCode, 500);
  assert.equal(JSON.parse(result.body).__type, 'InternalFailure');
  const failure = messages.find(row => row.event === 'media_request_failed');
  assert.equal(failure.level, 'error');
  assert.equal(failure.cause, 'ENOSPC');
  assert.doesNotMatch(JSON.stringify(messages), /private-fixture/);
});

function verifiedRequest(accountId, path) {
  const caller = { accountId };
  Object.defineProperty(caller, VERIFIED_CALLER, { value: true });
  return { params: { path }, [VERIFIED_CALLER]: caller };
}

function responseSink() {
  const res = new PassThrough();
  const chunks = [];
  // Node's ServerResponse defaults to 200 when a handler streams without
  // explicitly calling writeHead, which is how the successful blob path runs.
  let statusCode = 200;
  res.on('data', (chunk) => chunks.push(chunk));
  res.writeHead = (status) => { statusCode = status; return res; };
  res.setHeader = () => {};
  return {
    res,
    result: async () => {
      await new Promise((resolve, reject) => { res.once('end', resolve); res.once('error', reject); });
      return { statusCode, body: Buffer.concat(chunks).toString('utf8') };
    },
  };
}

test('Media blob reads authorize every current loop member, not only the original uploader', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-media-blob-member-'));
  try {
    const store = new MediaStore({ directory: join(dir, 'objects'), file: join(dir, 'media.json') });
    await store.putObject({
      path: 'shared-photo', type: 'image', accountId: 'uploader', loopId: 'shared-loop',
      created: 1, meta: {}, isEncrypted: false, isDeleted: false, thumbs: [],
    }, Readable.from([Buffer.from('shared-bytes')]));
    const handler = mediaBlobRoutes(store, {
      callerBoundary: true,
      loops: { members: async () => ['uploader', 'another-member'] },
    })['GET /media/blob/:path'];
    const allowed = responseSink();
    const allowedResult = allowed.result();
    await handler({ req: verifiedRequest('another-member', 'shared-photo'), res: allowed.res });
    assert.deepEqual(await allowedResult, { statusCode: 200, body: 'shared-bytes' });

    const deniedHandler = mediaBlobRoutes(store, {
      callerBoundary: true,
      loops: { members: async () => ['uploader'] },
    })['GET /media/blob/:path'];
    const denied = responseSink();
    const deniedResult = denied.result();
    await deniedHandler({ req: verifiedRequest('former-member', 'shared-photo'), res: denied.res });
    assert.deepEqual(await deniedResult, { statusCode: 403, body: 'forbidden' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
