# jiborobot/srv-robots-read-ws:src/query.handlers/robot.calibrate.js@decbbf7e959af3dabe2384940cb316b0689a18b4

import AbstractRobotHandler from './abstract.robot.handler';

class RobotCalibrateQueryHandler extends AbstractRobotHandler {
  async handle({ objectId, options }) {
    await this.validate({ objectId, options });
    const robot = await this.getById(objectId);
    const result = robot.toObject();
    const response = {
      id: result._id,
      calibrationPayload: result.calibrationPayload
    };
    return response;
  }
}

export default RobotCalibrateQueryHandler;
