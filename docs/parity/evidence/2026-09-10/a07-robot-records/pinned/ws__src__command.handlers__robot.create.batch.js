# jiborobot/srv-robots-ws:src/command.handlers/robot.create.batch.js@4c8b1b75f3e0ccb90fab160019637704ba62d36a

import {log} from '@jibo/server';
import AbstractCommandHandler from './abstract.cmd.handler';
import RobotCreateCommandHandler from './robot.create';
import RobotRepository from '../repositories/robot.repo';

export default class RobotCreateBatchCommandHandler extends AbstractCommandHandler {
  constructor() {
    super();
    this.repo = new RobotRepository();
    this.createHandler = new RobotCreateCommandHandler();
  }
  async handle(requests) {
    await this.validate(requests);
    for (let request of requests) {
      try {
        this.createHandler.validate({ objectId: request.id, payload: request.payload });
        this.createHandler.handle({ objectId: request.id, payload: request.payload });
      } catch (e) {
        log.error('Ignoring error: ', e);
      }
    }
  }
}
