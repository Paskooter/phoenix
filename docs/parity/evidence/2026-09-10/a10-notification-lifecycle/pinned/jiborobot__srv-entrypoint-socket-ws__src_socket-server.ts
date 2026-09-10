# jiborobot/srv-entrypoint-socket-ws:src/socket-server.ts

import WebSocket = require('ws');
import NotificationClient from './clients/notification.client';
import { log, events, EventSender } from '@jibo/server';

class SocketServer {
  private config: any;
  private server: WebSocket.Server;
  private controller: NotificationClient;
  private eventSender: EventSender;
  private connectionCache: any;
  private tokenCache: any;

  constructor({ config, registry, eventSender }) {
    this.config = config;
    this.server = new WebSocket.Server({ port: config.server.wsPort });
    log.info('Creating WebSocketServer at port: ', config.server.wsPort);
    this.controller = new NotificationClient({ registry });
    this.eventSender = eventSender;
    this.connectionCache = {};
    this.tokenCache = {};

    this.server.on('connection', ws => {
      this.onServerConnection(ws)
      .then((accountId) => {
        log.debug('Connection established with accountId:', accountId);
      }).catch(err => {
        log.error('Error happened during connection setup. Closing WS connection.:', err);
        ws.close(err.statusCode);
      });
    });
  }

  async onServerConnection(ws) {
    let url = ws.upgradeReq && ws.upgradeReq.url;
    log.info('WebSocket connection request received on URL:', url);
    let tokenKey = url && url.length && url.substring(url.lastIndexOf('/') + 1);

    let token;
    try{
      token = await this.controller.findByToken(tokenKey);
    }catch(err){
      log.debug('Failed to validate token:', tokenKey);
      throw err;
    }

    this.eventSender.send(new events.SocketConnected({
      accountId: token.accountId,
      token: token.token
    }));

    let tokenId = token._id;
    this.connectionCache[tokenId] = ws;
    this.tokenCache[tokenId] = token;
    ws.on('close', () => {
      log.info('WebSocket disconnected. accountId:', token.accountId);
      this.close(tokenId);
    });
    ws.on('ping', () => {
      if (process.env.ETCO_server_socket_logping) {
        log.debug('Ping for token %s, accountId:', tokenKey, token.accountId);
      }
    });
    ws.on('error', (data) => {
      log.error('Error for token %s, accountId: %s :', tokenKey, token.accountId, data.stack);
    });
    this.deliverAllPending(token);

    return token.accountId;
  }

  deliverAllPending(token) {
    let notifications = token.notifications;
    for (let notification of notifications) {
      this.deliver(token._id, notification);
    }
  }

  deliver(tokenId, notification) {
    let ws = this.connectionCache[tokenId];
    if (ws && ws.readyState === WebSocket.OPEN) {
      let message = JSON.stringify(notification);
      ws.send(message, err => {
        if (err) {
          log.debug('Error sending notificaiton (tokenId: %s, notification: %s). Will be retried next time.', tokenId, JSON.stringify(notification), err.stack);
        }else {
          this.controller.markAsDelivered(notification._id).then(n=> {
            log.debug('Mark notification as delivered for tokenId: %s.', tokenId, JSON.stringify(n));
          });
        }
      });
    } else {
      this.close(tokenId);
    }
  }

  close(tokenId) {
    let ws = this.connectionCache[tokenId];
    if (ws) {
      ws.close();
    }
    let token = this.tokenCache[tokenId];
    if (token) {
      this.eventSender.send(new events.SocketDisconnected({
        accountId: token.accountId,
        token: token.token
      }));
    }
    delete this.connectionCache[tokenId];
    delete this.tokenCache[tokenId];
  }

  startDelivery() {
    this.controller.getNewNotifications(Object.keys(this.connectionCache)).then(
      notifications => {
        if(notifications){
          log.debug('Got notifications:', JSON.stringify(notifications, null, 2));
          for (let notificationInfo of notifications) {
            this.deliver(notificationInfo.tokenId, notificationInfo.notification);
          }
        }
      },
      err => log.error('Error while updating notifications', err));
    setTimeout(this.startDelivery.bind(this), this.config.server.notification.frequency);
  }

}

export default SocketServer;
