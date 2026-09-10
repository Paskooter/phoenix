# jiborobot/srv-entrypoint-socket-ws:src/index.ts

import { App, log, EventSender } from '@jibo/server';//NB: It is required to load @jibo/server ASAP to let newrelik init properly
import Handler from './handlers/handler';
import SocketServer from './socket-server';

let eventSender;

new App({
  name: process.env.ETCO_server_name || 'socket',
  handlerFactory: (config, registry) => {
    //NOTE: Required to have HTTP healthcheck up
    return [ new Handler() ];
  },
  startInterceptor: (next, config, registry) => {
    eventSender = new EventSender({
      topicArn: config.server.sns.topicArn
    });
    new SocketServer({ config, registry, eventSender }).startDelivery();
    log.info('SocketServer started.');
    next();
  },
  defaultConfig: require('../config/config')
}).start();
