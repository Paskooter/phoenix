import { timingSafeEqual } from 'node:crypto';
import { sendJson } from '@phoenix/common';
import { robotIdentity } from './robotActionProtocol.js';

export function robotActionRoutes(bridge, { peerToken } = {}) {
  const peer = (handler) => async ({ req, res, body }) => {
    res.setHeader('cache-control', 'no-store');
    const supplied = req.headers['x-phoenix-internal-token'];
    const wanted = typeof peerToken === 'string' ? Buffer.from(peerToken) : null;
    const actual = typeof supplied === 'string' ? Buffer.from(supplied) : null;
    if (!wanted?.length || !actual || wanted.length !== actual.length || !timingSafeEqual(wanted, actual)) {
      return sendJson(res, 403, { error: 'forbidden' });
    }
    if (!robotIdentity(body?.identity)) return sendJson(res, 400, { error: 'unverified_robot' });
    const result = await handler(body);
    if (result?.outcome === 'error' && result.code === 'server_draining') {
      res.setHeader('retry-after', '5');
      return sendJson(res, 503, result);
    }
    return result;
  };
  return {
    'POST /internal/home-assistant/robot-action/status': peer((body) => bridge.status(body.identity)),
    'POST /internal/home-assistant/robot-action/announce': peer((body) => bridge.announce(body)),
  };
}
