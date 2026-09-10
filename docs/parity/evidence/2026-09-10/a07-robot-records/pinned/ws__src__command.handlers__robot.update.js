# jiborobot/srv-robots-ws:src/command.handlers/robot.update.js@4c8b1b75f3e0ccb90fab160019637704ba62d36a

import AbstractCommandHandler from './abstract.cmd.handler';
import RobotRepository from '../repositories/robot.repo';
import AccountClient from '../clients/account.client';
import { Boom, events } from '@jibo/server';
import { ROBOT_OR_OWNER_ONLY, MANUFACTURING_ONLY } from '../errors/robot';

export default class RobotUpdateCommandHandler extends AbstractCommandHandler {
  constructor({ registry, eventSender, config }) {
    super();
    this.repo = new RobotRepository();
    this.accountClient = new AccountClient({ registry });
    this.eventSender = eventSender;
    this.config = config;
  }
  async validate({ objectId, payload, options }) {
    const isOwnerEditable = this.config.restrictedToOwner.some(propName => payload[propName]!==undefined);
    const restrictedToManufacturing = this.config.restrictedToManufacturing.some(propName => payload[propName]!==undefined);
    const robots = await this.accountClient.listRobots(options.ownerId, isOwnerEditable);
    if (!options.manufacturing && restrictedToManufacturing) {
      throw Boom.createWithCode(MANUFACTURING_ONLY);
    }
    if (!options.manufacturing && !robots.includes(objectId)) {
      throw Boom.createWithCode(ROBOT_OR_OWNER_ONLY);
    }
    await this.repo.getAggregate(objectId);
  }
  async handle({ objectId, payload, options }) {
    await this.validate({ objectId, payload, options });
    let updatedEvent = await this.eventCtrl.create({
      name: 'RobotUpdated',
      objectId,
      payload
    });
    this.eventSender.send(new events.RobotUpdated({
      payload,
      objectId,
      ownerId: options.ownerId
    }));
    this.eventBus.emit(updatedEvent);
  }
}
