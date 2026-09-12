// CONTEXT message preprocessing — port of utils/MessagePreProcessor.ts + MessageValidator.ts.
//
// Fills GeneralData defaults from the authenticated socket, trims loop-member names, and
// validates that the CONTEXT identity matches the socket's JWT. Disabled authentication still
// supplies a stable, non-credentialed identity so CONTEXT turns can use the normal path.

export const ANONYMOUS_AUTH = Object.freeze({
  id: 'anonymous-account',
  friendlyId: 'anonymous-robot',
});

/**
 * Mutates the CONTEXT message in place.
 * @param {object} message a CONTEXT message {type, data:{general?, runtime?, skill?}}
 * @param {{id?:string, friendlyId?:string}|null} auth decoded JWT payload, or null in disableAuth
 * @param {string} [remoteAddress]
 */
export function preprocessContext(message, auth, remoteAddress) {
  const identity = auth == null ? ANONYMOUS_AUTH : auth;
  const defaults = {
    accountID: readLegacyProperty(identity, 'id'),
    robotID: readLegacyProperty(identity, 'friendlyId'),
    lang: 'en',
    release: '1.8.0', // assume Fajita unless told otherwise
    remoteAddress,
  };
  const data = readLegacyProperty(message, 'data');
  data.general = Object.assign({}, defaults, readLegacyProperty(data, 'general'));

  const runtime = readLegacyProperty(data, 'runtime');
  const loop = readLegacyProperty(runtime, 'loop');
  if (loop && loop.users) {
    const users = loop.users;
    const forEach = readLegacyProperty(users, 'forEach');
    if (typeof forEach !== 'function') throw new TypeError('loop.users.forEach is not a function');
    forEach.call(users, (user) => {
      const firstName = readLegacyProperty(user, 'firstName');
      user.firstName = firstName ? trimLegacy(firstName, 'user.firstName') : firstName;
      const lastName = readLegacyProperty(user, 'lastName');
      user.lastName = lastName ? trimLegacy(lastName, 'user.lastName') : lastName;
      const phoneticName = readLegacyProperty(user, 'phoneticName');
      user.phoneticName = phoneticName ? trimLegacy(phoneticName, 'user.phoneticName') : phoneticName;
    });
  }

  validateGeneralData(data.general, identity);
}

/** Cross-check CONTEXT identity against the socket JWT (MessageValidator.validateGeneralData). */
export function validateGeneralData(general, auth) {
  const identity = auth == null ? ANONYMOUS_AUTH : auth;
  if (!readLegacyProperty(general, 'accountID')) throw new Error('accountID is missing in general data');
  if (!readLegacyProperty(general, 'robotID')) throw new Error('robotID is missing in general data');
  if (!readLegacyProperty(general, 'release')) throw new Error('release is missing in general data');
  if (general.accountID !== readLegacyProperty(identity, 'id')) throw new Error('data.general.accountID is not equal to socket accountID');
  if (general.robotID !== readLegacyProperty(identity, 'friendlyId')) throw new Error('data.general.robotID is not equal to socket robotID');
}

/** Minimal CONTEXT validation independent of auth (MessageValidator.validateContextMessage). */
export function validateContextMessage(message) {
  const data = readLegacyProperty(message, 'data');
  const general = readLegacyProperty(data, 'general');
  if (!general || !general.accountID) throw new Error('Invalid CONTEXT message: accountID is missing');
  if (!general.robotID) throw new Error('Invalid CONTEXT message: robotID is missing');
  return message;
}

function readLegacyProperty(object, property) {
  if (object === undefined) throw new TypeError(`Cannot read property '${property}' of undefined`);
  if (object === null) throw new TypeError(`Cannot read property '${property}' of null`);
  return object[property];
}

function trimLegacy(value, expression) {
  if (typeof value.trim !== 'function') throw new TypeError(`${expression}.trim is not a function`);
  return value.trim();
}
