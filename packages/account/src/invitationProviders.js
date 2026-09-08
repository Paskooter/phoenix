// Source-shaped seams for LoopController invitation side effects.
//
// srv-account-ws@6cea creates two MailController instances (the `invitation`
// and `invitationExistingUser` templates) and one @jibo/server EventSender.
// Phoenix does not ship the SMTP/SES or SNS credentials, so construction of
// those transports stays outside the account service.  The service accepts
// the same small send contracts here and keeps their source ordering.

import querystring from 'node:querystring';

const REQUIRED_EVENT_FIELDS = ['email', 'loopId', 'ownerId'];

/**
 * The source BaseEvent adds eventKey to the payload and validates the event
 * before EventSender publishes it.  Keep that observable shape without
 * pulling the archived @jibo/server runtime into the Phoenix production
 * dependency graph.
 */
export class InvitedToJoinLoop {
  constructor(payload) {
    this.payload = payload || {};
    this.payload.eventKey = this.constructor.name;
    this.validate(payload);
  }

  validate() {
    const payload = this.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new TypeError('InvitedToJoinLoop payload must be an object');
    }
    for (const field of REQUIRED_EVENT_FIELDS) {
      if (typeof payload[field] !== 'string' || payload[field].length === 0) {
        throw new TypeError(`InvitedToJoinLoop ${field} is required`);
      }
    }
    if (payload.accountId !== undefined && typeof payload.accountId !== 'string') {
      throw new TypeError('InvitedToJoinLoop accountId must be a string');
    }
    for (const field of ['firstName', 'lastName']) {
      if (payload[field] !== undefined && typeof payload[field] !== 'string') {
        throw new TypeError(`InvitedToJoinLoop ${field} must be a string`);
      }
    }
    if (payload.memberIds !== undefined && !Array.isArray(payload.memberIds)) {
      throw new TypeError('InvitedToJoinLoop memberIds must be an array');
    }
    return this;
  }
}

function noopSend() {
  return Promise.resolve(undefined);
}

function sendMethod(provider, args) {
  if (typeof provider === 'function') return provider(...args);
  if (provider && typeof provider.send === 'function') return provider.send(...args);
  return noopSend();
}

function reportFailure(providers, error, kind) {
  if (typeof providers.onError !== 'function') return;
  // The source logs a rejected mail/event promise. A logging hook must not
  // turn that contained rejection into an account-request failure.
  try {
    providers.onError(error, kind);
  } catch (_) {
    // Preserve the source fire-and-forget boundary even when a test logger is
    // deliberately faulty.
  }
}

function observeRejection(result, providers, kind) {
  // The source providers return Promises. Promise.resolve also makes the
  // seam convenient for deterministic synchronous test providers while still
  // containing a rejected asynchronous send.
  Promise.resolve(result).catch((error) => reportFailure(providers, error, kind));
}

/**
 * Normalize the explicit service option. The provider objects mirror the
 * source fields: `invitation` is MailController(template=invitation),
 * `invitationExistingUser` is MailController(template=invitationExistingUser),
 * and `eventSender` is EventSender.
 */
export function normalizeInvitationProviders(input = undefined) {
  const options = input || {};
  return {
    portalUrl: options.portalUrl === undefined ? '' : String(options.portalUrl),
    invitation: options.invitation || options.mailInvitation || null,
    invitationExistingUser: options.invitationExistingUser || options.mailInvitationExisting || null,
    eventSender: options.eventSender || null,
    onError: options.onError,
  };
}

function ownerDetails(store, ownerId) {
  const owner = store.accounts.get(ownerId);
  if (!owner) throw new Error(`Account not found: ${ownerId}`);
  return owner;
}

/**
 * Build and dispatch the exact two source side effects for an email member.
 * Mail invocation happens before event construction/send. Both provider
 * rejections are logged/contained by the source. A provider that throws
 * before returning its Promise is treated as a malformed seam and remains a
 * request failure; the source MailController and EventSender expose
 * Promise-returning send methods whose transport rejections are contained.
 */
export function dispatchInvitationSideEffects(store, {
  email, ownerId, accountId, code, loopId, loopOwnerId, memberProperties,
}, inputProviders = undefined) {
  if (!email) return;
  const providers = normalizeInvitationProviders(inputProviders);
  const owner = ownerDetails(store, ownerId);
  // The source chooses the existing-user template with `if (!accountId)`;
  // retain that truthiness boundary before converting an ObjectId-like value.
  const knownAccount = Boolean(accountId);
  const query = knownAccount ? { email } : { email, code };
  const path = knownAccount ? '/home' : '/create';
  const mailOptions = {
    email,
    name: owner.fullName || owner.email,
    photoUrl: owner.photoUrl,
    url: `${providers.portalUrl}${path}?${querystring.stringify(query)}`,
  };
  const mailProvider = knownAccount ? providers.invitationExistingUser : providers.invitation;
  // Source sendInvitationMail invokes MailController.send after its owner
  // lookup, then catches the returned promise without awaiting SMTP/SES.
  observeRejection(sendMethod(mailProvider, [email, mailOptions]), providers, 'invitation-mail');

  const payload = {
    accountId: knownAccount ? String(accountId) : undefined,
    email,
    loopId: String(loopId),
    ownerId: String(loopOwnerId === undefined ? store.loops.get(loopId)?.owner : loopOwnerId),
  };
  if (memberProperties && memberProperties.firstName) payload.firstName = memberProperties.firstName;
  if (memberProperties && memberProperties.lastName) payload.lastName = memberProperties.lastName;
  const event = new InvitedToJoinLoop(payload);
  // Source eventSender.send(event).catch(...) is also fire-and-forget.
  observeRejection(sendMethod(providers.eventSender, [event]), providers, 'invited-to-join-loop');
}
