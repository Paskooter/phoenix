// Internal Account seam reproducing srv-key-ws's AccountClient membership lookup:
//   Loop_2016.ListLoopMembers  (src/clients/account.client.ts listMembers)
// (jiborobot/srv-key-ws@HEAD src/controllers/key.ctrl.ts getMemberIds/getSiblingIds)
//
// The Key service consults the caller's membership list for every loop-scoped operation:
//   * getMemberIds  — the caller (or a request's owning account) must be in the loop, else
//                     KEY_NOT_PART_OF_LOOP (403);
//   * getSiblingIds — the same, minus the caller, for ListIncomingRequests and Share.
// The original read that list from the Account service over the trusted internal hop; Phoenix
// exposes the same seam as an additive peer route next to GET /loop (backupPeerRoutes.js), so
// the Key membership checks resolve in a real deployment instead of always falling back to
// LAN trust.
//
// Scope mirrors the source: every member of the loop that carries an accountId (the controller
// itself filters on `member.accountId && member.loopId === loopId`). Member status is NOT
// filtered — ListLoopMembers is called with an empty payload, which selects every status.

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

export function keyPeerRoutes(store) {
  return {
    'GET /loopMembers': ({ req, url, res }) => {
      if (!internalPeerAuthorized(req, res)) return;
      const loopId = url.searchParams.get('loopId');
      const loop = loopId ? store.loops.get(loopId) : null;
      if (!loop || loop.isDeleted === true) {
        return sendJson(res, 404, { statusCode: 404, error: 'Not Found', message: 'Loop not found' });
      }
      const members = (Array.isArray(loop.members) ? loop.members : [])
        .filter((member) => member && member.accountId)
        .map((member) => String(member.accountId));
      return { id: loop._id, members };
    },
  };
}
