# jiborobot/srv-robots-ws:src/repositories/abstract.repository.js@4c8b1b75f3e0ccb90fab160019637704ba62d36a

import EventController from '../controllers/event.ctrl';
import Aggregate from '../aggregates/abstract.aggregate';
import {Boom} from '@jibo/server';
import * as Errors from '../errors/robot';

export default class AbstractRepository {
  constructor() {
    this.eventCtrl = new EventController();
  }
  getEmptyAggregate(id) {
    return new Aggregate(id);
  }

  async getRawAggregate(id) {
    let events = await this.getEvents(id);
    let entity = this.getEmptyAggregate(id);
    for (let event of events) {
      entity.applyEvent(event);
    }
    return entity;
  }
  async getEvents(id) {
    let events = await this.eventCtrl.findByObjectId(id);
    if (!events.length) {
      throw Boom.createWithCode(Errors.ENTITY_NOT_FOUND);
    }
    return events;
  }
}
