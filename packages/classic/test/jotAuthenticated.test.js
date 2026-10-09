// Jot behind the verified caller boundary: the membership and robot-impersonation gates run
// against Account's peer loop lookup on both the X-Amz-Target face and the direct bulk
// unread-count route, and an unavailable lookup fails closed with ACCOUNT_SERVICE_UNAVAILABLE.
//
// All ids, keys, secrets and tokens are SYNTHETIC test values.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SYNTHETIC_PEER_TOKEN, freePort, setEnv, signedAmz, signedFetch, storeCallerBoundary,
  syntheticAccount, writeSyntheticAccountStore,
} from './fixtures/signedClassic.js';
import { createAccountService } from '../../account/src/index.js';
import { createClassicEntrypoint, JotMessageController, JotStore, JOT_BULK_ROUTE } from '../src/index.js';

const LOOP = 'synthetic-jot-loop-a';
const OTHER_LOOP = 'synthetic-jot-loop-b';
const OWNER = 'synthetic-jot-owner';
const MEMBER = 'synthetic-jot-member';
const INVITED = 'synthetic-jot-invited';
const OUTSIDER = 'synthetic-jot-outsider';
const ROBOT = 'synthetic-jot-robot';

const ACCOUNTS = Object.fromEntries([OWNER, MEMBER, INVITED, OUTSIDER, ROBOT]
  .map((id) => [id, syntheticAccount(id)]));
const LOOPS = [
  {
    _id: LOOP, owner: OWNER, robot: ROBOT,
    members: [
      { accountId: OWNER, status: 'accepted' },
      { accountId: MEMBER, status: 'accepted' },
      { accountId: INVITED, status: 'invited' },
      { accountId: ROBOT, status: 'accepted' },
    ],
  },
  { _id: OTHER_LOOP, owner: OUTSIDER, robot: 'synthetic-jot-other-robot', members: [{ accountId: OUTSIDER, status: 'accepted' }] },
];

async function harness({ accountReachable = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'phoenix-jot-auth-'));
  const store = writeSyntheticAccountStore(join(dir, 'account.json'), { accounts: Object.values(ACCOUNTS), loops: LOOPS });
  const restoreToken = setEnv({ ETCO_account_internalPeerToken: SYNTHETIC_PEER_TOKEN });
  let account = null;
  let accountBase;
  if (accountReachable) {
    account = await createAccountService({ store }).listen(0, '127.0.0.1');
    accountBase = `http://127.0.0.1:${account.address().port}`;
  } else {
    accountBase = `http://127.0.0.1:${await freePort()}`;
  }
  const restoreNet = setEnv({ NET_account: accountBase });
  const jotStore = new JotStore({ file: join(dir, 'jot.json') });
  const classic = createClassicEntrypoint({
    publicUrl: 'https://classic.synthetic.test',
    callerBoundary: storeCallerBoundary(store),
    notificationFile: join(dir, 'notifications.json'),
    jot: { store: jotStore, onEvent: () => {} },
  });
  const server = await classic.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    jotStore,
    amz: (target, body, id) => signedAmz(base, target, body, ACCOUNTS[id]),
    async bulk(body, id) {
      const res = await signedFetch(`${base}${JOT_BULK_ROUTE}`, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        credentials: ACCOUNTS[id],
      });
      const text = await res.text();
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { parsed = text; }
      return { status: res.status, body: parsed };
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      if (account) await new Promise((resolve) => account.close(resolve));
      restoreNet();
      restoreToken();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('authenticated Jot refuses a caller that is not an accepted member of the loop', async () => {
  const h = await harness();
  try {
    h.jotStore.create({ sender: OWNER, loopId: LOOP, content: 'synthetic member-only message', read: [OWNER], tags: [], parts: [] });
    for (const caller of [OUTSIDER, INVITED]) {
      const listed = await h.amz('Jot_20160512.ListMessages', { loopId: LOOP }, caller);
      assert.equal(listed.status, 403, `${caller} ListMessages`);
      assert.equal(listed.body.code, 'JOT_MUST_BE_LOOP_MEMBER');
      assert.ok(!JSON.stringify(listed.body).includes('member-only'));

      const created = await h.amz('Jot_20160512.CreateMessage', { loopId: LOOP, content: 'synthetic intrusion' }, caller);
      assert.equal(created.status, 403, `${caller} CreateMessage`);
      assert.equal(created.body.code, 'JOT_MUST_BE_LOOP_MEMBER');

      const marked = await h.amz('Jot_20160512.MarkLoopRead', { loopId: LOOP }, caller);
      assert.equal(marked.status, 403, `${caller} MarkLoopRead`);

      const counted = await h.amz('Jot_20160512.NumberOfUnreadMessagesInLoops', { loopIds: [LOOP] }, caller);
      assert.equal(counted.status, 403, `${caller} NumberOfUnreadMessagesInLoops`);
      assert.equal(counted.body.code, 'JOT_MUST_BE_LOOP_MEMBER');
    }
    const notRobot = await h.amz('Jot_20160512.ListMessages', { loopId: LOOP, impersonateAs: OWNER }, MEMBER);
    assert.equal(notRobot.status, 403);
    assert.equal(notRobot.body.code, 'JOT_ROBOT_CAN_IMPERSONATE');
    const robotAsOutsider = await h.amz('Jot_20160512.ListMessages', { loopId: LOOP, impersonateAs: OUTSIDER }, ROBOT);
    assert.equal(robotAsOutsider.status, 403);
    assert.equal(robotAsOutsider.body.code, 'JOT_MUST_BE_LOOP_MEMBER');
    assert.equal(h.jotStore.findForList({ loopId: LOOP }).length, 1, 'no message was written by a non-member');
  } finally { await h.close(); }
});

test('authenticated bulk unread count refuses loops and accounts the caller may not read', async () => {
  const h = await harness();
  try {
    h.jotStore.create({ sender: OWNER, loopId: LOOP, content: 'synthetic unread', read: [OWNER], tags: [], parts: [] });
    const ownLoopOnly = await h.bulk([{ accountId: OUTSIDER, loopIds: [LOOP] }], OUTSIDER);
    assert.equal(ownLoopOnly.status, 403);
    assert.equal(ownLoopOnly.body.code, 'JOT_MUST_BE_LOOP_MEMBER');

    const otherAccount = await h.bulk([{ accountId: MEMBER, loopIds: [LOOP] }], OUTSIDER);
    assert.equal(otherAccount.status, 403);
    assert.equal(otherAccount.body.code, 'JOT_ROBOT_CAN_IMPERSONATE');

    const mixed = await h.bulk([{ accountId: OUTSIDER, loopIds: [OTHER_LOOP, LOOP] }], OUTSIDER);
    assert.equal(mixed.status, 403, 'one unreadable loop refuses the whole request');

    const allowed = await h.bulk([{ accountId: OUTSIDER, loopIds: [OTHER_LOOP] }], OUTSIDER);
    assert.equal(allowed.status, 200);
    assert.deepEqual(allowed.body, [{ count: 0, accountId: OUTSIDER, loopIds: [OTHER_LOOP] }]);

    const unsigned = await fetch(`${h.base}${JOT_BULK_ROUTE}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify([{ accountId: MEMBER, loopIds: [LOOP] }]),
    });
    assert.equal(unsigned.status, 401);
  } finally { await h.close(); }
});

test('authenticated Jot still serves accepted members and robot impersonation', async () => {
  const h = await harness();
  try {
    const created = await h.amz('Jot_20160512.CreateMessage', { loopId: LOOP, content: 'synthetic hello' }, OWNER);
    assert.equal(created.status, 200);
    assert.equal(created.body.sender, OWNER);

    const listed = await h.amz('Jot_20160512.ListMessages', { loopId: LOOP }, MEMBER);
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.map((m) => m.content), ['synthetic hello']);

    const counted = await h.amz('Jot_20160512.NumberOfUnreadMessagesInLoops', { loopIds: [LOOP] }, MEMBER);
    assert.deepEqual(counted.body, { count: 1 });
    const bulk = await h.bulk([{ accountId: MEMBER, loopIds: [LOOP] }], MEMBER);
    assert.equal(bulk.status, 200);
    assert.deepEqual(bulk.body, [{ count: 1, accountId: MEMBER, loopIds: [LOOP] }]);

    const onBehalf = await h.amz('Jot_20160512.CreateMessage', { loopId: LOOP, content: 'synthetic from robot', impersonateAs: MEMBER }, ROBOT);
    assert.equal(onBehalf.status, 200);
    assert.equal(onBehalf.body.sender, MEMBER);
    const robotBulk = await h.bulk([{ accountId: OWNER, loopIds: [LOOP] }], ROBOT);
    assert.equal(robotBulk.status, 200);
    assert.deepEqual(robotBulk.body, [{ count: 1, accountId: OWNER, loopIds: [LOOP] }]);

  } finally { await h.close(); }
});

test('authenticated Jot answers ACCOUNT_SERVICE_UNAVAILABLE when Account cannot be reached', async () => {
  const h = await harness({ accountReachable: false });
  try {
    const listed = await h.amz('Jot_20160512.ListMessages', { loopId: LOOP }, OWNER);
    assert.equal(listed.status, 503);
    assert.equal(listed.body.code, 'ACCOUNT_SERVICE_UNAVAILABLE');
    const bulk = await h.bulk([{ accountId: OWNER, loopIds: [LOOP] }], OWNER);
    assert.equal(bulk.status, 503);
    assert.equal(bulk.body.code, 'ACCOUNT_SERVICE_UNAVAILABLE');
  } finally { await h.close(); }
});

test('a Jot controller that requires Account never skips the gates without a seam', async () => {
  const controller = new JotMessageController({ store: new JotStore({ file: null }), requireAccount: true });
  await assert.rejects(controller.list({ accountId: OUTSIDER, loopId: LOOP }), { code: 'ACCOUNT_SERVICE_UNAVAILABLE', statusCode: 503 });
  await assert.rejects(controller.numberOfUnreadMessagesBulk([{ accountId: OUTSIDER, loopIds: [LOOP] }], { callerId: OUTSIDER }),
    { code: 'ACCOUNT_SERVICE_UNAVAILABLE' });
  const lanTrust = new JotMessageController({ store: new JotStore({ file: null }) });
  assert.deepEqual(await lanTrust.list({ accountId: OUTSIDER, loopId: LOOP }), []);
});
