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

export { Store, getStore, resetStore } from './store.js';
export * as model from './model.js';
export * as sessions from './sessions.js';
export { portalRoutes } from './portalApi.js';
export { robotFaceRoutes } from './robotFace.js';

export function createAccountService({ store = getStore() } = {}) {
  return createService({
    name: 'account',
    routes: {
      ...portalRoutes(store),
      ...robotFaceRoutes(store), // AWS-JSON POST / (OOBE ops + Update_* proxy to OTA)
    },
  });
}

export function start(port = Number(process.env.PORT) || DefaultPort.account) {
  return createAccountService().listen(port);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch((e) => { console.error(e); process.exit(1); });
}
