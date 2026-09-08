/*
 * Candidate-side companion to the pinned Node 8 ListLoopMembers control.
 *
 * This is a source-shaped synthetic fixture only.  It exercises the actual
 * Store/populateLoop/listMembers code and records undefined explicitly so the
 * result can be compared with the source harness without changing JSON wire
 * serialization rules.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../packages/account/src/store.js';
import { listMembers, populateLoop } from '../../packages/account/src/loopMembership.js';
import { MEMBER_STATUS } from '../../packages/account/src/model.js';

function plain(value, seen = []) {
  if (value === undefined) return { __undefined: true };
  if (value === null || typeof value !== 'object') return value;
  if (seen.includes(value)) return '[Circular]';
  const next = [...seen, value];
  if (Array.isArray(value)) return value.map((item) => plain(item, next));
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, plain(value[key], next)]));
}

function fixture(file, name, { robotFacebookAccessToken = null } = {}) {
  const store = new Store(file);
  const owner = {
    _id: `${name}-owner`, email: null, firstName: null, gender: null,
    lastName: null, phoneNumber: null, photoUrl: null, birthday: null,
    facebookAccessToken: null,
  };
  const robot = {
    _id: `${name}-robot`, friendlyId: 'source-robot', email: null,
    firstName: undefined, gender: null, lastName: null,
    phoneNumber: null, photoUrl: null, birthday: null,
    facebookAccessToken: robotFacebookAccessToken,
  };
  const invited = { _id: `${name}-invited`, email: 'invite@example.invalid' };
  const declined = { _id: `${name}-declined` };
  const removed = { _id: `${name}-removed` };
  for (const account of [owner, robot, invited, declined, removed]) {
    store.accounts.set(account._id, account);
  }
  const loop = {
    _id: `${name}-loop`, owner: owner._id, robot: robot._id,
    name: 'List members source control', created: 1700000000000,
    isDeleted: false, isSuspended: false,
    members: [
      { _id: `${name}-owner-member`, accountId: owner._id, status: MEMBER_STATUS.ACCEPTED,
        enrolled: { face: true, voice: false } },
      { _id: `${name}-robot-member`, accountId: robot._id, status: MEMBER_STATUS.ACCEPTED,
        enrolled: { face: false, voice: true } },
      { _id: `${name}-invited-member`, accountId: invited._id, status: MEMBER_STATUS.INVITED,
        memberProperties: { email: 'invite@example.invalid' } },
      { _id: `${name}-declined-member`, accountId: declined._id, status: MEMBER_STATUS.DECLINED,
        memberProperties: { firstName: 'Declined' } },
      { _id: `${name}-removed-member`, accountId: removed._id, status: MEMBER_STATUS.REMOVED,
        memberProperties: { firstName: 'Removed' } },
      { _id: `${name}-orphan-member`, status: MEMBER_STATUS.ACCEPTED,
        memberProperties: { firstName: 'Orphan' } },
    ],
  };
  store.loops.set(loop._id, loop);
  return { store, loop, owner, robot };
}

function populated(name, isRobotRequesting, robotFacebookAccessToken = null) {
  const dir = mkdtempSync(join(tmpdir(), 'phx-a04-list-members-control-'));
  try {
    const f = fixture(join(dir, 'store.json'), name, { robotFacebookAccessToken });
    const output = populateLoop(f.store, f.loop, isRobotRequesting);
    const account = output.members[isRobotRequesting ? 1 : 0].account;
    return {
      mode: isRobotRequesting,
      output: plain(output),
      memberKeys: output.members.map((member) => ({
        id: member.id,
        accountKeys: member.account ? Object.keys(member.account).sort() : null,
      })),
      selectedAccountOrder: {
        keys: Object.keys(account),
        hasFacebookAccessToken: Object.hasOwn(account, 'facebookAccessToken'),
        facebookAccessToken: account.facebookAccessToken === undefined
          ? { __undefined: true } : account.facebookAccessToken,
      },
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function filtered(name, statusList, typeList, friendlyId) {
  const dir = mkdtempSync(join(tmpdir(), 'phx-a04-list-members-control-'));
  try {
    const f = fixture(join(dir, 'store.json'), name);
    // The source control replaces `list()` with five records whose fourth
    // record is incoming.  Make the real candidate fixture express that same
    // source-shaped member relation before comparing only the filter result.
    f.loop.members[3].accountId = f.owner._id;
    f.loop.members = f.loop.members.slice(0, 5);
    return {
      statusList: plain(statusList),
      typeList: plain(typeList),
      friendlyId: plain(friendlyId),
      // Compare the actual candidate filter output with the source control's
      // replacement `list()` records; population is covered separately above.
      result: plain(listMembers(f.store, {
        ownerId: f.owner._id,
        // The source control stubs `list()`; keep the filter comparison
        // independent of its separate robot-selection behavior.
        friendlyId: null,
        statusList,
        typeList,
      })).map(({ status, type }) => ({ status, type })),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const output = {
  node: process.version,
  candidateBase: '4d453eb8a85a0bebcac189a7dc643153d54ba35c',
  populate: [
    populated('null-fields', false),
    populated('null-fields-robot', true, null),
  ],
  filters: [
    filtered('filters-default', null, null, null),
    filtered('filters-empty', [], [], null),
    filtered('filters-status', ['accepted'], null, null),
    filtered('filters-type', null, ['incoming'], null),
    filtered('filters-both', ['accepted', 'declined'], ['outgoing'], 'source-friendly'),
    filtered('filters-order', ['removed', 'accepted'], ['outgoing', 'incoming'], null),
  ],
};

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
