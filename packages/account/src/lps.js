// LPS (log-upload credentials) face — Lps_20171201.NewCredentials (srv-lps-ws).
//
// Source: jiborobot/srv-lps-ws@e36e378a58cb66cfc577a554863de86360a82bb2
//   handlers/handler.ts, controllers/sts.ctrl.ts, errors/lps.ts, index.ts.
// Framework: jiborobot/srv-server parseCredentials.ts / validate.ts.
// Gateway: jiborobot/srv-security-gw@43a692fe7670660aaed6ab5979c6c83039eb711c
//   auth.ctrl.ts — Lps_20171201.NewCredentials is absent from unauthorizedMethods/
//   unsignedMethods/unactiveMethods, so a verified AWS V4 signature is required.
//
// Handler behavior (handler.ts):
//   NewCredentials: @parseCredentials({}) @validatePayload({}) — no payload fields.
//   If request.auth.credentials.friendlyId is missing -> ROBOT_ONLY 403.
//   Otherwise sts.ctrl.newCredentials(credentials.id, credentials.friendlyId).
//
// STS controller (sts.ctrl.ts): assumeRole with ExternalId and RoleSessionName both
// `${friendlyId}_${accountId}` against config.server.lps.robotRole; bucketPath =
//   lps/robot={friendlyId}/account={accountId}/year={y}/month={m}/day={d}/session={ts}/
// where m is the JS 0-based month index, exactly as written in the source. The
// response carries the assumed credentials, region, and the bucket name/path.
//
// Phoenix has no AWS STS; `sts` is an injectable { newCredentials(accountId, friendlyId) }
// provider. The default provider (createLpsStsProvider) implements the source controller
// around an injected assumeRole function, so the wire contract is faithful while the
// actual credential issuance stays behind the external seam.

import { sendAmz, sendAmzError } from './loopHttp.js';

export const LPS_ERRORS = Object.freeze({
  ROBOT_ONLY: { code: 'ROBOT_ONLY', message: 'Request forbidden. Only robotd are allowed.', statusCode: 403 },
});

/**
 * Lps_20171201.NewCredentials dispatch. `caller` is the verified access-key account; the
 * source gate checks credentials.friendlyId, so only a robot account (one carrying a
 * friendlyId) may call. `stsProvider.newCredentials(accountId, friendlyId)` returns the
 * NewCredentialsResponse wire shape.
 */
export function lpsDispatch(store, { req, res, body, op, caller, log, stsProvider }) {
  const method = op.toLowerCase();
  if (method !== 'newcredentials') {
    log.warn('lps: unknown operation', { op });
    return void sendAmzError(res, { code: 'UnknownOperationException', message: `unknown operation ${op}`, statusCode: 400 });
  }
  if (!caller || !caller.friendlyId) {
    return void sendAmzError(res, LPS_ERRORS.ROBOT_ONLY);
  }
  const accountId = String(caller._id);
  const friendlyId = caller.friendlyId;
  return Promise.resolve(stsProvider.newCredentials(accountId, friendlyId))
    .then((credentials) => void sendAmz(res, 200, credentials))
    .catch((error) => {
      if (error && error.code && error.statusCode) return void sendAmzError(res, error);
      throw error;
    });
}

/** sts.ctrl.ts bucketPath — month uses the source's 0-based getMonth(). */
export function lpsBucketPath(friendlyId, accountId, now = new Date()) {
  return `lps/robot=${friendlyId}/account=${accountId}/`
    + `year=${now.getFullYear()}/month=${now.getMonth()}/day=${now.getDate()}/`
    + `session=${now.getTime()}/`;
}

/**
 * Production STS controller equivalent (sts.ctrl.ts newCredentials): assumeRole with the
 * ExternalId/RoleSessionName both `${friendlyId}_${accountId}`, then shape the response.
 * `assumeRole` mirrors `AWS.STS.assumeRole(...).promise()`; `now` is injectable for tests.
 */
export async function lpsNewCredentials(assumeRole, { roleArn, bucketName, region, accountId, friendlyId, now = new Date() }) {
  const assumed = await assumeRole({
    ExternalId: `${friendlyId}_${accountId}`,
    RoleArn: roleArn,
    RoleSessionName: `${friendlyId}_${accountId}`,
  });
  const creds = assumed && assumed.Credentials;
  return {
    bucketName,
    bucketPath: lpsBucketPath(friendlyId, accountId, now),
    credentials: creds
      ? {
          AccessKeyId: creds.AccessKeyId,
          Expiration: creds.Expiration,
          SecretAccessKey: creds.SecretAccessKey,
          SessionToken: creds.SessionToken,
        }
      : undefined,
    region,
  };
}

/**
 * Wire a configured LPS provider: reads role/bucket/region from `config.server.lps`
 * (robotRole, region) and `config.server.bucketName`, matching the source index.ts
 * construction `new StsController(config.server.lps.robotRole, config.server.bucketName,
 * config.server.lps.region)`. Unconfigured providers throw a clear setup error rather
 * than silently issuing anything.
 */
export function createLpsStsProvider({ assumeRole, config = {} }) {
  const server = config.server || {};
  const lps = server.lps || {};
  const roleArn = lps.robotRole;
  const bucketName = server.bucketName;
  const region = lps.region;
  return {
    newCredentials: (accountId, friendlyId) => {
      if (!roleArn || !bucketName || !region || typeof assumeRole !== 'function') {
        const missing = ['robotRole', 'bucketName', 'region']
          .filter((key) => !(key === 'robotRole' ? roleArn : key === 'bucketName' ? bucketName : region));
        throw Object.assign(
          new Error(`LPS STS provider not configured (missing ${missing.join(', ')})`),
          { code: 'LPS_STS_UNAVAILABLE', statusCode: 503 },
        );
      }
      return lpsNewCredentials(assumeRole, { roleArn, bucketName, region, accountId, friendlyId });
    },
  };
}