import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccountService, Store } from '../src/index.js';
import { createOwnerAccount, createLoop, newId } from '../src/model.js';
import { createClassicEntrypoint } from '../../classic/src/index.js';
import { signedLoopHeaders } from './fixtures/signedLoopRequest.js';
import { LoopUpdatedOutbox } from '../src/loopUpdatedOutbox.js';
import { acceptInvitation, removeMember } from '../src/loopMembership.js';

test('membership events follow saved state through Account and Classic and contain transport rejection', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'phoenix-membership-events-'));
  const store = new Store(join(directory, 'account.json'));
  const owner = createOwnerAccount(store, { email: 'owner@synthetic.invalid', password: 'synthetic-password' });
  const member = createOwnerAccount(store, { email: 'member@synthetic.invalid', password: 'synthetic-password' });
  const { loop } = createLoop(store, { owner, robotId: 'synthetic-membership-events' });
  const id = newId();
  loop.members.push({ _id: id, accountId: member._id, status: 'invited', invitedAsLegalGuardian: true, memberProperties: { email: member.email } });
  store.flush();
  const sent = [], failures = [];
  const eventSender = { send(event) {
    const saved = JSON.parse(readFileSync(store.file));
    assert.deepEqual(saved.loops.find(row => row._id === loop._id), store.loops.get(loop._id));
    assert.equal(saved.notificationOutbox.length, store.notificationOutbox.size); // Save precedes delivery.
    sent.push({ event: JSON.parse(JSON.stringify(event)), status: store.loops.get(loop._id).members.find(m => m._id === id).status, saves: store.notificationOutbox.size });
    return Promise.reject(new Error('synthetic recipient unavailable'));
  } };
  const account = await createAccountService({ store, invitationProviders: { eventSender, onError(error, kind) { failures.push(kind); } } }).listen(0);
  const previous = process.env.NET_account; process.env.NET_account = 'http://127.0.0.1:' + account.address().port;
  const classic = await createClassicEntrypoint({ notificationFile: join(directory, 'notifications.json'), notificationPollIntervalMs: 60000 }).listen(0);
  try {
    for (const server of [account, classic]) {
      store.loops.get(loop._id).members.find(m => m._id === id).status = 'invited'; store.flush();
      const base = 'http://127.0.0.1:' + server.address().port;
      const post = async (op, body, caller) => {
        const r = await fetch(base, { method: 'POST', signal: AbortSignal.timeout(5000), headers: signedLoopHeaders(store, base, 'Loop_20160324.' + op, body, caller.accessKeyId), body: JSON.stringify(body) });
        return { status: r.status, body: await r.json() };
      };
      for (const [op, state, key, caller] of [
        ['AcceptInvitation', 'accepted', 'InvitationToLoopAccepted', member],
        ['DeclineInvitation', 'declined', 'InvitationToLoopDeclined', member],
        ['RemoveMember', 'removed', 'MemberRemovedFromLoop', owner],
      ]) {
        const count = sent.length, saves = store.notificationOutbox.size;
        const response = await post(op, { loopId: loop._id, id }, caller);
        assert.equal(response.status, 200); assert.equal(sent.length, count + 1);
        const row = sent.at(-1); assert.equal(row.status, state); assert.equal(row.saves, saves + 1);
        const p = row.event.payload; assert.equal(p.eventKey, key); assert.equal(p.accountId, member._id); assert.equal(p.ownerId, owner._id); assert.equal(p.loopId, loop._id);
        const accepted = store.loops.get(loop._id).members.filter(m => String(m.status).toLowerCase() === 'accepted' && m.accountId).map(m => m.accountId);
        if (state === 'removed') accepted.push(member._id);
        assert.deepEqual(p.memberIds, accepted);
        if (state === 'accepted') assert.equal(p.invitedAsLegalGuardian, true);
        if (state === 'removed') assert.equal(p.email, member.email);
      }
      const before = sent.length;
      assert.equal((await post('AcceptInvitation', { loopId: loop._id }, member)).status, 404);
      assert.equal(sent.length, before);
    }
    await new Promise(resolve => setImmediate(resolve)); assert.equal(failures.length, 6);
  } finally {
    await Promise.all([account, classic].map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })));
    if (previous === undefined) delete process.env.NET_account; else process.env.NET_account = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('duplicate memberships preserve first-match guardian and removed recipient duplication; failed saves emit nothing', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'phoenix-membership-duplicates-'));
  const store = new Store(join(directory, 'account.json'));
  try {
    const owner = createOwnerAccount(store, { email: 'duplicate-owner@synthetic.invalid', password: 'synthetic-password' });
    const { loop } = createLoop(store, { owner, robotId: 'synthetic-duplicate-events' });
    const target = newId();
    loop.members.push({ _id: newId(), accountId: 'synthetic-member', status: 'declined', invitedAsLegalGuardian: false, memberProperties: {} }, { _id: target, accountId: 'synthetic-member', status: 'invited', invitedAsLegalGuardian: true, memberProperties: {} });
    store.flush();
    const outbox = new LoopUpdatedOutbox(store);
    const events = []; const options = { invitationProviders: { eventSender: { send(event) { events.push(event.payload); return Promise.resolve(); } } } };
    await acceptInvitation(store, { loopId: loop._id, accountId: 'synthetic-member' }, outbox, options);
    assert.equal(events[0].invitedAsLegalGuardian, false);
    store.loops.get(loop._id).members.find(m => m.accountId === 'synthetic-member').status = 'accepted';
    await removeMember(store, { loopId: loop._id, ownerId: owner._id, id: target }, outbox, options);
    assert.equal(events[1].memberIds.filter(x => x === 'synthetic-member').length, 2);
    const flush = store.flush; store.flush = () => { throw new Error('synthetic save failure'); };
    await assert.rejects(removeMember(store, { loopId: loop._id, ownerId: owner._id, id: target }, outbox, options), /synthetic save failure/);
    assert.equal(events.length, 2); store.flush = flush;
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
