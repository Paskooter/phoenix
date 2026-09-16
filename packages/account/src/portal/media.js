// Portal REST: Gallery / Media (surface 6). The media store lives in the Classic entrypoint
// (`packages/classic/src/media.js`); the portal fronts it with the same SigV4 Media_20160725
// calls the app makes: List (/Get/Remove) plus a same-origin blob proxy so the browser can
// render byte content without reaching the classic port directly.

import { sendJson } from '@phoenix/common';
import { pipeline } from 'node:stream/promises';
import { classicCall, ClassicCallError } from './classicClient.js';
import { requireUser } from './session.js';

const SAFE_PATH = /^[A-Za-z0-9_-]+$/;

function idsEqual(a, b) {
  return a != null && b != null && String(a) === String(b);
}

export function portalMediaRoutes(store, options = {}) {
  const classic = options.classicCall || classicCall;
  const base = options.classicBase;

  async function loopOf(res, account, loopId) {
    const loop = loopId ? store.loops.get(loopId) : null;
    if (!loop || loop.isDeleted === true) {
      sendJson(res, 404, { error: 'Loop does not exist', code: 'LOOP_NOT_FOUND' });
      return null;
    }
    const member = (loop.members || []).some((m) => idsEqual(m.accountId, account._id)
      && String(m.status || '').toLowerCase() === 'accepted');
    if (!idsEqual(loop.owner, account._id) && !member) {
      sendJson(res, 403, { error: 'You must be a member of the loop', code: 'MEDIA_MUST_BE_MEMBER' });
      return null;
    }
    return loop;
  }

  return {
    'GET /api/media': async ({ req, res, url }) => {
      const account = requireUser(store, req, res);
      if (!account) return;
      const loopId = url.searchParams.get('loopId');
      const loop = await loopOf(res, account, loopId);
      if (!loop) return;
      try {
        const result = await classic({
          base,
          account,
          target: 'Media_20160725.List',
          body: { loopIds: [loop._id] },
        });
        return { media: result.body };
      } catch (error) {
        if (error instanceof ClassicCallError) {
          return sendJson(res, error.status, {
            error: error.message,
            code: error.code,
            classicUnreachable: true,
          });
        }
        throw error;
      }
    },

    'POST /api/media/remove': async ({ req, res, body }) => {
      const account = requireUser(store, req, res);
      if (!account) return;
      const { loopId, paths } = body || {};
      const loop = await loopOf(res, account, loopId);
      if (!loop) return;
      if (!Array.isArray(paths) || paths.length === 0 || paths.some((p) => typeof p !== 'string' || !p)) {
        return sendJson(res, 400, { error: 'paths must be a non-empty array of strings' });
      }
      try {
        const result = await classic({
          base,
          account,
          target: 'Media_20160725.Remove',
          body: { paths },
        });
        return { removed: result.body };
      } catch (error) {
        if (error instanceof ClassicCallError) {
          return sendJson(res, error.status, { error: error.message, code: error.code, classicUnreachable: true });
        }
        throw error;
      }
    },

    // Same-origin blob proxy: the classic object `url` is `<classic>/media/blob/<path>`; the
    // browser is served from the account origin, so re-serve the bytes here.
    'GET /api/media/blob/:path': async ({ req, res }) => {
      const account = requireUser(store, req, res);
      if (!account) return;
      const path = String(req.params.path || '');
      if (!SAFE_PATH.test(path)) { res.writeHead(400); res.end(); return; }
      let upstream;
      try {
        upstream = await fetch(`${String(base || '').replace(/\/+$/, '')}/media/blob/${path}`);
      } catch (error) {
        sendJson(res, 502, { error: `classic unreachable: ${error.message}` });
        return;
      }
      if (!upstream.ok) { res.writeHead(upstream.status); res.end(); return; }
      res.writeHead(200, { 'content-type': upstream.headers.get('content-type') || 'application/octet-stream' });
      await pipeline(upstream.body, res);
    },
  };
}