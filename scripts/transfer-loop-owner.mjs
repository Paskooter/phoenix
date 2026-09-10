// Transfer ownership of the "John O's Jibo" loop to pasketti's current account.
//
// The robot completed OOBE against the original Pegasus cloud in 2017 under
// johno250@hotmail.com. That loop, its robot binding and every enrolled family
// member survived the import into Phoenix, but the app now signs in as
// superman1762@gmail.com, which is neither the loop owner nor a member -- so
// ListLoops correctly returns nothing and the robot is invisible in the app.
//
// This makes the new account the owner and adds it as an accepted member.
// John O is retained as an accepted member with his face/voice enrolment
// intact, so no history is destroyed.
//
// The robot's own account, its credentials and the robot<->loop binding are
// NOT touched: the robot keeps working without being reflashed or re-paired.

import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const STORE = process.env.STORE;
const NEW_OWNER_EMAIL = 'superman1762@gmail.com';
const LOOP_NAME = "John O's Jibo";

const store = JSON.parse(readFileSync(STORE, 'utf8'));

const asList = (value) => (Array.isArray(value) ? value : Object.values(value || {}));
const accounts = asList(store.accounts);
const loops = asList(store.loops);

const newOwner = accounts.find((a) => a.email === NEW_OWNER_EMAIL);
if (!newOwner) throw new Error(`no account for ${NEW_OWNER_EMAIL}`);

const loop = loops.find((l) => l.name === LOOP_NAME);
if (!loop) throw new Error(`no loop named ${LOOP_NAME}`);

const previousOwner = loop.owner;
if (previousOwner === newOwner._id) {
  console.log('already owned by the new account; nothing to do');
  process.exit(0);
}

// Preserve the robot binding exactly.
const robotId = loop.robot;

loop.owner = newOwner._id;
loop.updated = Date.now();

// Ensure the new owner is also an accepted member. The source model treats
// owner and membership separately, and populateLoop only surfaces members.
const existing = (loop.members || []).find((m) => m.accountId === newOwner._id);
if (existing) {
  existing.status = 'accepted';
  console.log('new owner was already a member; status set to accepted');
} else {
  loop.members = loop.members || [];
  loop.members.push({
    _id: randomBytes(12).toString('hex'),
    accountId: newOwner._id,
    status: 'accepted',
    enrolled: { face: false, voice: false },
    memberProperties: {
      email: newOwner.email,
      firstName: newOwner.firstName || null,
      lastName: newOwner.lastName || null,
    },
    created: Date.now(),
  });
  console.log('added the new owner as an accepted member');
}

writeFileSync(STORE, `${JSON.stringify(store, null, 2)}\n`);

console.log('');
console.log('previous owner :', previousOwner);
console.log('new owner      :', loop.owner, `(${newOwner.email})`);
console.log('robot binding  :', robotId, robotId === loop.robot ? '(unchanged)' : '(CHANGED - BUG)');
console.log('members        :', loop.members.length);
for (const m of loop.members) {
  const p = m.memberProperties || {};
  console.log(`   ${String(m.status).padEnd(9)} ${p.firstName || p.email || '(robot/unnamed)'}`);
}
