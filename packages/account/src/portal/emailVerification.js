import { isIP } from 'node:net';
import { sendJson } from '@phoenix/common';
import { emailVerificationStatus, requestEmailVerification, confirmEmailVerification } from '../emailVerification.js';
import { requireUser } from './session.js';

const requestLimits = new WeakMap();

export function emailVerificationContext(options = {}) {
  return {
    mail: options.identityProviders?.emailVerification || options.mailProviders?.emailVerification
      || options.mailProviders?.activation,
    portalUrl: options.identityProviders?.portalUrl || options.mailProviders?.portalUrl
      || process.env.ETCO_account_portalUrl || process.env.PHOENIX_SITE_URL || '',
    now: options.emailVerificationNow || Date.now,
  };
}

function clientAddress(req) {
  const peer = req?.socket?.remoteAddress || 'unknown';
  // The public reverse proxy overwrites X-Real-IP. Never accept a caller's
  // forwarding header when the connection is not from our loopback proxy.
  if (['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer)) {
    const forwarded = String(req?.headers?.['x-real-ip'] || '').trim();
    if (isIP(forwarded)) return forwarded;
  }
  return peer;
}

/** Also bound requests across different addresses/tokens from the same client. */
export function allowVerificationRequest(store, req, res, context, kind = 'send') {
  let limits = requestLimits.get(store);
  if (!limits) { limits = new Map(); requestLimits.set(store, limits); }
  const now = context.now();
  const windowMs = kind === 'send' ? 60 * 60 * 1000 : 15 * 60 * 1000;
  const limit = kind === 'send' ? 40 : 100;
  const key = `${kind}:${clientAddress(req)}`;
  const existing = limits.get(key);
  const row = existing && now < existing.expiresAt ? existing : { count: 0, expiresAt: now + windowMs };
  row.count += 1;
  limits.set(key, row);
  if (limits.size > 10000) {
    for (const [candidate, value] of limits) if (now >= value.expiresAt) limits.delete(candidate);
    if (limits.size > 10000) limits.delete(limits.keys().next().value);
  }
  if (row.count <= limit) return true;
  const retryAfterSeconds = Math.ceil((row.expiresAt - now) / 1000);
  res.setHeader('Retry-After', String(retryAfterSeconds));
  sendJson(res, 429, { error: 'Too many verification requests. Please try again later.', retryAfterSeconds });
  return false;
}

function publicError(res, error) {
  const status = [400, 429, 502, 503].includes(error?.statusCode) ? error.statusCode : 503;
  if (status === 429) res.setHeader('Retry-After', String(error.retryAfterSeconds));
  return sendJson(res, status, {
    error: error?.statusCode ? error.message : 'Email verification is temporarily unavailable. Please try again later.',
    ...(error?.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
  });
}

export function resendPublicVerification(store, email, context) {
  const account = store.accountByEmail(email);
  if (!account || account.isDeleted === true || account.friendlyId) return;
  // Reservation/limits are synchronous; SMTP completes in the background.
  // Otherwise the response delay itself reveals whether this address exists.
  void requestEmailVerification(store, account, { ...context, now: context.now() })
    .catch(() => { /* Do not expose account existence or provider diagnostics. */ });
}

export function emailVerificationRoutes(store, context) {
  return {
    'GET /api/me/email-verification': ({ req, res }) => {
      const account = requireUser(store, req, res);
      if (!account) return;
      return emailVerificationStatus(store, account, { available: !!context.mail, now: context.now() });
    },
    'POST /api/me/email-verification/resend': async ({ req, res }) => {
      const account = requireUser(store, req, res);
      if (!account || !allowVerificationRequest(store, req, res, context)) return;
      try {
        return await requestEmailVerification(store, account, { ...context, now: context.now() });
      } catch (error) { return publicError(res, error); }
    },
    'POST /api/email-verification/confirm': ({ req, res, body }) => {
      if (!allowVerificationRequest(store, req, res, context, 'confirm')) return;
      try {
        confirmEmailVerification(store, body?.token, { now: context.now() });
        return { ok: true };
      } catch (error) { return publicError(res, error); }
    },
  };
}
