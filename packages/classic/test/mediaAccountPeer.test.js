import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough, Readable } from 'node:stream';
import { accountMediaLoops, MediaStore, mediaBlobRoutes } from '../src/media.js';
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
