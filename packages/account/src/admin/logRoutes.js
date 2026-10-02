// Admin log console API.
//
//   GET /api/admin/logs?since=&level=&ns=&limit=
//     -> { events: [...], cursor, dropped, buffered }
//
// The admin console polls this with the `cursor` it got back, so it renders the
// server's own log lines as they happen without a page reload.
//
// Why a cursor poll and not server-sent events: createService serialises a
// route's return value and ends the response (packages/common/src/service.js
// routeMiddleware), so a hanging SSE response would mean changing the shared
// service boundary for one admin screen. A poll is a few hundred bytes a second
// and cannot regress the request path.
//
// With PHOENIX_LOG_DIR configured, the native log reader includes every service
// and its retained rotations, surviving Account and whole-stack restarts.
// Without that directory the in-process buffer remains available:
//
//   * colocated stack (scripts/parity-robot/authenticated-stack.mjs) — every
//     service runs in ONE process, so this carries the hub, ASR, NLU, skills,
//     Classic and account lines together. This is the deployment where the log
//     console is genuinely a whole-server view.
//   * docker compose — each container is its own process, so this carries only
//     the account service's own lines. The other services' logs are in their own
//     containers (`docker compose logs <svc>`), not here.
//
// Level is a FILTER, not a verbosity switch: the buffer only ever holds lines the
// logger was already willing to emit, so `debug` entries appear only when the
// service runs at LOG_LEVEL=debug.
//
// Administrator-only, like every other /api/admin route.

import { recentLogs } from '@phoenix/common';
import { createFileLogReader } from './fileLogs.js';

const LEVEL_NAMES = ['error', 'warn', 'info', 'debug'];

export function adminLogRoutes(store, { requireAdmin, sendJson, env = process.env }) {
  const readFiles = env.PHOENIX_LOG_DIR ? createFileLogReader(env.PHOENIX_LOG_DIR) : null;
  return {
    'GET /api/admin/logs': async ({ req, res, url }) => {
      if (!requireAdmin(store, req, res)) return;

      const sinceRaw = url.searchParams.get('since');
      const since = Number.isFinite(Number(sinceRaw)) && sinceRaw !== null ? Number(sinceRaw) : 0;

      const levelParam = (url.searchParams.get('level') || '').toLowerCase();
      // An unknown level is rejected rather than ignored: silently showing
      // everything when someone asks for a level that does not exist would
      // misreport what is on screen.
      if (levelParam && !LEVEL_NAMES.includes(levelParam)) {
        return sendJson(res, 400, { error: `level must be one of ${LEVEL_NAMES.join(', ')}` });
      }

      const ns = url.searchParams.get('ns') || null;
      const limit = Number(url.searchParams.get('limit')) || 200;

      let page;
      try {
        page = readFiles ? await readFiles({ since: sinceRaw || 0, level: levelParam || null, ns, limit })
          : { ...recentLogs({ since, level: levelParam || null, ns, limit }), scope: 'process' };
      } catch {
        return sendJson(res, 503, { error: 'Retained service logs are unavailable' });
      }
      return {
        ...page,
        // What the caller actually has to know to interpret the result.
        levels: LEVEL_NAMES,
        levelIsFilterOnly: true,
      };
    },
  };
}
