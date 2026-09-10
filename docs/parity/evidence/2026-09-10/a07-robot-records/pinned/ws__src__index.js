# jiborobot/srv-robots-ws:src/index.js@4c8b1b75f3e0ccb90fab160019637704ba62d36a

import {App, connectMongo, EventSender} from '@jibo/server';//NB: It is required to load @jibo/server ASAP to let newrelik init properly
import Handler from './handlers/robot.handler';

const SERVER_NAME = process.env.ETCO_server_name || 'robots';

var eventSender;
var health = {
  ok: true
};
new App({
  name:SERVER_NAME,
  handlerFactory: (config, registry) => {
    const result = [
      new Handler({ config, registry, eventSender })
    ];
    return result;
  },
  healthcheck: (reply)=>{
    if (health.ok){
      reply(SERVER_NAME+' ok');
    }else{
      reply(health.msg).code(500);
    }
  },
  startInterceptor: (next, config, registry)=> {
    eventSender = new EventSender({
      topicArn: config.server.sns.topicArn
    });
    connectMongo(next, config, registry);
  },
  defaultConfig: require('../config/config')
}).start();
