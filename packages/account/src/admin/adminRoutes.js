// Admin operations API: who the administrators are, and what the server is doing.
//
//   GET    /api/admin/admins        every account, with its administrator flag
//   POST   /api/admin/admins        grant or revoke administrator access
//   GET    /api/admin/status        runtime facts and peer-service reachability
//
// Granting is the same operation scripts/portal-grant-admin.mjs performs — the
// `isAdmin` flag on the account, flushed to the store — so the two agree and
// neither is a second path with its own rules.

import { readEnvFile, envFilePath } from './envFile.js';
import { SERVICES } from './configCatalog.js';

/** Identity only. Never password material, access keys or secrets. */
function adminView(account) {
  return {
    id: String(account._id),
    email: account.email || null,
    firstName: account.firstName || '',
    lastName: account.lastName || '',
    isAdmin: !!account.isAdmin,
    isActive: account.isActive !== false,
    created: account.created || null,
  };
}

export function adminOpsRoutes(store, { requireAdmin, sendJson, currentAccount }) {
  return {
    'GET /api/admin/admins': ({ req, res }) => {
      if (!requireAdmin(store, req, res)) return;
      const accounts = [...store.accounts.values()]
        .filter((a) => !a.isDeleted)
        .map(adminView)
        // Administrators first, then by email, so the short list is at the top.
        .sort((a, b) => Number(b.isAdmin) - Number(a.isAdmin)
          || String(a.email || '').localeCompare(String(b.email || '')));
      return { accounts, adminCount: accounts.filter((a) => a.isAdmin).length };
    },

    'POST /api/admin/admins': ({ req, res, body }) => {
      if (!requireAdmin(store, req, res)) return;

      const email = body && typeof body.email === 'string' ? body.email.trim() : '';
      const grant = !!(body && body.grant);
      if (!email) return sendJson(res, 400, { error: 'email required' });

      const target = store.accountByEmail(email);
      if (!target) return sendJson(res, 404, { error: `no account with email ${email}` });

      const actor = currentAccount(store, req);

      // Removing your own access is a decision, not a slip, and a console that
      // lets you do it by accident is a console that locks you out of itself.
      if (!grant && actor && String(actor._id) === String(target._id)) {
        return sendJson(res, 400, {
          error: 'you cannot revoke your own administrator access from here — ask another '
            + 'administrator, or use scripts/portal-grant-admin.mjs',
        });
      }

      // The same guard one level up: never leave the instance with no way back in.
      if (!grant) {
        const remaining = [...store.accounts.values()]
          .filter((a) => !a.isDeleted && a.isAdmin && String(a._id) !== String(target._id));
        if (!remaining.length) {
          return sendJson(res, 400, {
            error: 'this is the only administrator — granting someone else access first keeps you '
              + 'from being locked out',
          });
        }
      }

      if (!!target.isAdmin === grant) {
        return { ok: true, changed: false, account: adminView(target) };
      }

      target.isAdmin = grant;
      store.flush();
      return { ok: true, changed: true, account: adminView(target) };
    },

    /**
     * What this process actually is, and whether it can see its peers.
     *
     * Every probe is a real request with a short timeout; nothing here is
     * inferred from configuration. A service that is configured but unreachable
     * is reported unreachable, which is the whole point of the page.
     */
    'GET /api/admin/status': async ({ req, res }) => {
      if (!requireAdmin(store, req, res)) return;

      const file = readEnvFile();
      const peers = await probePeers();

      return {
        runtime: {
          node: process.version,
          platform: `${process.platform} ${process.arch}`,
          pid: process.pid,
          uptimeSeconds: Math.round(process.uptime()),
          startedAt: Date.now() - Math.round(process.uptime() * 1000),
          cwd: process.cwd(),
          memoryMb: Math.round(process.memoryUsage().rss / 1048576),
        },
        config: {
          envFile: file.path,
          envFileExists: file.exists,
          envFileKeys: Object.keys(file.values).length,
          brandingFile: process.env.PHOENIX_BRANDING_FILE || null,
        },
        store: {
          accounts: store.accounts.size,
          loops: typeof store.loops?.size === 'number' ? store.loops.size : null,
          robots: typeof store.allRobots === 'function' ? store.allRobots().length : null,
        },
        peers,
      };
    },
  };
}

/** Probe every NET_-configured peer, concurrently, with a short timeout. */
async function probePeers() {
  const entries = Object.entries(SERVICES)
    .map(([id, meta]) => {
      const raw = process.env[`NET_${meta.compose}`] || process.env[`NET_${id}`];
      return raw ? { id, label: meta.label, target: normalize(raw) } : null;
    })
    .filter(Boolean);

  return Promise.all(entries.map(async (peer) => {
    const started = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      // A HEAD to the root is enough to know something is listening and
      // speaking HTTP. Any status counts as reachable — a 404 from a live
      // service is still a live service.
      const response = await fetch(peer.target, { method: 'HEAD', signal: controller.signal })
        .finally(() => clearTimeout(timer));
      return { ...peer, reachable: true, status: response.status, ms: Date.now() - started };
    } catch (error) {
      return {
        ...peer,
        reachable: false,
        ms: Date.now() - started,
        error: error.name === 'AbortError' ? 'timed out after 2s' : String(error.message || error),
      };
    }
  }));
}

function normalize(value) {
  return /^https?:\/\//.test(value) ? value : `http://${value}`;
}

export { envFilePath };
