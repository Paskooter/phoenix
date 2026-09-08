// Source: srv-account-ws@6cea434, LoopController.setLegalGuardian/updateAgreementStatus.
import { sendAmz, sendAmzError, sendValidationError } from './loopHttp.js';

const COMMAND = Object.freeze({ result: 'Command accepted' });
const STATUS = {
  LOOP_NOT_FOUND: 404, CAN_BE_ACCESSED_BY_OWNER: 403, LOOP_SUSPENDED: 403,
  MEMBER_NOT_FOUND: 404, PARENT_MUST_BE_ACCEPTED: 422,
  PARENT_MUST_HAVE_EMAIL_AND_NAME: 422, AGREEMENT_NOT_FOUND: 404,
  ECHO_SIGN_UNAVAILABLE: 503,
};
function fail(code) { throw Object.assign(new Error(code), { code, statusCode: STATUS[code] }); }
const clone = (value) => JSON.parse(JSON.stringify(value));
const equal = (left, right) => left != null && right != null && String(left) === String(right);

function persist(store, previous, next, outbox) {
  store.loops.set(previous._id, next);
  try {
    if (outbox) outbox.record(next);
    else store.flush();
  } catch (error) {
    store.loops.set(previous._id, previous);
    throw error;
  }
}

export async function setLegalGuardian(store, { ownerId, loopId, parentId, childId }, provider) {
  const loop = store.loops.get(loopId);
  if (!loop || loop.isDeleted === true) fail('LOOP_NOT_FOUND');
  if (!equal(loop.owner, ownerId)) fail('CAN_BE_ACCESSED_BY_OWNER');
  if (loop.isSuspended) fail('LOOP_SUSPENDED');
  const child = loop.members.find((member) => equal(member._id, childId));
  const parent = loop.members.find((member) => equal(member._id, parentId));
  if (!child || !parent) fail('MEMBER_NOT_FOUND');
  if (String(parent.status).toLowerCase() !== 'accepted') fail('PARENT_MUST_BE_ACCEPTED');
  // Account.findById in the original has no deleted-account filter here.
  const account = store.accounts.get(parent.accountId);
  if (!account || !account.email || !account.firstName || !account.lastName) fail('PARENT_MUST_HAVE_EMAIL_AND_NAME');
  await provider.refreshToken();
  const childName = `${child.memberProperties.firstName || 'Unknown'} ${child.memberProperties.lastName || 'Unknown'}`;
  const agreementId = await provider.send(account.email, account.firstName, account.lastName, childName);
  // Source uses Loop.update, not save: no save timestamp or LoopUpdated hook.
  // Recheck the query after awaiting the provider, as Mongo does for the update.
  const current = store.loops.get(loopId);
  if (current && current.isDeleted !== true && current.members.some((member) => equal(member._id, childId))) {
    const next = clone(current);
    const target = next.members.find((member) => equal(member._id, childId));
    target.agreementId = agreementId;
    target.legalGuardianId = parentId;
    persist(store, current, next);
  }
  return COMMAND;
}

export async function updateAgreementStatus(store, { agreementId }, provider, outbox) {
  const loop = [...store.loops.values()].find((entry) => entry.isDeleted !== true
    && entry.members.some((member) => member.agreementId === agreementId
      && String(member.status).toLowerCase() === 'invited'));
  if (!loop) fail('AGREEMENT_NOT_FOUND');
  await provider.refreshToken();
  if (await provider.isSigned(agreementId)) {
    const next = clone(loop);
    // Source's second find uses agreementId alone, including duplicate-code cases.
    next.members.find((member) => member.agreementId === agreementId).status = 'accepted';
    next.updated = Date.now();
    persist(store, loop, next, outbox);
  }
  return COMMAND;
}

function validation(body, fields) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return '"value" must be an object';
  for (const key of fields) {
    if (body[key] === undefined) return `child "${key}" fails because ["${key}" is required]`;
    if (typeof body[key] !== 'string') return `child "${key}" fails because ["${key}" must be a string]`;
    if (!body[key]) return `child "${key}" fails because ["${key}" is not allowed to be empty]`;
  }
  return null;
}

export function handleLoopAgreements({ store, req, res, body, op, provider, outbox }) {
  const operation = String(op).toLowerCase();
  if (!['setlegalguardian', 'updateagreementstatus'].includes(operation)) return false;
  const message = validation(body, operation === 'setlegalguardian' ? ['childId', 'loopId', 'parentId'] : ['agreementId']);
  if (message) return void sendValidationError(res, message);
  const result = operation === 'setlegalguardian'
    ? setLegalGuardian(store, { ...body, ownerId: req._phoenixVerifiedCredentials._id }, provider)
    : updateAgreementStatus(store, body, provider, outbox);
  return result.then((data) => sendAmz(res, 200, data)).catch((error) => {
    if (STATUS[error.code]) return sendAmzError(res, error);
    if (error.code === 'Service Unavailable' && error.statusCode === 503) return sendAmzError(res, error);
    if (Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode < 600) {
      // Preserve source Wreck/Boom status while keeping the AWS error type
      // generic; diagnostic wording is not part of the provider contract.
      return sendAmzError(res, { code: 'InternalFailure', statusCode: error.statusCode }, 'Internal server error');
    }
    return sendAmzError(res, { code: 'InternalFailure', statusCode: 500, message: 'Internal server error' });
  });
}
