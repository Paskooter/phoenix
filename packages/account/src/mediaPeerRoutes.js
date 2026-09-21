// Private Account peer route used by Classic Media_20160725.Remove.  Media
// may remove a record when the caller owns either the record itself or its
// loop; only Account owns the latter relationship.

import { sendJson } from '@phoenix/common';
import { timingSafeEqual } from 'node:crypto';

function internalPeerAuthorized(req, res) {
  const expected = process.env.ETCO_account_internalPeerToken;
  const presented = req?.headers?.['x-phoenix-internal-token'];
  if (!expected) {
    sendJson(res, 503, { error: 'internal peer authentication is not configured' });
    return false;
  }
  const left = Buffer.from(String(expected));
  const right = Buffer.from(typeof presented === 'string' ? presented : '');
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    sendJson(res, 401, { error: 'internal peer authentication failed' });
    return false;
  }
  return true;
}

/** Loop IDs owned by one account.  This route is intentionally not public. */
export function mediaPeerRoutes(store) {
  return {
    'GET /ownedLoops': ({ req, url, res }) => {
      if (!internalPeerAuthorized(req, res)) return;
      const accountId = url.searchParams.get('accountId');
      if (!accountId) return sendJson(res, 422, { error: 'accountId is required' });
      const loops = [...store.loops.values()]
        .filter((loop) => loop && loop.isDeleted !== true && String(loop.owner) === accountId)
        .map((loop) => String(loop._id));
      return { loops };
    },
  };
}
