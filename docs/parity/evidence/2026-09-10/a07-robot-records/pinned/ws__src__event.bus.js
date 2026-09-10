# jiborobot/srv-robots-ws:src/event.bus.js@4c8b1b75f3e0ccb90fab160019637704ba62d36a

import {registry, log} from '@jibo/server';
import redis from 'redis';

const CHANNEL_NAME = 'events';

let singleton = Symbol();
let singletonEnforcer = Symbol();

export default class EventBus {
  constructor(enforcer) {
    if (enforcer !== singletonEnforcer) {
      throw new Error('Cannot construct EventBus');
    }
    let redisLocation = registry.get('redis');
    if (!redisLocation) {
      throw new Error('Redis not found (used for events pub/sub)');
    }
    const options = String(redisLocation).split(':');
    const host = options[0];
    const port = options[1];
    log.debug('Redis options: ', { host, port });
    this.publishClient = redis.createClient(port, host);
  }
  static get instance() {
    if (!this[singleton]) {
      this[singleton] = new EventBus(singletonEnforcer);
    }
    return this[singleton];
  }
  emit(event) {
    this.publishClient.publish(CHANNEL_NAME, JSON.stringify(event));
  }
}
