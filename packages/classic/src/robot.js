// `robot` service (Robot_20160225) — robot manufacturing/lifecycle + read-state. The robot may
// read its cloud record at boot (GetRobot / GetCalibrationData). Phoenix keeps no separate robot
// registry beyond the account store's robot accounts, and **calibration lives on the robot's own
// /var** (not the cloud) for a Phoenix bring-up — so GetCalibrationData returns empty (the robot
// falls back to its local calibration, which is what we want). GetRobot returns the record shape
// from the account store when the robot is adopted, else an empty-but-valid record.
//
// Ops: GetRobot, GetCalibrationData, UpdateRobot, GetRobotHistory, GetFriendlyIds, RemoveRobot.

import { randomInt } from 'node:crypto';
import { sendAmz, sendAmzError, ValidationException } from './awsJson.js';

const ROBOT_NOT_FOUND = { code: 'ROBOT_NOT_FOUND', message: 'Robot not found', statusCode: 404 };

// A small word pool for GetFriendlyIds (provisioning). The real 4-word names came from a curated
// list; any pronounceable lowercase set works for stub provisioning.
const WORDS = ['castle', 'cylinder', 'fig', 'quilt', 'rocket', 'maple', 'pixel', 'comet', 'harbor',
  'lantern', 'pepper', 'violet', 'walnut', 'cobalt', 'ginger', 'meadow', 'pebble', 'saffron',
  'thistle', 'amber', 'breeze', 'cactus', 'domino', 'ember'];
const fourWords = () => Array.from({ length: 4 }, () => WORDS[randomInt(WORDS.length)]).join('-');

/**
 * @param {() => import('@phoenix/account').Store|null} getStore optional store accessor for
 *   resolving an adopted robot's record; pass () => null to run fully standalone.
 */
export function makeRobotHandler(getStore = () => null) {
  const findRobot = (id) => {
    const store = getStore();
    if (!store) return null;
    return store.accounts.get(id) || store.accountByFriendlyId(id) || null;
  };

  return function robotHandler({ res, op, body }) {
    const id = body && (body.id || body.serialNumber);
    switch (op.toLowerCase()) {
      case 'getrobot': {
        const robot = findRobot(id);
        return void sendAmz(res, 200, {
          id: id || (robot && robot._id) || '',
          payload: (robot && robot.payload) || {},
          calibrationPayload: {}, // cloud copy unused; robot uses local /var calibration
          created: (robot && robot.created) || null,
          updated: (robot && robot.updated) || null,
        });
      }
      case 'getcalibrationdata':
        return void sendAmz(res, 200, { id: id || '', calibrationPayload: {} });
      case 'updaterobot':
        return void sendAmz(res, 200, { result: 'Command accepted' });
      case 'getrobothistory':
        return void sendAmz(res, 200, { events: [] });
      case 'getfriendlyids': {
        const count = Math.max(1, Math.min(100, (body && body.count) || 1));
        return void sendAmz(res, 200, { pairs: Array.from({ length: count }, () => ({ friendlyId: fourWords() })) });
      }
      case 'removerobot':
        return void sendAmz(res, 200, { result: 'Command accepted' });
      default:
        return void sendAmzError(res, ValidationException, `unknown Robot operation: ${op}`);
    }
  };
}

export { ROBOT_NOT_FOUND };
