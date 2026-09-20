// Portal REST: Gallery / Media (surface 6). The media store lives in the Classic entrypoint
// (`packages/classic/src/media.js`); the portal fronts it with the same SigV4 Media_20160725
// calls the app makes: List (/Get/Remove) plus a same-origin blob proxy so the browser can
// render byte content without reaching the classic port directly.

import { sendJson, signSigV4 } from '@phoenix/common';
import { pipeline } from 'node:stream/promises';
import {
  classicBaseUrl, classicCall, ClassicCallError, DEFAULT_REGION, DEFAULT_SERVICE,
} from './classicClient.js';
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

  // Classic's Remove endpoint permits an owner to remove media from any of
  // their loops when given a path.  The portal request also carries a
  // user-controlled loopId, so validate every requested parent path against
  // that exact loop before forwarding the destructive call.
  async function pathsInLoop(account, loop, paths) {
    const result = await classic({
      base,
      account,
      target: 'Media_20160725.Get',
      body: { paths },
    });
    const rows = Array.isArray(result.body) ? result.body : [];
    const allowed = new Set(rows
      .filter((row) => idsEqual(row?.loopId, loop._id) && paths.includes(String(row.path)))
      .map((row) => String(row.path)));
    return paths.every((path) => allowed.has(String(path)));
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
        if (!(await pathsInLoop(account, loop, paths))) {
          return sendJson(res, 403, { error: 'media does not belong to this loop', code: 'MEDIA_NOT_IN_LOOP' });
        }
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
      // Blob URLs are bearer-like paths.  Do not let any logged-in account
      // fetch an object merely because it can guess/learn its path; resolve it
      // through Classic's ownership-aware Get operation first.
      try {
        const result = await classic({
          base,
          account,
          target: 'Media_20160725.Get',
          body: { paths: [path] },
        });
        const rows = Array.isArray(result.body) ? result.body : [];
        if (!rows.some((row) => String(row?.path) === path)) {
          return sendJson(res, 404, { error: 'media not found' });
        }
      } catch (error) {
        if (error instanceof ClassicCallError) {
          return sendJson(res, error.status, { error: error.message, code: error.code });
        }
        throw error;
      }
      let upstream;
      try {
        const classicBase = base || classicBaseUrl();
        const blobPath = `/media/blob/${encodeURIComponent(path)}`;
        // The blob route is a direct Classic route rather than AWS-JSON, but
        // it is still an account-owned object.  Sign the empty GET just as we
        // sign the preceding Media.Get authorization check; otherwise the
        // portal would reintroduce an anonymous object-read bypass.
        const signed = signSigV4({
          method: 'GET',
          path: blobPath,
          headers: { host: new URL(classicBase).host },
          body: '',
          accessKeyId: account.accessKeyId,
          secretAccessKey: account.secretAccessKey,
          region: DEFAULT_REGION,
          service: DEFAULT_SERVICE,
        });
        upstream = await fetch(`${String(classicBase).replace(/\/+$/, '')}${blobPath}`, {
          headers: signed.headers,
        });
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
