# jiborobot/srv-entrypoint-socket-ws:src/clients/notification.client.ts

import { BaseClient, Boom, log } from "@jibo/server";

export default class NotificationClient extends BaseClient {
  private registry: any;
  private notificationBase: string;

  constructor({ registry }) {
    super();
    this.registry = registry;
    this.notificationBase = this.registry.get("notification");
    if (!this.notificationBase) {
      throw Boom.badImplementation("Notification service information not available.");
    }
  }

  public async findByToken(token) {
    const result = await this.wreckGet({
      uri: `http://${this.notificationBase}/token/${token}`,
    });
    log.debug("Robot token entity: %j for token", result, token);
    return result;
  }

  public async markAsDelivered(notificationId) {
    const result = await this.wreckDelete({
      headers: {},
      uri: `http://${this.notificationBase}/notification/${notificationId}`,
    });
    log.debug("Deleted message: ", notificationId);
    return result;
  }

  public async getNewNotifications(robotTokenIds) {
    return await this.wreckPost({
      payload: { ids: robotTokenIds },
      uri: `http://${this.notificationBase}/notifications/`,
    });
  }
}
