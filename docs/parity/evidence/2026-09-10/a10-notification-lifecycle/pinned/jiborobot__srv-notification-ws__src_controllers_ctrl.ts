# jiborobot/srv-notification-ws:src/controllers/ctrl.ts

import { Boom, events, EventSender, log, mongoose } from "@jibo/server";
import { randomBytes } from "crypto";
import { promisify } from "util";
import * as Errors from "../errors/errors";
import Notification from "../schemes/notification";
import Token from "../schemes/token";
const randomBytesA = promisify(randomBytes);

const DATE_IN_PAST = new Date(2000, 0, 1);
const NOTIFICATIONS_LIMIT = 100;

export default class Controller {
  private serviceSender: EventSender;

  constructor(serviceSender: EventSender) {
    this.serviceSender = serviceSender;
  }

  public async populateToken(token) {
    const result = token.toJSON();
    result.notifications = await this.findNotificationByTokenId(token._id);
    return result;
  }

  public async findNotificationByTokenId(tokenId) {
    return await Notification.find({ tokenId }).sort({ created: 1 }).limit(NOTIFICATIONS_LIMIT);
  }

  public async newToken({ accountId }) {
    const tokenKey = (await randomBytesA(64)).toString("hex");
    let token = await Token.findOne({ accountId });
    if (token) {
      token.tokenKey = tokenKey;
      await token.save();
    } else {
      token = await Token.create({
        accountId,
        tokenKey,
      });
    }
    return await this.populateToken(token);
  }

  public async deliverNotification({ accountId, skillId, notification }) {
    let token = await Token.findOne({ accountId });
    if (!token) {
      log.debug("Seems like account has not connected yet." +
       "Generating new Token entry to save notifications.");
      token = await this.newToken({ accountId });
    }
    const notificationObject = await Notification.create({
      payload: notification,
      skillId,
      tokenId: token._id,
    });
    try {
      await this.serviceSender.send(new events.SocketAcceptedForDelivery({
        accountId: token.accountId,
        created: token.created,
        notification: notificationObject,
        token: token.tokenKey,
        updated: token.updated,
      }));
    } catch (err) {
      // don"t fail overall notification if service  part fails for any reason
      log.error("Error sending service notification %j for token %j:",
        { accountId, skillId, notification }, token, err);
    }
  }

  public async markAsDelivered(notificationId) {
    const notification = await Notification.findById(notificationId);
    if (!notification) {
      return null;
    }
    return await notification.remove();
  }

  public async findByToken(tokenKey) {
    const token = await Token.findOne({ tokenKey });
    if (!token) {
      throw Boom.createWithCode(Errors.TOKEN_NOT_FOUND);
    }
    return await this.populateToken(token);
  }

  public async getNewNotifications(tokenIds) {
    const tokenObjectIds = tokenIds.map((tokenId) => new mongoose.Types.ObjectId(tokenId));
    const notifications = await this.findNotificationByTokenId({ $in : tokenObjectIds });
    return notifications.map((notification) => ({ tokenId: notification.tokenId.toString(), notification }));
  }

  public async markConnected({ accountId }) {
    return await Token.update(
      { accountId },
      { lastConnected: Date.now() },
      { multi: true });
  }

  public async markDisconnected({ accountId }) {
    return await Token.update(
      { accountId },
      { lastConnected: DATE_IN_PAST },
      { multi: true });
  }

  public async getStatus({ accountId }) {
    const runningConnection = await Token.findOne({
      accountId,
      lastConnected: { $gt: new Date(Date.now() - 24 * 3600 * 1000) },
    });
    return {
      connected: !!runningConnection,
    };
  }
}
