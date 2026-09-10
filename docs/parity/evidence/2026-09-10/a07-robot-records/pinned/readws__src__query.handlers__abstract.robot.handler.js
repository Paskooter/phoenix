# jiborobot/srv-robots-read-ws:src/query.handlers/abstract.robot.handler.js@decbbf7e959af3dabe2384940cb316b0689a18b4

import AbstractQueryHandler from './abstract.query.handler';
import { Boom } from '@jibo/server';
import * as Errors from '../errors/robot';


/**
 * Abstract robot retrieval and validation
 */
class AbstractRobotHandler extends AbstractQueryHandler {
  async validate({ objectId, options }) {
    if (options && options.serialNumber) {
      const robot = await this.getById(objectId);
      if (!robot.payload.serialNumber) {
        throw Boom.createWithCode(Errors.SERIAL_NUMBER_NOT_SET);
      } else if (robot.payload.serialNumber !== options.serialNumber) {
        // TODO: Send out notification on number mismatch once we have email service
        throw Boom.createWithCode(Errors.SERIAL_NUMBER_NOT_MATCH);
      }
    }
  }
}

export default AbstractRobotHandler;
