// Source-compatible Loop robot lookup operations.
//
// Source: jiborobot/srv-account-ws@6cea43470825657d6a5722162f28c8f233153ee2
//   src/handlers/loop.handler.ts (FindOwner, GetRobot, ListOwnerRobots)
//   src/controllers/base.loop.ctrl.ts and loop.ctrl.ts (findById, findOwnerId,
//   list/listRobots/getRobot), plus src/schemes/loop.ts query middleware.
// Wire shapes: jiborobot/srv-jibo-server-client@155d20a8102960b2aeb89c197bdf04dc1f1fc344
//   apis/loop-2016-03-24.normal.json.

import { sendAmz, sendAmzError } from './loopHttp.js';
import { verifySigV4, SigV4Error, SIGV4_ERRORS } from '@phoenix/common';

const ERRORS = Object.freeze({
  LOOP_NOT_FOUND: { code: 'LOOP_NOT_FOUND', message: 'Loop does not exist', statusCode: 404 },
  CAN_BE_ACCESSED_BY_OWNER: {
    code: 'CAN_BE_ACCESSED_BY_OWNER',
    message: 'Only owner can manipulate this loop',
    statusCode: 403,
  },
  INTERNAL_FAILURE: { code: 'InternalFailure', message: 'Internal server error', statusCode: 500 },
});

/**
 * Dispatch the three lookup operations.  The return value follows
 * handleLoopMembership: true means that this operation was recognized and a
 * response was produced; false leaves dispatch to the next Loop handler.
 */
export function handleRobotLookup({ store, req, res, body, op }) {
  const operation = String(op || '').toLowerCase();
  if (!['getrobot', 'findowner', 'listownerrobots'].includes(operation)) return false;
  // srv-security-gw@43a692f has no anonymous or unsigned exception for these
  // operations. Authenticate before the internal Account handler validates.
  let caller;
  try {
    caller = verifySigV4({
      method: req.method,
      path: req.originalUrl || req.url || '/',
      headers: req.headers,
      body: req.rawBody === undefined
        ? (body == null ? '' : JSON.stringify(body)) : req.rawBody,
      resolveCredentials: (accessKeyId) => store.accountByAccessKeyId(accessKeyId),
    }).credentials;
  } catch (error) {
    if (!(error instanceof SigV4Error) || !SIGV4_ERRORS[error.code]) throw error;
    sendAmzError(res, SIGV4_ERRORS[error.code]);
    return true;
  }
  if (operation === 'getrobot') getRobot({ store, caller, res, body });
  else if (operation === 'findowner') findOwner({ store, res, body });
  else listOwnerRobots({ store, caller, res, body });
  return true;
}

function objectValidation(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return '"value" must be an object';
  return null;
}

function requiredString(body, field) {
  const objectError = objectValidation(body);
  if (objectError) return objectError;
  if (!Object.prototype.hasOwnProperty.call(body, field) || body[field] === undefined) {
    return `child "${field}" fails because ["${field}" is required]`;
  }
  if (typeof body[field] !== 'string') {
    return `child "${field}" fails because ["${field}" must be a string]`;
  }
  if (body[field].length === 0) {
    return `child "${field}" fails because ["${field}" is not allowed to be empty]`;
  }
  return null;
}

function optionalString(body, field) {
  const objectError = objectValidation(body);
  if (objectError) return objectError;
  if (!Object.prototype.hasOwnProperty.call(body, field) || body[field] === undefined) return null;
  if (typeof body[field] !== 'string') {
    return `child "${field}" fails because ["${field}" must be a string]`;
  }
  if (body[field].length === 0) {
    return `child "${field}" fails because ["${field}" is not allowed to be empty]`;
  }
  return null;
}

function sendValidationError(res, message) {
  const payload = JSON.stringify({
    statusCode: 422,
    error: 'Unprocessable Entity',
    message,
  });
  res.removeHeader('x-powered-by');
  res.removeHeader('keep-alive');
  res.writeHead(422, {
    connection: res.shouldKeepAlive ? 'keep-alive' : 'close',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-cache',
    vary: 'accept-encoding',
  });
  res.end(payload);
}


function idsEqual(left, right) {
  if (left === undefined || left === null || right === undefined || right === null) return false;
  if (left && typeof left.equals === 'function') return left.equals(right);
  if (right && typeof right.equals === 'function') return right.equals(left);
  return String(left) === String(right);
}

function idString(value) {
  if (value === undefined || value === null) return value;
  return typeof value === 'string' ? value : value.toString();
}

function activeLoops(store) {
  return [...store.loops.values()].filter((loop) => loop && loop.isDeleted !== true);
}

function activeLoopById(store, loopId) {
  const direct = store.loops.get(String(loopId));
  if (direct && direct.isDeleted !== true) return direct;
  return activeLoops(store).find((loop) => idsEqual(loop._id, loopId)) || null;
}

function sendInternalFailure(res) {
  // The source route wraps an unexpected null-account/stream failure in
  // Boom.badImplementation.  Keep the public face at the same status class;
  // the source does not define a robot-lookup error code for this boundary.
  return sendAmzError(res, ERRORS.INTERNAL_FAILURE);
}

/** API RobotAccount shape: source handler calls account.toJSON({unsafe:true}). */
function robotAccountWire(account) {
  // The generated client shape contains exactly these three observable fields.
  // `unsafe:true` is intentional here: GetRobot is the source operation that
  // hands an owner the robot's credentials. Account.Get remains safe.
  return {
    accessKeyId: account.accessKeyId,
    secretAccessKey: account.secretAccessKey,
    friendlyId: account.friendlyId,
  };
}

function getRobot({ store, caller, res, body }) {
  const validation = requiredString(body, 'loopId');
  if (validation) return sendValidationError(res, validation);

  // BaseLoopController.findById runs before the owner comparison in source.
  const loop = activeLoopById(store, body.loopId);
  if (!loop) return sendAmzError(res, ERRORS.LOOP_NOT_FOUND);

  if (!caller || !idsEqual(loop.owner, caller._id)) {
    return sendAmzError(res, ERRORS.CAN_BE_ACCESSED_BY_OWNER);
  }

  // Source Account.findById(loop.robot) is followed immediately by
  // robotAccount.toJSON({unsafe:true}); a stale relation is therefore an
  // unexpected 500, not the source ROBOT_NOT_FOUND error used by ClearRobot.
  const robot = loop.robot == null ? null
    : (store.accounts.get(String(loop.robot))
      || [...store.accounts.values()].find((account) => idsEqual(account._id, loop.robot))
      || null);
  if (!robot) return sendInternalFailure(res);
  return sendAmz(res, 200, robotAccountWire(robot));
}

function findOwner({ store, res, body }) {
  const validation = requiredString(body, 'accountId');
  if (validation) return sendValidationError(res, validation);

  // Keep the source `$or` query semantics: a member accountId match or an
  // owner match, in the model's natural insertion order.  The Loop schema's
  // findOne middleware excludes soft-deleted loops.
  const loop = activeLoops(store).find((candidate) => idsEqual(candidate.owner, body.accountId)
    || (Array.isArray(candidate.members)
      && candidate.members.some((member) => idsEqual(member && member.accountId, body.accountId))));
  // Mongoose findOne resolves to null when no loop matches; the source
  // expression `{ id: loop && loop.owner }` therefore preserves a null id.
  return sendAmz(res, 200, { id: loop ? idString(loop.owner) : null });
}

function visibleToOwner(loop, ownerId) {
  if (idsEqual(loop.owner, ownerId)) return true;
  return Array.isArray(loop.members) && loop.members.some((member) => idsEqual(member && member.accountId, ownerId)
    && ['accepted', 'invited'].includes(String(member.status || '').toLowerCase()));
}

function listOwnerRobots({ store, caller, res, body }) {
  const validation = optionalString(body, 'accountId');
  if (validation) return sendValidationError(res, validation);
  // ListOwnerRobots does not compare a supplied accountId with the caller in
  // the source handler. An omitted/falsy accountId falls back to credentials.
  const ownerId = body.accountId ? body.accountId : caller && caller._id;
  const visible = activeLoops(store).filter((loop) => visibleToOwner(loop, ownerId));

  // listRobots calls list({ownerId}) without `owned`, so a robot identity is
  // inferred from any visible loop whose robot relation equals ownerId. Once
  // inferred, source list() keeps only that robot's active, unsuspended loop.
  const isRobotRequesting = visible.some((loop) => loop.robot && idsEqual(loop.robot, ownerId));
  const loops = isRobotRequesting
    ? visible.filter((loop) => !loop.isSuspended && loop.robot && idsEqual(loop.robot, ownerId))
    : visible;

  const result = [];
  for (const loop of loops) {
    if (!loop.robot) continue;
    const robot = store.accounts.get(String(loop.robot))
      || [...store.accounts.values()].find((account) => idsEqual(account._id, loop.robot));
    // The source dereferences `robotAccount.friendlyId` without a null guard;
    // preserve that unexpected-failure boundary instead of inventing an ID.
    if (!robot) return sendInternalFailure(res);
    result.push(robot.friendlyId);
  }
  return sendAmz(res, 200, result);
}
