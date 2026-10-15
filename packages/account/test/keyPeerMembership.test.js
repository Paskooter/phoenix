import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyPeerRoutes } from '../src/keyPeerRoutes.js';

function readMembers(loop) {
  let status = 200;
  let payload;
  const result = keyPeerRoutes({ loops: new Map([['loop', loop]]) })['GET /loopMembers']({
    req: { headers: { 'x-phoenix-internal-token': process.env.ETCO_account_internalPeerToken } },
    url: new URL('http://localhost/loopMembers?loopId=loop'),
    res: { writeHead(value) { status = value; }, end(value) { payload = JSON.parse(value); } },
  });
  return { status, body: result || payload };
}

test('Key and Media peer projection contains only accepted account members', () => {
  const previous = process.env.ETCO_account_internalPeerToken;
  process.env.ETCO_account_internalPeerToken = 'synthetic-member-peer';
  try {
    const loop = { _id: 'loop', owner: 'owner', robot: 'robot', members: [
      { accountId: 'owner', status: 'accepted' }, { accountId: 'robot', status: 'ACCEPTED' },
      ...['invited', 'declined', 'removed', 'INVITED', 'DECLINED', 'REMOVED', 'unknown', null]
        .map((status, index) => ({ accountId: `account-${index}`, status })),
      { status: 'accepted' }, null,
    ] };
    assert.deepEqual(readMembers(loop), { status: 200, body: { id: 'loop', members: ['owner', 'robot'] } },
      'authorization projection requires accepted membership');
    loop.isDeleted = true;
    assert.equal(readMembers(loop).status, 404, 'deleted loops have no authorization projection');
  } finally {
    if (previous === undefined) delete process.env.ETCO_account_internalPeerToken;
    else process.env.ETCO_account_internalPeerToken = previous;
  }
});
