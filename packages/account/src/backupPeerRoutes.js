// Internal Account seam reproducing srv-backup-ws's AccountClient.getLoop:
//   GET <account>/loop?loopId=<id>
// (jiborobot/srv-backup-ws@1153de1 src/clients/account.client.js:10-18). The Backup service
// reads `loop.robot` from that document and refuses the call unless it equals the caller's
// account id (ctrl.js:26-28,48-50), so the value must be the robot ACCOUNT id, not a friendly id.
//
// Additive peer route in the same spirit as settingsPeerRoutes: it exists only for the classic
// Backup service on the trusted internal hop.

import { sendJson } from '@phoenix/common';

export function backupPeerRoutes(store) {
  return {
    'GET /loop': ({ url, res }) => {
      const loopId = url.searchParams.get('loopId');
      const loop = loopId ? store.loops.get(loopId) : null;
      if (!loop || loop.isDeleted === true) {
        return sendJson(res, 404, { statusCode: 404, error: 'Not Found', message: 'Loop not found' });
      }
      return { id: loop._id, robot: loop.robot, owner: loop.owner, isSuspended: loop.isSuspended };
    },
  };
}
