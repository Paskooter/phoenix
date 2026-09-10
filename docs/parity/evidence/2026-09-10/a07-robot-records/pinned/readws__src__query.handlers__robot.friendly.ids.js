# jiborobot/srv-robots-read-ws:src/query.handlers/robot.friendly.ids.js@decbbf7e959af3dabe2384940cb316b0689a18b4

import AbstractQueryHandler from './abstract.query.handler';
import { randomlyGenerateCombos } from '@jibo/serial-names';
import { Boom } from '@jibo/server';
import * as Errors from '../errors/robot';

/**
 * Gets friendly ids that can later be used for robots creation
 */
class RobotFriendlyIdsQueryHandler extends AbstractQueryHandler {
  async handle({ count }) {
    const newIds = [];
    let limit = count * 1000;
    while (newIds.length < count) {
      const newId = randomlyGenerateCombos('bla bla', '-', 25, 1)[0];
      const existing = await this.findById(newId);
      if (!existing && !newIds.includes(newId)) {
        newIds.push(newId);
      } else {
        limit = limit - 1;
      }
      if (limit < 0) {
        throw Boom.createWithCode(Errors.ROBOT_NAMES_NOT_GENERATED);
      }
    }
    return newIds.map(id => ({ id }));
  }
}

export default RobotFriendlyIdsQueryHandler;
