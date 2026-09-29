// Deleting your own account from the console.
//
//   GET  /api/me/deletion  what deleting this account would remove, shown before asking
//   POST /api/me/delete    { password }: delete it, and sign out everywhere
//
// What goes:
//   * the account, with its sessions, sign-in and setup codes, email changes,
//     phone checks, browser notification subscriptions, report, calendar and
//     linked-service settings, and its photo;
//   * every loop it owns, with everything stored for it and the photos of the
//     people in it, and each robot whose only loops those were, so that robot can
//     be set up again from scratch;
//   * accounts without an email address (children the original app added) that
//     were only in those loops;
//   * its place in other people's loops, and what Classic and History keep that
//     is its own (packages/classic/src/accountForget.js). Those loops keep their
//     robot, their people and everyone else's messages and photos.
//
// Classic must confirm before the account store changes; History is asked but
// optional. Every service first saves a backup under removal-backups/deletion-…,
// deleted after PHOENIX_DELETION_BACKUP_DAYS (default 30): the privacy policy
// says deleted data can survive only in a backup that has not yet aged out.
//
// The server's only administrator cannot delete their account, or nobody could
// administer the server afterwards.

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  deletionBackupDays, logger, pruneDeletionBackups, purgeBackupDir, purgeCollections, purgeNeedles, sendJson,
} from '@phoenix/common';
import { compareAccountPassword } from '../accountIdentity.js';
import { saveLoop } from '../loopMembership.js';
import { clearCookie } from '../sessions.js';
import { SIDE_COLLECTIONS, defaultBackupRoot, defaultPeers, purgePeers } from '../admin/removalRoutes.js';
import { requireUser } from './session.js';

const log = logger('account.deletion');
const sameId = (a, b) => a != null && b != null && String(a) === String(b);
const isRobot = (account) => !!account?.friendlyId;
const clone = (value) => JSON.parse(JSON.stringify(value));
// Photo storage keys an object by the last segment of its URL.
const photoKey = (url) => String(url).split('/').pop();
// Account-store collections whose records name the account they belong to.
const OWN_RECORDS = ['tokens', 'sessions', 'emailResets', 'phoneVerifications', 'webPushSubscriptions'];
const statusOf = (member) => String(member?.status || '').toLowerCase();

/** What deleting `account` involves. Changes nothing. */
export function deletionPlan(store, account) {
  const id = String(account._id);
  const loops = [...store.loops.values()];
  const owned = loops.filter((loop) => sameId(loop.owner, id));
  const ownedIds = new Set(owned.map((loop) => String(loop._id)));
  const others = loops.filter((loop) => !ownedIds.has(String(loop._id)));

  // A robot goes with the loops it is in, unless someone else's loop still has it.
  const robots = [...new Set(owned.map((loop) => loop.robot).filter(Boolean).map(String))]
    .map((robotId) => store.accounts.get(robotId))
    .filter((robot) => isRobot(robot) && !others.some((loop) => sameId(loop.robot, robot._id)));

  // An account without an email address exists only through its loops: it goes
  // when it is in no loop but these, and owns none of the others.
  const elsewhere = new Set(others.flatMap((loop) => [loop.owner, ...(loop.members || []).map((member) => member.accountId)])
    .filter(Boolean).map(String));
  const dependents = [...new Set(owned.flatMap((loop) => (loop.members || []).map((member) => member.accountId))
    .filter(Boolean).map(String))]
    .filter((memberId) => memberId !== id && !elsewhere.has(memberId))
    .map((memberId) => store.accounts.get(memberId))
    .filter((member) => member && !member.email && !isRobot(member));

  const people = [id, ...dependents.map((dependent) => String(dependent._id))];
  const leaving = new Set([...people, ...robots.map((robot) => String(robot._id))]);
  const memberships = others.filter((loop) => (loop.members || [])
    .some((member) => member.accountId && leaving.has(String(member.accountId))));
  return { account, owned, robots, dependents, people, memberships };
}

/** Everything that goes outright: the owned loops, and each departing robot's ids and name. */
function removalIds(plan) {
  return [
    ...plan.owned.map((loop) => loop._id),
    ...plan.robots.flatMap((robot) => [robot._id, robot.accessKeyId, robot.friendlyId]),
  ].filter(Boolean).map(String);
}

function onlyAdministrator(store, account) {
  if (!account.isAdmin) return false;
  return ![...store.accounts.values()].some((other) => other.isAdmin && !sameId(other._id, account._id)
    && other.isDeleted !== true && !isRobot(other));
}

const activeLoop = (loop) => loop.isDeleted !== true;

/** The console's view of a plan: names and counts, never other people's details. */
function planView(store, plan) {
  const robotName = (loop) => {
    const robot = loop.robot ? store.accounts.get(String(loop.robot)) : null;
    return robot?.friendlyId || null;
  };
  const account = String(plan.account._id);
  return {
    loops: plan.owned.filter(activeLoop).map((loop) => {
      // Everyone else Jibo knows in this loop, with or without an account.
      const others = (loop.members || []).filter((member) => statusOf(member) === 'accepted'
        && !sameId(member.accountId, account) && !sameId(member.accountId, loop.robot));
      return {
        id: String(loop._id),
        name: loop.name || null,
        robot: robotName(loop),
        people: others.length,
        // Someone with their own account there could become its owner instead.
        canHandOn: others.some((member) => {
          const other = member.accountId ? store.accounts.get(String(member.accountId)) : null;
          return !!other?.email && other.isDeleted !== true;
        }),
      };
    }),
    robots: plan.robots.map((robot) => robot.friendlyId),
    // Loops they are in, or invited to; not ones they already left.
    memberships: plan.memberships.filter(activeLoop).flatMap((loop) => {
      const mine = (loop.members || []).filter((member) => sameId(member.accountId, account)
        && ['accepted', 'invited'].includes(statusOf(member)));
      if (!mine.length) return [];
      return [{
        id: String(loop._id),
        name: loop.name || null,
        robot: robotName(loop),
        invited: mine.every((member) => statusOf(member) === 'invited'),
      }];
    }),
    onlyAdministrator: onlyAdministrator(store, plan.account),
    backupDays: deletionBackupDays(),
  };
}

function removeWhere(map, test) {
  let removed = 0;
  for (const [key, value] of [...map.entries()]) {
    if (!test(value, key)) continue;
    map.delete(key);
    removed += 1;
  }
  return removed;
}

/**
 * Remove the plan's records from the account store. Returns the photo URLs of
 * the accounts and loop members that went, for the photo storage to delete.
 */
function applyPlan(store, plan, loopUpdatedOutbox) {
  const people = new Set(plan.people);
  const robotIds = plan.robots.map((robot) => String(robot._id));
  const leaving = new Set([...people, ...robotIds]);
  const photos = [];

  // Whatever mentions a loop or robot that goes, as the administrator's removal does.
  const ids = removalIds(plan);
  if (ids.length) {
    const collections = Object.fromEntries(SIDE_COLLECTIONS.filter((name) => store[name]).map((name) => [name, store[name]]));
    purgeCollections(collections, purgeNeedles(ids));
  }
  // The departing people's own records.
  for (const name of OWN_RECORDS) {
    if (store[name]) removeWhere(store[name], (record) => people.has(String(record?.accountId)));
  }
  for (const personId of people) {
    store.settings.delete(personId);
    store.settings.delete(`lasso:${personId}`);
  }
  for (const robotId of robotIds) store.settings.delete(robotId);

  for (const loop of plan.owned) {
    for (const member of loop.members || []) photos.push(member.memberProperties?.photoUrl);
    store.settings.delete(`loop:${loop._id}`);
    store.loops.delete(String(loop._id));
  }
  // Other people's loops lose the departing people and robots, and each loop's
  // robot is told, as when someone leaves a loop.
  for (const loop of plan.memberships) {
    const stored = store.loops.get(String(loop._id));
    if (!stored) continue;
    const before = clone(stored);
    const draft = clone(stored);
    draft.members = (draft.members || []).filter((member) => {
      const goes = member.accountId && leaving.has(String(member.accountId));
      if (goes) photos.push(member.memberProperties?.photoUrl);
      return !goes;
    });
    if (loopUpdatedOutbox) saveLoop(store, draft, loopUpdatedOutbox, before);
    else { draft.updated = Date.now(); store.loops.set(String(draft._id), draft); }
  }

  for (const accountId of leaving) {
    photos.push(store.accounts.get(accountId)?.photoUrl);
    store.accounts.delete(accountId);
  }
  store.flush();
  // An imported household can share one stored photo between an account and a
  // member entry; a photo someone who stays still shows is kept.
  const inUse = new Set([
    ...[...store.accounts.values()].map((account) => account.photoUrl),
    ...[...store.loops.values()].flatMap((loop) => (loop.members || []).map((member) => member.memberProperties?.photoUrl)),
  ].filter((url) => typeof url === 'string' && url).map(photoKey));
  return [...new Set(photos.filter((url) => typeof url === 'string' && url))].filter((url) => !inUse.has(photoKey(url)));
}

async function removePhotos(photoProvider, urls) {
  if (!photoProvider || typeof photoProvider.remove !== 'function') return 0;
  const results = await Promise.allSettled(urls.map((url) => photoProvider.remove(photoKey(url))));
  return results.filter((result) => result.status === 'rejected').length;
}

export function accountDeletionRoutes(store, {
  loopUpdatedOutbox,
  photoProvider,
  fetch: fetchImpl = globalThis.fetch,
  peers = defaultPeers,
  backupRoot = () => defaultBackupRoot(store),
} = {}) {
  return {
    'GET /api/me/deletion': ({ req, res }) => {
      const account = requireUser(store, req, res);
      if (!account) return undefined;
      return planView(store, deletionPlan(store, account));
    },

    'POST /api/me/delete': async ({ req, res, body }) => {
      const account = requireUser(store, req, res);
      if (!account) return undefined;
      const password = body?.password;
      if (typeof password !== 'string' || !account.password || !compareAccountPassword(password, account.password)) {
        return sendJson(res, 401, { error: 'That password isn’t right.', code: 'WRONG_PASSWORD' });
      }
      if (onlyAdministrator(store, account)) {
        return sendJson(res, 409, {
          error: 'You’re the only administrator of this server. Make someone else an administrator first.',
          code: 'ONLY_ADMINISTRATOR',
        });
      }

      const plan = deletionPlan(store, account);
      const root = backupRoot();
      try { pruneDeletionBackups(root); } catch (error) { log.warn('could not prune deletion backups', { error: error.message }); }
      const backupDir = purgeBackupDir(root, 'deletion', 'account');
      mkdirSync(backupDir, { recursive: true, mode: 0o700 });
      if (store.file && existsSync(store.file)) copyFileSync(store.file, join(backupDir, 'store.json'));

      let services;
      try {
        services = await purgePeers(peers(), fetchImpl, {
          ids: removalIds(plan), forget: plan.people, dryRun: false, label: 'deletion',
        });
      } catch (error) {
        log.error('account deletion stopped before the account store changed', { error: error.message });
        return sendJson(res, 502, {
          error: 'Your account couldn’t be deleted just now, and nothing was changed. Try again in a few minutes.',
        });
      }
      const photos = applyPlan(store, plan, loopUpdatedOutbox);
      const photoFailures = await removePhotos(photoProvider, photos);
      log.info('account deleted', {
        loops: plan.owned.length,
        robots: plan.robots.length,
        dependents: plan.dependents.length,
        memberships: plan.memberships.length,
        photos: photos.length,
        photoFailures,
        services: services.map((entry) => `${entry.service}:${entry.error || entry.skipped || 'ok'}`).join(' '),
      });
      res.setHeader('Set-Cookie', clearCookie());
      return { deleted: true };
    },
  };
}
