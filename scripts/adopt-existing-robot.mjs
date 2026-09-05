// One-off: adopt an ALREADY-CREDENTIALED robot into Phoenix's account store, binding a loop to the
// robot's EXISTING accessKeyId (from its /var/jibo/credentials.json) so Loop.List returns exactly
// one loop for it — the precondition jibo-system-backup.js needs before Backup.New. Unlike OOBE,
// this does NOT mint new keys; it reuses the robot's current ones (LAN trust, SigV4 unverified).
//
// Usage: node scripts/adopt-existing-robot.mjs <accessKeyId> <secretAccessKey> <friendlyId>
import { getStore } from '../packages/account/src/store.js';
import { createOwnerAccount, createLoop } from '../packages/account/src/model.js';

const [accessKeyId, secretAccessKey, friendlyId] = process.argv.slice(2);
if (!accessKeyId || !secretAccessKey || !friendlyId) {
  console.error('usage: adopt-existing-robot.mjs <accessKeyId> <secretAccessKey> <friendlyId>');
  process.exit(2);
}

const store = getStore();
const owner = store.accountByEmail('owner@phoenix.local')
  || createOwnerAccount(store, { email: 'owner@phoenix.local', password: 'phoenix-local-owner', firstName: 'Phoenix' });

const { loop, robot } = createLoop(store, { owner, robotId: friendlyId });
// Override the freshly-minted keys with the robot's existing ones so its signed calls resolve here.
robot.accessKeyId = accessKeyId;
robot.secretAccessKey = secretAccessKey;
store.accounts.set(robot._id, robot);
store.flush();

console.log(JSON.stringify({
  ok: true, loopId: loop._id, loopName: loop.name,
  robotAccountId: robot._id, friendlyId: robot.friendlyId, accessKeyId: robot.accessKeyId,
}, null, 2));
