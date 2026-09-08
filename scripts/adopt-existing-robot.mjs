// One-off: adopt an ALREADY-CREDENTIALED robot into Phoenix's account store, binding a loop to the
// robot's EXISTING accessKeyId (from its /var/jibo/credentials.json) so Loop.List returns exactly
// one loop for it — the precondition jibo-system-backup.js needs before Backup.New. Unlike OOBE,
// this does NOT mint new keys; it reuses the robot's current ones (LAN trust, SigV4 unverified).
//
// Usage: node scripts/adopt-existing-robot.mjs <accessKeyId> <secretAccessKey> <friendlyId>
//    or: node scripts/adopt-existing-robot.mjs --stdin   with the robot's own
//        credentials.json on stdin: {accessKeyId, secretAccessKey, friendlyId?}
//
// Prefer --stdin when a script is driving this. Command-line arguments are
// visible to every user on the machine through the process list, and the secret
// access key must not appear there.
import { readFileSync } from 'node:fs';
import { getStore } from '../packages/account/src/store.js';
import { createOwnerAccount, createLoop } from '../packages/account/src/model.js';

let accessKeyId; let secretAccessKey; let friendlyId;
if (process.argv[2] === '--stdin') {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(0, 'utf8'));
  } catch (error) {
    console.error(`could not parse credentials on stdin: ${error.message}`);
    process.exit(2);
  }
  ({ accessKeyId, secretAccessKey } = parsed);
  friendlyId = parsed.friendlyId || process.argv[3];
} else {
  [accessKeyId, secretAccessKey, friendlyId] = process.argv.slice(2);
}
if (!accessKeyId || !secretAccessKey || !friendlyId) {
  console.error('usage: adopt-existing-robot.mjs <accessKeyId> <secretAccessKey> <friendlyId>');
  console.error('   or: adopt-existing-robot.mjs --stdin [friendlyId]   (credentials JSON on stdin)');
  process.exit(2);
}

const store = getStore();

// Idempotent: this runs from the repoint script, which is meant to be safely
// re-runnable. Creating a second loop for a robot that already has one would
// break Loop.List, which the backup flow requires to return exactly one.
const existing = store.accountByAccessKeyId(accessKeyId);
if (existing) {
  const loop = [...store.loops.values()].find((entry) => entry.robot === existing._id) || null;
  console.log(JSON.stringify({
    ok: true, alreadyAdopted: true, robotAccountId: existing._id,
    friendlyId: existing.friendlyId, loopId: loop ? loop._id : null,
  }, null, 2));
  process.exit(0);
}

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
