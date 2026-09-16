// Shared session helpers for the portal REST face. Same store + same session cookie as the
// original /api/login — one identity system, reused by every new route.
import { getSession } from '../sessions.js';
import { sendJson } from '@phoenix/common';

/** The logged-in human account, or null (session absent / not a user session). */
export function userFromSession(store, req) {
  const session = getSession(store, req);
  if (!session || session.kind !== 'user') return null;
  return store.accounts.get(session.accountId) || null;
}

/** Resolve the logged-in account, answering 401 and returning null when absent. */
export function requireUser(store, req, res) {
  const account = userFromSession(store, req);
  if (!account) sendJson(res, 401, { error: 'not logged in' });
  return account;
}

/** Safe, minimal account projection for the portal (identity only, never credentials). */
export function portalAccount(account) {
  if (!account) return null;
  const out = {
    id: account._id,
    email: account.email,
    firstName: account.firstName,
    lastName: account.lastName,
    gender: account.gender,
    isActive: !!account.isActive,
    messagingAllowed: account.messagingAllowed === undefined ? true : !!account.messagingAllowed,
    phoneNumber: account.phoneNumber,
    photoUrl: account.photoUrl,
    created: account.created,
  };
  if (account.birthday != null) out.birthday = Number(account.birthday);
  return out;
}