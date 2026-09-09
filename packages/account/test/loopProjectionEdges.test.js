// A-04 gate 4: source query/projection edges through the signed Account→Classic
// boundary, then the same read after Store close/reopen.
//
// Source: jiborobot/srv-account-ws@6cea43470825657d6a5722162f28c8f233153ee2
//   LoopController.list / listMembers / populateLoop / loadMembers / getRobot /
//   listRobots / findOwnerId; schemes/loop.ts find middleware; schemes/account.ts
//   (no isDeleted query middleware; unique sparse email/friendlyId).
// Synthetic households and local peers only. No robot host, no live mail.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { signedLoopHeaders } from './fixtures/signedLoopRequest.js';

const { createAccountService } = await import('../src/index.js');
const { createClassicEntrypoint } = await import('../../classic/src/index.js');
const { Store } = await import('../src/store.js');
const { createOwnerAccount, createLoop, findOrCreateRobotAccount, MEMBER_STATUS } = await import('../src/model.js');
const { LoopUpdatedOutbox } = await import('../src/loopUpdatedOutbox.js');
const { inviteMember } = await import('../src/loopMembership.js');

const EVIDENCE_DIR = join(
  process.cwd(),
  '.parity/reviews/a04-projection-edges-20260910',
);
const CREATE_PASSWORD = 'ValidPass1';
const recorded = [];

function makeProviders() {
  const mail = [];
  const events = [];
  return {
    mail,
    events,
    invitationProviders: {
      portalUrl: 'https://portal.fixture.test',
      invitation: {
        send(to, options) {
          mail.push({ template: 'invitation', to, options: { ...options } });
          return Promise.resolve();
        },
      },
      invitationExistingUser: {
        send(to, options) {
          mail.push({ template: 'invitationExistingUser', to, options: { ...options } });
          return Promise.resolve();
        },
      },
      eventSender: {
        send(event) {
          events.push({
            eventKey: event.payload?.eventKey || event.constructor?.name,
            payload: { ...event.payload },
          });
          return Promise.resolve();
        },
      },
    },
  };
}

function makeHousehold(prefix) {
  const directory = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const store = new Store(join(directory, 'store.json'));
  const owner = createOwnerAccount(store, {
    email: `${prefix}-owner@fixture.test`,
    password: 'fixture-password',
    firstName: 'Owner',
    lastName: 'Alpha',
  });
  owner.facebookAccessToken = 'owner-facebook-token';
  const guest = createOwnerAccount(store, {
    email: `${prefix}-guest@fixture.test`,
    password: 'fixture-password',
    firstName: 'Guest',
    lastName: 'Beta',
  });
  const healthy = createOwnerAccount(store, {
    email: `${prefix}-healthy@fixture.test`,
    password: 'fixture-password',
    firstName: 'Healthy',
    lastName: 'Control',
  });
  const { loop, robot } = createLoop(store, { owner, robotId: `${prefix}-robot-active` });
  loop.name = `${prefix}-active`;
  const deleted = createLoop(store, { owner, robotId: `${prefix}-robot-deleted` });
  deleted.loop.name = `${prefix}-deleted`;
  const { loop: healthyLoop, robot: healthyRobot } = createLoop(store, {
    owner: healthy,
    robotId: `${prefix}-robot-healthy`,
  });
  healthyLoop.name = `${prefix}-healthy`;
  store.flush();
  return {
    directory,
    store,
    owner,
    guest,
    healthy,
    loop,
    robot,
    deletedLoop: deleted.loop,
    deletedRobot: deleted.robot,
    healthyLoop,
    healthyRobot,
  };
}

function record(name, payload) {
  recorded.push({ name, at: new Date().toISOString(), ...payload });
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  const copy = {};
  for (const [key, item] of Object.entries(value)) {
    if (/secret|password|accessKey/i.test(key) && typeof item === 'string') copy[key] = '<redacted>';
    else copy[key] = redact(item);
  }
  return copy;
}

function memberSummary(member) {
  if (!member) return null;
  return {
    id: member.id,
    accountId: member.accountId ?? null,
    memberId: member.memberId ?? null,
    status: member.status,
    type: member.type,
    loopId: member.loopId,
    account: member.account
      ? {
        email: member.account.email ?? null,
        firstName: member.account.firstName ?? null,
        lastName: member.account.lastName ?? null,
        isChild: member.account.isChild,
        hasFacebookAccessToken: Object.hasOwn(member.account, 'facebookAccessToken'),
      }
      : null,
  };
}

function loopSummary(loop) {
  if (!loop) return null;
  return {
    id: loop.id,
    name: loop.name,
    owner: loop.owner,
    robot: loop.robot ?? null,
    hasRobotFriendlyId: Object.hasOwn(loop, 'robotFriendlyId'),
    robotFriendlyId: loop.robotFriendlyId ?? null,
    isSuspended: loop.isSuspended,
    memberIds: (loop.members || []).map((member) => member.id),
    members: (loop.members || []).map(memberSummary),
  };
}

async function closeServer(server) {
  if (!server) return;
  server.closeAllConnections?.();
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function post(base, store, target, body, accessKeyId) {
  const serialized = body === undefined ? '' : JSON.stringify(body);
  const headers = {
    'content-type': 'application/x-amz-json-1.1',
    'x-amz-target': target,
    connection: 'close',
  };
  if (accessKeyId) {
    Object.assign(headers, signedLoopHeaders(store, base, target, body, accessKeyId));
  }
  const response = await fetch(`${base}/`, {
    method: 'POST',
    signal: AbortSignal.timeout(5000),
    headers,
    body: body === undefined ? undefined : serialized,
  });
  const rawBody = await response.text();
  let parsed = null;
  try { parsed = rawBody ? JSON.parse(rawBody) : null; } catch { parsed = rawBody; }
  return {
    status: response.status,
    errorType: response.headers.get('x-amzn-errortype'),
    rawBody,
    body: parsed,
  };
}

const robotReadClient = {
  async getRobot() {
    throw new Error('Robot read service is not configured');
  },
};

async function withFaces(state, invitationProviders, run) {
  const prior = process.env.NET_account;
  let accountServer;
  let classicServer;
  try {
    const account = createAccountService({ store: state.store, invitationProviders, robotReadClient });
    accountServer = await account.listen(0);
    const accountBase = `http://127.0.0.1:${accountServer.address().port}`;
    process.env.NET_account = accountBase;
    const classic = createClassicEntrypoint({
      notificationFile: join(state.directory, 'classic-notifications.json'),
      notificationPollIntervalMs: 60000,
    });
    classicServer = await classic.listen(0);
    const classicBase = `http://127.0.0.1:${classicServer.address().port}`;
    return await run({ accountBase, classicBase, store: state.store });
  } finally {
    await closeServer(classicServer);
    await closeServer(accountServer);
    if (prior === undefined) delete process.env.NET_account;
    else process.env.NET_account = prior;
  }
}

async function reopenFaces(state, invitationProviders, run) {
  const store = new Store(state.store.file);
  const prior = process.env.NET_account;
  let accountServer;
  let classicServer;
  try {
    const account = createAccountService({ store, invitationProviders, robotReadClient });
    accountServer = await account.listen(0);
    const accountBase = `http://127.0.0.1:${accountServer.address().port}`;
    process.env.NET_account = accountBase;
    const classic = createClassicEntrypoint({
      notificationFile: join(state.directory, 'classic-notifications-reopen.json'),
      notificationPollIntervalMs: 60000,
    });
    classicServer = await classic.listen(0);
    const classicBase = `http://127.0.0.1:${classicServer.address().port}`;
    return await run({ accountBase, classicBase, store });
  } finally {
    await closeServer(classicServer);
    await closeServer(accountServer);
    if (prior === undefined) delete process.env.NET_account;
    else process.env.NET_account = prior;
  }
}

function byLoop(list, loopId) {
  return (list || []).find((item) => item.id === loopId) || null;
}

function membersOn(list, loopId) {
  return (list || []).filter((member) => member.loopId === loopId);
}

function emailMembers(list, email) {
  return (list || []).filter((member) => member.account?.email === email);
}

test('dangling account and robot references project through Account and Classic, then after reopen', async () => {
  const state = makeHousehold('a04-proj-dangle');
  const side = makeProviders();
  try {
    const missingRobotId = 'a04-proj-missing-robot-account';
    const missingMemberId = 'a04-proj-missing-member-account';
    state.loop.robot = missingRobotId;
    state.loop.members.push({
      _id: 'a04-proj-dangle-member',
      accountId: missingMemberId,
      status: MEMBER_STATUS.ACCEPTED,
      memberProperties: {
        email: 'dangling-member@fixture.test',
        firstName: 'Dangling',
        lastName: 'Member',
      },
      enrolled: { face: false, voice: false },
      created: 1700000000000,
    });
    state.store.flush();

    const capture = {};
    await withFaces(state, side.invitationProviders, async ({ accountBase, classicBase, store }) => {
      for (const [face, base] of [['account', accountBase], ['classic', classicBase]]) {
        const listed = await post(base, store, 'Loop_20160324.ListLoops', {}, state.owner.accessKeyId);
        assert.equal(listed.status, 200, `${face} ListLoops dangling robot`);
        const active = byLoop(listed.body, state.loop._id);
        assert.ok(active, `${face} ListLoops still returns the active loop`);
        assert.equal(active.robot, missingRobotId);
        assert.equal(Object.hasOwn(active, 'robotFriendlyId'), false, `${face} populateLoop omits robotFriendlyId when Account.findById misses`);
        const dangling = (active.members || []).find((member) => member.id === 'a04-proj-dangle-member');
        assert.ok(dangling);
        assert.equal(dangling.status, 'accepted');
        assert.equal(dangling.accountId, missingMemberId);
        assert.equal(dangling.account.email, 'dangling-member@fixture.test');
        assert.equal(dangling.account.firstName, 'Dangling');
        assert.equal(Object.hasOwn(dangling.account, 'facebookAccessToken'), false);

        const members = await post(base, store, 'Loop_20160324.ListLoopMembers', {}, state.owner.accessKeyId);
        assert.equal(members.status, 200, `${face} ListLoopMembers dangling member`);
        const listedDangling = membersOn(members.body, state.loop._id)
          .find((member) => member.id === 'a04-proj-dangle-member');
        assert.ok(listedDangling);
        assert.equal(listedDangling.account.email, 'dangling-member@fixture.test');
        assert.equal(listedDangling.type, 'outgoing');

        const findMissingMember = await post(base, store, 'Loop_20160324.FindOwner', {
          accountId: missingMemberId,
        }, state.healthy.accessKeyId);
        assert.equal(findMissingMember.status, 200);
        assert.deepEqual(findMissingMember.body, { id: state.owner._id },
          `${face} FindOwner matches members.accountId even when the Account document is gone`);

        const getRobot = await post(base, store, 'Loop_20160324.GetRobot', {
          loopId: state.loop._id,
        }, state.owner.accessKeyId);
        assert.equal(getRobot.status, 500, `${face} GetRobot unguarded toJSON of a missing robot`);
        assert.equal(getRobot.body.__type, 'InternalFailure');
        assert.notEqual(getRobot.body.__type, 'ROBOT_NOT_FOUND');

        const ownerRobots = await post(base, store, 'Loop_20160324.ListOwnerRobots', {}, state.owner.accessKeyId);
        assert.equal(ownerRobots.status, 500, `${face} ListOwnerRobots throws on the first missing robotAccount.friendlyId`);
        assert.equal(ownerRobots.body.__type, 'InternalFailure');

        const healthyGet = await post(base, store, 'Loop_20160324.GetRobot', {
          loopId: state.healthyLoop._id,
        }, state.healthy.accessKeyId);
        assert.equal(healthyGet.status, 200, `${face} following valid GetRobot`);
        assert.equal(healthyGet.body.friendlyId, state.healthyRobot.friendlyId);

        const healthyList = await post(base, store, 'Loop_20160324.ListOwnerRobots', {}, state.healthy.accessKeyId);
        assert.equal(healthyList.status, 200);
        assert.deepEqual(healthyList.body, [state.healthyRobot.friendlyId]);

        capture[face] = {
          listLoops: { status: listed.status, loop: loopSummary(active) },
          listLoopMembers: { status: members.status, dangling: memberSummary(listedDangling) },
          findOwner: { status: findMissingMember.status, body: findMissingMember.body },
          getRobot: { status: getRobot.status, type: getRobot.body?.__type, raw: redact(getRobot.body) },
          listOwnerRobots: { status: ownerRobots.status, type: ownerRobots.body?.__type },
          followingGetRobot: { status: healthyGet.status, friendlyId: healthyGet.body.friendlyId },
          followingListOwnerRobots: { status: healthyList.status, body: healthyList.body },
        };
      }
      assert.deepEqual(capture.account.listLoops.loop, capture.classic.listLoops.loop);
      assert.deepEqual(capture.account.findOwner.body, capture.classic.findOwner.body);
    });

    const reopened = await reopenFaces(state, side.invitationProviders, async ({ classicBase, store }) => {
      const listed = await post(classicBase, store, 'Loop_20160324.ListLoops', {}, state.owner.accessKeyId);
      const members = await post(classicBase, store, 'Loop_20160324.ListLoopMembers', {}, state.owner.accessKeyId);
      const findOwner = await post(classicBase, store, 'Loop_20160324.FindOwner', {
        accountId: missingMemberId,
      }, state.healthy.accessKeyId);
      const getRobot = await post(classicBase, store, 'Loop_20160324.GetRobot', {
        loopId: state.loop._id,
      }, state.owner.accessKeyId);
      const ownerRobots = await post(classicBase, store, 'Loop_20160324.ListOwnerRobots', {}, state.owner.accessKeyId);
      const healthyGet = await post(classicBase, store, 'Loop_20160324.GetRobot', {
        loopId: state.healthyLoop._id,
      }, state.healthy.accessKeyId);
      const persisted = store.loops.get(state.loop._id);
      return { listed, members, findOwner, getRobot, ownerRobots, healthyGet, persisted };
    });

    assert.equal(reopened.listed.status, 200);
    const reopenedActive = byLoop(reopened.listed.body, state.loop._id);
    assert.equal(reopenedActive.robot, missingRobotId);
    assert.equal(Object.hasOwn(reopenedActive, 'robotFriendlyId'), false);
    const reopenedDangling = (reopenedActive.members || []).find((member) => member.id === 'a04-proj-dangle-member');
    assert.equal(reopenedDangling.account.email, 'dangling-member@fixture.test');
    assert.deepEqual(reopened.findOwner.body, { id: state.owner._id });
    assert.equal(reopened.getRobot.status, 500);
    assert.equal(reopened.getRobot.body.__type, 'InternalFailure');
    assert.equal(reopened.ownerRobots.status, 500);
    assert.equal(reopened.healthyGet.status, 200);
    assert.equal(reopened.healthyGet.body.friendlyId, state.healthyRobot.friendlyId);
    assert.equal(reopened.persisted.robot, missingRobotId);

    record('dangling-account-robot', {
      fixture: {
        loopId: state.loop._id,
        missingRobotId,
        missingMemberId,
        memberRow: { _id: 'a04-proj-dangle-member', accountId: missingMemberId, status: 'accepted' },
      },
      sourceProjection: {
        listLoops: 'Loop.find middleware keeps the active loop; populateLoop Account.findById miss omits robotFriendlyId and falls back to memberProperties',
        getRobot: 'Account.findById(loop.robot) then unguarded toJSON → Boom.badImplementation / InternalFailure, not ROBOT_NOT_FOUND',
        findOwner: 'Loop.findOne $or members.accountId/owner does not join Account, so a missing account still resolves the owner id',
      },
      accountClassic: capture,
      reopen: {
        listLoops: loopSummary(reopenedActive),
        findOwner: reopened.findOwner.body,
        getRobot: { status: reopened.getRobot.status, type: reopened.getRobot.body?.__type },
        followingGetRobot: { status: reopened.healthyGet.status, friendlyId: reopened.healthyGet.body.friendlyId },
      },
    });
  } finally {
    rmSync(state.directory, { recursive: true, force: true });
  }
});

test('soft-deleted accounts and loops surface only on the source predicates, including after reopen', async () => {
  const state = makeHousehold('a04-proj-soft');
  const side = makeProviders();
  try {
    const capture = {};
    await withFaces(state, side.invitationProviders, async ({ accountBase, classicBase, store }) => {
      const removed = await post(classicBase, store, 'Loop_20160324.RemoveLoop', {
        loopId: state.deletedLoop._id,
      }, state.owner.accessKeyId);
      assert.equal(removed.status, 200);
      assert.equal(store.loops.get(state.deletedLoop._id).isDeleted, true);
      assert.equal(store.loops.get(state.deletedLoop._id).robot, undefined);

      const childInvite = await post(classicBase, store, 'Loop_20160324.InviteLoopMember', {
        loopId: state.loop._id,
        firstName: 'Child',
        lastName: 'Row',
      }, state.owner.accessKeyId);
      assert.equal(childInvite.status, 200, childInvite.rawBody);
      const child = (childInvite.body.members || []).find((member) => member.account?.firstName === 'Child');
      assert.ok(child);
      assert.equal(child.status, 'accepted', 'source addMember accepts a non-child row with no email');

      state.guest.isDeleted = true;
      state.guest.firstName = 'DeletedGuest';
      store.flush();

      const updated = await post(classicBase, store, 'Loop_20160324.UpdateLoopMember', {
        loopId: state.loop._id,
        id: child.id,
        email: state.guest.email,
        firstName: 'Bound',
      }, state.owner.accessKeyId);
      assert.equal(updated.status, 200, updated.rawBody);
      const bound = (updated.body.members || []).find((member) => member.id === child.id);
      assert.equal(bound.status, 'invited');
      assert.equal(bound.accountId, state.guest._id, 'UpdateMember Account.findOne({ email }) has no isDeleted predicate');
      assert.equal(bound.account.email, state.guest.email);
      assert.equal(bound.account.firstName, 'Bound', 'invited rows project memberProperties, not the deleted Account document');

      const acceptedGuest = {
        _id: 'a04-proj-soft-accepted',
        accountId: state.guest._id,
        status: MEMBER_STATUS.ACCEPTED,
        memberProperties: { email: 'stale-properties@fixture.test', firstName: 'StaleProps' },
        enrolled: { face: false, voice: false },
        created: 1700000001000,
      };
      store.loops.get(state.loop._id).members.push(acceptedGuest);
      store.flush();

      for (const [face, base] of [['account', accountBase], ['classic', classicBase]]) {
        const listed = await post(base, store, 'Loop_20160324.ListLoops', {}, state.owner.accessKeyId);
        assert.equal(listed.status, 200);
        const ids = (listed.body || []).map((item) => item.id);
        assert.equal(ids.includes(state.deletedLoop._id), false, `${face} ListLoops find middleware excludes isDeleted loops`);
        assert.equal(ids.includes(state.loop._id), true);
        const active = byLoop(listed.body, state.loop._id);
        const boundMember = (active.members || []).find((member) => member.id === child.id);
        const leftoverAccepted = (active.members || []).find((member) => member.id === acceptedGuest._id);
        assert.equal(boundMember.status, 'invited');
        assert.equal(boundMember.account.firstName, 'Bound');
        assert.equal(leftoverAccepted.status, 'accepted');
        assert.equal(leftoverAccepted.account.firstName, 'DeletedGuest',
          `${face} loadMembers Account.find has no isDeleted predicate, so an accepted leftover still projects the deleted account`);
        assert.notEqual(leftoverAccepted.account.firstName, 'StaleProps');
        assert.equal(Object.hasOwn(active.members.find((member) => member.accountId === state.owner._id).account, 'facebookAccessToken'), false,
          `${face} human ListLoops does not copy facebookAccessToken`);

        const members = await post(base, store, 'Loop_20160324.ListLoopMembers', {}, state.owner.accessKeyId);
        assert.equal(members.status, 200);
        assert.equal(membersOn(members.body, state.deletedLoop._id).length, 0, `${face} ListLoopMembers uses list() so deleted loops contribute no members`);
        const invited = await post(base, store, 'Loop_20160324.ListLoopMembers', {
          statusList: ['invited'],
        }, state.owner.accessKeyId);
        assert.equal(emailMembers(invited.body, state.guest.email).some((member) => member.id === child.id), true);
        const accepted = await post(base, store, 'Loop_20160324.ListLoopMembers', {
          statusList: ['accepted'],
        }, state.owner.accessKeyId);
        const acceptedProjection = membersOn(accepted.body, state.loop._id)
          .find((member) => member.id === acceptedGuest._id);
        assert.equal(acceptedProjection.account.firstName, 'DeletedGuest');

        const findDeletedLoopOwner = await post(base, store, 'Loop_20160324.FindOwner', {
          accountId: state.deletedRobot._id,
        }, state.healthy.accessKeyId);
        assert.equal(findDeletedLoopOwner.status, 200);
        assert.deepEqual(findDeletedLoopOwner.body, { id: null },
          `${face} FindOwner findOne middleware excludes the soft-deleted loop; this is the already-covered null projection`);

        const findBound = await post(base, store, 'Loop_20160324.FindOwner', {
          accountId: state.guest._id,
        }, state.healthy.accessKeyId);
        assert.equal(findBound.status, 200);
        assert.deepEqual(findBound.body, { id: state.owner._id },
          `${face} FindOwner does not consult Account.isDeleted`);

        const getDeleted = await post(base, store, 'Loop_20160324.GetRobot', {
          loopId: state.deletedLoop._id,
        }, state.owner.accessKeyId);
        assert.equal(getDeleted.status, 404, `${face} GetRobot findById uses findOne middleware`);
        assert.equal(getDeleted.body.__type, 'LOOP_NOT_FOUND');

        const getActive = await post(base, store, 'Loop_20160324.GetRobot', {
          loopId: state.loop._id,
        }, state.owner.accessKeyId);
        assert.equal(getActive.status, 200);
        assert.equal(getActive.body.friendlyId, state.robot.friendlyId);

        const ownerRobots = await post(base, store, 'Loop_20160324.ListOwnerRobots', {}, state.owner.accessKeyId);
        assert.equal(ownerRobots.status, 200);
        assert.deepEqual(ownerRobots.body, [state.robot.friendlyId],
          `${face} ListOwnerRobots skips the removed loop (robot cleared + isDeleted)`);

        capture[face] = {
          listLoopsIds: ids,
          bound: memberSummary(boundMember),
          leftoverAccepted: memberSummary(leftoverAccepted),
          invitedFilter: emailMembers(invited.body, state.guest.email).map(memberSummary),
          findOwnerDeletedLoop: findDeletedLoopOwner.body,
          findOwnerBoundAccount: findBound.body,
          getDeleted: { status: getDeleted.status, type: getDeleted.body?.__type },
          getActive: { status: getActive.status, friendlyId: getActive.body.friendlyId },
          listOwnerRobots: ownerRobots.body,
        };
      }
      assert.deepEqual(capture.account.listLoopsIds, capture.classic.listLoopsIds);
      assert.deepEqual(capture.account.bound.accountId, capture.classic.bound.accountId);
      assert.deepEqual(capture.account.listOwnerRobots, capture.classic.listOwnerRobots);
    });

    const reopened = await reopenFaces(state, side.invitationProviders, async ({ classicBase, store }) => {
      const listed = await post(classicBase, store, 'Loop_20160324.ListLoops', {}, state.owner.accessKeyId);
      const invited = await post(classicBase, store, 'Loop_20160324.ListLoopMembers', {
        statusList: ['invited'],
      }, state.owner.accessKeyId);
      const accepted = await post(classicBase, store, 'Loop_20160324.ListLoopMembers', {
        statusList: ['accepted'],
      }, state.owner.accessKeyId);
      const findBound = await post(classicBase, store, 'Loop_20160324.FindOwner', {
        accountId: state.guest._id,
      }, state.healthy.accessKeyId);
      const getDeleted = await post(classicBase, store, 'Loop_20160324.GetRobot', {
        loopId: state.deletedLoop._id,
      }, state.owner.accessKeyId);
      const getActive = await post(classicBase, store, 'Loop_20160324.GetRobot', {
        loopId: state.loop._id,
      }, state.owner.accessKeyId);
      const ownerRobots = await post(classicBase, store, 'Loop_20160324.ListOwnerRobots', {}, state.owner.accessKeyId);
      const guest = store.accounts.get(state.guest._id);
      const deletedLoop = store.loops.get(state.deletedLoop._id);
      return {
        listed, invited, accepted, findBound, getDeleted, getActive, ownerRobots, guest, deletedLoop,
      };
    });

    const reopenedIds = (reopened.listed.body || []).map((item) => item.id);
    assert.equal(reopenedIds.includes(state.deletedLoop._id), false);
    assert.equal(reopenedIds.includes(state.loop._id), true);
    assert.equal(reopened.deletedLoop.isDeleted, true);
    assert.equal(reopened.guest.isDeleted, true);
    assert.deepEqual(reopened.findBound.body, { id: state.owner._id });
    assert.equal(reopened.getDeleted.status, 404);
    assert.equal(reopened.getActive.status, 200);
    assert.deepEqual(reopened.ownerRobots.body, [state.robot.friendlyId]);
    const leftover = membersOn(reopened.accepted.body, state.loop._id)
      .find((member) => member.id === 'a04-proj-soft-accepted');
    assert.equal(leftover.account.firstName, 'DeletedGuest');

    record('soft-deleted-accounts-loops', {
      fixture: {
        removedLoopId: state.deletedLoop._id,
        activeLoopId: state.loop._id,
        deletedAccountId: state.guest._id,
        updateMemberBind: 'InviteLoopMember without email, then UpdateLoopMember email of isDeleted account',
        leftoverAcceptedMemberId: 'a04-proj-soft-accepted',
      },
      sourceProjection: {
        list: 'Loop pre-find/findOne isDeleted $ne true',
        invite: 'Account.findOne({ email, isDeleted: { $ne: true } })',
        updateMember: 'Account.findOne({ email }) with no isDeleted predicate',
        loadMembers: 'Account.find({ _id: { $in } }) with no isDeleted predicate',
        getRobot: 'findById → LOOP_NOT_FOUND for a deleted loop',
      },
      accountClassic: capture,
      reopen: {
        listLoopsIds: reopenedIds,
        findOwnerBound: reopened.findBound.body,
        getDeleted: { status: reopened.getDeleted.status, type: reopened.getDeleted.body?.__type },
        listOwnerRobots: reopened.ownerRobots.body,
        leftoverAccepted: memberSummary(leftover),
      },
    });
  } finally {
    rmSync(state.directory, { recursive: true, force: true });
  }
});

test('repeated invitation emails are source-permitted; repeated friendlyIds are uniqueness-bound', async () => {
  const state = makeHousehold('a04-proj-repeat');
  const side = makeProviders();
  const email = 'repeat-invite@fixture.test';
  try {
    const capture = {};
    const live = createOwnerAccount(state.store, {
      email,
      password: 'fixture-password',
      firstName: 'RepeatLive',
      lastName: 'Invitee',
    });

    const outbox = new LoopUpdatedOutbox(state.store);
    const [firstInvite, secondInvite] = await Promise.all([
      inviteMember(state.store, {
        ownerId: state.owner._id,
        loopId: state.loop._id,
        email,
        firstName: 'One',
      }, outbox, { invitationProviders: side.invitationProviders }),
      inviteMember(state.store, {
        ownerId: state.owner._id,
        loopId: state.loop._id,
        email,
        firstName: 'Two',
      }, outbox, { invitationProviders: side.invitationProviders }),
    ]);
    assert.ok(firstInvite && secondInvite);
    const storedMembers = (state.store.loops.get(state.loop._id).members || [])
      .filter((member) => member.memberProperties?.email === email);
    assert.equal(storedMembers.length, 2, 'source $pushAll lets both independently loaded same-email invites survive');
    assert.notEqual(storedMembers[0]._id, storedMembers[1]._id);
    assert.ok(storedMembers.every((member) => member.accountId === live._id));

    await withFaces(state, side.invitationProviders, async ({ accountBase, classicBase, store }) => {
      const removed = await post(classicBase, store, 'Loop_20160324.RemoveLoop', {
        loopId: state.deletedLoop._id,
      }, state.owner.accessKeyId);
      assert.equal(removed.status, 200);

      const reused = findOrCreateRobotAccount(store, state.deletedRobot.friendlyId);
      assert.equal(reused._id, state.deletedRobot._id, 'Account.findOne({ friendlyId }) has no isDeleted predicate and the unique sparse index reuses the same document');
      const second = findOrCreateRobotAccount(store, state.deletedRobot.friendlyId);
      assert.equal(second._id, state.deletedRobot._id);
      assert.equal([...store.accounts.values()].filter((account) => account.friendlyId === state.deletedRobot.friendlyId).length, 1,
        'a second Account with the same friendlyId is not source-permitted (unique sparse index)');

      const recreate = await post(classicBase, store, 'Loop_20160324.CreateLoop', {
        name: 'reused-robot-loop',
        robotId: state.deletedRobot.friendlyId,
      }, state.owner.accessKeyId);
      assert.equal(recreate.status, 200, recreate.rawBody);
      assert.equal(recreate.body.robot, state.deletedRobot._id);
      assert.equal(recreate.body.robotFriendlyId, state.deletedRobot.friendlyId);

      live.isDeleted = true;
      store.flush();

      const createReuse = await post(accountBase, store, 'Account_20151111.Create', {
        email,
        password: CREATE_PASSWORD,
        firstName: 'Reborn',
        lastName: 'Invitee',
      });
      assert.equal(createReuse.status, 200, createReuse.rawBody);
      assert.equal(store.accounts.get(live._id), undefined, 'Account.create hard-removes the previous isDeleted document');
      const reborn = store.accountByEmail(email);
      assert.ok(reborn);
      assert.notEqual(reborn._id, live._id);

      const afterCreate = store.loops.get(state.loop._id).members
        .filter((member) => member.memberProperties?.email === email);
      const rebound = afterCreate.filter((member) => member.accountId === reborn._id);
      const dangling = afterCreate.filter((member) => member.accountId === live._id);
      assert.equal(rebound.length, 1, 'source Loop.update members.$ positional write rebinds the first matching email member');
      assert.equal(dangling.length, 1, 'the second same-email member keeps the removed Account _id');

      for (const [face, base] of [['account', accountBase], ['classic', classicBase]]) {
        const listed = await post(base, store, 'Loop_20160324.ListLoops', {}, state.owner.accessKeyId);
        assert.equal(listed.status, 200);
        const active = byLoop(listed.body, state.loop._id);
        const repeats = (active.members || []).filter((member) => member.account?.email === email);
        assert.equal(repeats.length, 2, `${face} ListLoops projects both same-email members`);
        assert.equal(repeats.filter((member) => member.accountId === reborn._id).length, 1);
        assert.equal(repeats.filter((member) => member.accountId === live._id).length, 1);
        const danglingWire = repeats.find((member) => member.accountId === live._id);
        assert.equal(danglingWire.account.email, email);
        assert.equal(danglingWire.account.firstName === 'One' || danglingWire.account.firstName === 'Two', true,
          `${face} invited dangling member falls back to memberProperties`);

        const all = await post(base, store, 'Loop_20160324.ListLoopMembers', {}, state.owner.accessKeyId);
        const invited = await post(base, store, 'Loop_20160324.ListLoopMembers', {
          statusList: ['invited'],
        }, state.owner.accessKeyId);
        const accepted = await post(base, store, 'Loop_20160324.ListLoopMembers', {
          statusList: ['accepted'],
        }, state.owner.accessKeyId);
        const declined = await post(base, store, 'Loop_20160324.ListLoopMembers', {
          statusList: ['declined'],
        }, state.owner.accessKeyId);
        const removedStatus = await post(base, store, 'Loop_20160324.ListLoopMembers', {
          statusList: ['removed'],
        }, state.owner.accessKeyId);
        assert.equal(emailMembers(all.body, email).length, 2);
        assert.equal(emailMembers(invited.body, email).length, 2);
        assert.equal(emailMembers(accepted.body, email).length, 0);
        assert.equal(emailMembers(declined.body, email).length, 0);
        assert.equal(emailMembers(removedStatus.body, email).length, 0);

        const findOld = await post(base, store, 'Loop_20160324.FindOwner', {
          accountId: live._id,
        }, state.healthy.accessKeyId);
        assert.deepEqual(findOld.body, { id: state.owner._id },
          `${face} FindOwner still matches the dangling members.accountId`);
        const findNew = await post(base, store, 'Loop_20160324.FindOwner', {
          accountId: reborn._id,
        }, state.healthy.accessKeyId);
        assert.deepEqual(findNew.body, { id: state.owner._id });

        const ownerRobots = await post(base, store, 'Loop_20160324.ListOwnerRobots', {}, state.owner.accessKeyId);
        assert.equal(ownerRobots.status, 200);
        assert.equal(ownerRobots.body.filter((id) => id === state.deletedRobot.friendlyId).length, 1);
        assert.equal(new Set(ownerRobots.body).size, ownerRobots.body.length,
          `${face} ListOwnerRobots does not emit a repeated friendlyId; unique sparse loop.robot plus find middleware prevent it`);

        capture[face] = {
          listLoopsRepeats: repeats.map(memberSummary),
          filters: {
            all: emailMembers(all.body, email).map(memberSummary),
            invited: emailMembers(invited.body, email).map((member) => member.id),
            accepted: emailMembers(accepted.body, email).length,
            declined: emailMembers(declined.body, email).length,
            removed: emailMembers(removedStatus.body, email).length,
          },
          findOwnerOld: findOld.body,
          findOwnerNew: findNew.body,
          listOwnerRobots: ownerRobots.body,
          rebornAccountId: reborn._id,
        };
      }
      assert.equal(capture.account.filters.all.length, capture.classic.filters.all.length);
      assert.deepEqual(capture.account.listOwnerRobots, capture.classic.listOwnerRobots);
    });

    const reopened = await reopenFaces(state, side.invitationProviders, async ({ classicBase, store }) => {
      const listed = await post(classicBase, store, 'Loop_20160324.ListLoops', {}, state.owner.accessKeyId);
      const invited = await post(classicBase, store, 'Loop_20160324.ListLoopMembers', {
        statusList: ['invited'],
      }, state.owner.accessKeyId);
      const findOld = await post(classicBase, store, 'Loop_20160324.FindOwner', {
        accountId: live._id,
      }, state.healthy.accessKeyId);
      const ownerRobots = await post(classicBase, store, 'Loop_20160324.ListOwnerRobots', {}, state.owner.accessKeyId);
      const getActive = await post(classicBase, store, 'Loop_20160324.GetRobot', {
        loopId: state.loop._id,
      }, state.owner.accessKeyId);
      const friendlyMatches = [...store.accounts.values()]
        .filter((account) => account.friendlyId === state.deletedRobot.friendlyId);
      return { listed, invited, findOld, ownerRobots, getActive, friendlyMatches, store };
    });

    const reopenedRepeats = emailMembers(byLoop(reopened.listed.body, state.loop._id).members, email);
    assert.equal(reopenedRepeats.length, 2);
    assert.equal(emailMembers(reopened.invited.body, email).length, 2);
    assert.deepEqual(reopened.findOld.body, { id: state.owner._id });
    assert.equal(reopened.friendlyMatches.length, 1);
    assert.equal(reopened.getActive.status, 200);
    assert.equal(new Set(reopened.ownerRobots.body).size, reopened.ownerRobots.body.length);

    record('repeated-emails-friendlyids', {
      fixture: {
        email,
        dualInviteMemberIds: storedMembers.map((member) => member._id),
        originalAccountId: live._id,
        removedLoopId: state.deletedLoop._id,
        reusedFriendlyId: state.deletedRobot.friendlyId,
      },
      sourceProjection: {
        dualEmail: 'addMember concurrent $pushAll of two invited rows with the same memberProperties.email; email index is not unique',
        accountCreate: 'Account.create hard-removes isDeleted email collision then Loop.update members.$ rebinds only the first match',
        friendlyId: 'Account.friendlyId unique sparse + findOrCreateRobotAccount findOne({ friendlyId }) reuse; two live accounts with the same friendlyId are uniqueness-malformed and excluded',
      },
      accountClassic: capture,
      reopen: {
        repeats: reopenedRepeats.map(memberSummary),
        findOwnerOld: reopened.findOld.body,
        listOwnerRobots: reopened.ownerRobots.body,
        friendlyIdAccountCount: reopened.friendlyMatches.length,
        followingGetRobot: { status: reopened.getActive.status, friendlyId: reopened.getActive.body.friendlyId },
      },
    });
  } finally {
    rmSync(state.directory, { recursive: true, force: true });
  }
});

after(() => {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(join(EVIDENCE_DIR, 'cases.json'), `${JSON.stringify(recorded, null, 2)}\n`);
});
