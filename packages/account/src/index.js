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
import { staticRoutes } from './static.js';
import { createSettingsProviders } from './settingsProviders.js';

export { Store, getStore, resetStore } from './store.js';
export * as model from './model.js';
export { createHubToken, createAuthenticatedHubToken, secretMatches } from './model.js';
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
export { staticRoutes } from './static.js';

function isCreateHubTokenTarget(req) {
  return /\.createhubtoken$/i.test(String(req?.headers?.['x-amz-target'] || ''));
}

function isSettingsTarget(req) {
  return /^settings/i.test(String(req?.headers?.['x-amz-target'] || '').split('.').slice(0, -1).join('.'));
}

export function createAccountService({ store = getStore(), settingsProviders } = {}) {
  // The source Settings controller is always the production algorithm. Explicit provider
  // injection is reserved for tests; normal construction uses Phoenix storage/NET seams.
  const effectiveSettingsProviders = settingsProviders === undefined
    ? createSettingsProviders({ store }) : settingsProviders;
  return createService({
    name: 'account',
    // Hapi/Joi validates JSON primitives at the CreateHubToken handler.
    // Hapi also parses Settings payloads as JSON values before Joi rejects
    // top-level primitives with the source "value must be an object" error.
    // Keep the common strict parser for every other route.
    jsonStrict: (req) => !isCreateHubTokenTarget(req) && !isSettingsTarget(req),
    routes: {
      ...staticRoutes(),         // the portal UI (GET /, /admin, assets)
      ...portalRoutes(store),     // REST /api/* (sessions)
      ...settingsPeerRoutes(store), // internal Account client seams used by source Settings
      ...settingsPortalRoutes(store), // GET/PUT /api/settings (the report-settings editor)
      ...robotFaceRoutes(store, { settingsProviders: effectiveSettingsProviders }), // AWS-JSON POST / (OOBE ops + Update_* proxy to OTA)
    },
  });
}

export function start(port = Number(process.env.PORT) || DefaultPort.account) {
  return createAccountService().listen(port);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch((e) => { console.error(e); process.exit(1); });
}
