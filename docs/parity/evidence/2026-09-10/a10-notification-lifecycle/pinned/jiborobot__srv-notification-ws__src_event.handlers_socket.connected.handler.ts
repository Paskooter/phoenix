# jiborobot/srv-notification-ws:src/event.handlers/socket.connected.handler.ts

import { events, log } from "@jibo/server";
import BaseEventHandler from "./base.event.handler";

export default class SocketConnectedHandler extends BaseEventHandler {

  public async handle(evt) {
    log.debug("Handling:", evt);
    const accountId = evt.payload.accountId;
    return await this.ctrl.markConnected({ accountId });
  }
}
