// Mailbox proof is separate from account activation. In particular, an active
// imported/LAN account has not necessarily proved ownership of its email.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
export const EMAIL_VERIFICATION_COOLDOWN_MS = 60 * 1000;
export const EMAIL_VERIFICATION_HOURLY_LIMIT = 5;
export const EMAIL_VERIFICATION_DAILY_LIMIT = 20;
const HOUR_MS = 60 * 60 * 1000;

const normalizedEmail = (email) => String(email || '').trim().toLowerCase();
const tokenHash = (token) => createHash('sha256').update(token).digest('hex');

export function isEmailVerified(account) {
  const email = normalizedEmail(account?.email);
  return !!email && account?.emailVerified === true
    && normalizedEmail(account.emailVerifiedAddress) === email;
}

/** Call only after proof of the CURRENT mailbox, before the caller persists. */
export function markEmailVerified(account, now = Date.now()) {
  account.emailVerified = true;
  account.emailVerifiedAddress = normalizedEmail(account.email);
  account.emailVerifiedAt = now;
}

function verificationError(code, message, statusCode, extra = {}) {
  return Object.assign(new Error(message), { code, statusCode, ...extra });
}

function recentRequests(row, now) {
  return (Array.isArray(row?.requests) ? row.requests : [])
    .filter((at) => Number.isFinite(at) && at > now - EMAIL_VERIFICATION_TTL_MS);
}

function retryAfterMs(row, now) {
  const requests = recentRequests(row, now).sort((a, b) => a - b);
  const hour = requests.filter((at) => at > now - HOUR_MS);
  return Math.max(0,
    requests.length ? requests.at(-1) + EMAIL_VERIFICATION_COOLDOWN_MS - now : 0,
    hour.length >= EMAIL_VERIFICATION_HOURLY_LIMIT
      ? hour[hour.length - EMAIL_VERIFICATION_HOURLY_LIMIT] + HOUR_MS - now : 0,
    requests.length >= EMAIL_VERIFICATION_DAILY_LIMIT
      ? requests[requests.length - EMAIL_VERIFICATION_DAILY_LIMIT] + EMAIL_VERIFICATION_TTL_MS - now : 0);
}

export function emailVerificationStatus(store, account, { available = false, now = Date.now() } = {}) {
  const verified = isEmailVerified(account);
  return {
    emailVerified: verified,
    emailVerifiedAt: verified ? account.emailVerifiedAt || null : null,
    available: !!available,
    retryAfterSeconds: verified ? 0 : Math.ceil(retryAfterMs(store.emailVerifications.get(account._id), now) / 1000),
  };
}

function verificationUrl(portalUrl, token) {
  let base;
  try { base = new URL(portalUrl); } catch { /* reported without configuration/credentials */ }
  if (!base || !['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
    throw verificationError('VERIFICATION_UNAVAILABLE', 'Email verification is temporarily unavailable. Please try again later.', 503);
  }
  const url = new URL('/verify-email', base);
  // Fragments are not sent to HTTP servers or in Referer headers. Neither
  // nginx access logs nor link previews should retain a bearer credential.
  url.hash = `token=${token}`;
  return url.href;
}

/** Reserve the limit/token durably before delivery, so concurrent requests and
 * process restarts cannot bypass the resend limits. Tokens are stored hashed. */
export async function requestEmailVerification(store, account, {
  mail, portalUrl, now = Date.now(),
} = {}) {
  if (!account?.email || account.friendlyId || account.isDeleted === true
    || (account.isActive === false && account.emailActivationPending !== true && !account.activationCode)) {
    throw verificationError('VERIFICATION_UNAVAILABLE', 'This account cannot request email verification.', 400);
  }
  if (isEmailVerified(account)) return { sent: false, emailVerified: true, retryAfterSeconds: 0 };
  const send = typeof mail === 'function' ? mail : mail?.send?.bind(mail);
  if (!send) {
    throw verificationError('VERIFICATION_UNAVAILABLE', 'Email verification is temporarily unavailable. Please try again later.', 503);
  }
  const previous = store.emailVerifications.get(account._id);
  const wait = retryAfterMs(previous, now);
  if (wait > 0) {
    throw verificationError('VERIFICATION_RATE_LIMITED', 'Please wait before requesting another verification email.', 429,
      { retryAfterSeconds: Math.ceil(wait / 1000) });
  }
  const token = randomBytes(32).toString('hex');
  const url = verificationUrl(portalUrl, token);
  const row = {
    _id: account._id,
    email: normalizedEmail(account.email),
    tokenHash: tokenHash(token),
    created: now,
    expiresAt: now + EMAIL_VERIFICATION_TTL_MS,
    activateAccount: account.isActive === false && (account.emailActivationPending === true || !!account.activationCode),
    requests: [...recentRequests(previous, now), now],
  };
  store.emailVerifications.set(row._id, row);
  try { store.flush(); } catch (error) {
    if (previous) store.emailVerifications.set(row._id, previous);
    else store.emailVerifications.delete(row._id);
    throw error;
  }
  try {
    await send(account.email, { email: account.email, firstName: account.firstName || 'there', url });
  } catch {
    // Keep the previous working link when a resend fails, but retain the
    // attempt budget so repeated SMTP failures cannot become a spam loop.
    if (store.emailVerifications.get(row._id) === row) {
      store.emailVerifications.set(row._id, { ...previous, _id: row._id, requests: row.requests });
      store.flush();
    }
    throw verificationError('VERIFICATION_DELIVERY_FAILED', 'Could not send the verification email. Please try again later.', 502);
  }
  return { sent: true, emailVerified: false, retryAfterSeconds: Math.ceil(retryAfterMs(row, now) / 1000) };
}

/** Validate and consume one token atomically with the email verification flag. */
export function confirmEmailVerification(store, token, { now = Date.now() } = {}) {
  const invalid = () => verificationError('VERIFICATION_LINK_INVALID', 'This verification link is invalid or has expired. Request a new email.', 400);
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw invalid();
  const hash = Buffer.from(tokenHash(token), 'hex');
  const row = [...store.emailVerifications.values()].find((candidate) => {
    if (typeof candidate.tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.tokenHash)) return false;
    return timingSafeEqual(hash, Buffer.from(candidate.tokenHash, 'hex'));
  });
  const account = row && store.accounts.get(row._id);
  if (!account || account.isDeleted === true || account.friendlyId || !Number.isFinite(row.expiresAt)
    || now >= row.expiresAt || normalizedEmail(account.email) !== row.email
    || (account.isActive === false && !(row.activateAccount && (account.emailActivationPending === true || account.activationCode)))) throw invalid();
  const next = { ...account, updated: now };
  markEmailVerified(next, now);
  if (row.activateAccount) next.isActive = true;
  if (row.activateAccount) delete next.activationCode;
  delete next.emailActivationPending;
  const consumed = { ...row };
  delete consumed.tokenHash;
  delete consumed.expiresAt;
  store.accounts.set(next._id, next);
  store.emailVerifications.set(row._id, consumed);
  try { store.flush(); } catch (error) {
    store.accounts.set(account._id, account);
    store.emailVerifications.set(row._id, row);
    throw error;
  }
  return next;
}
