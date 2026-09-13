import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SIGV4_ERRORS, SigV4Error, verifySigV4 } from '@phoenix/common';
import { UploadTooLargeError, declaredContentLength, writeAtomicUpload } from './rawUpload.js';

/** The request-local slot is not representable by a client-supplied HTTP header. */
export const VERIFIED_CALLER = Symbol('phoenix.classic.verifiedCaller');
const STAGED_BODY = Symbol('phoenix.classic.stagedBody');
const DEFAULT_AUTH_BODY_MAX_BYTES = 1_000_000_000;

function requestHasEntity(req) {
  const length = declaredContentLength(req);
  if (length !== null) return length > 0;
  return req?.headers?.['transfer-encoding'] !== undefined;
}

function targetOf(req) {
  return String(req?.headers?.['x-amz-target'] || '');
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

/**
 * Stage an unparsed request entity while calculating its digest. Classic's raw media/key/update
 * handlers still receive a replayable stream, but SigV4 is checked against the exact bytes before
 * any identity, membership, owner, or admin decision is made.
 */
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
    await writeAtomicUpload(req, file, {
      maxBytes,
      onChunk: (chunk) => hash.update(chunk),
    });
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

/** Remove the temporary replay file created for a raw authenticated request. */
export async function cleanupVerifiedClassicRequest(req) {
  const state = req?.[STAGED_BODY];
  if (!state) return;
  await state.cleanup();
}

/** Read the wire entity, never a re-serialized parsed object, for the verifier. */
function verificationBody(req, body, bodyDigest) {
  if (bodyDigest !== undefined) return { body: undefined, bodyDigest };
  if (req?.rawBody !== undefined) return { body: req.rawBody };
  if (body !== undefined && body !== null) return { body };
  return { body: '' };
}

/**
 * Create the authenticated caller boundary used by Classic's exposed AWS-JSON face.
 *
 * `resolveCredentials` is deliberately injected: the authenticated launcher supplies
 * `accountStore.accountByAccessKeyId`, while unit tests can provide an isolated account store.
 * The resolver sees only the access key parsed from Authorization. `x-amz-credentials` is never
 * consulted, because it is an untrusted forwarding header outside the original gateway.
 */
export function createVerifiedClassicCaller({
  resolveCredentials,
  now,
  allowNativeClientPayloadHash = true,
  maxBodyBytes = DEFAULT_AUTH_BODY_MAX_BYTES,
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
    Object.defineProperty(req, VERIFIED_CALLER, { value: caller, configurable: true });
    // Keep a readable diagnostic slot for existing Classic handler seams. The symbol remains the
    // authority; this field is never populated from a request header.
    req._phoenixVerifiedCaller = caller;
    return caller;
  };
  boundary.maxBodyBytes = limit;
  boundary.errorFor = errorFor;
  return boundary;
}

/** Return the verified caller, or null when the request has not crossed the boundary. */
export function verifiedCallerFromRequest(req) {
  const caller = req?.[VERIFIED_CALLER];
  return caller && caller[VERIFIED_CALLER] === true ? caller : null;
}

/** Convert a verifier failure into the Classic AWS-JSON error envelope. */
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
