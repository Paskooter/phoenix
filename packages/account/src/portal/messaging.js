// Portal REST: Jot loop inbox + browser notifications + legacy push registrations (surface 8).
// All three live in the Classic entrypoint; the portal calls them with the account's signed
// identity. Push registration listing needs a thin read sidecar on the classic push handler
// (its AWS surface only has Create/Remove), added there as GET /push/devices.

import { signSigV4 } from '@phoenix/common';
import { DEFAULT_REGION, DEFAULT_SERVICE } from './classicClient.js';
import { sendJson } from '@phoenix/common';
import { classicCall, ClassicCallError } from './classicClient.js';
import { requireUser } from './session.js';
import { WebPushError } from '../webPush.js';

function idsEqual(a, b) {
  return a != null && b != null && String(a) === String(b);
}

export function portalMessagingRoutes(store, options = {}) {
  const classic = options.classicCall || classicCall;
  const base = options.classicBase;
  const blobBase = options.classicBase;
  const webPush = options.webPush;

  function webPushError(res, error) {
    if (error instanceof WebPushError) return sendJson(res, error.statusCode, { error: error.message });
    throw error;
  }

  function acceptedPeople(loop) {
    return (loop.members || []).filter((member) => String(member.status || '').toLowerCase() === 'accepted'
      && member.accountId && !idsEqual(member.accountId, loop.robot));
  }

  // Jot's `tags` are Account member ids (the `memberId` field in the original
  // populated-loop payload), not a private audience. Every accepted loop
  // member can list the loop's Jots; a tag says who the message is for and who
  // gets a prominent notification. Do not let a portal caller tag an account
  // outside this loop.
  function acceptedRecipientIds(loop) {
    return new Set([loop.owner, ...acceptedPeople(loop).map((member) => member.accountId)]
      .filter(Boolean)
      .map((id) => String(id)));
  }

  function loopRecipients(loop, senderId, tags = []) {
    const selected = new Set(tags.map(String));
    const accountIds = acceptedRecipientIds(loop);
    accountIds.delete(String(senderId));
    return [...accountIds].filter((id) => {
      const account = store.accounts.get(id);
      if (!account || account.isDeleted === true || account.isActive === false || account.messagingAllowed === false) return false;
      // Recovered Push settings behavior: source defaults an unset preference
      // to `tagged`; `always` alerts for every message other than the sender;
      // `none` produces no visible alert. Tags do not make a Jot private.
      const mode = ['always', 'tagged', 'none'].includes(account.jotNotificationMode)
        ? account.jotNotificationMode : 'tagged';
      return mode === 'always' || (mode === 'tagged' && selected.has(String(id)));
    });
  }

  async function loopOf(res, account, loopId) {
    const loop = loopId ? store.loops.get(loopId) : null;
    if (!loop || loop.isDeleted === true) {
      sendJson(res, 404, { error: 'Loop does not exist', code: 'LOOP_NOT_FOUND' });
      return null;
    }
    if (!idsEqual(loop.owner, account._id)
      && !(loop.members || []).some((m) => idsEqual(m.accountId, account._id)
        && String(m.status || '').toLowerCase() === 'accepted')) {
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
      const text = typeof content === 'string' ? content.trim() : content;
      if (!text && !Array.isArray(parts)) {
        return sendJson(res, 400, { error: 'A message or attachment is required', code: 'JOT_CONTENT_OR_PARTS_REQUIRED' });
      }
      const rawTags = body && body.tags;
      if (rawTags !== undefined && (!Array.isArray(rawTags)
        || rawTags.some((tag) => typeof tag !== 'string' || !tag || tag.length > 128))) {
        return sendJson(res, 400, { error: 'Recipients must be a list of member ids', code: 'JOT_INVALID_RECIPIENT' });
      }
      const tags = [...new Set(rawTags || [])];
      const allowedRecipients = acceptedRecipientIds(loop);
      if (tags.some((tag) => !allowedRecipients.has(tag))) {
        return sendJson(res, 400, { error: 'Recipients must be accepted people in this loop', code: 'JOT_INVALID_RECIPIENT' });
      }
      try {
        const result = await classic({
          base,
          account,
          target: 'Jot_20160512.CreateMessage',
          body: { loopId: loop._id, content: text, parts, tags },
        });
        // Web Push is supplementary: Classic is still the source of truth for
        // the message and a failed browser provider must never turn a sent
        // loop message into an API error. Do not include message text in
        // the payload; the recipient opens the authenticated console to read it.
        const recipients = loopRecipients(loop, account._id, tags);
        if (webPush && recipients.length) {
          void webPush.notifyAccounts(recipients, {
            title: 'New Jibo message',
            body: `There is a new Jibo message in ${loop.name || 'your loop'}.`,
            url: '/app#/inbox',
            tag: `jot-${loop._id}`,
          }).catch(() => {});
        }
        return { message: result.body };
      } catch (error) {
        if (error instanceof ClassicCallError) return sendJson(res, error.status, { error: error.message, code: error.code, classicUnreachable: true });
        throw error;
      }
    },

    // -- browser Web Push -----------------------------------------------------

    'GET /api/web-push': ({ req, res }) => {
      const account = requireUser(store, req, res);
      if (!account) return;
      if (!webPush) return { available: false, reason: 'not configured', subscriptions: [] };
      return webPush.status(account._id);
    },

    'POST /api/web-push/subscribe': ({ req, res, body }) => {
      const account = requireUser(store, req, res);
      if (!account) return;
      try {
        const subscription = webPush?.subscribe(account._id, body?.subscription, body?.label);
        return { subscription };
      } catch (error) {
        return webPushError(res, error);
      }
    },

    'POST /api/web-push/unsubscribe': ({ req, res, body }) => {
      const account = requireUser(store, req, res);
      if (!account) return;
      try {
        return webPush?.unsubscribe(account._id, body?.subscription) || { removed: false };
      } catch (error) {
        return webPushError(res, error);
      }
    },

    'POST /api/web-push/test': async ({ req, res }) => {
      const account = requireUser(store, req, res);
      if (!account) return;
      try {
        return await webPush?.sendTest(account._id) || { delivered: 0, skipped: true };
      } catch (error) {
        return webPushError(res, error);
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
        // Signed exactly like the portal's other Classic calls, so the sidecar resolves
        // identity through the same accessKeyIdFromAuth path as Push_20160729 itself.
        const pushPath = '/push/devices';
        const pushUrl = `${String(blobBase).replace(/\/+$/, '')}${pushPath}`;
        const signed = signSigV4({
          method: 'GET',
          path: pushPath,
          headers: { host: new URL(pushUrl).host },
          body: '',
          accessKeyId: account.accessKeyId,
          secretAccessKey: account.secretAccessKey,
          region: DEFAULT_REGION,
          service: DEFAULT_SERVICE,
        });
        // signSigV4 returns {headers, authorization, canonicalRequest, stringToSign};
        // `headers` is the map to send, with Authorization already folded in.
        const upstream = await fetch(pushUrl, { headers: signed.headers });
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
