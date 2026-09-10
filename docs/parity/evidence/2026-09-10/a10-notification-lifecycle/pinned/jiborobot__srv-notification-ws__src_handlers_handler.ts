# jiborobot/srv-notification-ws:src/handlers/handler.ts

import { Joi, log, parseCredentials, validatePayload } from "@jibo/server";
import Controller from "../controllers/ctrl";

export default class NotificationHandler {
  public mapping: any;
  private controller: Controller;

  constructor(controller: Controller) {
    this.controller = controller;
    this.mapping = {
      getStatus: { method: this.GetStatus },
      newRobotToken: { method: this.NewRobotToken },
    };
  }

  /**
   * Creates (or replaces existing) pushToken for pair calling account.
   * @return robotPushToken - string that is used by Jibo Robot internal API
   * to initiate WebSocket connection. Should not be pusblished to skills.
   */
  @parseCredentials({})
  @validatePayload({
    deviceId: Joi.string(), // NB:left for API backward compatibility
  })
  public async NewRobotToken(request) {
    log.debug("Generating new robot notification token.");
    const accountId = request.auth.credentials.id;
    const result = await this.controller.newToken({ accountId });
    log.debug("New Robot Token:", JSON.stringify(result));
    return {
      token: result.tokenKey,
    };
  }

  @parseCredentials({})
  @validatePayload({
    accountId: Joi.string().required(),
  })
  public async GetStatus(request) {
    // TODO: Check if requestor can get connected status for account
    return await this.controller.getStatus({
      accountId: request.payload.accountId,
    });
  }
}
