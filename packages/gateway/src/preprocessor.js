// CONTEXT message preprocessing — port of utils/MessagePreProcessor.ts + MessageValidator.ts.
//
// Fills GeneralData defaults (anonymous identity when auth is absent, i.e. disableAuth mode —
// commit c776f204), trims loop-member names, and (only when authenticated) validates that the
// CONTEXT identity matches the socket's JWT.

const GENERAL_DEFAULTS = {
  accountID: 'anonymous-account',
  robotID: 'anonymous-robot',
  lang: 'en',
  release: '1.8.0', // assume Fajita unless told otherwise
};

/**
 * Mutates the CONTEXT message in place.
 * @param {object} message a CONTEXT message {type, data:{general?, runtime?, skill?}}
 * @param {{id?:string, friendlyId?:string}|null} auth decoded JWT payload, or null in disableAuth
 * @param {string} [remoteAddress]
 */
export function preprocessContext(message, auth, remoteAddress) {
  const defaults = {
    accountID: auth ? auth.id : GENERAL_DEFAULTS.accountID,
    robotID: auth ? auth.friendlyId : GENERAL_DEFAULTS.robotID,
    lang: GENERAL_DEFAULTS.lang,
    release: GENERAL_DEFAULTS.release,
    remoteAddress,
  };
  message.data.general = Object.assign({}, defaults, message.data.general);

  const loop = message.data.runtime && message.data.runtime.loop;
  if (loop && loop.users) {
    for (const u of loop.users) {
      if (u.firstName) u.firstName = u.firstName.trim();
      if (u.lastName) u.lastName = u.lastName.trim();
      if (u.phoneticName) u.phoneticName = u.phoneticName.trim();
    }
  }

  if (auth) validateGeneralData(message.data.general, auth);
}

/** Cross-check CONTEXT identity against the socket JWT (MessageValidator.validateGeneralData). */
export function validateGeneralData(general, auth) {
  if (!auth) return;
  if (!general.accountID) throw new Error('accountID is missing in general data');
  if (!general.robotID) throw new Error('robotID is missing in general data');
  if (!general.release) throw new Error('release is missing in general data');
  if (general.accountID !== auth.id) throw new Error('data.general.accountID is not equal to socket accountID');
  if (general.robotID !== auth.friendlyId) throw new Error('data.general.robotID is not equal to socket robotID');
}

/** Minimal CONTEXT validation independent of auth (MessageValidator.validateContextMessage). */
export function validateContextMessage(message) {
  if (!message.data.general || !message.data.general.accountID) throw new Error('Invalid CONTEXT message: accountID is missing');
  if (!message.data.general.robotID) throw new Error('Invalid CONTEXT message: robotID is missing');
  return message;
}
