# jiborobot/srv-robots-read-ws:src/query.handlers/robot.history.js@decbbf7e959af3dabe2384940cb316b0689a18b4

import AbstractRobotHandler from './abstract.robot.handler';

/**
 * Retrieves robot modifications as collection of events
 */
class RobotHistoryQueryHandler extends AbstractRobotHandler {
  async handle({ objectId, options }) {
    this.validate({ objectId, options });
    const robot = await this.getById(objectId);
    return robot.events.map(event => ({
      id: event.objectId,
      name: event.name,
      created: new Date(event.created).getTime(),
      payload: event.payload
    }));
  }
}

export default RobotHistoryQueryHandler;
