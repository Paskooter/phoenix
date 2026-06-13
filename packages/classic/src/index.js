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

export { createClassicRouter } from './router.js';
export * as awsJson from './awsJson.js';
export { logHandler } from './log.js';
export { makeRobotHandler } from './robot.js';
export { NotificationHub } from './notification.js';

const netUrl = (name, defPort) => {
  const v = process.env[`NET_${name}`];
  if (!v) return `http://localhost:${defPort}`;
  return /^https?:\/\//.test(v) ? v : `http://${v}`;
};

/** Build the entrypoint's route table. `extra` registrations are prepended (later iterations). */
export function classicRoutes(hub, extra = []) {
  const router = createClassicRouter([
    ...extra,
    { match: /^log/i, handler: logHandler },
    { match: /^robot/i, handler: makeRobotHandler() },
    { match: /^notification/i, handler: makeNotificationHandler(hub) },
    { match: /^oobe/i, proxyTo: () => netUrl('account', DefaultPort.account) },
    { match: /^account/i, proxyTo: () => netUrl('account', DefaultPort.account) },
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
export function createClassicEntrypoint({ extra = [] } = {}) {
  const hub = new NotificationHub();
  const service = createService({
    name: 'classic',
    routes: {
      ...classicRoutes(hub, extra),
      // Internal enqueue: push a notification to a robot's account (portal/system/tests use this).
      'POST /notify': ({ res, body }) => {
        if (!body || !body.accountId) return sendJson(res, 400, { error: 'accountId required' });
        const n = hub.enqueue(body.accountId, body.payload || {});
        return { queued: n._id };
      },
    },
  });
  const wss = attachNotificationSocket(service.server, hub);
  return { ...service, hub, wss };
}

export function start(port = Number(process.env.PORT) || DefaultPort.classic) {
  return createClassicEntrypoint().listen(port);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch((e) => { console.error(e); process.exit(1); });
}
