// Account identity core — Create, Login, Get, Update, CheckEmail, ChangePassword
// plus the email/phone/terms slice: ChangeEmail, ResetEmail, ConfirmEmailReset,
// SendPhoneVerificationCode, VerifyPhoneByCode, AcceptTerms,
// plus Search and Remove.
//
// Source: jiborobot/srv-account-ws@6cea43470825657d6a5722162f28c8f233153ee2
//   handlers/account.handler.ts, controllers/account.ctrl.ts, schemes/account.ts,
//   schemes/email.reset.ts, schemes/phoneVerification.ts, utils/password.ts,
//   errors/account.ts, errors/token.ts, controllers/loop.ctrl.ts (clearAssociated).
// Framework: jiborobot/srv-server parseCredentials.ts / validate.ts / server.ts
//   lowerMethodName = split('.')[1], first character lowercased.
// Gateway: jiborobot/srv-security-gw@43a692fe7670660aaed6ab5979c6c83039eb711c
//   auth.ctrl.ts unauthorizedMethods for Create/Login/CheckEmail/ConfirmEmailReset.
//   Search is NOT on that list (handler has no parseCredentials; gateway still
//   requires a signature). unactiveMethods is only Account_20151111.Remove.
//
// Public Classic/Account identity is the signed access key (A-04 Loop pattern).
// parseCredentials still reads only x-amz-credentials and is tested as the
// original internal boundary; it is not a public caller switch.

import { pbkdf2Sync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import querystring from 'node:querystring';
import { SIGV4_ERRORS, SigV4Error, verifySigV4 } from '@phoenix/common';
import { sendAmz, sendAmzEmpty, sendAmzError, sendValidationError } from './loopHttp.js';
import { fillAccessKeys, isAcceptedStatus, MEMBER_STATUS, MEMBER_TYPE, newId, verifyPassword } from './model.js';
import { listMembers, LOOP_MEMBERSHIP_ERRORS, removeLoop } from './loopMembership.js';

export const ACCOUNT_PASSWORD_REGEX = /^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)[A-Za-z\d-_!$%@#£€*?&\(\)\^]{8,}$/;
const ACCOUNT_MINIMAL_AGE = 13;
const GENDERS = Object.freeze(['male', 'female', 'other', 'they']);
const ROLES = Object.freeze(['user', 'developer']);
const EXCLUDED_UPDATE_PROPS = Object.freeze(['email', 'password', 'accessKeyId', 'secretAccessKey']);
export const EMAIL_RESET_STATUS = Object.freeze({
  NEW: 'new',
  USED: 'used',
  CANCELED: 'canceled',
});
const EMAIL_RESET_NEW = EMAIL_RESET_STATUS.NEW;
const EMAIL_RESET_TTL_MS = 86400000;
const PHONE_VERIFICATION_CODE_LIFETIME_MS = 1000 * 60 * 10;
const PHONE_VERIFICATION_CODE_SIZE = 6;
const AUTHORIZED_UNDER_ADMIN = {
  code: 'AUTHORIZED_UNDER_ADMIN',
  message: 'Must be authorized under admin account',
  statusCode: 401,
};

// Gateway unauthorizedMethods — exact x-amz-target strings, not case-folded.
export const ACCOUNT_ANONYMOUS_TARGETS = Object.freeze([
  'Account_20151111.CheckEmail',
  'Account_20151111.Create',
  'Account_20151111.Login',
  'Account_20151111.ConfirmEmailReset',
  'Account_20151111.ResendActivationCode',
  'Account_20151111.ActivateByCode',
  'Account_20151111.SendPasswordReset',
  'Account_20151111.PasswordResetByCode',
]);

// Gateway unactiveMethods — inactive accounts may call only this target.
export const ACCOUNT_UNACTIVE_TARGETS = Object.freeze([
  'Account_20151111.Remove',
]);

export const ACCOUNT_IDENTITY_METHODS = Object.freeze([
  'create',
  'login',
  'get',
  'update',
  'checkEmail',
  'changePassword',
  'changeEmail',
  'resetEmail',
  'confirmEmailReset',
  'sendPhoneVerificationCode',
  'verifyPhoneByCode',
  'acceptTerms',
  'activateByCode',
  'activateById',
  'passwordResetByCode',
  'resendActivationCode',
  'sendPasswordReset',
  'search',
  'remove',
]);

export const ACCOUNT_ERRORS = Object.freeze({
  ACCOUNT_NOT_FOUND: { code: 'ACCOUNT_NOT_FOUND', message: 'Account not found', statusCode: 404 },
  ACCOUNT_IS_DELETED: { code: 'ACCOUNT_IS_DELETED', message: 'Account is removed', statusCode: 404 },
  EMAIL_ALREADY_EXISTS: {
    code: 'EMAIL_ALREADY_EXISTS',
    message: 'Account with such e-mail already exists',
    statusCode: 409,
  },
  EMAIL_NOT_VALID: { code: 'EMAIL_NOT_VALID', message: 'Email is not valid', statusCode: 422 },
  STALE_VERSION: {
    code: 'STALE_VERSION',
    message: 'Account entity received is older than server one',
    statusCode: 409,
  },
  ROBOT_CANNOT_BE_UPDATED: {
    code: 'ROBOT_CANNOT_BE_UPDATED',
    message: 'Robot account cannot be updated',
    statusCode: 409,
  },
  WRONG_PASSWORD: { code: 'WRONG_PASSWORD', message: 'Wrong password', statusCode: 401 },
  PASSWORD_NOT_VALID_LENGTH: {
    code: 'PASSWORD_NOT_VALID_LENGTH',
    message: 'Password length should be 8 chars',
    statusCode: 401,
  },
  PASSWORD_NOT_VALID_STRING: {
    code: 'PASSWORD_NOT_VALID_STRING',
    message: 'Password must contain one uppercase letter, one lowercase letter and one number.   Allowed special characters: -_!$%@#£€*?&',
    statusCode: 401,
  },
  MEMBER_CAN_REQUEST: {
    code: 'MEMBER_CAN_REQUEST',
    message: 'You can only request members that are in your loops',
    statusCode: 401,
  },
  ACCOUNT_EMAIL_CHANGE_INCOMPLETE: {
    code: 'ACCOUNT_EMAIL_CHANGE_INCOMPLETE',
    message: 'Account email change is not yet confirmed',
    statusCode: 401,
  },
  CHILD_NOT_ALLOWED_TO_CREATE: {
    code: 'CHILD_NOT_ALLOWED_TO_CREATE',
    message: 'Child is not allowed to create his own account.',
    statusCode: 403,
  },
  EMAIL_WAS_NOT_CHANGED: {
    code: 'EMAIL_WAS_NOT_CHANGED',
    message: 'Email was not changed',
    statusCode: 409,
  },
  PHONE_VERIFICATION_SERVICE_FAILED: {
    code: 'PHONE_VERIFICATION_SERVICE_FAILED',
    message: 'Verification message is not sent',
    statusCode: 503,
  },
  AUTHORIZED_UNDER_ADMIN,  ACCOUNT_ACTIVATED: {
    code: 'ACCOUNT_ACTIVATED',
    message: 'Account is already active',
    statusCode: 409,
  },
  ACTIVATION_CODE_NOT_FOUND: {
    code: 'ACTIVATION_CODE_NOT_FOUND',
    message: 'Activation code not found',
    statusCode: 404,
  },
  AUTHORIZED_UNDER_ADMIN: {
    code: 'AUTHORIZED_UNDER_ADMIN',
    message: 'Must be authorized under admin account',
    statusCode: 401,
  },
  PASSWORD_CODE_WRONG: {
    code: 'PASSWORD_CODE_WRONG',
    message: 'Password reset code is wrong',
    statusCode: 404,
  },
  OWNER_CAN_REMOVE: {
    code: 'OWNER_CAN_REMOVE',
    message: 'Owner can only remove accounts with no associated e-mail',
    statusCode: 401,
  },
  OWNER_CAN_MANIPULATE: {
    code: 'OWNER_CAN_MANIPULATE',
    message: 'Only owner can manipulate loop or members',
    statusCode: 401,
  },
  LOOPS_MUST_BE_SUSPENDED: {
    code: 'LOOPS_MUST_BE_SUSPENDED',
    message: 'All account loops must be suspended',
    statusCode: 409,
  },
});

export const TOKEN_ERRORS = Object.freeze({
  EMAIL_RESET_TOKEN_NOT_FOUND: {
    code: 'EMAIL_RESET_TOKEN_NOT_FOUND',
    message: 'Email reset token not found',
    statusCode: 404,
  },
  EMAIL_RESET_TOKEN_EXPIRED: {
    code: 'EMAIL_RESET_TOKEN_EXPIRED',
    message: 'Email reset token expired',
    statusCode: 409,
  },
  PHONE_TOKEN_NOT_FOUND: {
    code: 'TOKEN_NOT_FOUND',
    message: 'Token not found',
    statusCode: 404,
  },
  PHONE_TOKEN_EXPIRED: {
    code: 'PHONE_TOKEN_EXPIRED',
    message: 'Phone token expired',
    statusCode: 409,
  },
});

function fail(err) {
  const error = new Error(err.message);
  error.code = err.code;
  error.statusCode = err.statusCode;
  throw error;
}

function idsEqual(left, right) {
  if (left === undefined || left === null || right === undefined || right === null) return false;
  return String(left) === String(right);
}

/** srv-server Server.lowerMethodName: split('.')[1], lowercase only the first character. */
export function accountMethodName(target) {
  const methodName = String(target || '').split('.')[1];
  if (!methodName) return '';
  return methodName[0].toLowerCase() + methodName.substring(1);
}

/**
 * @jibo/server parseCredentials. Malformed JSON becomes {}. JSON null is
 * retained; later `.id` access is the source error path, not a substitution.
 */
export function parseInternalCredentials(req) {
  let credentials;
  try {
    credentials = JSON.parse(req?.headers?.['x-amz-credentials']);
  } catch {
    credentials = {};
  }
  return credentials;
}

/** utils/password.ts hash: pbkdf2 sha512$512$10000$salt$hash, 64-char hex salt. */
export function hashAccountPassword(password, saltLength = 64, iterations = 10000, keylen = 512, digest = 'sha512') {
  const salt = randomBytes(Math.ceil(saltLength / 2)).toString('hex').slice(0, saltLength);
  const currentHash = pbkdf2Sync(String(password), salt, iterations, keylen, digest).toString('hex');
  return `${digest}$${keylen}$${iterations}$${salt}$${currentHash}`;
}

/**
 * Source compare() for the pbkdf2 encoding, plus Phoenix portal scrypt hashes
 * so a portal-created fixture can still authenticate on this public face.
 */
export function compareAccountPassword(password, stored) {
  if (!stored) return false;
  if (String(stored).startsWith('scrypt:')) return verifyPassword(password, stored);
  const [digest, keylen, iterations, salt, hashPart] = String(stored).split('$');
  if (!digest || !keylen || !iterations || salt === undefined || hashPart === undefined) return false;
  const actual = pbkdf2Sync(
    String(password),
    salt,
    parseInt(iterations, 10),
    parseInt(keylen, 10),
    digest,
  ).toString('hex');
  const a = Buffer.from(actual);
  const b = Buffer.from(hashPart);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function asTime(value) {
  if (value == null) return 0;
  if (typeof value === 'number') return value;
  if (typeof value.getTime === 'function') return value.getTime();
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function dashlessUuid() {
  return randomUUID().replace(/-/g, '');
}

/** schemes/phoneVerification.ts getRandomCode: 6 digits from randomBytes(n) % 10. */
export function randomPhoneVerificationCode() {
  return Array.from(randomBytes(PHONE_VERIFICATION_CODE_SIZE), (byte) => byte % 10).join('');
}

export function normalizeIdentityProviders(input = undefined) {
  const options = input && typeof input === 'object' ? input : {};
  return {
    portalUrl: options.portalUrl === undefined ? '' : String(options.portalUrl),
    campaign: options.campaign && typeof options.campaign === 'object' ? options.campaign : {},
    emailReset: options.emailReset || null,
    emailResetComplete: options.emailResetComplete || null,
    sms: options.sms || options.smsProvider || null,
    onError: options.onError,
  };
}

export function createHttpSmsProvider({ url, timeoutMs = 5000, headers = {} } = {}) {
  if (!url) throw new Error('sms url is required');
  return {
    async send({ to, body }) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify({ to, body }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`sms provider HTTP ${response.status}`);
        return response;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function sendMethod(provider, args) {
  if (typeof provider === 'function') return provider(...args);
  if (provider && typeof provider.send === 'function') return provider.send(...args);
  return Promise.resolve(undefined);
}

function reportProviderFailure(providers, error, kind) {
  if (typeof providers?.onError !== 'function') return;
  try {
    providers.onError(error, kind);
  } catch {
    // Preserve the source fire-and-forget boundary.
  }
}

function observeMailRejection(result, onErrorOrProviders, kind) {
  // Two call-shapes reach this helper after the A-03 slices were merged: a bare
  // `onError` callback (activation / password-reset) and a providers object
  // carrying `.onError` (the invitation deployment seam). Dispatch on the type
  // rather than forcing one convention, because the call sites were written
  // independently against their own context shape.
  const onError = typeof onErrorOrProviders === 'function'
    ? onErrorOrProviders
    : onErrorOrProviders && onErrorOrProviders.onError;
  Promise.resolve(result).catch((error) => {
    if (typeof onError !== 'function') return;
    try {
      onError(error, kind);
    } catch {
      // Preserve the source fire-and-forget boundary even when a test logger is
      // deliberately faulty.
    }
  });
}

async function sendSms(provider, phoneNumber, message) {
  if (!provider) return;
  if (typeof provider.send === 'function') return provider.send({ to: phoneNumber, body: message });
  if (provider.messages && typeof provider.messages.create === 'function') {
    return provider.messages.create({ to: phoneNumber, body: message });
  }
}

function persistAccount(store, account, previous) {
  store.accounts.set(account._id, account);
  try {
    store.flush();
  } catch (error) {
    if (previous) store.accounts.set(previous._id, previous);
    else store.accounts.delete(account._id);
    throw error;
  }
  return account;
}

/**
 * escape-regexp@0.0.1 — a regex escape, not HTML escaping.
 * Source: `import escape = require("escape-regexp")`.
 */
export function escapeRegexp(str) {
  return String(str).replace(/([.*+?=^!:${}()|[\]\/\\])/g, '\\$1');
}

function fieldMatches(value, regex) {
  if (value == null) return false;
  return regex.test(String(value));
}

function snapshotAccount(account) {
  return account ? JSON.parse(JSON.stringify(account)) : null;
}

/**
 * schemes/account.ts toJSON transform. unsafe Create/Login keep access keys;
 * Get/Update/ChangePassword omit them. password/activation/reset codes never
 * leave. created is deleted. _id is retained and copied to id.
 */
export function accountToSourceJson(account, { unsafe = false } = {}) {
  if (!account) return null;
  const ret = {};
  if (unsafe && account.accessKeyId !== undefined) ret.accessKeyId = account.accessKeyId;
  if (account.birthday != null && account.birthday !== '') {
    ret.birthday = new Date(account.birthday).getTime();
  }
  if (account.email !== undefined) ret.email = account.email;
  if (account.firstName !== undefined) ret.firstName = account.firstName;
  if (account.friendlyId !== undefined && account.friendlyId !== null) ret.friendlyId = account.friendlyId;
  if (account.gender !== undefined) ret.gender = account.gender;
  ret.isActive = !!account.isActive;
  ret.isAdmin = !!account.isAdmin;
  ret.isDeleted = !!account.isDeleted;
  if (account.lastName !== undefined) ret.lastName = account.lastName;
  ret.messagingAllowed = account.messagingAllowed === undefined ? true : !!account.messagingAllowed;
  if (account.phoneNumber !== undefined) ret.phoneNumber = account.phoneNumber;
  if (account.photoUrl !== undefined) ret.photoUrl = account.photoUrl;
  ret.roles = Array.isArray(account.roles) ? account.roles : ['user'];
  if (unsafe && account.secretAccessKey !== undefined) ret.secretAccessKey = account.secretAccessKey;
  if (account.termsAccepted != null && account.termsAccepted !== '') {
    ret.termsAccepted = new Date(account.termsAccepted).getTime();
  }
  if (account.updated !== undefined) ret.updated = account.updated;
  ret._id = account._id;
  ret.id = account._id;
  ret.facebookConnected = !!account.facebookAccessToken;
  return ret;
}

function requiredChild(field, detail) {
  return `child "${field}" fails because ["${field}" ${detail}]`;
}

function isObjectPayload(body) {
  return body !== null && typeof body === 'object' && !Array.isArray(body);
}

function joiString(value, field, { required = false } = {}) {
  if (value === undefined) {
    return required ? requiredChild(field, 'is required') : null;
  }
  if (typeof value !== 'string') return requiredChild(field, 'must be a string');
  if (value.length === 0) return requiredChild(field, 'is not allowed to be empty');
  return null;
}

function joiEmail(value, { minDomainAtoms = 2 } = {}) {
  if (typeof value !== 'string' || value.length === 0) return false;
  const at = value.lastIndexOf('@');
  if (at < 1) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (!local || !domain || /\s/.test(value)) return false;
  const atoms = domain.split('.');
  if (atoms.length < minDomainAtoms) return false;
  return atoms.every((atom) => atom.length > 0);
}

function joiEmailString(value, field, { required = false } = {}) {
  const typeError = joiString(value, field, { required });
  if (typeError) return typeError;
  if (value === undefined) return null;
  if (!joiEmail(value)) return requiredChild(field, 'must be a valid email');
  return null;
}

function joiRequiredAny(value, field) {
  if (value === undefined || value === null) return requiredChild(field, 'is required');
  return null;
}

function joiBoolean(value, field) {
  if (value === undefined) return null;
  if (value === true || value === false) return null;
  if (value === 0 || value === 1) return null;
  if (value === 'true' || value === 'false' || value === 'yes' || value === 'no'
    || value === 'on' || value === 'off' || value === '0' || value === '1') {
    return null;
  }
  return requiredChild(field, 'must be a boolean');
}

function joiNumber(value, field, { allowNull = false } = {}) {
  if (value === undefined) return null;
  if (allowNull && value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return null;
  if (typeof value === 'string' && value.length && Number.isFinite(Number(value))) return null;
  return requiredChild(field, 'must be a number');
}

function joiDate(value, field, { allowNull = false } = {}) {
  if (value === undefined) return null;
  if (allowNull && value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return null;
  if (typeof value.getTime === 'function' && Number.isFinite(value.getTime())) return null;
  if (typeof value === 'string' && value.length && Number.isFinite(new Date(value).getTime())) return null;
  return requiredChild(field, 'must be a valid date');
}

function payloadObjectMessage(body) {
  if (!isObjectPayload(body)) return '"value" must be an object';
  return null;
}

function validateCreate(body) {
  const top = payloadObjectMessage(body);
  if (top) return top;
  const emailReq = joiRequiredAny(body.email, 'email');
  if (emailReq) return emailReq;
  const passwordReq = joiRequiredAny(body.password, 'password');
  if (passwordReq) return passwordReq;
  if (body.birthday !== undefined) {
    const birthday = joiNumber(body.birthday, 'birthday', { allowNull: true });
    if (birthday) return birthday;
  }
  if (body.campaign !== undefined) {
    const campaign = joiString(body.campaign, 'campaign');
    if (campaign) return campaign;
  }
  if (body.firstName !== undefined) {
    const firstName = joiString(body.firstName, 'firstName');
    if (firstName) return firstName;
  }
  if (body.gender !== undefined) {
    if (typeof body.gender !== 'string' || !GENDERS.includes(body.gender)) {
      return requiredChild('gender', `must be one of [${GENDERS.join(', ')}]`);
    }
  }
  if (body.invitationCode !== undefined) {
    const invitationCode = joiString(body.invitationCode, 'invitationCode');
    if (invitationCode) return invitationCode;
  }
  if (body.lastName !== undefined) {
    const lastName = joiString(body.lastName, 'lastName');
    if (lastName) return lastName;
  }
  if (body.messagingAllowed !== undefined) {
    const messaging = joiBoolean(body.messagingAllowed, 'messagingAllowed');
    if (messaging) return messaging;
  }
  if (body.roles !== undefined) {
    if (!Array.isArray(body.roles)) return requiredChild('roles', 'must be an array');
    for (let i = 0; i < body.roles.length; i += 1) {
      const role = body.roles[i];
      if (typeof role !== 'string' || !ROLES.includes(role)) {
        return `child "roles" fails because ["roles" at position ${i} fails because ["${i}" must be one of [${ROLES.join(', ')}]]]`;
      }
    }
  }
  if (body.termsAccepted !== undefined) {
    const terms = joiNumber(body.termsAccepted, 'termsAccepted');
    if (terms) return terms;
  }
  return null;
}

function validateLogin(body) {
  const top = payloadObjectMessage(body);
  if (top) return top;
  const email = joiEmailString(body.email, 'email', { required: true });
  if (email) return email;
  return joiString(body.password, 'password', { required: true });
}

function validateCheckEmail(body) {
  const top = payloadObjectMessage(body);
  if (top) return top;
  return joiEmailString(body.email, 'email', { required: true });
}

function validateGet(body) {
  const top = payloadObjectMessage(body);
  if (top) return top;
  if (body.ids === undefined) return null;
  if (!Array.isArray(body.ids)) return requiredChild('ids', 'must be an array');
  for (let i = 0; i < body.ids.length; i += 1) {
    if (typeof body.ids[i] !== 'string') {
      return `child "ids" fails because ["ids" at position ${i} fails because ["${i}" must be a string]]`;
    }
    if (body.ids[i].length === 0) {
      return `child "ids" fails because ["ids" at position ${i} fails because ["${i}" is not allowed to be empty]]`;
    }
  }
  return null;
}

function validateUpdate(body) {
  const top = payloadObjectMessage(body);
  if (top) return top;
  if (body.birthday !== undefined) {
    const birthday = joiNumber(body.birthday, 'birthday', { allowNull: true });
    if (birthday) return birthday;
  }
  if (body.email !== undefined) {
    const email = joiString(body.email, 'email');
    if (email) return email;
  }
  if (body.firstName !== undefined) {
    const firstName = joiString(body.firstName, 'firstName');
    if (firstName) return firstName;
  }
  if (body.gender !== undefined) {
    if (typeof body.gender !== 'string' || !GENDERS.includes(body.gender)) {
      return requiredChild('gender', `must be one of [${GENDERS.join(', ')}]`);
    }
  }
  if (body.lastName !== undefined) {
    const lastName = joiString(body.lastName, 'lastName');
    if (lastName) return lastName;
  }
  if (body.messagingAllowed !== undefined) {
    const messaging = joiBoolean(body.messagingAllowed, 'messagingAllowed');
    if (messaging) return messaging;
  }
  if (body.password !== undefined) {
    const password = joiString(body.password, 'password');
    if (password) return password;
  }
  if (body.updated !== undefined) {
    const updated = joiDate(body.updated, 'updated', { allowNull: true });
    if (updated) return updated;
  }
  return null;
}

function validateChangePassword(body) {
  const top = payloadObjectMessage(body);
  if (top) return top;
  const next = joiRequiredAny(body.newPassword, 'newPassword');
  if (next) return next;
  return joiString(body.oldPassword, 'oldPassword', { required: true });
}

function validateChangeEmail(body) {
  const top = payloadObjectMessage(body);
  if (top) return top;
  if (body.campaign !== undefined) {
    const campaign = joiString(body.campaign, 'campaign');
    if (campaign) return campaign;
  }
  const email = joiEmailString(body.email, 'email', { required: true });
  if (email) return email;
  return joiString(body.password, 'password', { required: true });
}

function validateResetEmail(body) {
  const top = payloadObjectMessage(body);
  if (top) return top;
  if (body.campaign !== undefined) {
    const campaign = joiString(body.campaign, 'campaign');
    if (campaign) return campaign;
  }
  const email = joiEmailString(body.email, 'email', { required: true });
  if (email) return email;
  return joiString(body.id, 'id', { required: true });
}

function validateConfirmEmailReset(body) {
  const top = payloadObjectMessage(body);
  if (top) return top;
  return joiString(body.code, 'code', { required: true });
}

function validateSendPhoneVerificationCode(body) {
  const top = payloadObjectMessage(body);
  if (top) return top;
  return joiString(body.phoneNumber, 'phoneNumber', { required: true });
}

function validateVerifyPhoneByCode(body) {
  const top = payloadObjectMessage(body);
  if (top) return top;
  return joiString(body.code, 'code', { required: true });
}

function validateAcceptTerms() {
  return null;
}

function loopIsVisibleTo(loop, ownerId) {
  if (!loop || loop.isDeleted === true) return false;
  if (idsEqual(loop.owner, ownerId)) return true;
  return (loop.members || []).some((member) => idsEqual(member.accountId, ownerId)
    && (isAcceptedStatus(member.status) || String(member.status || '').toLowerCase() === 'invited'));
}

/** AccountController.checkIdsBelongToOwnerLoops via listMembers({ statusList: ACCEPTED }). */
export function checkIdsBelongToOwnerLoops(store, { ownerId, ids }) {
  const memberIds = new Set([String(ownerId)]);
  for (const loop of store.loops.values()) {
    if (!loopIsVisibleTo(loop, ownerId)) continue;
    for (const member of loop.members || []) {
      if (member.accountId && isAcceptedStatus(member.status)) {
        memberIds.add(String(member.accountId));
      }
    }
  }
  if (!ids.every((id) => memberIds.has(String(id)))) fail(ACCOUNT_ERRORS.MEMBER_CAN_REQUEST);
}

function findById(store, accountId) {
  const account = store.accounts.get(accountId);
  if (!account) fail(ACCOUNT_ERRORS.ACCOUNT_NOT_FOUND);
  if (account.isDeleted) fail(ACCOUNT_ERRORS.ACCOUNT_IS_DELETED);
  return account;
}

function findByEmail(store, email) {
  const account = store.accountByEmail(email);
  if (account && account.isDeleted) fail(ACCOUNT_ERRORS.ACCOUNT_IS_DELETED);
  if (account) return account;
  const pending = [...(store.emailResets ? store.emailResets.values() : [])]
    .find((row) => row.email === email && row.status === EMAIL_RESET_NEW);
  if (pending) fail(ACCOUNT_ERRORS.ACCOUNT_EMAIL_CHANGE_INCOMPLETE);
  fail(ACCOUNT_ERRORS.ACCOUNT_NOT_FOUND);
}

function childAge(birthday) {
  const ageDate = new Date(Date.now() - new Date(birthday).getTime());
  return Math.abs(ageDate.getUTCFullYear() - 1970);
}

function applyInvitation(store, account, invitationCode) {
  if (!invitationCode) return;
  for (const loop of store.loops.values()) {
    const membership = (loop.members || []).find((member) => member.invitationCode === invitationCode);
    if (!membership) continue;
    if (account._id) membership.accountId = account._id;
    if (account.email && membership.memberProperties && account.email === membership.memberProperties.email) {
      account.isActive = true;
    }
    const properties = membership.memberProperties || {};
    for (const propertyName of ['firstName', 'lastName', 'phoneticName', 'gender', 'birthday']) {
      account[propertyName] = account[propertyName] || properties[propertyName];
    }
    store.loops.set(loop._id, loop);
    return;
  }
  throw new Error('invitationCode did not match a loop member');
}

function updateInvitationsByEmail(store, { email, accountId }) {
  for (const loop of store.loops.values()) {
    const member = (loop.members || []).find((item) => item.memberProperties && item.memberProperties.email === email);
    if (!member) continue;
    member.accountId = accountId;
    store.loops.set(loop._id, loop);
    return;
  }
}

function saveActivationCode(store, account) {
  const previous = snapshotAccount(account);
  account.activationCode = dashlessUuid();
  account.updated = Date.now();
  persistAccount(store, account, previous);
}

function createAccount(store, payload, mail) {
  if (payload.birthday) {
    if (childAge(payload.birthday) < ACCOUNT_MINIMAL_AGE) fail(ACCOUNT_ERRORS.CHILD_NOT_ALLOWED_TO_CREATE);
  }
  const existing = store.accountByEmail(payload.email);
  let removed = null;
  if (existing) {
    if (!existing.isDeleted) fail(ACCOUNT_ERRORS.EMAIL_ALREADY_EXISTS);
    removed = snapshotAccount(existing);
    store.accounts.delete(existing._id);
  }
  const loopsBefore = [...store.loops.values()].map((loop) => snapshotAccount(loop));
  const account = {
    _id: newId(),
    email: payload.email,
    password: hashAccountPassword(payload.password),
    firstName: payload.firstName,
    lastName: payload.lastName,
    gender: payload.gender,
    birthday: payload.birthday == null ? undefined : payload.birthday,
    messagingAllowed: payload.messagingAllowed === undefined ? true : payload.messagingAllowed,
    roles: Array.isArray(payload.roles) ? payload.roles : ['user'],
    termsAccepted: payload.termsAccepted,
    friendlyId: undefined,
    isActive: false,
    isAdmin: false,
    isDeleted: false,
    ...fillAccessKeys(),
    created: Date.now(),
    updated: Date.now(),
  };
  try {
    applyInvitation(store, account, payload.invitationCode);
    persistAccount(store, account, null);
    if (!account.isActive) sendActivation(store, account, payload.campaign, mail);
    updateInvitationsByEmail(store, { email: account.email, accountId: account._id });
    store.flush();
  } catch (error) {
    store.accounts.delete(account._id);
    if (removed) store.accounts.set(removed._id, removed);
    store.loops.clear();
    for (const loop of loopsBefore) store.loops.set(loop._id, loop);
    throw error;
  }
  return account;
}

function loginAccount(store, email, password) {
  const account = findByEmail(store, email);
  if (!compareAccountPassword(password, account.password)) fail(ACCOUNT_ERRORS.WRONG_PASSWORD);
  return account;
}

function getAccounts(store, { ownerId, isAdmin, ids }) {
  if (!isAdmin) checkIdsBelongToOwnerLoops(store, { ownerId, ids });
  const wanted = new Set(ids.map(String));
  const result = [];
  for (const account of store.accounts.values()) {
    if (wanted.has(String(account._id)) && account.isDeleted !== true) result.push(account);
  }
  return result;
}

function updateAccount(store, ownerId, payload) {
  const existing = findById(store, ownerId);
  if (existing.friendlyId) fail(ACCOUNT_ERRORS.ROBOT_CANNOT_BE_UPDATED);
  if (payload.updated && asTime(existing.updated) > asTime(payload.updated)) {
    fail(ACCOUNT_ERRORS.STALE_VERSION);
  }
  const previous = snapshotAccount(existing);
  const next = { ...existing };
  for (const prop of Object.keys(payload)) {
    if (!Array.isArray(next[prop]) && EXCLUDED_UPDATE_PROPS.indexOf(prop) === -1) {
      next[prop] = payload[prop];
    }
  }
  next.updated = Date.now();
  persistAccount(store, next, previous);
  return next;
}

function checkEmail(store, email) {
  const account = store.accountByEmail(email);
  return { exists: !!account && !account.isDeleted };
}

function changePassword(store, { id, oldPassword, newPassword }) {
  const account = findById(store, id);
  if (!compareAccountPassword(oldPassword, account.password)) fail(ACCOUNT_ERRORS.WRONG_PASSWORD);
  const previous = snapshotAccount(account);
  const next = { ...account, password: hashAccountPassword(newPassword), updated: Date.now() };
  persistAccount(store, next, previous);
  return next;
}

function emailResetUrl(providers, { campaign, email, originalEmail, code }) {
  const campaignUrl = campaign && providers.campaign && providers.campaign[campaign]
    ? providers.campaign[campaign].emailReset
    : null;
  const baseUrl = campaignUrl || `${providers.portalUrl || ''}/confirmemailreset`;
  return `${baseUrl}?${querystring.stringify({ email, originalEmail, code })}`;
}

function sendResetEmail(providers, { email, originalEmail, code, campaign }) {
  const url = emailResetUrl(providers, { campaign, email, originalEmail, code });
  observeMailRejection(
    sendMethod(providers.emailReset, [email, { url, email, originalEmail }]),
    providers,
    'email-reset',
  );
  observeMailRejection(
    sendMethod(providers.emailResetComplete, [originalEmail, { newEmailAddress: email, originalEmail }]),
    providers,
    'email-reset-complete',
  );
}

function resetAccessKeys(store, accountId) {
  const account = findById(store, accountId);
  const previous = snapshotAccount(account);
  const next = { ...account, ...fillAccessKeys(), updated: Date.now() };
  persistAccount(store, next, previous);
  return next;
}

function persistEmailReset(store, row, previous) {
  store.emailResets.set(row._id, row);
  try {
    store.flush();
  } catch (error) {
    if (previous) store.emailResets.set(previous._id, previous);
    else store.emailResets.delete(row._id);
    throw error;
  }
  return row;
}

function resetEmail(store, accountId, email, campaign, providers) {
  const account = findById(store, accountId);
  if (account.email === email) fail(ACCOUNT_ERRORS.EMAIL_WAS_NOT_CHANGED);
  const existingAccount = [...store.accounts.values()].find((row) => row.email === email);
  const previousExisting = existingAccount ? snapshotAccount(existingAccount) : null;
  if (existingAccount) {
    if (!existingAccount.isDeleted) fail(ACCOUNT_ERRORS.EMAIL_ALREADY_EXISTS);
    existingAccount.email = `${email}-reused-by-${account._id}`;
    existingAccount.updated = Date.now();
    store.accounts.set(existingAccount._id, existingAccount);
  }
  const emailReset = {
    _id: newId(),
    accountId,
    code: randomUUID(),
    created: Date.now(),
    email: String(email).toLowerCase(),
    originalEmail: account.email,
    status: EMAIL_RESET_NEW,
  };
  try {
    persistEmailReset(store, emailReset, null);
  } catch (error) {
    if (previousExisting) store.accounts.set(previousExisting._id, previousExisting);
    throw error;
  }
  sendResetEmail(providers, {
    campaign,
    code: emailReset.code,
    email: emailReset.email,
    originalEmail: emailReset.originalEmail,
  });
  return { id: emailReset._id };
}

function changeEmail(store, { id, password, email, campaign }, providers) {
  const account = findById(store, id);
  if (!compareAccountPassword(password, account.password)) fail(ACCOUNT_ERRORS.WRONG_PASSWORD);
  return resetEmail(store, id, email, campaign, providers);
}

function confirmEmailReset(store, code) {
  const emailReset = [...store.emailResets.values()].find((row) => row.code === code);
  if (!emailReset) fail(TOKEN_ERRORS.EMAIL_RESET_TOKEN_NOT_FOUND);
  if (emailReset.status !== EMAIL_RESET_NEW) fail(TOKEN_ERRORS.EMAIL_RESET_TOKEN_EXPIRED);
  const tokenAge = Date.now() - asTime(emailReset.created);
  if (tokenAge > EMAIL_RESET_TTL_MS) fail(TOKEN_ERRORS.EMAIL_RESET_TOKEN_EXPIRED);
  const account = findById(store, emailReset.accountId);
  const previousAccount = snapshotAccount(account);
  const previousResets = [...store.emailResets.values()].map((row) => snapshotAccount(row));
  const next = { ...account, email: emailReset.email, updated: Date.now() };
  persistAccount(store, next, previousAccount);
  resetAccessKeys(store, next._id);
  for (const request of store.emailResets.values()) {
    if (!idsEqual(request.accountId, emailReset.accountId)) continue;
    request.status = idsEqual(request._id, emailReset._id)
      ? EMAIL_RESET_STATUS.USED
      : EMAIL_RESET_STATUS.CANCELED;
    store.emailResets.set(request._id, request);
  }
  try {
    store.flush();
  } catch (error) {
    store.accounts.set(previousAccount._id, previousAccount);
    store.emailResets.clear();
    for (const row of previousResets) store.emailResets.set(row._id, row);
    throw error;
  }
}

async function sendPhoneVerificationCode(store, accountId, phoneNumber, providers) {
  const phoneVerification = {
    _id: newId(),
    accountId,
    code: randomPhoneVerificationCode(),
    created: Date.now(),
    phoneNumber,
  };
  store.phoneVerifications.set(phoneVerification._id, phoneVerification);
  try {
    store.flush();
  } catch (error) {
    store.phoneVerifications.delete(phoneVerification._id);
    throw error;
  }
  try {
    await sendSms(providers.sms, phoneNumber, `Jibo verification code: ${phoneVerification.code}`);
  } catch (error) {
    reportProviderFailure(providers, error, 'phone-verification-sms');
    fail(ACCOUNT_ERRORS.PHONE_VERIFICATION_SERVICE_FAILED);
  }
  return { id: phoneVerification._id };
}

function phoneVerificationsFor(store, accountId) {
  return [...store.phoneVerifications.values()].filter((row) => idsEqual(row.accountId, accountId));
}

function verifyPhoneByCode(store, accountId, code) {
  const account = findById(store, accountId);
  const matches = phoneVerificationsFor(store, accountId).filter((row) => row.code === code);
  const phoneVerification = matches[0];
  if (!phoneVerification) fail(TOKEN_ERRORS.PHONE_TOKEN_NOT_FOUND);
  const latest = phoneVerificationsFor(store, accountId)
    .slice()
    .sort((left, right) => asTime(right.created) - asTime(left.created))[0];
  if (!idsEqual(phoneVerification._id, latest._id)) fail(TOKEN_ERRORS.PHONE_TOKEN_EXPIRED);
  const codeLifetime = Date.now() - asTime(phoneVerification.created);
  if (codeLifetime > PHONE_VERIFICATION_CODE_LIFETIME_MS) fail(TOKEN_ERRORS.PHONE_TOKEN_EXPIRED);
  const previousAccount = snapshotAccount(account);
  const previousVerifications = phoneVerificationsFor(store, accountId).map((row) => snapshotAccount(row));
  const next = { ...account, phoneNumber: phoneVerification.phoneNumber, updated: Date.now() };
  for (const row of previousVerifications) store.phoneVerifications.delete(row._id);
  try {
    persistAccount(store, next, previousAccount);
  } catch (error) {
    for (const row of previousVerifications) store.phoneVerifications.set(row._id, row);
    throw error;
  }
  return next;
}

function acceptTerms(store, accountId) {
  const account = findById(store, accountId);
  const previous = snapshotAccount(account);
  const next = { ...account, termsAccepted: Date.now(), updated: Date.now() };
  persistAccount(store, next, previous);
  return next;
}

function authenticatePublicAccount({ store, req, body, target, auth }) {
  const authorization = req.headers && req.headers.authorization;
  if (auth === 'none' && !authorization && ACCOUNT_ANONYMOUS_TARGETS.includes(target)) {
    return { credentials: null };
  }
  try {
    const verification = verifySigV4({
      method: req.method,
      path: req.originalUrl || req.url || '/',
      headers: req.headers,
      body: req.rawBody === undefined
        ? (body === null || body === undefined ? '' : JSON.stringify(body))
        : req.rawBody,
      resolveCredentials: (accessKeyId) => {
        const account = store.accountByAccessKeyId(accessKeyId);
        if (!account || account.isDeleted === true) return null;
        // verifySigV4 always rejects !isActive. Gateway unactiveMethods lets
        // Remove through; present a live flag only for that verifier check.
        if (!account.isActive && ACCOUNT_UNACTIVE_TARGETS.includes(target)) {
          return { ...account, isActive: true };
        }
        return account;
      },
    });
    req._phoenixVerifiedCredentials = verification.credentials;
    return { credentials: verification.credentials };
  } catch (error) {
    if (error instanceof SigV4Error && SIGV4_ERRORS[error.code]) return { error: SIGV4_ERRORS[error.code] };
    throw error;
  }
}

const OPS = {
  create: {
    auth: 'none',
    validate: validateCreate,
    run({ store, body, mail }) {
      if (!joiEmail(body.email)) fail(ACCOUNT_ERRORS.EMAIL_NOT_VALID);
      if (String(body.password).length < 8) fail(ACCOUNT_ERRORS.PASSWORD_NOT_VALID_LENGTH);
      if (!ACCOUNT_PASSWORD_REGEX.test(String(body.password))) fail(ACCOUNT_ERRORS.PASSWORD_NOT_VALID_STRING);
      const payload = { ...body, email: String(body.email).toLowerCase() };
      return { value: accountToSourceJson(createAccount(store, payload, mail), { unsafe: true }) };
    },
  },
  login: {
    auth: 'none',
    validate: validateLogin,
    run({ store, body }) {
      return {
        value: accountToSourceJson(loginAccount(store, String(body.email).toLowerCase(), body.password), { unsafe: true }),
      };
    },
  },
  get: {
    auth: 'parseCredentials',
    validate: validateGet,
    run({ store, body, credentials }) {
      const ids = body.ids && body.ids.length ? body.ids : [credentials._id];
      const accounts = getAccounts(store, {
        ownerId: credentials._id,
        isAdmin: !!credentials.isAdmin,
        ids,
      });
      return { value: accounts.map((account) => accountToSourceJson(account, { unsafe: false })) };
    },
  },
  update: {
    auth: 'parseCredentials',
    validate: validateUpdate,
    run({ store, body, credentials }) {
      const payload = { ...body };
      if (payload.email) payload.email = payload.email.toLowerCase();
      return { value: accountToSourceJson(updateAccount(store, credentials._id, payload), { unsafe: false }) };
    },
  },
  checkEmail: {
    auth: 'none',
    validate: validateCheckEmail,
    run({ store, body }) {
      return { value: checkEmail(store, String(body.email).toLowerCase()) };
    },
  },
  changePassword: {
    auth: 'parseCredentials',
    validate: validateChangePassword,
    run({ store, body, credentials }) {
      if (!ACCOUNT_PASSWORD_REGEX.test(String(body.newPassword))) fail(ACCOUNT_ERRORS.PASSWORD_NOT_VALID_STRING);
      return {
        value: accountToSourceJson(changePassword(store, {
          id: credentials._id,
          newPassword: body.newPassword,
          oldPassword: body.oldPassword,
        }), { unsafe: false }),
      };
    },
  },
  changeEmail: {
    auth: 'parseCredentials',
    validate: validateChangeEmail,
    run({ store, body, credentials, providers }) {
      return {
        value: changeEmail(store, {
          campaign: body.campaign,
          email: String(body.email).toLowerCase(),
          id: credentials._id,
          password: body.password,
        }, providers),
      };
    },
  },
  resetEmail: {
    auth: 'parseCredentials',
    adminOnly: true,
    validate: validateResetEmail,
    run({ store, body, providers }) {
      return {
        value: resetEmail(store, body.id, body.email, body.campaign, providers),
      };
    },
  },
  confirmEmailReset: {
    auth: 'none',
    validate: validateConfirmEmailReset,
    run({ store, body }) {
      confirmEmailReset(store, body.code);
      return { empty: true };
    },
  },
  sendPhoneVerificationCode: {
    auth: 'parseCredentials',
    validate: validateSendPhoneVerificationCode,
    async run({ store, body, credentials, providers }) {
      return {
        value: await sendPhoneVerificationCode(store, credentials._id, body.phoneNumber, providers),
      };
    },
  },
  verifyPhoneByCode: {
    auth: 'parseCredentials',
    validate: validateVerifyPhoneByCode,
    run({ store, body, credentials }) {
      return {
        value: accountToSourceJson(verifyPhoneByCode(store, credentials._id, body.code), { unsafe: false }),
      };
    },
  },
  acceptTerms: {
    auth: 'parseCredentials',
    validate: validateAcceptTerms,
    run({ store, credentials }) {
      return {
        value: accountToSourceJson(acceptTerms(store, credentials._id), { unsafe: false }),
      };
    },
  },
  activateByCode: {
    auth: 'none',
    validate: validateActivateByCode,
    run({ store, body }) {
      return { value: accountToSourceJson(activateByCode(store, body.code), { unsafe: true }) };
    },
  },
  activateById: {
    auth: 'parseCredentials',
    adminOnly: true,
    validate: validateActivateById,
    run({ store, body }) {
      return { value: accountToSourceJson(activateById(store, body.id), { unsafe: false }) };
    },
  },
  passwordResetByCode: {
    auth: 'none',
    validate: validatePasswordResetByCode,
    run({ store, body }) {
      if (!ACCOUNT_PASSWORD_REGEX.test(String(body.password))) fail(ACCOUNT_ERRORS.PASSWORD_NOT_VALID_STRING);
      return {
        value: accountToSourceJson(passwordReset(store, body.code, body.password), { unsafe: true }),
      };
    },
  },
  resendActivationCode: {
    auth: 'none',
    validate: validateResendActivationCode,
    run({ store, body, mail }) {
      return {
        value: accountToSourceJson(
          resendActivation(store, String(body.email).toLowerCase(), body.campaign, mail),
          { unsafe: false },
        ),
      };
    },
  },
  sendPasswordReset: {
    auth: 'none',
    validate: validateSendPasswordReset,
    run({ store, body, mail }) {
      if (!joiEmail(body.email)) fail(ACCOUNT_ERRORS.EMAIL_NOT_VALID);
      return {
        value: accountToSourceJson(
          sendPasswordReset(store, String(body.email).toLowerCase(), body.campaign, mail),
          { unsafe: false },
        ),
      };
    },
  },
  // Handler Search has no @parseCredentials, but it is NOT in gateway
  // unauthorizedMethods. Unsigned requests 401; a verified signature is
  // unused by the controller. Results use the safe toJSON projection
  // (handler does not call toJSON({ unsafe: true })).
  search: {
    auth: 'none',
    validate: validateSearch,
    run({ store, body }) {
      return {
        value: searchAccounts(store, body.query).map((account) => accountToSourceJson(account, { unsafe: false })),
      };
    },
  },
  remove: {
    auth: 'parseCredentials',
    validate: validateRemove,
    run({ store, body, credentials, loopUpdatedOutbox }) {
      return {
        value: accountToSourceJson(
          removeById(store, credentials._id, body.id, loopUpdatedOutbox),
          { unsafe: false },
        ),
      };
    },
  },
};

function resolveMailContext(mailProviders, loopConfig) {
  const providers = mailProviders || {};
  const server = (loopConfig && loopConfig.server) || {};
  const portalUrl = providers.portalUrl
    ? String(providers.portalUrl)
    : (server.portalUrl === undefined ? '' : String(server.portalUrl));
  return {
    activation: providers.activation || providers.mailActivation || null,
    passwordReset: providers.passwordReset || providers.mailPasswordReset || null,
    onError: providers.onError,
    portalUrl,
    campaign: providers.campaign || (loopConfig && loopConfig.campaign) || {},
  };
}

export async function handleAccountIdentity({ store, req, res, body, log, mailProviders, loopConfig, identityProviders, loopUpdatedOutbox }) {
  const target = String(req.headers && req.headers['x-amz-target'] || '');
  const methodName = accountMethodName(target);
  const spec = OPS[methodName];
  if (!spec) return false;
  try {
    const auth = authenticatePublicAccount({ store, req, body, target, auth: spec.auth });
    if (auth.error) return void sendAmzError(res, auth.error);
    if (spec.adminOnly && !(auth.credentials && auth.credentials.isAdmin)) {
      return void sendAmzError(res, AUTHORIZED_UNDER_ADMIN);
    }
    const validation = spec.validate(body);
    if (validation) return void sendValidationError(res, validation);
    // Two provider shapes reach this handler and both must be threaded:
    // `mail` (activation / password-reset SMTP) and `providers` (email-reset
    // and SMS). The base branch supplied only one; omitting `mail` silently
    // disabled activation and password-reset mail.
    const mail = resolveMailContext(mailProviders, loopConfig);
    const result = await spec.run({
      store,
      body,
      credentials: auth.credentials,
      req,
      mail,
      providers: normalizeIdentityProviders(identityProviders),
      loopUpdatedOutbox,
    });
    log.info('account identity', { op: methodName });
    if (result && result.empty) return void sendAmzEmpty(res);
    return void sendAmz(res, 200, result.value);
  } catch (error) {
    if (error && error.code && error.statusCode) return void sendAmzError(res, error);
    throw error;
  }
}

function activateByCode(store, activationCode) {
  if (!activationCode) fail(ACCOUNT_ERRORS.ACTIVATION_CODE_NOT_FOUND);
  const account = [...store.accounts.values()].find((row) => row.activationCode === activationCode);
  if (!account) fail(ACCOUNT_ERRORS.ACTIVATION_CODE_NOT_FOUND);
  return activateById(store, account._id);
}

function activateById(store, accountId) {
  const account = findById(store, accountId);
  if (account.isActive) fail(ACCOUNT_ERRORS.ACCOUNT_ACTIVATED);
  const previous = snapshotAccount(account);
  delete account.activationCode;
  account.isActive = true;
  account.updated = Date.now();
  persistAccount(store, account, previous);
  return account;
}

function sendPasswordReset(store, email, campaign, mail) {
  const account = findByEmail(store, email);
  const previous = snapshotAccount(account);
  account.passwordResetCode = dashlessUuid();
  account.updated = Date.now();
  const context = mail || {};
  const url = campaignLandingUrl(
    context,
    campaign,
    'resetPassword',
    '/reset',
    { email: account.email, code: account.passwordResetCode },
  );
  observeMailRejection(sendMethod(context.passwordReset, [account.email, {
    email,
    firstName: account.firstName || 'There',
    url,
  }]), context.onError, 'password-reset-mail');
  persistAccount(store, account, previous);
  return account;
}

function campaignLandingUrl(mail, campaign, kind, fallbackPath, query) {
  const mapped = campaign && mail.campaign && mail.campaign[campaign] && mail.campaign[campaign][kind];
  const baseUrl = mapped || `${mail.portalUrl || ''}${fallbackPath}`;
  return `${baseUrl}?${querystring.stringify(query)}`;
}

function passwordReset(store, code, password) {
  if (!code) fail(ACCOUNT_ERRORS.PASSWORD_CODE_WRONG);
  const account = [...store.accounts.values()].find((row) => row.passwordResetCode === code);
  if (!account) fail(ACCOUNT_ERRORS.PASSWORD_CODE_WRONG);
  const previous = snapshotAccount(account);
  account.password = hashAccountPassword(password);
  delete account.passwordResetCode;
  account.isActive = true;
  account.updated = Date.now();
  persistAccount(store, account, previous);
  return account;
}

function resendActivation(store, email, campaign, mail) {
  const account = findByEmail(store, email);
  return sendActivation(store, account, campaign, mail);
}

function validateActivateByCode(body) {
  const top = payloadObjectMessage(body);
  if (top) return top;
  return joiString(body.code, 'code', { required: true });
}

function validateActivateById(body) {
  const top = payloadObjectMessage(body);
  if (top) return top;
  return joiString(body.id, 'id', { required: true });
}

function validatePasswordResetByCode(body) {
  const top = payloadObjectMessage(body);
  if (top) return top;
  const code = joiString(body.code, 'code', { required: true });
  if (code) return code;
  return joiRequiredAny(body.password, 'password');
}

function validateResendActivationCode(body) {
  const top = payloadObjectMessage(body);
  if (top) return top;
  const email = joiEmailString(body.email, 'email', { required: true });
  if (email) return email;
  if (body.campaign !== undefined) return joiString(body.campaign, 'campaign');
  return null;
}

function validateSendPasswordReset(body) {
  const top = payloadObjectMessage(body);
  if (top) return top;
  const email = joiRequiredAny(body.email, 'email');
  if (email) return email;
  if (body.campaign !== undefined) return joiString(body.campaign, 'campaign');
  return null;
}

function validateSearch(body) {
  const top = payloadObjectMessage(body);
  if (top) return top;
  return joiString(body.query, 'query', { required: true });
}

function validateRemove(body) {
  const top = payloadObjectMessage(body);
  if (top) return top;
  if (body.id === undefined) return null;
  return joiString(body.id, 'id');
}

function searchAccounts(store, query) {
  const pattern = new RegExp(escapeRegexp(query), 'i');
  const result = [];
  for (const account of store.accounts.values()) {
    if (account.isDeleted === true) continue;
    if (fieldMatches(account.lastName, pattern)
      || fieldMatches(account.firstName, pattern)
      || fieldMatches(account.email, pattern)) {
      result.push(account);
    }
  }
  return result;
}

function getAuthorizedMembership(store, ownerId, accountId) {
  const members = listMembers(store, {
    ownerId,
    statusList: [MEMBER_STATUS.ACCEPTED],
    typeList: [MEMBER_TYPE.OUTGOING],
  });
  const member = members.find((mem) => idsEqual(mem.accountId, accountId));
  if (member) return member;
  const owner = findById(store, ownerId);
  if (idsEqual(owner._id, accountId) || owner.isAdmin) {
    return { account: null };
  }
  fail(ACCOUNT_ERRORS.OWNER_CAN_MANIPULATE);
}

function listOwnerLoops(store, ownerId) {
  return [...store.loops.values()].filter((loop) => idsEqual(loop.owner, ownerId) && loop.isDeleted !== true);
}

function memberIdsOf(loop) {
  return (loop && loop.members || []).map((member) => String(member && (member._id || member.id)));
}

function persistClearedLoop(store, loop, before, loopUpdatedOutbox) {
  loop.updated = Date.now();
  const previousIds = memberIdsOf(before);
  const nextIds = memberIdsOf(loop);
  if (previousIds.length !== nextIds.length || previousIds.some((id, index) => id !== nextIds[index])) {
    const version = Number(before && before.__v);
    loop.__v = (Number.isInteger(version) && version >= 0 ? version : 0) + 1;
  }
  const prior = store.loops.get(loop._id);
  store.loops.set(loop._id, loop);
  try {
    if (loopUpdatedOutbox && typeof loopUpdatedOutbox.record === 'function') {
      loopUpdatedOutbox.record(loop);
    } else {
      store.flush();
    }
  } catch (error) {
    if (prior) store.loops.set(loop._id, prior);
    else store.loops.delete(loop._id);
    throw error;
  }
  return loop;
}

/** LoopController.clearMember: hard-filter members by accountId, then save. */
function clearMember(store, { loopId, accountId }, loopUpdatedOutbox) {
  const stored = store.loops.get(loopId);
  if (!stored || stored.isDeleted === true) fail(LOOP_MEMBERSHIP_ERRORS.LOOP_NOT_FOUND);
  const before = snapshotAccount(stored);
  const loop = snapshotAccount(stored);
  const membersCount = (loop.members || []).length;
  loop.members = (loop.members || []).filter((member) => !member.accountId || !idsEqual(member.accountId, accountId));
  if (loop.members.length === membersCount) fail(LOOP_MEMBERSHIP_ERRORS.MEMBER_NOT_FOUND);
  return persistClearedLoop(store, loop, before, loopUpdatedOutbox);
}

/**
 * LoopController.clearAssociated. Owned loops must all be suspended; each is
 * then `_remove`'d (Phoenix `removeLoop`). Remaining loops that still list the
 * account as a member go through `clearMember`. Source saves each loop before
 * the account row; a throw after a loop save leaves those loop writes in place.
 */
function clearAssociated(store, accountId, loopUpdatedOutbox) {
  const loops = listOwnerLoops(store, accountId);
  if (loops.some((loop) => !loop.isSuspended)) fail(ACCOUNT_ERRORS.LOOPS_MUST_BE_SUSPENDED);
  for (const loop of loops) {
    removeLoop(store, { ownerId: accountId, loopId: loop._id }, loopUpdatedOutbox);
  }
  const loopsHavingAccount = [...store.loops.values()].filter((loop) => loop.isDeleted !== true
    && (loop.members || []).some((member) => member.accountId && idsEqual(member.accountId, accountId)));
  for (const loop of loopsHavingAccount) {
    clearMember(store, { loopId: loop._id, accountId }, loopUpdatedOutbox);
  }
}

/**
 * AccountController.removeById. With `id`, membership is checked first, then
 * an account that has an email is OWNER_CAN_REMOVE, then ownerId is reassigned
 * to the target. Order: isDeleted = true on the in-memory row, then
 * clearAssociated, then save. passwordResetCode is not cleared (DIVERGENCES A1).
 */
function removeById(store, ownerId, accountId, loopUpdatedOutbox) {
  if (accountId) {
    getAuthorizedMembership(store, ownerId, accountId);
    const account = findById(store, accountId);
    if (account.email) fail(ACCOUNT_ERRORS.OWNER_CAN_REMOVE);
    ownerId = accountId;
  }
  const accountToRemove = findById(store, ownerId);
  const previous = snapshotAccount(accountToRemove);
  const next = { ...accountToRemove, isDeleted: true, updated: Date.now() };
  clearAssociated(store, ownerId, loopUpdatedOutbox);
  persistAccount(store, next, previous);
  return next;
}

function sendActivation(store, account, campaign, mail) {
  if (account.isActive) fail(ACCOUNT_ERRORS.ACCOUNT_ACTIVATED);
  const previous = snapshotAccount(account);
  account.activationCode = dashlessUuid();
  account.updated = Date.now();
  const context = mail || {};
  const url = campaignLandingUrl(
    context,
    campaign,
    'activation',
    '/activate',
    { code: account.activationCode, email: account.email },
  );
  observeMailRejection(sendMethod(context.activation, [account.email, {
    email: account.email,
    firstName: account.firstName || 'There',
    url,
  }]), context.onError, 'activation-mail');
  persistAccount(store, account, previous);
  return account;
}
