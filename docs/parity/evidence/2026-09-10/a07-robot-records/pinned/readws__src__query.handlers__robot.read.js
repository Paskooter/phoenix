# jiborobot/srv-robots-read-ws:src/query.handlers/robot.read.js@decbbf7e959af3dabe2384940cb316b0689a18b4

import AbstractRobotHandler from './abstract.robot.handler';

/**
 * Retrieves robot actual state
 */
class RobotReadQueryHandler extends AbstractRobotHandler {
  async handle({ objectId, options }) {
    await this.validate({ objectId, options });
    const robot = await this.getById(objectId);
    const result = robot.toObject();
    result.id = result._id;
    delete result._id;
    delete result.events;
    delete result.calibrationPayload;
    result.payload = result.payload || {};
    if (result.created) {
      result.created = result.created.getTime();
    }
    if (result.updated) {
      result.updated = result.updated.getTime();
    }
    return result;
  }
}

export default RobotReadQueryHandler;
