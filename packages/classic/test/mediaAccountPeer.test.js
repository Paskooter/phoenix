import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountMediaLoops } from '../src/media.js';

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
