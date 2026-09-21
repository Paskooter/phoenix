// Portal -> Classic SigV4 client. The web backend is a thin presentation layer: for any
// surface the Classic services own (media, person, jot, push, notification, robot, voicetraining,
// ifttt, update), it calls them the way the phone app does — `POST /` with an `X-Amz-Target`
// header, signed with the logged-in account's accessKeyId/secretAccessKey. That access key is
// the classic entrypoint's identity seam: its handlers resolve the caller to an account by the
// Credential scope, exactly like the app's own signed requests.
//
// The production Classic entrypoint verifies this signature against the Account
// credential snapshot. Keeping the portal on the same signing path therefore
// binds every Classic operation to the logged-in account rather than trusting a
// forwarded identity assertion.

import { signSigV4 } from '@phoenix/common';

// DefaultPort.classic (7017). The env override mirrors the NET_* peer convention used across the
// repo (NET_account for the account service etc.). Explicit for tests via classicCall.base.
export const DEFAULT_CLASSIC_PORT = 7017;
export const DEFAULT_REGION = 'global';
export const DEFAULT_SERVICE = 'jibo';

/** The classic entrypoint base URL the portal fronts. */
export function classicBaseUrl(env = process.env) {
  const raw = env.NET_classic || env.ETCO_account_classicUrl;
  if (raw) return /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  return `http://localhost:${DEFAULT_CLASSIC_PORT}`;
}

/** A non-2xx response (or a signing/config failure) from a Classic call, preserved for the UI. */
export class ClassicCallError extends Error {
  constructor({ status, code, message, envelope }) {
    super(message || `Classic call failed (${status})`);
    this.name = 'ClassicCallError';
    this.status = status;
    this.code = code;
    this.envelope = envelope;
  }
}

/**
 * Make one SigV4-signed Classic AWS-JSON call for an account.
 *
 * @param {object} options
 * @param {string} [options.base] classic entrypoint base URL (default classicBaseUrl())
 * @param {{accessKeyId:string, secretAccessKey:string}} options.account signing identity
 * @param {string} options.target X-Amz-Target value, e.g. "Media_20160725.List"
 * @param {object|string} [options.body] JSON body (object is serialized here)
 * @param {string} [options.region] SigV4 scope region (default 'global')
 * @param {string} [options.service] SigV4 scope service (default 'jibo')
 * @param {object} [options.credentials] when set, forwarded as the x-amz-credentials header
 *        ({ id, email?, isAdmin?, friendlyId? }) — the trust seam the original security gateway
 *        forwarded, and what person/voicetraining handlers use for precise account resolution.
 * @param {typeof fetch} [options.fetchImpl] injectable fetch (tests only)
 * @returns {Promise<{status:number, body:any, headers:Headers}>}
 */
export async function classicCall({
  base = classicBaseUrl(),
  account,
  target,
  body = {},
  region = DEFAULT_REGION,
  service = DEFAULT_SERVICE,
  credentials = null,
  fetchImpl = fetch,
} = {}) {
  if (!account || !account.accessKeyId || !account.secretAccessKey) {
    throw new ClassicCallError({
      status: 503,
      code: 'CREDENTIALS_REQUIRED',
      message: 'This account has no signing credentials',
    });
  }
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const headers = {
    host: new URL(base).host,
    'content-type': 'application/x-amz-json-1.1',
    'x-amz-target': target,
  };
  if (credentials && typeof credentials === 'object') {
    const forwarded = {
      id: credentials.id ?? credentials._id,
    };
    if (credentials.email !== undefined) forwarded.email = credentials.email;
    if (credentials.isAdmin !== undefined) forwarded.isAdmin = !!credentials.isAdmin;
    if (credentials.friendlyId !== undefined) forwarded.friendlyId = credentials.friendlyId;
    headers['x-amz-credentials'] = JSON.stringify(forwarded);
  }
  const signed = signSigV4({
    method: 'POST',
    path: '/',
    body: payload,
    headers,
    accessKeyId: account.accessKeyId,
    secretAccessKey: account.secretAccessKey,
    region,
    service,
  });
  const res = await fetchImpl(`${base.replace(/\/+$/, '')}/`, {
    method: 'POST',
    headers: signed.headers,
    body: payload,
  });
  const text = await res.text();
  let parsed = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = null; }
  }
  if (res.status >= 400) {
    const code = (parsed && (parsed.__type || parsed.code)) || `HTTP_${res.status}`;
    const message = (parsed && (parsed.message || parsed.error)) || text || `HTTP ${res.status}`;
    throw new ClassicCallError({ status: res.status, code, message, envelope: parsed });
  }
  return { status: res.status, headers: res.headers, body: parsed };
}

/** Best-effort numeric epoch from a Classic media/person/jot value. */
export function toEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
    const d = Date.parse(value);
    if (Number.isFinite(d)) return d;
  }
  if (value instanceof Date) return value.getTime();
  return null;
}
