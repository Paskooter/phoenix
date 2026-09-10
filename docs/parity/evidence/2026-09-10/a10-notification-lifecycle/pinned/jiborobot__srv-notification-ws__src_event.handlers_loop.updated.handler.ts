# jiborobot/srv-notification-ws:src/event.handlers/loop.updated.handler.ts

import { events, log } from "@jibo/server";
import BaseEventHandler from "./base.event.handler";

export default class LoopUpdatedHandler extends BaseEventHandler {

  public async handle(evt) {
    log.debug("Handling:", JSON.stringify(evt, null, 2));
    const accountId = evt.payload.robot;
    if (accountId) {
      const skillId = "-1";
      const notification = {
        name: "LoopUpdated",
        payload: evt.payload,
      };
      this.ctrl.deliverNotification({ accountId, skillId, notification });
    }
    return Promise.resolve();
  }
}
