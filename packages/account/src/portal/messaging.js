// Portal REST: Jot loop messaging + notifications + push registrations (surface 8).
// All three live in the Classic entrypoint; the portal calls them with the account's signed
// identity. Push registration listing needs a thin read sidecar on the classic push handler
// (its AWS surface only has Create/Remove), added there as GET /push/devices.

import { sendJson } from '@phoenix/common';
import { classicCall, ClassicCallError } from './classicClient.js';
import { requireUser } from './session.js';

function idsEqual(a, b) {
  return a != null && b != null && String(a) === String(b);
}

export function portalMessagingRoutes(store, options = {}) {
  const classic = options.classicCall || classicCall;
  const base = options.classicBase;
  const blobBase = options.classicBase;

  async function loopOf(res, account, loopId) {
    const loop = loopId ? store.loops.get(loopId) : null;
    if (!loop || loop.isDeleted === true) {
      sendJson(res, 404, { error: 'Loop does not exist', code: 'LOOP_NOT_FOUND' });
      return null;
    }
    if (!idsEqual(loop.owner, account._id)
      && !(loop.members || []).some((m) => idsEqual(m.accountId, account._id))) {
      sendJson(res, 403, { error: 'You must be a member of the loop', code: 'JOT_MUST_BE_LOOP_MEMBER' });
      return null;
    }
    return loop;
  }

  return {
    // -- Jot ------------------------------------------------------------------

    'GET /api/jot': async ({ req, res, url }) => {
      const account = requireUser(store, req, res);
      if (!account) return;
      const loopId = url.searchParams.get('loopId');
      const loop = await loopOf(res, account, loopId);
      if (!loop) return;
      try {
        const result = await classic({
          base,
          account,
          target: 'Jot_20160512.ListMessages',
          body: { loopId: loop._id },
        });
        return { messages: result.body };
      } catch (error) {
        if (error instanceof ClassicCallError) return sendJson(res, error.status, { error: error.message, code: error.code, classicUnreachable: true });
        throw error;
      }
    },

    'POST /api/jot/message': async ({ req, res, body }) => {
      const account = requireUser(store, req, res);
      if (!account) return;
      const loop = await loopOf(res, account, body && body.loopId);
      if (!loop) return;
      const content = body && body.content;
      const parts = body && body.parts;
      if (typeof content !== 'string' && !Array.isArray(parts)) {
        return sendJson(res, 400, { error: 'content is required' });
      }
      try {
        const result = await classic({
          base,
          account,
          target: 'Jot_20160512.CreateMessage',
          body: { loopId: loop._id, content, parts },
        });
        return { message: result.body };
      } catch (error) {
        if (error instanceof ClassicCallError) return sendJson(res, error.status, { error: error.message, code: error.code, classicUnreachable: true });
        throw error;
      }
    },

    // -- notifications ---------------------------------------------------------

    'GET /api/notifications': async ({ req, res }) => {
      const account = requireUser(store, req, res);
      if (!account) return;
      try {
        const result = await classic({
          base,
          account,
          target: 'Notification_20150505.GetStatus',
          body: { accountId: account._id },
        });
        return { status: result.body };
      } catch (error) {
        if (error instanceof ClassicCallError) return sendJson(res, error.status, { error: error.message, code: error.code, classicUnreachable: true });
        throw error;
      }
    },

    // -- push registrations ----------------------------------------------------

    // The raw access key is the push registry's account key (source push-ws keys AccountPush by
    // the signed access key). The portal reads the account's own devices through the classic
    // read sidecar (GET /push/devices) and removes one with the real Push_20160729.RemoveDevice.
    'GET /api/push': async ({ req, res }) => {
      const account = requireUser(store, req, res);
      if (!account) return;
      if (!blobBase) return sendJson(res, 502, { error: 'classic base not configured' });
      try {
        const upstream = await fetch(`${String(blobBase).replace(/\/+$/, '')}/push/devices`, {
          headers: { authorization: `portal-key ${account.accessKeyId}` },
        });
        const body = await upstream.json().catch(() => null);
        if (!upstream.ok) {
          return sendJson(res, upstream.status, { error: (body && body.error) || 'push list failed' });
        }
        return { devices: body && body.devices };
      } catch (error) {
        return sendJson(res, 502, { error: `classic unreachable: ${error.message}` });
      }
    },

    'POST /api/push/remove': async ({ req, res, body }) => {
      const account = requireUser(store, req, res);
      if (!account) return;
      if (!body || typeof body.name !== 'string' || !body.name) {
        return sendJson(res, 400, { error: 'name is required' });
      }
      try {
        const result = await classic({
          base,
          account,
          target: 'Push_20160729.RemoveDevice',
          body: { name: body.name },
        });
        return { devices: result.body };
      } catch (error) {
        if (error instanceof ClassicCallError) return sendJson(res, error.status, { error: error.message, code: error.code, classicUnreachable: true });
        throw error;
      }
    },
  };
}