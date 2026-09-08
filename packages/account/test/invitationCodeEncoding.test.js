import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { createOwnerAccount, createLoop } from '../src/model.js';
import { LoopUpdatedOutbox } from '../src/loopUpdatedOutbox.js';
import { inviteMember, updateMember } from '../src/loopMembership.js';

// Fixed outputs from Account6cea's bs58@3.1.0/base-x@1.1.0, also
// independently executed under Node8 by the root token review.
test('invitation creation and email assignment preserve leading-zero token bytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-invitation-encoding-'));
  const originalRandomBytes = crypto.randomBytes;
  try {
    const store = new Store(join(dir, 'store.json'));
    const owner = createOwnerAccount(store, { email: 'owner@synthetic.invalid', password: 'synthetic-password' });
    const outbox = new LoopUpdatedOutbox(store);
    const vectors = [
      ['0000000000', '11111'],
      ['0000000001', '11112'],
      ['000000ffff', '111LUv'],
      ['0000010000', '11LUw'],
      ['00ffffffff', '17YXq9G'],
      ['ffffffffff', 'VtB5VXc'],
    ];
    for (const [hex, expected] of vectors) {
      const { loop } = createLoop(store, { owner, robotId: `synthetic-${hex}` });
      crypto.randomBytes = (size, ...rest) => size === 5
        ? Buffer.from(hex, 'hex') : originalRandomBytes(size, ...rest);
      syncBuiltinESMExports();
      await inviteMember(store, { ownerId: owner._id, loopId: loop._id, firstName: 'Synthetic' }, outbox);
      let saved = store.loops.get(loop._id);
      const member = saved.members[saved.members.length - 1];
      assert.equal(member.invitationCode, expected, `InviteMember ${hex}`);
      await updateMember(store, { ownerId: owner._id, loopId: loop._id, id: member._id, email: `guest-${hex}@synthetic.invalid` }, outbox);
      saved = new Store(store.file).loops.get(loop._id);
      assert.equal(saved.members.find(item => item._id === member._id).invitationCode, expected, `UpdateMember persisted ${hex}`);
    }
  } finally {
    crypto.randomBytes = originalRandomBytes;
    syncBuiltinESMExports();
    rmSync(dir, { recursive: true, force: true });
  }
});
