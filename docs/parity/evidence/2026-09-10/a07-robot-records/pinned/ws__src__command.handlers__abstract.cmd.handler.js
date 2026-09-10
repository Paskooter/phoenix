# jiborobot/srv-robots-ws:src/command.handlers/abstract.cmd.handler.js@4c8b1b75f3e0ccb90fab160019637704ba62d36a

import EventController from '../controllers/event.ctrl';
import EventBus from '../event.bus';

export default class CommandHandler {
  constructor() {
    this.eventCtrl = new EventController();
    this.eventBus = EventBus.instance;
  }
  async validate({ objectId, payload, options }) {
    return { objectId, payload, options };
  }
  async handle({ objectId, payload, options }) {
    await this.validate({ objectId, payload, options });
  }
}
