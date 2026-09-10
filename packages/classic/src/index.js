// @phoenix/classic — the classic-service entrypoint: the robot's single front door. One AWS-JSON
// endpoint (POST /) that the robot's region (https://<region>.jibo.com) resolves to, dispatching
// by X-Amz-Target prefix to the right service. Lightweight stateless services (log, robot) run
// in-process here; stateful services that own a store proxy to their dedicated process:
//   OOBE_*   -> account service (NET_account, default localhost:7016)
//   Update_* -> ota service     (NET_ota,     default localhost:7015)
// New services (settings, notification, key, …) register here as they land in later iterations.

import { createService, sendJson } from '@phoenix/common';
import { DefaultPort } from '@phoenix/contracts';
import { createClassicRouter } from './router.js';
import { LogStore, makeLogHandler, logHttpRoutes } from './log.js';
import { makeRobotHandler } from './robot.js';
import { NotificationHub, makeNotificationHandler, attachNotificationSocket } from './notification.js';
import { KeyStore, makeKeyHandler, keyRoutes } from './key.js';
import { DeviceRegistry, makePushHandler } from './push.js';
import { BackupStore, makeBackupHandler, backupBlobRoutes } from './backup.js';
import { MediaStore, makeMediaHandler, mediaBlobRoutes, isMediaUpload } from './media.js';
import { makeRomHandler } from './rom.js';
import { stubRegistrations } from './stubs.js';
import { proxyMemberPhoto } from './photoProxy.js';

export { createClassicRouter } from './router.js';
export * as awsJson from './awsJson.js';
export { LogStore, makeLogHandler, logHttpRoutes } from './log.js';
export { makeRobotHandler } from './robot.js';
export { NotificationHub, createVerifiedNotificationAccountResolver } from './notification.js';
export { NotificationStore } from './notification.js';
export { KeyStore, keyRoutes, KEY_ERRORS } from './key.js';
export { DeviceRegistry } from './push.js';
export { BackupStore, credentialsAccountId, accountLoopRobot } from './backup.js';
export { MediaStore, makeMediaHandler, mediaBlobRoutes, expandMedia, accessKeyAccountResolver, MEDIA_ERRORS, MEDIA_TYPES } from './media.js';
export {
  RomController, RomError, CertificateStore, ROM_ERRORS,
  makeRomHandler, makeAccountClient, makeRobotClient, generateCertificatePair,
  accountBaseUrl, robotBaseUrl, CERTIFICATE_LIFETIME_DAYS,
} from './rom.js';

const netUrl = (name, defPort) => {
  const v = process.env[`NET_${name}`];
  if (!v) return `http://localhost:${defPort}`;
  return /^https?:\/\//.test(v) ? v : `http://${v}`;
};

function isNotificationTarget(req) {
  return /^notification[^.]*\./i.test(String(req?.headers?.['x-amz-target'] || ''));
}

function isCreateHubTokenTarget(req) {
  return /\.createhubtoken$/i.test(String(req?.headers?.['x-amz-target'] || ''));
}

function isLoopTarget(req) {
  return /^loop[^.]*\./i.test(String(req?.headers?.['x-amz-target'] || ''));
}

function isAccountTarget(req) {
  return /^account/i.test(String(req?.headers?.['x-amz-target'] || ''));
}

/** Build the entrypoint's route table. `extra` registrations are prepended (later iterations). */
export function classicRoutes(hub, extra = [], { notificationAccountResolver, logStore, baseFor, media, keyStore, keyMembership, keyBinaryDir, rom } = {}) {
  const mediaStore = media?.store || new MediaStore();
  const keys = keyStore || new KeyStore();
  const router = createClassicRouter([
    ...extra,
    { match: /^log/i, handler: makeLogHandler(logStore || new LogStore(), baseFor) },
    { match: /^robot/i, handler: makeRobotHandler() },
    { match: /^notification/i, handler: makeNotificationHandler(hub, { accountResolver: notificationAccountResolver }), preserveBody: true, bodyDefault: null },
    { match: /^key/i, handler: makeKeyHandler(keys, { membership: keyMembership, baseFor, binaryDir: keyBinaryDir }) },
    { match: /^push/i, handler: makePushHandler(new DeviceRegistry()) },
    // Media_20160725 owns a real store: the app's Gallery reads it and the robot writes photos to
    // it. Registered before the tier-3 stubs so the media stub never answers for it.
    { match: /^media/i, handler: makeMediaHandler({
      store: mediaStore,
      baseFor,
      accountResolver: media?.accountResolver,
      loops: media?.loops,
    }) },
    { match: /^rom/i, handler: makeRomHandler(rom) }, // ROM_20171011 cert exchange (A-16)
    ...stubRegistrations(), // build-to-spec tier-3 stubs (person/ifttt/nlp/collision)
    { match: /^oobe/i, proxyTo: () => netUrl('account', DefaultPort.account) },
    { match: /^account/i, proxyTo: () => netUrl('account', DefaultPort.account) },
    { match: /^loop/i, proxyTo: () => netUrl('account', DefaultPort.account) },
    { match: /^settings/i, proxyTo: () => netUrl('account', DefaultPort.account) },
    { match: /^update/i, proxyTo: () => netUrl('ota', DefaultPort.ota) },
  ]);
  return router;
}

/**
 * The classic-service entrypoint. Returns { service, listen, hub, wss }. The notification
 * socket (the wss push door) is attached to the same HTTP server — the robot reaches the REST
 * face and the socket on one host (path /socket/<token>).
 */
export function createClassicEntrypoint({ extra = [], tls, notificationFile, notificationStore, notificationClock, notificationTtlMs, notificationPollIntervalMs, notificationAccountResolver, backupOwnership, media, keyStore, keyMembership, keyBinaryDir, rom } = {}) {
  const hub = new NotificationHub({
    file: notificationFile,
    store: notificationStore,
    clock: notificationClock,
    notificationTtlMs,
    pollIntervalMs: notificationPollIntervalMs,
  });
  const backups = new BackupStore();
  const keys = keyStore || new KeyStore();
  // The Backup URLs (and OTA-style self-hosting) point back at whatever host the robot reached
  // us on, so the blob upload/download land here too. ETCO_classic_publicUrl overrides.
  const baseFor = (req) => process.env.ETCO_classic_publicUrl || `${req.socket?.encrypted ? 'https' : 'http'}://${(req.headers && req.headers.host) || 'localhost'}`;
  const logStore = new LogStore();
  const mediaStore = media?.store || new MediaStore();
  const service = createService({
    name: 'classic',
    tls,
    // The Hapi-backed Account boundary validates primitive JSON values after
    // parsing. Notification's Hapi validator also needs null/scalar payloads
    // intact to reject them before token mutation. Other routes stay strict.
    jsonStrict: (req) => !isCreateHubTokenTarget(req) && !isNotificationTarget(req) && !isLoopTarget(req) && !isAccountTarget(req),
    routes: {
      ...classicRoutes(hub, [...extra, { match: /^backup/i, handler: makeBackupHandler(backups, baseFor, { ownership: backupOwnership }) }], {
        notificationAccountResolver,
        logStore,
        baseFor,
        media: { ...media, store: mediaStore },
        keyStore: keys,
        keyMembership,
        keyBinaryDir,
        rom,
      }),
      // Account owns the photo objects. Keep the URL on the same public
      // Classic/TLS origin that the robot already reaches.
      'GET /member-photos/:key': ({ req, res, log }) => proxyMemberPhoto({
        baseUrl: netUrl('account', DefaultPort.account),
        key: req.params.key,
        req,
        res,
        log,
      }),
      ...backupBlobRoutes(backups), // PUT/GET /backup/blob — the self-hosted store the URLs point at
      ...keyRoutes(keys, { membership: keyMembership, baseFor, binaryDir: keyBinaryDir }), // POST /binaryRequest, /deleteBinaries, GET /key/binary
      ...logHttpRoutes(logStore),  // PUT/GET /log/upload|blob — the log/ASR/binary sink the URLs point at
      ...mediaBlobRoutes(mediaStore), // GET /media/blob/:path — the object bytes behind a Media url
      // Internal enqueue: push a notification to a robot's account (portal/system/tests use this).
      'POST /notify': ({ res, body }) => {
        if (!body || !body.accountId) return sendJson(res, 400, { error: 'accountId required' });
        const notification = Object.prototype.hasOwnProperty.call(body, 'notification')
          ? body.notification
          : Object.prototype.hasOwnProperty.call(body, 'payload') ? body.payload : {};
        const n = hub.enqueueNotification({
          accountId: body.accountId,
          skillId: body.skillId === undefined ? '-1' : body.skillId,
          notification,
        });
        return { queued: n._id };
      },
    },
  });
  const wss = attachNotificationSocket(service.server, hub);
  hub.startDelivery();
  service.server.on('close', () => hub.stopDelivery());
  return { ...service, hub, wss, backups, logStore, mediaStore, keys };
}

export function start(port = Number(process.env.PORT) || DefaultPort.classic) {
  return createClassicEntrypoint().listen(port);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch((e) => { console.error(e); process.exit(1); });
}
