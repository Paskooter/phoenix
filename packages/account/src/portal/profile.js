// Portal REST: account profile + password (surface 3). Same store + session as login; a UI
// change is exactly the account the mobile app signs into.

import { sendJson } from '@phoenix/common';
import { hashPassword } from '../model.js';
// Both formats, same reason as the login route: an imported household's password
// is the source pbkdf2 encoding, not the portal's scrypt.
import { compareAccountPassword } from '../accountIdentity.js';
import { requireUser, portalAccount } from './session.js';
import { bumpAccountSessionVersion } from '../sessions.js';

const GENDERS = ['male', 'female', 'other', 'they'];

function badRequest(res, message) {
  return sendJson(res, 400, { error: message });
}

export function portalProfileRoutes(store) {
  return {
    'PUT /api/me': ({ req, res, body }) => {
      const account = requireUser(store, req, res);
      if (!account) return;
      const input = body || {};
      if (input.firstName !== undefined) {
        if (typeof input.firstName !== 'string') return badRequest(res, 'firstName must be a string');
        account.firstName = input.firstName.trim();
      }
      if (input.lastName !== undefined) {
        if (typeof input.lastName !== 'string') return badRequest(res, 'lastName must be a string');
        account.lastName = input.lastName.trim();
      }
      if (input.gender !== undefined) {
        if (typeof input.gender !== 'string' || !GENDERS.includes(input.gender)) {
          return badRequest(res, `gender must be one of ${GENDERS.join(', ')}`);
        }
        account.gender = input.gender;
      }
      if (input.birthday !== undefined) {
        if (input.birthday !== null && (typeof input.birthday !== 'number' || !Number.isFinite(input.birthday))) {
          return badRequest(res, 'birthday must be an epoch-ms number or null');
        }
        account.birthday = input.birthday;
      }
      if (input.phoneNumber !== undefined) {
        if (input.phoneNumber !== null && typeof input.phoneNumber !== 'string') {
          return badRequest(res, 'phoneNumber must be a string or null');
        }
        account.phoneNumber = input.phoneNumber;
      }
      if (input.messagingAllowed !== undefined) {
        if (typeof input.messagingAllowed !== 'boolean') return badRequest(res, 'messagingAllowed must be a boolean');
        account.messagingAllowed = input.messagingAllowed;
      }
      account.updated = Date.now();
      store.flush();
      return { account: portalAccount(account) };
    },

    'POST /api/me/password': ({ req, res, body }) => {
      const account = requireUser(store, req, res);
      if (!account) return;
      const { currentPassword, newPassword } = body || {};
      if (typeof currentPassword !== 'string' || !compareAccountPassword(currentPassword, account.password)) {
        return sendJson(res, 401, { error: 'current password is incorrect' });
      }
      if (typeof newPassword !== 'string' || newPassword.length < 8) {
        return badRequest(res, 'newPassword must be at least 8 characters');
      }
      if (currentPassword === newPassword) {
        return sendJson(res, 400, { error: 'new password must differ from the current one' });
      }
      account.password = hashPassword(newPassword);
      bumpAccountSessionVersion(account);
      account.updated = Date.now();
      store.flush();
      return { ok: true };
    },

    'POST /api/me/email': ({ req, res, body }) => {
      const account = requireUser(store, req, res);
      if (!account) return;
      const { currentPassword, email } = body || {};
      if (typeof currentPassword !== 'string' || !compareAccountPassword(currentPassword, account.password)) {
        return sendJson(res, 401, { error: 'current password is incorrect' });
      }
      if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return badRequest(res, 'email must be a valid address');
      }
      const existing = store.accountByEmail(email);
      if (existing && existing._id !== account._id) {
        return sendJson(res, 409, { error: 'An account with that email already exists' });
      }
      account.email = email.toLowerCase();
      bumpAccountSessionVersion(account);
      account.updated = Date.now();
      store.flush();
      return { account: portalAccount(account) };
    },
  };
}
