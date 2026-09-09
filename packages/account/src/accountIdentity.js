// Account identity core — Create, Login, Get, Update, CheckEmail, ChangePassword.
//
// Source: jiborobot/srv-account-ws@6cea43470825657d6a5722162f28c8f233153ee2
//   handlers/account.handler.ts, controllers/account.ctrl.ts, schemes/account.ts,
//   utils/password.ts, errors/account.ts.
// Framework: jiborobot/srv-server parseCredentials.ts / validate.ts / server.ts
//   lowerMethodName = split('.')[1], first character lowercased.
// Gateway: jiborobot/srv-security-gw@43a692fe7670660aaed6ab5979c6c83039eb711c
//   auth.ctrl.ts unauthorizedMethods for Create/Login/CheckEmail.
//
// Public Classic/Account identity is the signed access key (A-04 Loop pattern).
// parseCredentials still reads only x-amz-credentials and is tested as the
// original internal boundary; it is not a public caller switch.

import { pbkdf2Sync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { SIGV4_ERRORS, SigV4Error, verifySigV4 } from '@phoenix/common';
import { sendAmz, sendAmzError, sendValidationError } from './loopHttp.js';
import { fillAccessKeys, isAcceptedStatus, newId, verifyPassword } from './model.js';

export const ACCOUNT_PASSWORD_REGEX = /^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)[A-Za-z\d-_!$%@#£€*?&\(\)\^]{8,}$/;
const ACCOUNT_MINIMAL_AGE = 13;
const GENDERS = Object.freeze(['male', 'female', 'other', 'they']);
const ROLES = Object.freeze(['user', 'developer']);
const EXCLUDED_UPDATE_PROPS = Object.freeze(['email', 'password', 'accessKeyId', 'secretAccessKey']);
const EMAIL_RESET_NEW = 'new';

// Gateway unauthorizedMethods — exact x-amz-target strings, not case-folded.
export const ACCOUNT_ANONYMOUS_TARGETS = Object.freeze([
  'Account_20151111.CheckEmail',
  'Account_20151111.Create',
  'Account_20151111.Login',
]);

export const ACCOUNT_IDENTITY_METHODS = Object.freeze([
  'create',
  'login',
  'get',
  'update',
  'checkEmail',
  'changePassword',
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

function createAccount(store, payload) {
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
    if (!account.isActive) saveActivationCode(store, account);
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
        return account && account.isDeleted !== true ? account : null;
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
    run({ store, body }) {
      if (!joiEmail(body.email)) fail(ACCOUNT_ERRORS.EMAIL_NOT_VALID);
      if (String(body.password).length < 8) fail(ACCOUNT_ERRORS.PASSWORD_NOT_VALID_LENGTH);
      if (!ACCOUNT_PASSWORD_REGEX.test(String(body.password))) fail(ACCOUNT_ERRORS.PASSWORD_NOT_VALID_STRING);
      const payload = { ...body, email: String(body.email).toLowerCase() };
      return { value: accountToSourceJson(createAccount(store, payload), { unsafe: true }) };
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
};

export function handleAccountIdentity({ store, req, res, body, log }) {
  const target = String(req.headers && req.headers['x-amz-target'] || '');
  const methodName = accountMethodName(target);
  const spec = OPS[methodName];
  if (!spec) return false;
  try {
    const auth = authenticatePublicAccount({ store, req, body, target, auth: spec.auth });
    if (auth.error) return void sendAmzError(res, auth.error);
    const validation = spec.validate(body);
    if (validation) return void sendValidationError(res, validation);
    const result = spec.run({ store, body, credentials: auth.credentials, req });
    log.info('account identity', { op: methodName });
    return void sendAmz(res, 200, result.value);
  } catch (error) {
    if (error && error.code && error.statusCode) return void sendAmzError(res, error);
    throw error;
  }
}
