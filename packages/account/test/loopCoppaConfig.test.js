// Invented fixtures only. Source LoopController uses features.coppa in both
// invitation status and child authorization; it does not change editability.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccountService, Store } from '../src/index.js';
import { createOwnerAccount, createLoop, newId } from '../src/model.js';
import { signSigV4 } from '@phoenix/common';

for (const [label, loopConfig, enabled] of [
  ['default', {}, true],
  ['empty features', { features: {} }, true],
  ['off', { features: { coppa: 'off' } }, false],
  ['on', { features: { coppa: 'on' } }, true],
  ['uppercase OFF', { features: { coppa: 'OFF' } }, true],
  ['boolean false', { features: { coppa: false } }, true],
]) {
  test(`Loop source COPPA configuration: ${label}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'phoenix-coppa-fixture-'));
    const store = new Store(join(dir, 'account.json'));
    const owner = createOwnerAccount(store, { email: 'owner@coppa-fixture.test', password: 'fixture-owner-password' });
    const guardian = createOwnerAccount(store, { email: 'guardian@coppa-fixture.test', password: 'fixture-guardian-password' });
    const { loop, robot } = createLoop(store, { owner, robotId: 'coppa-fixture-robot' });
    const server = await createAccountService({ store, loopConfig }).listen(0);
    const base = `http://localhost:${server.address().port}`;
    async function post(operation, payload, caller = owner) {
      const body = JSON.stringify(payload);
      const { headers } = signSigV4({
        method: 'POST', path: '/', body,
        headers: { host: new URL(base).host, 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `Loop_20160324.${operation}` },
        accessKeyId: caller.accessKeyId, secretAccessKey: caller.secretAccessKey,
        region: 'global', service: 'jibo',
      });
      const response = await fetch(base + '/', { method: 'POST', headers, body });
      return { status: response.status, body: await response.json() };
    }
    try {
      const invited = await post('InviteLoopMember', { loopId: loop._id, firstName: 'Synthetic Child', isChild: true });
      assert.equal(invited.status, 200);
      const persisted = store.loops.get(loop._id);
      const child = persisted.members.find(member => member.memberProperties?.isChild);
      assert.ok(child);
      assert.equal(child.status, enabled ? 'invited' : 'accepted');
      const guardianId = newId();
      persisted.members.push({ _id: guardianId, accountId: guardian._id, status: 'accepted', memberProperties: {} });
      child.legalGuardianId = guardianId;
      child.status = 'declined';
      store.flush();
      const payload = { loopId: loop._id, id: child._id, firstName: 'Updated Fixture Child', isChild: false };
      for (const [caller, accepted] of [[owner, !enabled], [robot, !enabled], [guardian, enabled]]) {
        const result = await post('UpdateLoopMember', payload, caller);
        assert.equal(result.status, accepted ? 200 : 403);
        if (!accepted) assert.equal(result.body.__type, enabled ? 'CAN_BE_ACCESSED_BY_LEGAL_GUARDIAN' : 'CAN_BE_ACCESSED_BY_OWNER_OR_ROBOT');
        const savedChild = store.loops.get(loop._id).members.find(member => member._id === child._id);
        assert.equal(savedChild.memberProperties.isChild, true, 'configuration and ignored request field do not erase the child flag');
        assert.equal(savedChild.status, 'declined', 'child remains editable regardless of COPPA flag');
      }
    } finally {
      await new Promise(resolve => server.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
