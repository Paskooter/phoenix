import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SIGV4_CLOCK_SKEW_MS, SIGV4_ERRORS, SigV4Error, verifySigV4 } from '@phoenix/common';
import { UploadTooLargeError, declaredContentLength, writeAtomicUpload } from './rawUpload.js';

/** The request-local slot is not representable by a client-supplied HTTP header. */
export const VERIFIED_CALLER = Symbol('phoenix.classic.verifiedCaller');
const STAGED_BODY = Symbol('phoenix.classic.stagedBody');
const DEFAULT_AUTH_BODY_MAX_BYTES = 1_000_000_000;

/**
 * A SigV4 timestamp is intentionally short-lived, but a valid signed request can still be
 * replayed several times during that window.  Keep a bounded, process-local nonce cache at the
 * public Classic boundary.  The credential access key is part of the key so two accounts cannot
 * collide, while the signature itself is already bound to method/path/headers/body by SigV4.
 */
class ReplayGuard {
  constructor({ now = Date.now, maxEntries = 50_000 } = {}) {
    this.now = now;
    this.maxEntries = maxEntries;
    this.entries = new Map();
  }

  accept(key, expires) {
    if (!key) return false;
    const now = Number(this.now());
    for (const [entry, expiry] of this.entries) {
      if (expiry <= now) this.entries.delete(entry);
    }
    if (this.entries.has(key)) return false;
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, Math.min(Number(expires) || now + SIGV4_CLOCK_SKEW_MS, now + SIGV4_CLOCK_SKEW_MS));
    return true;
  }
}

function signatureFromAuthorization(value) {
  return /(?:^|,\s*)Signature=([a-f0-9]{64})(?:,|$)/i.exec(String(value || ''))?.[1]?.toLowerCase() || null;
}

function clockMillis(now) {
  if (typeof now === 'function') return clockMillis(now());
  if (now instanceof Date) return now.getTime();
  if (now !== undefined && now !== null) {
    const value = Number(now);
    if (Number.isFinite(value)) return value;
  }
  return Date.now();
}

function requestHasEntity(req) {
  const length = declaredContentLength(req);
  if (length !== null) return length > 0;
  return req?.headers?.['transfer-encoding'] !== undefined;
}

function accountIdOf(account) {
  const value = account?.id ?? account?._id ?? account?.accountId;
  if (value === undefined || value === null || String(value).length === 0) return null;
  return String(value);
}

function nowValue(now) {
  return typeof now === 'function' ? now() : now;
}

function errorFor(error) {
  if (error instanceof SigV4Error && SIGV4_ERRORS[error.code]) return SIGV4_ERRORS[error.code];
  if (error?.code === 'SIGNATURE_REPLAYED') {
    return { code: 'SIGNATURE_REPLAYED', statusCode: 401, message: 'Request signature has already been used' };
  }
  if (error?.code === 'PAYLOAD_TOO_LARGE' || error?.statusCode === 413 || error?.status === 413) {
    return { code: 'PAYLOAD_TOO_LARGE', statusCode: 413, message: error.message || 'Payload too large' };
  }
  return SIGV4_ERRORS.ACCOUNT_SERVICE_UNAVAILABLE;
}

/** Turn an account-store record into the only identity object Classic handlers may use. */
function callerFromVerification(verification) {
  const account = verification.credentials;
  const accountId = accountIdOf(account);
  if (!accountId) throw new SigV4Error(SIGV4_ERRORS.ACCOUNT_SERVICE_UNAVAILABLE);
  const caller = {
    accountId,
    id: accountId,
    accessKeyId: verification.accessKeyId,
    email: account.email ?? null,
    friendlyId: account.friendlyId ?? null,
    isAdmin: account.isAdmin === true,
    account,
  };
  Object.defineProperty(caller, VERIFIED_CALLER, { value: true });
  return Object.freeze(caller);
}

/** Stage an unparsed entity so verification and downstream upload handling see identical bytes. */
async function stageRequestBody(req, maxBytes) {
  if (req?.[STAGED_BODY] || req?._phoenixBodyDigest !== undefined || req?.rawBody !== undefined) return;
  if (!requestHasEntity(req) || typeof req?.pipe !== 'function') return;
  const declared = declaredContentLength(req);
  if (declared !== null && declared > maxBytes) {
    req.resume?.();
    throw new UploadTooLargeError(maxBytes);
  }
  const directory = await mkdtemp(join(tmpdir(), `phoenix-classic-auth-${randomUUID()}-`));
  const file = join(directory, 'body');
  const hash = createHash('sha256');
  try {
    await writeAtomicUpload(req, file, { maxBytes, onChunk: (chunk) => hash.update(chunk) });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  req._phoenixBodyDigest = hash.digest('hex');
  req._phoenixBodyStream = createReadStream(file);
  req[STAGED_BODY] = {
    directory,
    cleanup: async () => {
      req._phoenixBodyStream?.destroy?.();
      await rm(directory, { recursive: true, force: true });
      delete req._phoenixBodyStream;
      delete req._phoenixBodyDigest;
      delete req[STAGED_BODY];
    },
  };
}

export async function cleanupVerifiedClassicRequest(req) {
  const state = req?.[STAGED_BODY];
  if (!state) return;
  await state.cleanup();
}

function verificationBody(req, body, bodyDigest) {
  if (bodyDigest !== undefined) return { body: undefined, bodyDigest };
  if (req?.rawBody !== undefined) return { body: req.rawBody };
  if (body !== undefined && body !== null) return { body };
  return { body: '' };
}

/** Create the authenticated caller boundary used by Classic's exposed AWS-JSON face. */
export function createVerifiedClassicCaller({
  resolveCredentials,
  now,
  allowNativeClientPayloadHash = true,
  maxBodyBytes = DEFAULT_AUTH_BODY_MAX_BYTES,
  replayGuard = new ReplayGuard({ now: () => clockMillis(now) }),
} = {}) {
  if (typeof resolveCredentials !== 'function') throw new TypeError('resolveCredentials must be a function');
  if (!Number.isSafeInteger(Number(maxBodyBytes)) || Number(maxBodyBytes) < 0) {
    throw new TypeError('maxBodyBytes must be a non-negative safe integer');
  }
  const limit = Number(maxBodyBytes);
  const boundary = async ({ req, body, bodyDigest } = {}) => {
    if (!req) throw new TypeError('verified caller requires a request');
    const existing = req[VERIFIED_CALLER];
    if (existing && existing[VERIFIED_CALLER] === true) return existing;
    await stageRequestBody(req, limit);
    const wire = verificationBody(req, body, bodyDigest ?? req._phoenixBodyDigest);
    const verification = verifySigV4({
      method: req.method || 'POST',
      path: req.originalUrl || req.url || '/',
      headers: req.headers || {},
      ...wire,
      now: nowValue(now),
      resolveCredentials: (accessKeyId) => {
        const account = resolveCredentials(accessKeyId);
        return account && account.isDeleted !== true ? account : null;
      },
      allowNativeClientPayloadHash: typeof allowNativeClientPayloadHash === 'function'
        ? !!allowNativeClientPayloadHash({ req, body })
        : !!allowNativeClientPayloadHash,
    });
    const caller = callerFromVerification(verification);
    const signature = signatureFromAuthorization(req.headers?.authorization);
    if (signature && !replayGuard.accept(`${verification.accessKeyId}:${signature}`, clockMillis(now) + SIGV4_CLOCK_SKEW_MS)) {
      throw new SigV4Error({ code: 'SIGNATURE_REPLAYED', statusCode: 401, message: 'Request signature has already been used' });
    }
    Object.defineProperty(req, VERIFIED_CALLER, { value: caller, configurable: true });
    req._phoenixVerifiedCaller = caller;
    return caller;
  };
  boundary.maxBodyBytes = limit;
  boundary.errorFor = errorFor;
  return boundary;
}

export function verifiedCallerFromRequest(req) {
  const caller = req?.[VERIFIED_CALLER];
  return caller && caller[VERIFIED_CALLER] === true ? caller : null;
}

export function sendVerifiedCallerError(res, error) {
  const definition = errorFor(error);
  const body = JSON.stringify({ __type: definition.code, message: definition.message || definition.code });
  res.writeHead(definition.statusCode || 401, {
    'content-type': 'application/x-amz-json-1.1',
    'content-length': Buffer.byteLength(body),
    'x-amzn-errortype': definition.code,
  });
  res.end(body);
}

export { DEFAULT_AUTH_BODY_MAX_BYTES };
