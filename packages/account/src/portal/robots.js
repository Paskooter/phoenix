// Portal REST: robot detail + service status (surface 4). The pairing flow (POST
// /api/robots/setup, GET /api/robots/setup/status, the QR renderer) is untouched and lives in
// portalApi.js alongside the list view. This module adds the loop robot's record and the
// Robot_20160225 read (manufacturing/read-state from the Classic entrypoint, the same way the
// app reads it).

import { sendJson } from '@phoenix/common';
import { classicCall, ClassicCallError } from './classicClient.js';
import { requireUser } from './session.js';

function idsEqual(a, b) {
  return a != null && b != null && String(a) === String(b);
}

function isAcceptedMember(loop, accountId) {
  return (loop.members || []).some((member) => idsEqual(member.accountId, accountId)
    && String(member.status || '').toLowerCase() === 'accepted');
}

export function portalRobotRoutes(store, options = {}) {
  const classic = options.classicCall || classicCall;
  const base = options.classicBase;

  return {
    // Loop robot detail: the robot Account record (from the account store) plus the Classic
    // Robot_20160225.GetRobot read projection for the friendly-id.
    'GET /api/robot': async ({ req, res, url }) => {
      const account = requireUser(store, req, res);
      if (!account) return;
      const loopId = url.searchParams.get('loopId');
      const loop = loopId ? store.loops.get(loopId) : null;
      // The native app presented a joined loop's Jibo details to accepted
      // members as well as its owner.  This portal projection never exposes
      // robot credentials, so use the same membership boundary instead of
      // showing a Details button which will always fail for a shared loop.
      if (!loop || loop.isDeleted === true
        || (!idsEqual(loop.owner, account._id) && !isAcceptedMember(loop, account._id))) {
        return sendJson(res, 404, { error: 'Loop does not exist', code: 'LOOP_NOT_FOUND' });
      }
      const robot = loop.robot ? store.accounts.get(loop.robot) : null;
      const out = {
        loop: {
          id: loop._id,
          name: loop.name,
          isSuspended: !!loop.isSuspended,
          members: (loop.members || []).length,
        },
        robot: robot ? {
          friendlyId: robot.friendlyId,
          isActive: !!robot.isActive,
          created: robot.created,
          lastSeen: robot.lastSeen || null,
        } : null,
      };
      if (!robot) return out;
      try {
        const classicResult = await classic({
          base,
          account,
          target: 'Robot_20160225.GetRobot',
          body: { id: robot.friendlyId },
        });
        out.getRobot = classicResult.body;
      } catch (error) {
        out.getRobot = null;
        out.diagnostics = { robotRecordError: error instanceof ClassicCallError ? {
          status: error.status, code: error.code, message: error.message,
        } : { message: String(error.message || error) } };
      }
      // Phoenix verifies loop membership before this route, then asks the
      // notification service with the robot's server-held credentials. The
      // source mobile client queried the robot account directly; doing it here
      // preserves the useful connection state without exposing a robot secret
      // or weakening the Classic caller boundary for arbitrary account ids.
      try {
        const connection = await classic({
          base,
          account: robot,
          target: 'Notification_20150505.GetStatus',
          body: { accountId: robot._id },
        });
        out.connection = connection.body;
      } catch (error) {
        out.diagnostics = {
          ...(out.diagnostics || {}),
          connectionError: error instanceof ClassicCallError ? {
            status: error.status, code: error.code, message: error.message,
          } : { message: String(error.message || error) },
        };
      }
      return out;
    },
  };
}
