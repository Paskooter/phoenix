// Portal REST: OTA/update status, IFTTT, OAuth clients (surface 9).
//   - Update_20160301 (the OTA service, reached through the classic proxy) — status list.
//   - OAuth clients — the account service OWNS the oauthClients registry (OauthClients_20171108),
//     read directly from the store.
//   - IFTTT_20170207 — the classic IFTTT handler; the portal shows the account's IFTTT identity
//     and its applet (trigger) rows.

import { sendJson } from '@phoenix/common';
import { classicCall, ClassicCallError } from './classicClient.js';
import { requireUser } from './session.js';

// The subsystems a Jibo OTA package can target. `main` is the catalog's default for an
// omitted subsystem, so it is queried too — a deployment that publishes under it still shows up.
const UPDATE_SUBSYSTEMS = ['os', 'services', 'skills', 'main'];

function reportError(res, error) {
  if (error instanceof ClassicCallError) {
    return sendJson(res, error.status, { error: error.message, code: error.code, classicUnreachable: true });
  }
  return sendJson(res, 502, { error: String(error.message || error), classicUnreachable: true });
}

export function portalSystemRoutes(store, options = {}) {
  const classic = options.classicCall || classicCall;
  const base = options.classicBase;
  const forwarded = (account) => ({ id: account._id, email: account.email });

  return {
    // Update_20160301.ListUpdates — the catalog of packages the OTA service would offer a robot.
    // The source ALWAYS scopes a query to one subsystem and defaults an omitted one to "main"
    // (catalog.js _matchSubsystem), which is never a match-all. Sending `{}` therefore asks for
    // a subsystem no real package uses and always returns [] — the console shows "no updates
    // available" while a robot updates fine, because the robot asks per subsystem. Query the
    // real subsystems and concatenate.
    'GET /api/update/status': async ({ req, res }) => {
      const account = requireUser(store, req, res);
      if (!account) return;
      try {
        const lists = await Promise.all(UPDATE_SUBSYSTEMS.map((subsystem) => classic({
          base,
          account,
          credentials: forwarded(account),
          target: 'Update_20160301.ListUpdates',
          body: { subsystem },
        })));
        const updates = [];
        for (const result of lists) {
          if (Array.isArray(result.body)) updates.push(...result.body);
        }
        return { updates };
      } catch (error) {
        return reportError(res, error);
      }
    },

    'GET /api/oauthclients': ({ req, res }) => {
      const account = requireUser(store, req, res);
      if (!account) return;
      return { clients: [...store.oauthClients.values()].map((c) => ({
        id: c._id,
        name: c.name,
        clientId: c.clientId,
        description: c.description,
        created: c.created,
      })) };
    },

    'GET /api/ifttt': async ({ req, res }) => {
      const account = requireUser(store, req, res);
      if (!account) return;
      const out = { identity: null, applets: [] };
      try {
        const identity = await classic({
          base,
          account,
          credentials: forwarded(account),
          target: 'IFTTT_20170207.UserInfo',
          body: {},
        });
        out.identity = identity.body;
        if (identity.body && identity.body.id) {
          const triggers = await classic({
            base,
            account,
            credentials: forwarded(account),
            target: 'IFTTT_20170207.ListTriggers',
            body: { identity: identity.body.id },
          });
          out.applets = triggers.body || [];
        }
      } catch (error) {
        if (error instanceof ClassicCallError) {
          out.diagnostics = { code: error.code, message: error.message };
        }
      }
      return out;
    },
  };
}