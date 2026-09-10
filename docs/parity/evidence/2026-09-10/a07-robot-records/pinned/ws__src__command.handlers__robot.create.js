# jiborobot/srv-robots-ws:src/command.handlers/robot.create.js@4c8b1b75f3e0ccb90fab160019637704ba62d36a

import {Boom, log} from '@jibo/server';
import AbstractCommandHandler from './abstract.cmd.handler';
import RobotRepository from '../repositories/robot.repo';
import * as Errors from '../errors/robot';

export default class RobotCreateCommandHandler extends AbstractCommandHandler {
  constructor() {
    super();
    this.repo = new RobotRepository();
  }
  async validate({ objectId }) {
    let existing;
    try {
      existing = await this.repo.getAggregate(objectId);
    } catch (e) {
      log.silly('Ignoring error: ', e);
    }
    if (existing) {
      throw Boom.createWithCode(Errors.ENTITY_ALREADY_EXISTS);
    }
  }
  async handle({ objectId, payload }) {
    await this.validate({ objectId, payload });
    let createdEvent = await this.eventCtrl.create({
      name: 'RobotCreated',
      objectId,
      payload
    });
    this.eventBus.emit(createdEvent);
  }
}
