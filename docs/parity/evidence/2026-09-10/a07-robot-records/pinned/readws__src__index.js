# jiborobot/srv-robots-read-ws:src/index.js@decbbf7e959af3dabe2384940cb316b0689a18b4

//NB: It is required to load @jibo/server ASAP to let newrelik init properly
import { App, log, connectMongo, EventSender, events} from '@jibo/server';
import Handler from './handlers/robot.handler';
import EventBus from './event.bus';
import RobotEventHandler from './event.handlers/robot.event.handler';
import {robotSchema} from './schemes/robot';

const robotEventHandler = new RobotEventHandler();

new App({
  name:process.env.ETCO_server_name || 'robots-read',
  handlerFactory: (config, registry) => {
    const result = [
      new Handler({ config, registry })
    ];
    return result;
  },
  startInterceptor: (next, config, registry)=> {
    const eventSender = new EventSender({
      topicArn: config.server.sns.topicArn
    });
    connectMongo(()=> {
      EventBus.instance.on(async (event) => {
        log.info('Incoming event', { event });
        const isNotDuplicated = await robotEventHandler.checkEventDuplication(event);
        if(isNotDuplicated) {
          robotEventHandler.handlers[event.name](event).then(() => {
            log.info('Event processed', { event });
          }, err => {
            log.warn('Event failed to process', { event, err });
          });
        }
      });
      setupEntityTriggers({ eventSender: eventSender });
      next();
    }, config, registry);
  },
  defaultConfig: require('../config/config')
}).start();

function setupEntityTriggers({ eventSender }) {
  robotSchema.postSave = function (doc, next) {
    setImmediate(()=> {
      try {
        let evtBody = {
          id: doc._id.toString(),
          created: doc.created,
          updated: doc.updated,
          payload: doc.payload,
          calibrationPayload: doc.calibrationPayload
        };
        let evt = new events.RobotEntityUpdated(evtBody);
        eventSender.send(evt).then(data=> {
          log.debug('Sent RobotEntityUpdated event:', data);
        }).catch(err=> {
          log.error('Failed to send RobotEntityUpdated event:', err);
        });
      }catch (err) {
        log.error('Failed to perform Robot_postSave action. Err:', err);
      }
    });
    next();
  };
}
