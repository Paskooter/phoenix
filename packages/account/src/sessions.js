// Cookie sessions for the portal UI. Opaque ids stored server-side (in the Store, so they survive
// restarts), HttpOnly cookies, 7-day TTL. One session kind, 'user', carrying an accountId.
//
// There is no separate admin session: administrator access is a flag on the signed-in account
// (see portalApi.js's isAdmin), which is why the shared ADMIN_PASSWORD and its session kind are
// gone. Grant admin with scripts/portal-grant-admin.mjs.

import { randomBytes } from 'node:crypto';

export const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const COOKIE = 'phx_session';

// Session records carry the account's authentication version at issuance.  A
// password/key reset increments that version, which makes every older browser
// session invalid without having to find and delete an unbounded number of
// rows.  Keep the field optional when reading old stores; pre-versioned
// accounts are treated as version zero and upgraded on their next write.
export const SESSION_VERSION_FIELD = 'sessionVersion';

function accountSessionVersion(account) {
  const version = Number(account?.[SESSION_VERSION_FIELD]);
  return Number.isSafeInteger(version) && version >= 0 ? version : 0;
}

/** Increment the account authentication version in-place before persisting it. */
export function bumpAccountSessionVersion(account) {
  const current = accountSessionVersion(account);
  account[SESSION_VERSION_FIELD] = current >= Number.MAX_SAFE_INTEGER ? 0 : current + 1;
  return account[SESSION_VERSION_FIELD];
}

export function createSession(store, { kind, accountId = null }) {
  const account = accountId ? store.accounts.get(accountId) : null;
  const session = {
    _id: randomBytes(24).toString('hex'),
    kind,
    accountId,
    accountVersion: account ? accountSessionVersion(account) : null,
    created: Date.now(),
  };
  store.sessions.set(session._id, session);
  store.flush();
  return session;
}

export function destroySession(store, id) {
  if (store.sessions.delete(id)) store.flush();
}

/** Parse the session cookie and return the live session (sweeping it if expired). */
export function getSession(store, req) {
  const cookies = parseCookies(req.headers.cookie || '');
  const id = cookies[COOKIE];
  if (!id) return null;
  const session = store.sessions.get(id);
  if (!session) return null;
  if (Date.now() - session.created > SESSION_TTL_MS) {
    destroySession(store, id);
    return null;
  }
  if (session.kind === 'user') {
    const account = session.accountId ? store.accounts.get(session.accountId) : null;
    // A session must never survive account deletion/deactivation or an
    // authentication-sensitive change (password, key rotation, recovery).
    if (!account || account.isDeleted === true || account.isActive === false
      || (session.accountVersion ?? 0) !== accountSessionVersion(account)) {
      destroySession(store, id);
      return null;
    }
  }
  return session;
}

function cookiesSecureByDefault() {
  // HTTPS is the safe default even when a deployment forgot to set
  // NODE_ENV=production.  An explicit opt-out is retained for local HTTP
  // development; production runbooks must never set it to false.
  if (process.env.ETCO_account_secureCookies !== undefined) {
    return process.env.ETCO_account_secureCookies === 'true';
  }
  return true;
}

export function sessionCookie(session, { secure = cookiesSecureByDefault() } = {}) {
  const parts = [`${COOKIE}=${session._id}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearCookie({ secure = cookiesSecureByDefault() } = {}) {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

export function parseCookies(header) {
  const out = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}
