# jiborobot/srv-robots-ws:src/repositories/robot.repo.js@4c8b1b75f3e0ccb90fab160019637704ba62d36a

import AbstractRepository from './abstract.repository';
import Robot from '../aggregates/robot';
import {Boom} from '@jibo/server';
import * as Errors from '../errors/robot';

export default class RobotRepository extends AbstractRepository {
  getEmptyAggregate(id) {
    return new Robot(id);
  }
  async getAggregate(id) {
    let entity = await this.getRawAggregate(id);
    if (entity._deleted) {
      throw Boom.createWithCode(Errors.ENTITY_DELETED);
    }
    return entity;
  }
}
