# jiborobot/srv-robots-ws:src/command.handlers/robot.calibrate.js@4c8b1b75f3e0ccb90fab160019637704ba62d36a

import AbstractCommandHandler from './abstract.cmd.handler';
import RobotRepository from '../repositories/robot.repo';

export default class RobotCalibrateCommandHandler extends AbstractCommandHandler {
  constructor() {
    super();
    this.repo = new RobotRepository();
  }
  async validate({ objectId }) {
    await this.repo.getAggregate(objectId);
  }
  async handle({ objectId, payload }) {
    let calibrateEvent = await this.eventCtrl.create({
      name: 'RobotCalibrated',
      objectId,
      payload
    });
    this.eventBus.emit(calibrateEvent);
  }
}
