import { timingSafeEqual } from 'node:crypto';
import { WebSocket } from 'ws';
import { sendJson } from '@phoenix/common';

// Read live authenticated notification socket presence only. This endpoint
// never enqueues or delivers announcements through the durable notification hub.
export function homeAssistantPresenceRoutes(hub, {
  callerBoundary, peerToken = process.env.ETCO_account_internalPeerToken,
} = {}) {
  return {
    'POST /internal/home-assistant/robot-presence': ({ req, res, body }) => {
      res.setHeader('cache-control', 'no-store');
      const supplied = req.headers['x-phoenix-internal-token'];
      if (typeof peerToken !== 'string' || !peerToken || typeof supplied !== 'string') {
        return sendJson(res, 403, { error: 'forbidden' });
      }
      const expected = Buffer.from(peerToken); const actual = Buffer.from(supplied);
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        return sendJson(res, 403, { error: 'forbidden' });
      }
      // Account asserts this identity after live ownership/binding checks. The
      // peer token does not turn a public caller's robot/account claims into auth.
      const identity = body?.identity;
      if (!identity || ['id', 'accessKeyId', 'friendlyId'].some((key) => typeof identity[key] !== 'string'
        || !identity[key] || identity[key].length > 200 || /[\u0000-\u001f\u007f]/.test(identity[key]))) {
        return sendJson(res, 400, { error: 'unverified_robot' });
      }
      if (typeof callerBoundary !== 'function') return { online: false };
      const online = [...hub.sockets].some(([tokenId, socket]) => socket.readyState === WebSocket.OPEN
        && hub.tokenCache.get(tokenId)?.accountId === identity.id);
      return { online };
    },
  };
}
