#!/usr/bin/env node
// Repair an accidental new loop made while re-pairing an existing OOBE robot.
// Run with the account service stopped; its in-memory Store must not overwrite
// the repaired snapshot. Dry-run unless --apply is supplied.

import { copyFileSync, chmodSync, existsSync, constants } from 'node:fs';
import { Store } from '../packages/account/src/store.js';

const args = process.argv.slice(2);
function arg(name) {
  const index = args.indexOf(name);
  return index < 0 ? null : args[index + 1];
}
const storeFile = arg('--store');
const friendlyId = arg('--robot');
const keepId = arg('--keep-loop');
const duplicateId = arg('--duplicate-loop');
const apply = args.includes('--apply');
if (!storeFile || !friendlyId || !keepId || !duplicateId || keepId === duplicateId || !existsSync(storeFile)) {
  console.error('usage: node scripts/reconcile-duplicate-oobe-loop.mjs --store <file> --robot <friendly-id> --keep-loop <id> --duplicate-loop <id> [--apply]');
  process.exit(2);
}

const store = new Store(storeFile);
const robots = [...store.accounts.values()].filter((account) => account.friendlyId === friendlyId && account.isDeleted !== true);
if (robots.length !== 1) throw new Error('expected exactly one active robot account');
const robot = robots[0];
const keep = store.loops.get(keepId);
const duplicate = store.loops.get(duplicateId);
if (!keep || !duplicate || keep.isDeleted === true || duplicate.isDeleted === true) throw new Error('both loops must exist and be active');
if (String(keep.owner) !== String(duplicate.owner)) throw new Error('loops have different owners');
if (keep.robot != null || keep.isSuspended !== true) throw new Error('original loop is not the suspended, unbound loop');
if (String(duplicate.robot) !== String(robot._id) || duplicate.isSuspended === true) throw new Error('duplicate loop is not the active robot loop');

const members = duplicate.members || [];
if (members.some((member) => ![String(duplicate.owner), String(robot._id)].includes(String(member.accountId)))) {
  throw new Error('duplicate loop has other members; merge it manually to avoid data loss');
}
const robotMember = members.find((member) => String(member.accountId) === String(robot._id));
if (!robotMember) throw new Error('duplicate loop has no robot member to transfer');
if ((keep.members || []).some((member) => String(member.accountId) === String(robot._id))) {
  throw new Error('original loop already has a robot member; inspect before repairing');
}

console.log(`Robot: ${friendlyId} (${robot._id})`);
console.log(`Keep: ${keep.name} (${keep._id}, ${keep.members?.length || 0} members)`);
console.log(`Retire: ${duplicate.name} (${duplicate._id}, ${members.length} members)`);
if (!apply) {
  console.log('Dry run only. Stop the account service, then rerun with --apply.');
  process.exit(0);
}

const backup = `${storeFile}.before-oobe-loop-repair-${Date.now()}`;
copyFileSync(storeFile, backup, constants.COPYFILE_EXCL);
chmodSync(backup, 0o600);
const now = Date.now();
keep.robot = robot._id;
keep.isSuspended = false;
keep.members = [...(keep.members || []), robotMember];
keep.updated = now;
duplicate.robot = null;
duplicate.isSuspended = true;
duplicate.isDeleted = true;
duplicate.updated = now;
store.flush();
console.log(`Repaired. Private backup: ${backup}. Restart the account service.`);
