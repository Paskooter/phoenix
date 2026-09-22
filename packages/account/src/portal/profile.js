// Portal REST: account profile + password (surface 3). Same store + session as login; a UI
// change is exactly the account the mobile app signs into.

import { sendJson } from '@phoenix/common';
import { hashPassword } from '../model.js';
// Both formats, same reason as the login route: an imported household's password
// is the source pbkdf2 encoding, not the portal's scrypt.
import {
  changeEmail,
  compareAccountPassword,
  confirmEmailReset,
  notifyPasswordChanged,
} from '../accountIdentity.js';
import { requireUser, portalAccount } from './session.js';
import { bumpAccountSessionVersion } from '../sessions.js';

const GENDERS = ['male', 'female', 'other', 'they'];
const JOT_NOTIFICATION_MODES = ['always', 'tagged', 'none'];

function badRequest(res, message) {
  return sendJson(res, 400, { error: message });
}

export function portalProfileRoutes(store, { identityProviders = undefined } = {}) {
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
      if (input.jotNotificationMode !== undefined) {
        if (typeof input.jotNotificationMode !== 'string' || !JOT_NOTIFICATION_MODES.includes(input.jotNotificationMode)) {
          return badRequest(res, `jotNotificationMode must be one of ${JOT_NOTIFICATION_MODES.join(', ')}`);
        }
        account.jotNotificationMode = input.jotNotificationMode;
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
      notifyPasswordChanged(identityProviders, account);
      return { ok: true };
    },

    'POST /api/me/email': ({ req, res, body }) => {
      const account = requireUser(store, req, res);
      if (!account) return;
      const { currentPassword, email } = body || {};
      if (typeof currentPassword !== 'string' || !compareAccountPassword(currentPassword, account.password)) {
        return sendJson(res, 401, { error: 'current password is incorrect' });
      }
      const nextEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextEmail) || nextEmail.length > 320) {
        return badRequest(res, 'email must be a valid address');
      }
      if (!identityProviders?.emailReset) {
        // Do not replace an address until the user proves control of it. If an
        // operator has not configured mail, failing closed is safer than
        // silently applying an unverified profile edit.
        return sendJson(res, 503, { error: 'email confirmation is not configured on this server' });
      }
      try {
        changeEmail(store, {
          id: account._id,
          password: currentPassword,
          email: nextEmail,
        }, identityProviders);
        return { pending: true, email: nextEmail };
      } catch (error) {
        if (error?.code === 'EMAIL_ALREADY_EXISTS') {
          return sendJson(res, 409, { error: 'An account with that email already exists' });
        }
        if (error?.code === 'EMAIL_WAS_NOT_CHANGED') {
          return sendJson(res, 400, { error: 'new email must differ from the current email' });
        }
        return sendJson(res, 400, { error: 'could not start email change' });
      }
    },

    // The code is delivered only to the proposed new mailbox. It is not tied
    // to the old session so it remains usable after a browser restart, and the
    // shared identity operation invalidates every existing session on success.
    'POST /api/me/email/confirm': ({ res, body }) => {
      const code = typeof body?.code === 'string' ? body.code : '';
      try {
        confirmEmailReset(store, code, identityProviders);
        return { ok: true };
      } catch {
        return sendJson(res, 400, { error: 'This email-change link is invalid or has expired' });
      }
    },
  };
}
