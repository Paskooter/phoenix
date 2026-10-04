import { timingSafeEqual } from 'node:crypto';
import { sendJson } from '@phoenix/common';
import { requireUser } from '../../portal/session.js';

function peerAuthorized(req, token) {
  const supplied = req.headers['x-phoenix-internal-token'];
  if (!token || typeof supplied !== 'string') return false;
  const a = Buffer.from(token); const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function homeAssistantRoutes(store, broker, { peerToken = process.env.ETCO_account_internalPeerToken } = {}) {
  const wrap = (handler) => async (ctx) => {
    ctx.res.setHeader('cache-control', 'no-store');
    try { return await handler(ctx); }
    catch (error) { return sendJson(ctx.res, error.status || 500, { error: error.code || 'internal_error' }); }
  };
  const owner = (handler) => wrap((ctx) => {
    const account = requireUser(store, ctx.req, ctx.res);
    if (!account) return;
    return handler(ctx, account);
  });
  const peer = (handler) => wrap((ctx) => {
    if (!peerAuthorized(ctx.req, peerToken)) return sendJson(ctx.res, 403, { error: 'forbidden' });
    // Identity here is a private Gateway assertion obtained from its verified
    // socket, never an x-jibo-* header or the robot's request context.
    return handler(ctx);
  });
  return {
    'GET /api/home-assistant': owner((_ctx, account) => broker.status(account)),
    'POST /api/home-assistant/codes': owner(({ body }, account) => broker.issueCode(account, body.robotIds, body.name)),
    'DELETE /api/home-assistant/codes': owner((_ctx, account) => {
      for (const [id, row] of store.homeAssistantCodes) if (row.ownerId === account._id) store.homeAssistantCodes.delete(id);
      store.flush(); return {};
    }),
    'DELETE /api/home-assistant': owner(({ body, res }, account) => {
      const row = store.homeAssistantInstallations.get(body.installationId);
      if (!row || row.ownerId !== account._id) return sendJson(res, 404, { error: 'not_found' });
      broker.revoke(row); return {};
    }),
    'PUT /api/home-assistant/installation': owner(({ body }, account) =>
      broker.setAnnouncements(account, body.installationId, body.announcementsEnabled)),
    'POST /api/home-assistant/exchange': wrap(({ req, res, body }) => {
      if (!broker.allowExchange(req.socket.remoteAddress)) return sendJson(res, 429, { error: 'rate_limited' });
      return broker.exchangeCode(body.code);
    }),
    'DELETE /api/home-assistant/installation': wrap(({ req, res }) => {
      const row = broker.authenticate(req.headers.authorization);
      if (!row) return sendJson(res, 401, { error: 'invalid_auth' });
      broker.revoke(row, 'integration_removed'); return {};
    }),
    'POST /internal/home-assistant/selection': peer(({ body }) => broker.selectionDetails(body.identity)),
    'POST /internal/home-assistant/command': peer(({ body }) => broker.command(body.identity, body.text, body.language, body.route)),
    'POST /internal/home-assistant/robot-action/authorize': peer(({ body }) => broker.authorizeAction(body)),
  };
}
