// Cookie sessions for the portal + admin UI. Opaque ids stored server-side (in the Store, so
// they survive restarts), HttpOnly cookies, 7-day TTL. Two session kinds share the mechanism:
// kind 'user' carries an accountId; kind 'admin' is granted by the ADMIN_PASSWORD from .env.

import { randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const COOKIE = 'phx_session';

export function createSession(store, { kind, accountId = null }) {
  const session = { _id: randomBytes(24).toString('hex'), kind, accountId, created: Date.now() };
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
  return session;
}

export function sessionCookie(session, { secure = process.env.ETCO_account_secureCookies === 'true' } = {}) {
  const parts = [`${COOKIE}=${session._id}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function parseCookies(header) {
  const out = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

/** Constant-time admin password check against ADMIN_PASSWORD (.env). */
export function checkAdminPassword(password) {
  const expected = process.env.ADMIN_PASSWORD || '';
  if (!expected) return false; // unset = admin UI disabled
  const a = Buffer.from(String(password));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
