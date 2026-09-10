# jiborobot/srv-robots-read-ws:src/query.handlers/abstract.query.handler.js@decbbf7e959af3dabe2384940cb316b0689a18b4

import RobotController from "../controllers/robot.ctrl";

/**
 * Base for all query handlers
 */
class AbstractQueryHandler {
  constructor() {
    this.robotCtrl = new RobotController();
  }
  async handle({ objectId, options }) {
    return { objectId, options };
  }
  async getById(objectId) {
    return await this.robotCtrl.getById(objectId);
  }
  async findById(objectId) {
    return await this.robotCtrl.findById(objectId);
  }
}

export default AbstractQueryHandler;
