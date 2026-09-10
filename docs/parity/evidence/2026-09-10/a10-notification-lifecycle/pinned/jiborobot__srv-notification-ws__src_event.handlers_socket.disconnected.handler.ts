# jiborobot/srv-notification-ws:src/event.handlers/socket.disconnected.handler.ts

import { EventListener, events, log } from "@jibo/server";
import BaseEventHandler from "./base.event.handler";

export default class SocketDisconnectedHandler extends BaseEventHandler {

  public async handle(evt) {
    log.debug("Handling:", evt);
    const accountId = evt.payload.accountId;
    return await this.ctrl.markDisconnected({ accountId });
  }
}
