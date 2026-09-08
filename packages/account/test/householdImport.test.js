// Synthetic controls for the local-only household staging importer.  The
// fixture deliberately contains an adopted robot with real-shaped key fields,
// a placeholder owner, one unrelated loop, and source members with null
// account IDs.  It does not contain any private values.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { Store } = await import('../src/store.js');
const { populateLoop } = await import('../src/model.js');
const {
  HouseholdImportError,
  buildHouseholdImport,
  stageHouseholdImport,
} = await import('../src/householdImport.js');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sourceFixture() {
  const root = {
    _id: 'local-root-node',
    data: {
      id: 'source-loop',
      name: "Source Owner's Jibo",
      owner: 'source-owner',
      robot: 'source-robot',
      robotFriendlyId: 'fixture-robot',
      created: 100,
      updated: 200,
      lastFullSyncTimestamp: 201,
      lastFullSyncCredentialsHash: 'source-hash-is-not-imported',
    },
    type: 'Loop',
    created: 100,
    updated: 200,
    edges: {
      owner: ['member-owner'],
      robot: ['member-robot'],
      user: ['member-owner', 'member-robot', 'member-guest', 'member-removed'],
    },
  };
  const users = [
    {
      _id: 'member-owner',
      data: {
        id: 'member-owner', loopId: 'source-loop', accountId: 'source-owner',
        account: {
          email: 'owner@example.test', firstName: 'Owner', lastName: 'Source',
          gender: 'other', birthday: 0, isChild: false,
        },
        isChild: false,
        enrolled: { face: true, voice: true }, status: 'accepted', type: 'incoming', created: 101,
      },
    },
    {
      _id: 'member-robot',
      data: {
        id: 'member-robot', loopId: 'source-loop', accountId: 'source-robot', account: {},
        enrolled: { face: false, voice: false }, status: 'accepted', type: 'outgoing', created: 102,
      },
    },
    {
      _id: 'member-guest',
      data: {
        id: 'member-guest', loopId: 'source-loop',
        account: { firstName: 'Guest', lastName: 'Child', isChild: true, email: null },
        enrolled: { face: true, voice: true }, status: 'accepted', type: 'outgoing',
        nickName: 'G', phoneticName: 'geh', created: 103,
      },
    },
    {
      _id: 'member-removed',
      data: {
        id: 'member-removed', loopId: 'source-loop',
        account: { firstName: 'Removed', lastName: 'Member', isChild: false },
        enrolled: { face: false, voice: false }, status: 'removed', type: 'outgoing', created: 104,
      },
    },
  ];
  return { root, users };
}

function currentFixture() {
  return {
    accounts: [
      {
        _id: 'old-robot', friendlyId: 'fixture-robot', isActive: false,
        accessKeyId: 'existing-robot-access', secretAccessKey: 'existing-robot-secret',
      },
      {
        _id: 'placeholder-owner', email: 'placeholder@example.test', password: 'existing-human-hash',
        friendlyId: null, firstName: 'Placeholder', lastName: '', accessKeyId: 'existing-human-access',
        secretAccessKey: 'existing-human-secret', isActive: true, created: 1,
      },
      { _id: 'unrelated-account', email: 'unrelated@example.test', isActive: true },
    ],
    loops: [
      {
        _id: 'adopted-loop', name: 'Temporary Jibo', owner: 'placeholder-owner', robot: 'old-robot',
        members: [
          { _id: 'old-owner-member', accountId: 'placeholder-owner', status: 'ACCEPTED' },
          { _id: 'old-robot-member', accountId: 'old-robot', status: 'ACCEPTED' },
        ], isSuspended: false, created: 2,
      },
      {
        _id: 'unrelated-loop', name: 'Unrelated', owner: 'unrelated-account', robot: null,
        members: [{ _id: 'unrelated-member', accountId: 'unrelated-account', status: 'ACCEPTED' }],
        isSuspended: false, created: 3,
      },
    ],
    tokens: [],
    sessions: [],
    settings: [],
    notificationOutbox: [],
  };
}

function errorCode(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof HouseholdImportError);
    return error.code;
  }
  assert.fail('expected importer to reject the fixture');
}

test('buildHouseholdImport preserves source IDs/status/enrollment and transfers only robot credentials', () => {
  const { root, users } = sourceFixture();
  const current = currentFixture();
  const before = JSON.stringify(current);
  const sourceBefore = JSON.stringify({ root, users });
  const result = buildHouseholdImport({
    currentSnapshot: current,
    rootSnapshot: root,
    usersSnapshot: users,
  });

  assert.deepEqual(current, JSON.parse(before), 'building is read-only');
  assert.deepEqual({ root, users }, JSON.parse(sourceBefore), 'source snapshots are read-only');
  assert.equal(result.stats.sourceMembers, 4);
  assert.equal(result.stats.acceptedMembers, 3);
  assert.equal(result.stats.removedMembers, 1);
  assert.equal(result.stats.unresolvedAccountMembers, 2);
  assert.equal(result.stats.oldRobotRemoved, true);

  const accounts = new Map(result.snapshot.accounts.map((account) => [account._id, account]));
  assert.equal(accounts.has('old-robot'), false);
  assert.equal(accounts.get('source-robot').accessKeyId, 'existing-robot-access');
  assert.equal(accounts.get('source-robot').secretAccessKey, 'existing-robot-secret');
  assert.equal(accounts.get('source-robot').friendlyId, 'fixture-robot');
  assert.equal(accounts.get('source-owner').email, 'owner@example.test');
  assert.equal(accounts.get('source-owner').isChild, false, 'accepted source profile fields are retained locally');
  assert.equal(accounts.get('source-robot').isActive, false, 'transferred robot activity state is retained');
  for (const key of ['password', 'accessKeyId', 'secretAccessKey']) {
    assert.equal(Object.hasOwn(accounts.get('source-owner'), key), false, `no human ${key} was fabricated`);
  }
  assert.equal(accounts.get('placeholder-owner').password, 'existing-human-hash', 'unrelated placeholder is retained');
  assert.ok(accounts.has('unrelated-account'));

  const loops = new Map(result.snapshot.loops.map((loop) => [loop._id, loop]));
  assert.equal(loops.has('adopted-loop'), false);
  assert.ok(loops.has('unrelated-loop'));
  const imported = loops.get('source-loop');
  assert.equal(imported.owner, 'source-owner');
  assert.equal(imported.robot, 'source-robot');
  assert.deepEqual(imported.members.map((member) => member._id), users.map((node) => node._id));
  assert.deepEqual(imported.members.map((member) => member.accountId), ['source-owner', 'source-robot', undefined, undefined]);
  // JSON serialization preserves the source's absent field; the in-memory
  // model may still expose an undefined property while projecting the wire.
  assert.equal(Object.hasOwn(imported.members[2], 'accountId'), false);
  assert.equal(imported.members[2].accountId, undefined);
  assert.deepEqual(imported.members.map((member) => member.status), ['accepted', 'accepted', 'accepted', 'removed']);
  assert.deepEqual(imported.members.map((member) => member.enrolled), users.map((node) => node.data.enrolled));
  assert.equal(imported.members[2].memberProperties.isChild, true);
  assert.equal(imported.members[2].nickname, 'G');

  const wire = result.wire;
  assert.equal(wire.id, 'source-loop');
  assert.deepEqual(wire.members.map((member) => member.id), users.map((node) => node._id));
  assert.deepEqual(wire.members.map((member) => member.status), ['accepted', 'accepted', 'accepted', 'removed']);
  assert.deepEqual(wire.members.map((member) => member.enrolled), users.map((node) => node.data.enrolled));
  assert.equal(wire.members[2].account.firstName, 'Guest');
  assert.equal(wire.members[2].nickname, 'G');
  assert.equal(wire.members[0].account.isChild, undefined, 'accepted-account wire keeps source projection semantics');
});

test('import rejects unrelated account, loop, member and auxiliary-reference collisions before mutation', () => {
  const { root, users } = sourceFixture();
  const current = currentFixture();

  const accountConflict = currentFixture();
  accountConflict.accounts.push({ _id: 'source-owner', email: 'collision@example.test' });
  assert.equal(errorCode(() => buildHouseholdImport({
    currentSnapshot: accountConflict, rootSnapshot: root, usersSnapshot: users,
    expectedStatusCounts: { accepted: 3, removed: 1 },
  })), 'CONFLICT_ACCOUNT_ID');

  const loopConflict = currentFixture();
  loopConflict.loops.push({ _id: 'source-loop', members: [] });
  assert.equal(errorCode(() => buildHouseholdImport({
    currentSnapshot: loopConflict, rootSnapshot: root, usersSnapshot: users,
    expectedStatusCounts: { accepted: 3, removed: 1 },
  })), 'CONFLICT_LOOP_ID');

  const memberConflict = currentFixture();
  memberConflict.loops[1].members.push({ _id: 'member-guest', accountId: 'unrelated-account', status: 'ACCEPTED' });
  assert.equal(errorCode(() => buildHouseholdImport({
    currentSnapshot: memberConflict, rootSnapshot: root, usersSnapshot: users,
    expectedStatusCounts: { accepted: 3, removed: 1 },
  })), 'CONFLICT_MEMBER_ID');

  const referenceConflict = currentFixture();
  referenceConflict.sessions.push({ _id: 'session-1', accountId: 'old-robot' });
  assert.equal(errorCode(() => buildHouseholdImport({
    currentSnapshot: referenceConflict, rootSnapshot: root, usersSnapshot: users,
    expectedStatusCounts: { accepted: 3, removed: 1 },
  })), 'UNRESOLVED_REFERENCE');
});

test('non-null source account without profile is rejected instead of becoming an orphan', () => {
  const { root, users } = sourceFixture();
  const malformed = clone(users);
  malformed[2].data.accountId = 'unmapped-account';
  malformed[2].data.account = {};
  assert.equal(errorCode(() => buildHouseholdImport({
    currentSnapshot: currentFixture(), rootSnapshot: root, usersSnapshot: malformed,
    expectedStatusCounts: { accepted: 3, removed: 1 },
  })), 'UNRESOLVED_ACCOUNT');
});

test('stage writes a private output and exact backup, while dry-run and existing paths stay non-destructive', () => {
  const { root, users } = sourceFixture();
  const current = currentFixture();
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-household-import-test-'));
  try {
    const currentPath = join(dir, 'current.json');
    const outputPath = join(dir, 'staged.json');
    const backupPath = join(dir, 'staged.backup.json');
    const currentBytes = Buffer.from(`${JSON.stringify(current, null, 2)}\n`);
    writeFileSync(currentPath, currentBytes, { mode: 0o600 });
    chmodSync(currentPath, 0o600);

    const dry = stageHouseholdImport({
      currentPath, rootPath: writeInput(dir, 'root.json', root), usersPath: writeInput(dir, 'users.json', users),
      dryRun: true, expectedStatusCounts: { accepted: 3, removed: 1 },
    });
    assert.equal(dry.summary.dryRun, true);
    assert.equal(existsSync(outputPath), false);

    const staged = stageHouseholdImport({
      currentPath, rootPath: join(dir, 'root.json'), usersPath: join(dir, 'users.json'),
      outputPath, backupPath, expectedStatusCounts: { accepted: 3, removed: 1 },
    });
    assert.equal(staged.summary.outputMode, 0o600);
    assert.equal(staged.summary.backupMode, 0o600);
    assert.equal(statSync(outputPath).mode & 0o777, 0o600);
    assert.equal(statSync(backupPath).mode & 0o777, 0o600);
    assert.deepEqual(readFileSync(backupPath), currentBytes);
    const reloaded = new Store(outputPath);
    const reloadedLoop = reloaded.loops.get('source-loop');
    const reloadedWire = populateLoop(reloaded, reloadedLoop, { isRobotRequesting: true });
    assert.deepEqual(reloadedWire.members.map((member) => member.id), users.map((node) => node._id));
    assert.deepEqual(reloadedWire.members.map((member) => member.enrolled), users.map((node) => node.data.enrolled));

    assert.equal(errorCode(() => stageHouseholdImport({
      currentPath, rootPath: join(dir, 'root.json'), usersPath: join(dir, 'users.json'),
      outputPath, backupPath, expectedStatusCounts: { accepted: 3, removed: 1 },
    })), 'OUTPUT_EXISTS');
    assert.deepEqual(readFileSync(currentPath), currentBytes, 'source store remains unchanged');

    const collisionPath = join(dir, 'collision.json');
    const collisionBytes = Buffer.from('existing writer\n');
    writeFileSync(collisionPath, collisionBytes, { mode: 0o600 });
    chmodSync(collisionPath, 0o600);
    assert.equal(errorCode(() => stageHouseholdImport({
      currentPath, rootPath: join(dir, 'root.json'), usersPath: join(dir, 'users.json'),
      outputPath: collisionPath, backupPath: join(dir, 'collision.backup.json'),
      expectedStatusCounts: { accepted: 3, removed: 1 },
    })), 'OUTPUT_EXISTS');
    assert.deepEqual(readFileSync(collisionPath), collisionBytes, 'a competing output is never removed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeInput(dir, name, value) {
  const file = join(dir, name);
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

test('rejects duplicate store IDs and fields that runtime persistence would discard', () => {
  const { root, users } = sourceFixture();
  const run = (currentSnapshot) => buildHouseholdImport({ currentSnapshot, rootSnapshot: root, usersSnapshot: users });
  const duplicate = currentFixture();
  duplicate.accounts.push({ ...duplicate.accounts[0], isActive: true });
  assert.equal(errorCode(() => run(duplicate)), 'DUPLICATE_STORE_ID');
  const unknown = currentFixture();
  unknown.futureCollection = [{ preserve: true }];
  assert.equal(errorCode(() => run(unknown)), 'UNSUPPORTED_COLLECTION');
});

test('supports every source membership status without a household-specific size guard', () => {
  const { root, users } = sourceFixture();
  users[2].data.status = 'invited';
  users[3].data.status = 'declined';
  const input = { currentSnapshot: currentFixture(), rootSnapshot: root, usersSnapshot: users };
  const result = buildHouseholdImport(input);
  assert.deepEqual(result.wire.members.map((m) => m.status), ['accepted', 'accepted', 'invited', 'declined']);
  assert.equal(errorCode(() => buildHouseholdImport({ ...input, expectedStatusCounts: { accepted: 9 } })), 'SOURCE_STATUS_COUNTS');
  assert.equal(errorCode(() => buildHouseholdImport({ ...input, expectedStatusCounts: { unknown: 1 } })), 'INVALID_ARGUMENTS');
});

test('failed exclusive open and rollback retain files belonging to another writer', async (t) => {
  const fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const { root, users } = sourceFixture();
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-household-races-'));
  const currentPath = writeInput(dir, 'current.json', currentFixture());
  const rootPath = writeInput(dir, 'root.json', root);
  const usersPath = writeInput(dir, 'users.json', users);
  const outputPath = join(dir, 'output.json');
  const backupPath = join(dir, 'backup.json');
  const originalOpen = fs.openSync;
  const originalWrite = fs.writeFileSync;
  const competingWrite = (path, content) => {
    const fd = originalOpen(path, 'wx', 0o600);
    try { originalWrite(fd, content); } finally { fs.closeSync(fd); }
  };
  const restore = () => { t.mock.restoreAll(); syncBuiltinESMExports(); };
  try {
    t.mock.method(fs, 'openSync', function(path, ...args) {
      if (path === outputPath) competingWrite(outputPath, 'competing output');
      return originalOpen(path, ...args);
    });
    syncBuiltinESMExports();
    assert.throws(() => stageHouseholdImport({ currentPath, rootPath, usersPath, outputPath, backupPath }), { code: 'EEXIST' });
    assert.equal(readFileSync(outputPath, 'utf8'), 'competing output');
    restore();
    rmSync(outputPath);

    t.mock.method(fs, 'openSync', function(path, ...args) {
      if (path === backupPath) {
        fs.renameSync(outputPath, join(dir, 'displaced-owned-output.json'));
        competingWrite(outputPath, 'replacement output');
        throw Object.assign(new Error('injected backup write failure'), { code: 'EIO' });
      }
      return originalOpen(path, ...args);
    });
    syncBuiltinESMExports();
    assert.throws(() => stageHouseholdImport({ currentPath, rootPath, usersPath, outputPath, backupPath }), { code: 'EIO' });
    assert.equal(readFileSync(outputPath, 'utf8'), 'replacement output');
    assert.equal(existsSync(backupPath), false);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});


test('source guests cannot reuse the adopted robot account as a human identity', () => {
  const { root, users } = sourceFixture();
  users[2].data.accountId = 'old-robot';
  const current = currentFixture();
  const before = clone(current);
  assert.equal(errorCode(() => buildHouseholdImport({
    currentSnapshot: current, rootSnapshot: root, usersSnapshot: users,
  })), 'CONFLICT_ACCOUNT_ID');
  assert.deepEqual(current, before);
});

test('rejects equal-profile duplicate source accounts before ambiguous owner resolution', () => {
  const { root, users } = sourceFixture();
  users[2].data.accountId = users[0].data.accountId;
  users[2].data.account = clone(users[0].data.account);
  users[2].data.type = 'incoming';
  assert.equal(errorCode(() => buildHouseholdImport({
    currentSnapshot: currentFixture(), rootSnapshot: root, usersSnapshot: users,
  })), 'DUPLICATE_SOURCE_ACCOUNT');
});

test('preserved loops keep their shared account profiles', () => {
  const { root, users } = sourceFixture();
  const current = currentFixture();
  current.accounts.push({ _id: 'source-owner', ...users[0].data.account, firstName: 'Different', isActive: false });
  current.loops[0].owner = 'source-owner';
  current.loops[0].members[0].accountId = 'source-owner';
  current.loops[1].members.push({ _id: 'shared-member', accountId: 'source-owner', status: 'accepted' });
  const input = { currentSnapshot: current, rootSnapshot: root, usersSnapshot: users };
  assert.equal(errorCode(() => buildHouseholdImport(input)), 'SHARED_PROFILE_CONFLICT');
  current.accounts.at(-1).firstName = users[0].data.account.firstName;
  const result = buildHouseholdImport(input);
  assert.deepEqual(result.snapshot.accounts.find((a) => a._id === 'source-owner'), current.accounts.at(-1));
  assert.deepEqual(result.snapshot.loops.find((l) => l._id === 'unrelated-loop'), current.loops[1]);
});

test('refuses loss of non-bootstrap membership, while identical imports remain idempotent', () => {
  const { root, users } = sourceFixture();
  const input = { currentSnapshot: currentFixture(), rootSnapshot: root, usersSnapshot: users };
  const extra = clone(input);
  extra.currentSnapshot.loops[0].members.push({ _id: 'current-only', accountId: 'unrelated-account', status: 'accepted' });
  assert.equal(errorCode(() => buildHouseholdImport(extra)), 'NON_PRISTINE_LOOP');
  const enrolled = clone(input);
  enrolled.currentSnapshot.loops[0].members[0].enrolled = { face: true, voice: false };
  assert.equal(errorCode(() => buildHouseholdImport(enrolled)), 'NON_PRISTINE_LOOP');
  const first = buildHouseholdImport(input);
  assert.equal(first.snapshot.accounts.find((a) => a._id === 'source-owner').isActive, false);
  first.snapshot.sessions.push({ _id: 'preserved-session', accountId: 'source-robot' });
  const repeated = buildHouseholdImport({ ...input, currentSnapshot: first.snapshot });
  assert.deepEqual(repeated.snapshot, first.snapshot);
  first.snapshot.loops.find((l) => l._id === 'source-loop').members.push({ _id: 'current-only', status: 'accepted' });
  assert.equal(errorCode(() => buildHouseholdImport({ ...input, currentSnapshot: first.snapshot })), 'NON_PRISTINE_LOOP');
});
