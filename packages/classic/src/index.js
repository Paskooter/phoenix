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
import { logHandler } from './log.js';
import { makeRobotHandler } from './robot.js';
import { NotificationHub, makeNotificationHandler, attachNotificationSocket } from './notification.js';
import { KeyStore, makeKeyHandler } from './key.js';
import { DeviceRegistry, makePushHandler } from './push.js';
import { BackupStore, makeBackupHandler, backupBlobRoutes } from './backup.js';
import { stubRegistrations } from './stubs.js';

export { createClassicRouter } from './router.js';
export * as awsJson from './awsJson.js';
export { logHandler } from './log.js';
export { makeRobotHandler } from './robot.js';
export { NotificationHub, createVerifiedNotificationAccountResolver } from './notification.js';
export { NotificationStore } from './notification.js';
export { KeyStore } from './key.js';
export { DeviceRegistry } from './push.js';
export { BackupStore } from './backup.js';

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

/** Build the entrypoint's route table. `extra` registrations are prepended (later iterations). */
export function classicRoutes(hub, extra = [], { notificationAccountResolver } = {}) {
  const router = createClassicRouter([
    ...extra,
    { match: /^log/i, handler: logHandler },
    { match: /^robot/i, handler: makeRobotHandler() },
    { match: /^notification/i, handler: makeNotificationHandler(hub, { accountResolver: notificationAccountResolver }), preserveBody: true, bodyDefault: null },
    { match: /^key/i, handler: makeKeyHandler(new KeyStore()) },
    { match: /^push/i, handler: makePushHandler(new DeviceRegistry()) },
    ...stubRegistrations(), // build-to-spec tier-3 stubs (rom/media/person/ifttt/nlp/collision)
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
export function createClassicEntrypoint({ extra = [], tls, notificationFile, notificationStore, notificationClock, notificationTtlMs, notificationPollIntervalMs, notificationAccountResolver } = {}) {
  const hub = new NotificationHub({
    file: notificationFile,
    store: notificationStore,
    clock: notificationClock,
    notificationTtlMs,
    pollIntervalMs: notificationPollIntervalMs,
  });
  const backups = new BackupStore();
  // The Backup URLs (and OTA-style self-hosting) point back at whatever host the robot reached
  // us on, so the blob upload/download land here too. ETCO_classic_publicUrl overrides.
  const baseFor = (req) => process.env.ETCO_classic_publicUrl || `${req.socket?.encrypted ? 'https' : 'http'}://${(req.headers && req.headers.host) || 'localhost'}`;
  const service = createService({
    name: 'classic',
    tls,
    // The Hapi-backed Account boundary validates primitive JSON values after
    // parsing. Notification's Hapi validator also needs null/scalar payloads
    // intact to reject them before token mutation. Other routes stay strict.
    jsonStrict: (req) => !isCreateHubTokenTarget(req) && !isNotificationTarget(req),
    routes: {
      ...classicRoutes(hub, [...extra, { match: /^backup/i, handler: makeBackupHandler(backups, baseFor) }], {
        notificationAccountResolver,
      }),
      ...backupBlobRoutes(backups), // PUT/GET /backup/blob — the self-hosted store the URLs point at
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
  return { ...service, hub, wss, backups };
}

export function start(port = Number(process.env.PORT) || DefaultPort.classic) {
  return createClassicEntrypoint().listen(port);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch((e) => { console.error(e); process.exit(1); });
}
