import { RobotReadClient } from './loopCreation.js';
// @phoenix/account — the account / loop / OOBE Classic Service + the web portal.
//
// Three faces over one persistent store (see OOBE-PORTAL-HANDOFF.md):
//   1. Robot face   — AWS-JSON-1.1 `POST /` dispatched by X-Amz-Target (OOBE.setupRobot …),
//                     plus a prefix-proxy for Update_* to the OTA service        [G.2]
//   2. Portal face  — REST /api/* with session cookies (signup/login/robots/QR)  [G.1/G.3]
//   3. Admin face   — /api/admin/* gated by ADMIN_PASSWORD from .env             [G.1]
// Static portal UI served from ./portal                                          [G.4]

import { createService } from '@phoenix/common';
import { DefaultPort } from '@phoenix/contracts';
import { getStore } from './store.js';
import { portalRoutes } from './portalApi.js';
import { robotFaceRoutes } from './robotFace.js';
import { settingsPeerRoutes, settingsPortalRoutes } from './settingsFace.js';
import { backupPeerRoutes } from './backupPeerRoutes.js';
import { staticRoutes } from './static.js';
import { createSettingsProviders } from './settingsProviders.js';
import { MemberPhotoStorage } from './memberPhotoStorage.js';
import { pipeline } from 'node:stream/promises';
import { join, dirname } from 'node:path';
import { LoopUpdatedOutbox } from './loopUpdatedOutbox.js';
import { createConfiguredInvitationProviders } from './invitationDeployment.js';
import {
  createHttpSmsProvider,
  normalizeIdentityProviders,
} from './accountIdentity.js';
import { createLpsStsProvider } from './lps.js';
import { createSmtpAccountMailProviders, smtpConfigFromEnv } from './smtpMail.js';

export { Store, getStore, resetStore } from './store.js';
export * as model from './model.js';
export { createHubToken, createAuthenticatedHubToken, createAuthenticatedWebToken, verifyWebToken, secretMatches } from './model.js';
export {
  ACCOUNT_ANONYMOUS_TARGETS,
  ACCOUNT_UNACTIVE_TARGETS,
  ACCOUNT_ERRORS,
  ACCOUNT_IDENTITY_METHODS,
  ACCOUNT_PASSWORD_REGEX,
  EMAIL_RESET_STATUS,
  TOKEN_ERRORS,
  accountMethodName,
  accountToSourceJson,
  compareAccountPassword,
  createHttpSmsProvider,
  escapeRegexp,
  handleAccountIdentity,
  hashAccountPassword,
  isAccountPhotoUpload,
  normalizeIdentityProviders,
  parseInternalCredentials,
  randomPhoneVerificationCode,
  removePhoto,
  updatePhoto,
} from './accountIdentity.js';
export * as sessions from './sessions.js';
export { portalRoutes } from './portalApi.js';
export { robotFaceRoutes } from './robotFace.js';
export {
  createSettingsInternalService,
  settingsAwsDispatch,
  settingsInternalDispatch,
  settingsInternalRoutes,
  settingsPeerRoutes,
  settingsPortalRoutes,
} from './settingsFace.js';
export {
  SETTINGS_API_VERSION,
  SETTINGS_GATEWAY_CONTENT_TYPE,
  SETTINGS_INTERNAL_CONTENT_TYPE,
  SETTINGS_PUBLIC_CONTENT_TYPE,
  SETTINGS_TRANSPORTS,
  createPublicSettingsForwarder,
  prepareInternalSettingsRequest,
  prepareSettingsRequest,
} from './settingsTransport.js';
export * as settingsData from './settingsData.js';
export { createSettingsProviders } from './settingsProviders.js';
export { LoopUpdatedOutbox, buildLoopUpdatedPayload, buildLoopUpdatedNotification } from './loopUpdatedOutbox.js';
export {
  InvitedToJoinLoop,
  dispatchInvitationSideEffects,
  normalizeInvitationProviders,
} from './invitationProviders.js';
export {
  createConfiguredInvitationProviders,
} from './invitationDeployment.js';
export {
  InvitationEventOutbox,
  createConfiguredInvitationEventSender,
  createHttpInvitationEventPublisher,
} from './invitationEventOutbox.js';
export {
  INVITATION_SUBJECT,
  MAIL_SUBJECTS,
  SmtpMailProvider,
  createSmtpAccountMailProviders,
  createSmtpMailProviders,
  normalizeSmtpConfig,
  smtpConfigFromEnv,
} from './smtpMail.js';
export { staticRoutes } from './static.js';

function isCreateHubTokenTarget(req) {
  return /\.createhubtoken$/i.test(String(req?.headers?.['x-amz-target'] || ''));
}

function isSettingsTarget(req) {
  return req.method === 'POST'
    && new URL(req.originalUrl || req.url, 'http://localhost').pathname === '/'
    && /^settings/i.test(String(req.headers?.['x-amz-target'] || '').split('.').slice(0, -1).join('.'));
}

function isLoopTarget(req) {
  return req.method === 'POST'
    && new URL(req.originalUrl || req.url, 'http://localhost').pathname === '/'
    && /^loop[^.]*\./i
      .test(String(req.headers?.['x-amz-target'] || ''));
}

function isAccountTarget(req) {
  return req.method === 'POST'
    && new URL(req.originalUrl || req.url, 'http://localhost').pathname === '/'
    && /^account/i.test(String(req.headers?.['x-amz-target'] || ''));
}

function firstNonEmpty(...values) {
  return values.find((value) => typeof value === 'string' && value.trim() !== '') || null;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined);
}

function photoPublicBaseUrl(...values) {
  const configured = firstNonEmpty(...values);
  if (!configured) return null;
  const trimmed = configured.replace(/\/+$/, '');
  let parsed;
  try { parsed = new URL(trimmed); }
  catch (error) { throw new Error(`Invalid photo public URL: ${error.message}`); }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Invalid photo public URL protocol: ${parsed.protocol}`);
  }
  // The deployment setting is normally the public Classic origin. The local
  // ingress owns this fixed path; retain an explicitly supplied path so a
  // reverse proxy can mount the photo endpoint below its own prefix.
  const path = parsed.pathname === '/' ? '/member-photos' : parsed.pathname;
  return `${parsed.origin}${path}`;
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function createConfiguredIdentityProviders({
  identityProviders,
  invitationProviders,
  smtp,
  fromAddress,
  templateDir,
  portalUrl,
  smsUrl,
  smsTimeoutMs,
  smsHeaders,
} = {}) {
  const options = identityProviders && typeof identityProviders === 'object' ? identityProviders : {};
  const normalized = normalizeIdentityProviders({
    ...options,
    portalUrl: firstDefined(
      options.portalUrl,
      invitationProviders && invitationProviders.portalUrl,
      portalUrl,
      process.env.ETCO_account_portalUrl,
      '',
    ),
  });
  const smtpOption = firstDefined(options.smtp, smtp);
  const smtpConfig = smtpOption === undefined ? smtpConfigFromEnv() : smtpOption;
  if (smtpConfig) {
    const mail = createSmtpAccountMailProviders({
      smtp: smtpConfig,
      fromAddress: firstDefined(options.fromAddress, fromAddress, process.env.ETCO_account_mailFrom, 'no-reply@jibo.com'),
      templateDir: firstDefined(options.templateDir, templateDir),
    });
    if (!own(options, 'emailReset')) normalized.emailReset = mail.emailReset;
    if (!own(options, 'emailResetComplete')) normalized.emailResetComplete = mail.emailResetComplete;
  }
  if (!own(options, 'sms') && !own(options, 'smsProvider')) {
    const url = firstDefined(options.smsUrl, smsUrl, process.env.ETCO_account_smsUrl);
    if (url) {
      normalized.sms = createHttpSmsProvider({
        url,
        timeoutMs: firstDefined(options.smsTimeoutMs, smsTimeoutMs, process.env.ETCO_account_smsTimeoutMs, 5000),
        headers: firstDefined(options.smsHeaders, smsHeaders, {}),
      });
    }
  }
  return normalized;
}

function photoConfiguration(loopConfig, store) {
  const server = loopConfig.server || {};
  return {
    publicBaseUrl: photoPublicBaseUrl(
      server.photoBaseUrl,
      process.env.ETCO_account_photoBaseUrl,
      process.env.PHOTO_PUBLIC_URL,
    ),
    directory: firstNonEmpty(
      server.photoDirectory,
      process.env.ETCO_account_photoDirectory,
      process.env.PHOTO_DIRECTORY,
    ) || join(dirname(store.file), 'member-photos'),
  };
}

export function createAccountService({
  store = getStore(),
  settingsProviders,
  notificationPublisher,
  loopConfig = {},
  agreementProvider,
  memberPhotoProvider,
  invitationProviders,
  identityProviders,
  robotReadClient = new RobotReadClient(),
  invitationSmtp,
  invitationEventFile,
  invitationEventUrl,
  invitationEventPublisher,
  invitationEventTimeoutMs,
  invitationEventHeaders,
  invitationMailFrom,
  invitationTemplateDir,
  identitySmtp,
  identityMailFrom,
  identityTemplateDir,
  identityPortalUrl,
  smsUrl,
  smsTimeoutMs,
  smsHeaders,
  lpsStsProvider,
} = {}) {
  // The source Settings controller is always the production algorithm. Explicit provider
  // injection is reserved for tests; normal construction uses Phoenix storage/NET seams.
  // `invitationProviders` is an explicit deployment/test seam with the
  // source contracts `{ send(to, options) }` for `invitation` and
  // `invitationExistingUser`, plus `{ send(event) }` for `eventSender`.
  // A normal launch fills missing mail providers from local SMTP settings and
  // missing event delivery from the durable local event queue/HTTP sink. When
  // neither is configured, the remaining no-op is an explicit unavailable
  // provider boundary rather than a hidden external delivery claim.
  const effectiveInvitationProviders = createConfiguredInvitationProviders({
    store,
    invitationProviders,
    smtp: invitationSmtp,
    eventFile: invitationEventFile,
    eventUrl: invitationEventUrl,
    eventPublisher: invitationEventPublisher,
    eventTimeoutMs: invitationEventTimeoutMs,
    eventHeaders: invitationEventHeaders,
    fromAddress: invitationMailFrom,
    templateDir: invitationTemplateDir,
  });
  const effectiveSettingsProviders = settingsProviders === undefined
    ? createSettingsProviders({ store }) : settingsProviders;
  const effectiveIdentityProviders = createConfiguredIdentityProviders({
    identityProviders,
    invitationProviders: effectiveInvitationProviders,
    smtp: identitySmtp,
    fromAddress: identityMailFrom,
    templateDir: identityTemplateDir,
    portalUrl: identityPortalUrl,
    smsUrl,
    smsTimeoutMs,
    smsHeaders,
  });
  const photo = memberPhotoProvider ? null : photoConfiguration(loopConfig, store);
  const photoProvider = memberPhotoProvider || (photo.publicBaseUrl
    ? new MemberPhotoStorage({ directory: photo.directory, publicBaseUrl: photo.publicBaseUrl }) : null);
  const loopUpdatedOutbox = new LoopUpdatedOutbox(store, { publisher: notificationPublisher });
  const service = createService({
    name: 'account',
    // Hapi/Joi validates JSON primitives at the CreateHubToken handler.
    // Hapi also parses Settings and Loop payloads as JSON values before Joi rejects
    // top-level primitives with the source "value must be an object" error.
    // Keep the common strict parser for every other route.
    jsonStrict: (req) => !isCreateHubTokenTarget(req) && !isSettingsTarget(req) && !isLoopTarget(req) && !isAccountTarget(req),
    routes: {
      'GET /member-photos/:key': async ({ req, res }) => {
        if (!photoProvider?.open) { res.writeHead(404); res.end(); return; }
        try {
          const stream = photoProvider.open(req.params.key);
          await new Promise((resolve, reject) => { stream.once('open', resolve); stream.once('error', reject); });
          res.setHeader('content-type', 'application/octet-stream');
          await pipeline(stream, res);
        } catch (error) {
          if (!res.headersSent && !res.destroyed) { res.writeHead(404); res.end(); }
          else res.destroy(error);
        }
      },
      ...staticRoutes(),         // the portal UI (GET /, /admin, assets)
      ...portalRoutes(store),     // REST /api/* (sessions)
      ...settingsPeerRoutes(store), // internal Account client seams used by source Settings
      ...backupPeerRoutes(store),   // internal Account client seam used by source Backup (getLoop)
      ...settingsPortalRoutes(store), // GET/PUT /api/settings (the report-settings editor)
      ...robotFaceRoutes(store, {
        settingsProviders: effectiveSettingsProviders,
        loopUpdatedOutbox,
        loopConfig,
        agreementProvider,
        invitationProviders: effectiveInvitationProviders,
        identityProviders: effectiveIdentityProviders,
        robotReadClient,
        memberPhotoProvider: photoProvider,
        // LPS issues credentials through the injected STS provider; an
        // unconfigured default throws a clear unavailable error.
        stsProvider: lpsStsProvider === undefined
          ? createLpsStsProvider({ config: loopConfig }) : lpsStsProvider,
      }), // AWS-JSON POST / (OOBE ops + Update_* proxy to OTA + OAuthClients/LPS)
    },
  });
  // An injected publisher is the explicit Account -> notification boundary;
  // recover rows left by a prior process after construction.
  service.loopUpdatedOutbox = loopUpdatedOutbox;
  service.invitationProviders = effectiveInvitationProviders;
  service.identityProviders = effectiveIdentityProviders;
  void loopUpdatedOutbox.recover();
  const invitationEvents = effectiveInvitationProviders.eventSender;
  if (invitationEvents && typeof invitationEvents.recover === 'function') {
    void Promise.resolve(invitationEvents.recover()).catch(() => {});
  }
  return service;
}

export function start(port = Number(process.env.PORT) || DefaultPort.account) {
  return createAccountService().listen(port);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch((e) => { console.error(e); process.exit(1); });
}
