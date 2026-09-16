// Portal REST: loop + loop-member management (surfaces 1 and 5).
//
// The account service OWNS loops in its store, so these routes act on it directly (the same
// store `POST /api/login` reads). Member operations reuse the source-shaped helpers from
// loopMembership.js where one exists; "link a member to an account" is a portal-specific
// fix — the report skill's SettingsClient resolves settings via `member.accountId`, so the
// members that carried no accountId (the news-bug root cause) are exactly what this surface
// repairs.
//
// Every route is session-cookie auth (the same account as the mobile app).

import { sendJson } from '@phoenix/common';
import { isMemberStatus, MEMBER_STATUS } from '../model.js';
import {
  LoopError,
  inviteMember,
  removeMember,
  saveLoop,
  setEnrollment,
  updateLoop,
  updateNickname,
  updatePhoneticName,
} from '../loopMembership.js';
import { requireUser } from './session.js';

const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function fail(res, error) {
  const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
  return sendJson(res, status, { error: error?.message || 'request failed', code: error?.code || undefined });
}

function activeLoop(store, loopId) {
  const loop = loopId ? store.loops.get(loopId) : null;
  return loop && loop.isDeleted !== true ? loop : null;
}

function idsEqual(a, b) {
  return a != null && b != null && String(a) === String(b);
}

/** Loops the account can see: owned, or an accepted/invited member of. */
export function visibleLoops(store, accountId) {
  return [...store.loops.values()].filter((loop) => {
    if (loop.isDeleted === true) return false;
    if (idsEqual(loop.owner, accountId)) return true;
    return (loop.members || []).some((member) => idsEqual(member.accountId, accountId)
      && ['accepted', 'invited'].includes(String(member.status || '').toLowerCase()));
  });
}

/** Linked account projection for a member (never credentials). */
function linkedAccount(store, member) {
  const account = member.accountId ? store.accounts.get(member.accountId) : null;
  if (!account) return null;
  return {
    id: account._id,
    email: account.email,
    firstName: account.firstName,
    lastName: account.lastName,
    isActive: !!account.isActive,
  };
}

function memberView(store, member) {
  const out = {
    id: member._id,
    accountId: member.accountId ?? null,
    status: String(member.status || '').toLowerCase(),
    enrolled: { face: !!(member.enrolled && member.enrolled.face), voice: !!(member.enrolled && member.enrolled.voice) },
    nickname: own(member, 'nickname') ? member.nickname : null,
    phoneticName: own(member, 'phoneticName') ? member.phoneticName : null,
    created: typeof member.created === 'number' ? member.created : null,
    memberProperties: member.memberProperties || {},
    account: linkedAccount(store, member),
  };
  return out;
}

function loopView(store, loop) {
  const robot = loop.robot ? store.accounts.get(loop.robot) : null;
  const members = (loop.members || [])
    .filter((member) => !['removed', 'declined'].includes(String(member.status || '').toLowerCase()))
    .map((member) => memberView(store, member));
  const out = {
    id: loop._id,
    name: loop.name,
    owner: loop.owner,
    robot: loop.robot ?? null,
    robotFriendlyId: (robot && robot.friendlyId) || null,
    isSuspended: !!loop.isSuspended,
    created: typeof loop.created === 'number' ? loop.created : null,
    updated: typeof loop.updated === 'number' ? loop.updated : null,
    members,
  };
  return out;
}

function findMember(loop, id) {
  return (loop.members || []).find((member) => idsEqual(member._id, id)) || null;
}

function requireLoopMember(res, loop, id) {
  const member = findMember(loop, id);
  if (!member) sendJson(res, 404, { error: 'Member not found', code: 'MEMBER_NOT_FOUND' });
  return member;
}

/** Minimal identity-only account lookup the owner uses to pick a link target. */
function accountSearch(store, term) {
  const needle = String(term || '').trim().toLowerCase();
  const all = [...store.accounts.values()].filter((a) => a.isActive !== false && !a.friendlyId);
  if (!needle) return all;
  return all.filter((account) => (account.email && account.email.toLowerCase().includes(needle))
    || (account.firstName && account.firstName.toLowerCase().includes(needle))
    || (account.lastName && account.lastName.toLowerCase().includes(needle)));
}

export function portalLoopRoutes(store, options = {}) {
  const loopUpdatedOutbox = options.loopUpdatedOutbox;
  const invitationProviders = options.invitationProviders;

  return {
    // -- loop record ----------------------------------------------------------

    'GET /api/loop': ({ req, res }) => {
      const account = requireUser(store, req, res);
      if (!account) return;
      const loops = visibleLoops(store, account._id).map((loop) => loopView(store, loop));
      return { loops };
    },

    'PUT /api/loop': ({ req, res, body }) => {
      const account = requireUser(store, req, res);
      if (!account) return;
      const { loopId, name } = body || {};
      if (!loopId) return sendJson(res, 400, { error: 'loopId is required' });
      if (typeof name !== 'string' || name.trim().length === 0) {
        return sendJson(res, 400, { error: 'name is required' });
      }
      try {
        updateLoop(store, { ownerId: account._id, loopId, name: name.trim() }, loopUpdatedOutbox);
      } catch (error) {
        if (error instanceof LoopError) return fail(res, error);
        throw error;
      }
      return { loop: loopView(store, activeLoop(store, loopId)) };
    },

    'POST /api/loop/suspend': ({ req, res, body }) => {
      const account = requireUser(store, req, res);
      if (!account) return;
      const loop = activeLoop(store, body && body.loopId);
      if (!loop) return sendJson(res, 404, { error: 'Loop does not exist', code: 'LOOP_NOT_FOUND' });
      if (!idsEqual(loop.owner, account._id)) {
        return sendJson(res, 403, { error: 'Only owner can manipulate this loop', code: 'CAN_BE_ACCESSED_BY_OWNER' });
      }
      loop.isSuspended = true;
      saveLoop(store, loop, loopUpdatedOutbox);
      return { loop: loopView(store, loop) };
    },

    'POST /api/loop/unsuspend': ({ req, res, body }) => {
      const account = requireUser(store, req, res);
      if (!account) return;
      const loop = activeLoop(store, body && body.loopId);
      if (!loop) return sendJson(res, 404, { error: 'Loop does not exist', code: 'LOOP_NOT_FOUND' });
      if (!idsEqual(loop.owner, account._id)) {
        return sendJson(res, 403, { error: 'Only owner can manipulate this loop', code: 'CAN_BE_ACCESSED_BY_OWNER' });
      }
      loop.isSuspended = false;
      saveLoop(store, loop, loopUpdatedOutbox);
      return { loop: loopView(store, loop) };
    },

    'POST /api/loop/invite': async ({ req, res, body }) => {
      const account = requireUser(store, req, res);
      if (!account) return;
      const payload = body || {};
      if (!payload.loopId) return sendJson(res, 400, { error: 'loopId is required' });
      try {
        await inviteMember(store, {
          asLegalGuardian: payload.asLegalGuardian,
          birthday: payload.birthday,
          email: payload.email || null,
          firstName: payload.firstName || null,
          gender: payload.gender,
          isChild: payload.isChild,
          lastName: payload.lastName || null,
          loopId: payload.loopId,
          ownerId: account._id,
          phoneNumber: payload.phoneNumber || null,
        }, loopUpdatedOutbox, {
          invitationProviders,
          coppaEnabled: options.coppaEnabled !== false,
        });
      } catch (error) {
        if (error instanceof LoopError) return fail(res, error);
        throw error;
      }
      return { loop: loopView(store, activeLoop(store, payload.loopId)) };
    },

    'POST /api/loop/remove': ({ req, res, body }) => {
      const account = requireUser(store, req, res);
      if (!account) return;
      const { loopId } = body || {};
      if (!loopId) return sendJson(res, 400, { error: 'loopId is required' });
      const loop = activeLoop(store, loopId);
      if (!loop) return sendJson(res, 404, { error: 'Loop does not exist', code: 'LOOP_NOT_FOUND' });
      if (!idsEqual(loop.owner, account._id)) {
        return sendJson(res, 403, { error: 'Only owner can manipulate this loop', code: 'CAN_BE_ACCESSED_BY_OWNER' });
      }
      loop.isDeleted = true;
      loop.robot = undefined;
      saveLoop(store, loop, loopUpdatedOutbox);
      return { removed: true };
    },

    // Ownership transfer is a portal-specific household action (the source exposes no
    // UpdateOwner op). The new owner must be an existing member carrying an accountId.
    'POST /api/loop/transfer': ({ req, res, body }) => {
      const account = requireUser(store, req, res);
      if (!account) return;
      const { loopId, toAccountId } = body || {};
      const loop = activeLoop(store, loopId);
      if (!loop) return sendJson(res, 404, { error: 'Loop does not exist', code: 'LOOP_NOT_FOUND' });
      if (!idsEqual(loop.owner, account._id)) {
        return sendJson(res, 403, { error: 'Only owner can manipulate this loop', code: 'CAN_BE_ACCESSED_BY_OWNER' });
      }
      const target = (loop.members || []).find((member) =>
        member.accountId && idsEqual(member.accountId, toAccountId));
      if (!target) {
        return sendJson(res, 404, { error: 'Target account is not a member', code: 'MEMBER_NOT_FOUND' });
      }
      const targetAccount = store.accounts.get(target.accountId);
      if (!targetAccount || targetAccount.isActive === false) {
        return sendJson(res, 400, { error: 'Target account is not active' });
      }
      loop.owner = target.accountId;
      saveLoop(store, loop, loopUpdatedOutbox);
      return { loop: loopView(store, loop) };
    },

    // -- members ----------------------------------------------------------------

    'POST /api/loop/members/remove': async ({ req, res, body }) => {
      const account = requireUser(store, req, res);
      if (!account) return;
      const { loopId, id } = body || {};
      if (!loopId || !id) return sendJson(res, 400, { error: 'loopId and id are required' });
      try {
        await removeMember(store, { ownerId: account._id, loopId, id }, loopUpdatedOutbox, { invitationProviders });
      } catch (error) {
        if (error instanceof LoopError) return fail(res, error);
        throw error;
      }
      return { loop: loopView(store, activeLoop(store, loopId)) };
    },

    'POST /api/loop/members/status': ({ req, res, body }) => {
      const account = requireUser(store, req, res);
      if (!account) return;
      const { loopId, id, status } = body || {};
      if (!loopId || !id) return sendJson(res, 400, { error: 'loopId and id are required' });
      if (!isMemberStatus(status)) {
        return sendJson(res, 400, { error: `status must be one of ${Object.values(MEMBER_STATUS).join(', ')}` });
      }
      const loop = activeLoop(store, loopId);
      if (!loop) return sendJson(res, 404, { error: 'Loop does not exist', code: 'LOOP_NOT_FOUND' });
      if (!idsEqual(loop.owner, account._id)) {
        return sendJson(res, 403, { error: 'Only owner can manipulate this loop', code: 'CAN_BE_ACCESSED_BY_OWNER' });
      }
      const member = findMember(loop, id);
      if (!member) return sendJson(res, 404, { error: 'Member not found', code: 'MEMBER_NOT_FOUND' });
      member.status = String(status).toLowerCase();
      saveLoop(store, loop, loopUpdatedOutbox);
      return { loop: loopView(store, loop) };
    },

    'POST /api/loop/members/nickname': ({ req, res, body }) => {
      const account = requireUser(store, req, res);
      if (!account) return;
      const { loopId, id, nickname } = body || {};
      if (!loopId || !id) return sendJson(res, 400, { error: 'loopId and id are required' });
      if (nickname !== null && nickname !== undefined && typeof nickname !== 'string') {
        return sendJson(res, 400, { error: 'nickname must be a string or null' });
      }
      try {
        updateNickname(store, { ownerId: account._id, loopId, id, nickname: nickname ?? null }, loopUpdatedOutbox);
      } catch (error) {
        if (error instanceof LoopError) return fail(res, error);
        throw error;
      }
      return { loop: loopView(store, activeLoop(store, loopId)) };
    },

    'POST /api/loop/members/phonetic': ({ req, res, body }) => {
      const account = requireUser(store, req, res);
      if (!account) return;
      const { loopId, id, phoneticName } = body || {};
      if (!loopId || !id) return sendJson(res, 400, { error: 'loopId and id are required' });
      if (phoneticName !== null && phoneticName !== undefined && typeof phoneticName !== 'string') {
        return sendJson(res, 400, { error: 'phoneticName must be a string or null' });
      }
      try {
        updatePhoneticName(store, { ownerId: account._id, loopId, id, phoneticName: phoneticName ?? null }, loopUpdatedOutbox);
      } catch (error) {
        if (error instanceof LoopError) return fail(res, error);
        throw error;
      }
      return { loop: loopView(store, activeLoop(store, loopId)) };
    },

    'POST /api/loop/members/enrollment': ({ req, res, body }) => {
      const account = requireUser(store, req, res);
      if (!account) return;
      const { loopId, id } = body || {};
      if (!loopId || !id) return sendJson(res, 400, { error: 'loopId and id are required' });
      if (body.face !== undefined && typeof body.face !== 'boolean') {
        return sendJson(res, 400, { error: 'face must be a boolean' });
      }
      if (body.voice !== undefined && typeof body.voice !== 'boolean') {
        return sendJson(res, 400, { error: 'voice must be a boolean' });
      }
      try {
        setEnrollment(store, { ownerId: account._id, loopId, id, face: body.face, voice: body.voice }, loopUpdatedOutbox);
      } catch (error) {
        if (error instanceof LoopError) return fail(res, error);
        throw error;
      }
      return { loop: loopView(store, activeLoop(store, loopId)) };
    },

    // THE news-bug fix: give an identified speaker an accountId so the report skill's
    // SettingsClient can resolve their settings.
    'POST /api/loop/members/link': ({ req, res, body }) => {
      const account = requireUser(store, req, res);
      if (!account) return;
      const { loopId, id, accountId } = body || {};
      if (!loopId || !id || !accountId) {
        return sendJson(res, 400, { error: 'loopId, id and accountId are required' });
      }
      const loop = activeLoop(store, loopId);
      if (!loop) return sendJson(res, 404, { error: 'Loop does not exist', code: 'LOOP_NOT_FOUND' });
      if (!idsEqual(loop.owner, account._id)) {
        return sendJson(res, 403, { error: 'Only owner can manipulate this loop', code: 'CAN_BE_ACCESSED_BY_OWNER' });
      }
      const member = requireLoopMember(res, loop, id);
      if (!member) return;
      const target = store.accounts.get(accountId);
      if (!target || target.friendlyId) {
        return sendJson(res, 404, { error: 'No such account', code: 'ACCOUNT_NOT_FOUND' });
      }
      // The member is only editable while not a removed/declined row; linking a live member
      // is the whole point, and the source's own editability gate (invited/child) is a mail
      // flow constraint, not relevant to a web owner action.
      member.accountId = target._id;
      if (member.status && String(member.status).toLowerCase() !== 'accepted') {
        // A linked member is a real household identity: accept them so the loop counts them
        // as an enrolled participant (enrollment drives the report skill's speaker lookup).
        member.status = 'accepted';
      }
      saveLoop(store, loop, loopUpdatedOutbox);
      return { loop: loopView(store, loop) };
    },

    'POST /api/loop/members/unlink': ({ req, res, body }) => {
      const account = requireUser(store, req, res);
      if (!account) return;
      const { loopId, id } = body || {};
      if (!loopId || !id) return sendJson(res, 400, { error: 'loopId and id are required' });
      const loop = activeLoop(store, loopId);
      if (!loop) return sendJson(res, 404, { error: 'Loop does not exist', code: 'LOOP_NOT_FOUND' });
      if (!idsEqual(loop.owner, account._id)) {
        return sendJson(res, 403, { error: 'Only owner can manipulate this loop', code: 'CAN_BE_ACCESSED_BY_OWNER' });
      }
      const member = requireLoopMember(res, loop, id);
      if (!member) return;
      member.accountId = undefined;
      saveLoop(store, loop, loopUpdatedOutbox);
      return { loop: loopView(store, loop) };
    },

    // -- account lookup for linking ---------------------------------------------

    'GET /api/accounts/search': ({ req, res, url }) => {
      const account = requireUser(store, req, res);
      if (!account) return;
      const accounts = accountSearch(store, url.searchParams.get('email') || '').slice(0, 50)
        .map((a) => ({ id: a._id, email: a.email, firstName: a.firstName, lastName: a.lastName }));
      return { accounts };
    },
  };
}