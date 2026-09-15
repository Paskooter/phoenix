import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createJotMessageCreatedConsumer, isSilentForMember, buildJotNotification,
} from '../src/jotPushConsumer.js';

// Behaviour is pinned to server/push-ws/src/event.handlers/jot.message.created.handler.js,
// read from the Jibo archive. See the module header for the recovered algorithm.

const SENDER = 'acct-sender';
const TAGGED = 'acct-tagged';
const QUIET = 'acct-quiet';

const event = (over = {}) => ({
  name: 'JotMessageCreated',
  payload: {
    messageId: 'msg-1', senderId: SENDER, loopId: 'loop-1',
    content: 'dinner at 7', tags: [TAGGED], ...over,
  },
});

const loop = {
  id: 'loop-1',
  members: [
    { memberId: SENDER, status: 'accepted' },
    { memberId: TAGGED, status: 'accepted' },
    { memberId: QUIET, status: 'accepted' },
    { memberId: 'acct-pending', status: 'pending' },
  ],
};

function harness(over = {}) {
  const sent = [];
  const deps = {
    account: {
      async get(loopId) { return loopId === 'loop-1' ? loop : null; },
      async getAccountById() { return { firstName: 'Ada', lastName: 'Lovelace' }; },
    },
    registry: {
      listDevices(ids) {
        const out = {};
        for (const id of ids) if (id !== 'acct-nodevice') out[id] = [{ name: `${id}-phone`, type: 'ios' }];
        return out;
      },
    },
    store: { countUnread: () => 3 },
    push: { async send(row) { sent.push(row); } },
    ...over,
  };
  return { sent, consume: createJotMessageCreatedConsumer(deps) };
}

// ------------------------------------------------------------- isSilent rules

test('isSilent: the sender is never pushed non-silently, even under always', () => {
  const member = { memberId: SENDER };
  assert.equal(isSilentForMember({ member, event: event(), notificationMode: 'always' }), true);
  assert.equal(isSilentForMember({ member, event: event({ tags: [SENDER] }), notificationMode: 'tagged' }), false,
    'the source only special-cases the sender under `always`');
});

test("isSilent: 'always' is non-silent for everyone but the sender", () => {
  assert.equal(isSilentForMember({ member: { memberId: QUIET }, event: event(), notificationMode: 'always' }), false);
});

test('isSilent: tagged, and an absent setting, are non-silent only when tagged', () => {
  for (const mode of ['tagged', undefined, null, '']) {
    assert.equal(isSilentForMember({ member: { memberId: TAGGED }, event: event(), notificationMode: mode }), false, String(mode));
    assert.equal(isSilentForMember({ member: { memberId: QUIET }, event: event(), notificationMode: mode }), true, String(mode));
  }
});

test('isSilent: an unrecognised mode falls through to silent', () => {
  assert.equal(isSilentForMember({ member: { memberId: TAGGED }, event: event(), notificationMode: 'weekly' }), true);
});

// ------------------------------------------------------------ payload contract

test('the notification carries the documented push contract', () => {
  const n = buildJotNotification({
    event: event(), sender: { firstName: 'Ada', lastName: 'Lovelace' }, badge: 3, isSilent: false,
  });
  assert.equal(n.locKey, 'new.message.from.member');
  assert.deepEqual(n.locArgs, ['Ada Lovelace']);
  assert.equal(n.body, 'dinner at 7');
  assert.equal(n.badge, 3);
  assert.equal(n.data.type, 'jot-created-tagged');
  assert.deepEqual(
    { messageId: n.data.messageId, senderId: n.data.senderId, loopId: n.data.loopId },
    { messageId: 'msg-1', senderId: SENDER, loopId: 'loop-1' },
  );
  assert.equal(buildJotNotification({ event: event(), sender: {}, badge: 0, isSilent: true }).data.type,
    'jot-created-silent');
});

// ----------------------------------------------------------------- fan-out

test('fan-out reaches every accepted member with a device', async () => {
  const { sent, consume } = harness();
  const out = await consume(event());
  assert.equal(out.delivered, 3, 'sender, tagged and quiet all have devices');
  assert.equal(sent.length, 3);
  const byMember = Object.fromEntries(out.notifications.map((row) => [row.memberId, row.notification]));
  assert.equal(byMember[TAGGED].data.type, 'jot-created-tagged');
  assert.equal(byMember[QUIET].data.type, 'jot-created-silent');
  assert.equal(byMember[SENDER].data.type, 'jot-created-silent');
  assert.ok(!('acct-pending' in byMember), 'a pending member is not an accepted member');
});

test('a member with no devices is skipped, not pushed to', async () => {
  const { sent, consume } = harness({
    registry: { listDevices: (ids) => Object.fromEntries(ids.filter((id) => id === TAGGED).map((id) => [id, [{ name: 'p', type: 'ios' }]])) },
  });
  const out = await consume(event());
  assert.equal(out.delivered, 1);
  assert.equal(sent[0].device.name, 'p');
});

test('the badge is the unread count for that member', async () => {
  const seen = [];
  const { consume } = harness({ store: { countUnread: (q) => { seen.push(q); return 7; } } });
  const out = await consume(event());
  assert.ok(out.notifications.every((row) => row.notification.badge === 7));
  assert.ok(seen.every((q) => q.loopIds.includes('loop-1')));
});

test('per-account notification mode is honoured', async () => {
  const { consume } = harness({ jotSettings: async () => ({ [QUIET]: 'always' }) });
  const out = await consume(event());
  const byMember = Object.fromEntries(out.notifications.map((row) => [row.memberId, row.notification]));
  assert.equal(byMember[QUIET].data.type, 'jot-created-tagged', "'always' makes a non-tagged member non-silent");
  assert.equal(byMember[SENDER].data.type, 'jot-created-silent', 'but never the sender');
});

// ------------------------------------------------------------- refusals

test('without an account seam the consumer does nothing rather than inventing recipients', async () => {
  const { sent, consume } = harness({ account: undefined });
  const out = await consume(event());
  assert.equal(out.delivered, 0);
  assert.equal(out.reason, 'no-account-seam');
  assert.equal(sent.length, 0);
});

test('an unknown loop delivers nothing', async () => {
  const { consume } = harness();
  const out = await consume(event({ loopId: 'loop-unknown' }));
  assert.equal(out.delivered, 0);
  assert.equal(out.reason, 'loop-not-found');
});

test('an unrelated event is ignored', async () => {
  const { sent, consume } = harness();
  const out = await consume({ name: 'LoopCreated', payload: {} });
  assert.equal(out.delivered, 0);
  assert.equal(sent.length, 0);
});

test('a failing push provider does not abort the remaining members', async () => {
  let calls = 0;
  const { consume } = harness({
    push: { async send() { calls += 1; if (calls === 1) throw new Error('APNs down'); } },
  });
  const out = await consume(event());
  assert.equal(calls, 3, 'every device is still attempted');
  assert.equal(out.delivered, 2, 'only the failed one is not counted');
});
