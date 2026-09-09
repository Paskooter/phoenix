// Configured local deployment wiring for Loop invitation side effects.
//
// The source account service constructs MailController(template=...) and an
// EventSender(topicArn) at startup. Phoenix exposes the same contracts while
// replacing unavailable SES/SNS credentials with explicit local transports:
// SMTP for mail and a durable file queue plus optional HTTP consumer for the
// event. No configured effect is silently replaced by a no-op.

import { dirname, join } from 'node:path';
import { createConfiguredInvitationEventSender } from './invitationEventOutbox.js';
import { normalizeInvitationProviders } from './invitationProviders.js';
import { createSmtpMailProviders, smtpConfigFromEnv } from './smtpMail.js';

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined);
}

function configuredEventFile(store, input, requested = false) {
  if (input !== undefined) return input;
  if (process.env.ETCO_account_invitationEventFile !== undefined) {
    return process.env.ETCO_account_invitationEventFile;
  }
  if (process.env.ETCO_account_eventFile !== undefined) return process.env.ETCO_account_eventFile;
  return requested && store?.file ? join(dirname(store.file), 'invitation-events.json') : undefined;
}

function configuredEventUrl(input) {
  return firstDefined(input, process.env.ETCO_account_invitationEventUrl, process.env.ETCO_account_eventUrl);
}

function configuredPortalUrl(input) {
  return firstDefined(input, process.env.ETCO_account_portalUrl, '');
}

function configuredFromAddress(input) {
  return firstDefined(input, process.env.ETCO_account_mailFrom, 'no-reply@jibo.com');
}

function envHeaders() {
  const value = process.env.ETCO_account_invitationEventHeaders;
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('must be an object');
    }
    return parsed;
  } catch (error) {
    throw new Error(`ETCO_account_invitationEventHeaders must be JSON object: ${error.message}`);
  }
}

/**
 * Resolve source-shaped providers for a normal Account service launch.
 *
 * Explicit providers win. Missing mail providers are filled from the local
 * SMTP settings, and a configured event URL is always paired with a durable
 * queue (derived beside the Account store when no file is supplied). With no
 * SMTP/event settings the historical contained no-op remains explicit and is
 * reported in the candidate documentation as an unavailable deployment.
 */
export function createConfiguredInvitationProviders({
  store,
  invitationProviders: input = undefined,
  smtp = undefined,
  eventFile = undefined,
  eventUrl = undefined,
  eventPublisher = undefined,
  eventTimeoutMs = undefined,
  eventHeaders = undefined,
  portalUrl = undefined,
  fromAddress = undefined,
  templateDir = undefined,
} = {}) {
  const options = input && typeof input === 'object' ? input : {};
  const normalized = normalizeInvitationProviders({
    ...options,
    portalUrl: configuredPortalUrl(firstDefined(options.portalUrl, portalUrl)),
  });

  const smtpOption = firstDefined(options.smtp, options.mailSmtp, smtp);
  const smtpConfig = smtpOption === undefined ? smtpConfigFromEnv() : smtpOption;
  if (smtpConfig) {
    const mail = createSmtpMailProviders({
      smtp: smtpConfig,
      fromAddress: configuredFromAddress(firstDefined(options.fromAddress, fromAddress)),
      templateDir: firstDefined(options.templateDir, templateDir),
    });
    if (!own(options, 'invitation') && !own(options, 'mailInvitation')) normalized.invitation = mail.invitation;
    if (!own(options, 'invitationExistingUser') && !own(options, 'mailInvitationExisting')) {
      normalized.invitationExistingUser = mail.invitationExistingUser;
    }
    if (!own(options, 'activation') && !own(options, 'mailActivation')) normalized.activation = mail.activation;
    if (!own(options, 'passwordReset') && !own(options, 'mailPasswordReset')) {
      normalized.passwordReset = mail.passwordReset;
    }
  }

  const explicitEventSender = own(options, 'eventSender') ? options.eventSender : undefined;
  if (explicitEventSender !== undefined) {
    normalized.eventSender = explicitEventSender;
  } else {
    const publisher = firstDefined(options.eventPublisher, eventPublisher);
    const url = configuredEventUrl(firstDefined(options.eventUrl, eventUrl));
    const explicitFile = firstDefined(options.eventFile, eventFile);
    const requested = publisher || url || explicitFile !== undefined
      || process.env.ETCO_account_invitationEventFile !== undefined
      || process.env.ETCO_account_eventFile !== undefined;
    const file = configuredEventFile(store, explicitFile, requested);
    // A file or publisher/URL is an explicit request for real local event
    // delivery. If a URL is supplied, file defaults beside account storage.
    if (requested) {
      const configuredHeaders = firstDefined(options.eventHeaders, eventHeaders);
      normalized.eventSender = createConfiguredInvitationEventSender({
        file,
        publisher,
        url,
        timeoutMs: firstDefined(options.eventTimeoutMs, eventTimeoutMs,
          process.env.ETCO_account_invitationEventTimeoutMs,
          process.env.ETCO_account_eventTimeoutMs),
        headers: configuredHeaders === undefined ? envHeaders() : configuredHeaders,
      });
    }
  }

  return normalized;
}
