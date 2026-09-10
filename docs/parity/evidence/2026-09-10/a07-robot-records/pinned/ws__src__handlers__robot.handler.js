# jiborobot/srv-robots-ws:src/handlers/robot.handler.js@4c8b1b75f3e0ccb90fab160019637704ba62d36a

import {Joi, Boom, parseCredentials, validatePayload} from '@jibo/server';
import RobotCreateCommandHandler from '../command.handlers/robot.create';
import RobotCreateBatchCommandHandler from '../command.handlers/robot.create.batch';
import RobotUpdateCommandHandler from '../command.handlers/robot.update';
import RobotDeleteCommandHandler from '../command.handlers/robot.delete';
import RobotCalibrateCommandHandler from '../command.handlers/robot.calibrate';
import * as Errors from '../errors/robot';

const COMMAND_ACCEPTED_RESPONSE = { result: 'Command accepted' };

export default class RobotHandler {
  constructor({ registry, eventSender, config }) {
    this.mapping = {
      removeRobot: { method: this.RemoveRobot },
      updateRobot: { method: this.UpdateRobot },
      createRobot: { method: this.CreateRobot },
      createRobotBatch: { method: this.CreateRobotBatch },
      calibrateRobot: { method: this.CalibrateRobot}
    };
    this.registry = registry;
    this.eventSender = eventSender;
    this.config = config;
  }

  isManufacturing(request) {
    return request.auth && request.auth.credentials && request.auth.credentials.email === 'manufacturing@jibo.com';
  }

  @parseCredentials({})
  @validatePayload({
    'id': Joi.string().required()
  })
  async RemoveRobot(request) {
    if (!this.isManufacturing(request)) {
      throw Boom.createWithCode(Errors.MANUFACTURING_ONLY);
    }
    await new RobotDeleteCommandHandler().handle({
      objectId: request.payload.id,
      payload: request.payload.payload
    });
    return COMMAND_ACCEPTED_RESPONSE;
  }

  @parseCredentials({})
  @validatePayload({
    'id': Joi.string().required(),
    'payload': Joi.object().unknown().required()
  })
  async UpdateRobot(request) {
    await new RobotUpdateCommandHandler({ registry: this.registry, eventSender: this.eventSender, config: this.config }).handle({
      objectId: request.payload.id,
      payload: request.payload.payload,
      options: {
        manufacturing: this.isManufacturing(request),
        ownerId: request.auth.credentials.id
      }
    });
    return COMMAND_ACCEPTED_RESPONSE;
  }

  @parseCredentials({})
  @validatePayload({
    'id': Joi.string().required(),
    'payload': Joi.object().unknown().required()
  })
  async CreateRobot(request) {
    if (!this.isManufacturing(request)) {
      throw Boom.createWithCode(Errors.MANUFACTURING_ONLY);
    }
    await new RobotCreateCommandHandler().handle({
      objectId: request.payload.id,
      payload: request.payload.payload
    });
    return COMMAND_ACCEPTED_RESPONSE;
  }

  @parseCredentials({})
  @validatePayload(Joi.array().items({
    'id': Joi.string().required(),
    'payload': Joi.object().unknown().required()
    }).required())
  async CreateRobotBatch(request) {
    if (!this.isManufacturing(request)) {
      throw Boom.createWithCode(Errors.MANUFACTURING_ONLY);
    }
    let createRobotBatchHandler = new RobotCreateBatchCommandHandler();
    await createRobotBatchHandler.handle(request.payload);
    return COMMAND_ACCEPTED_RESPONSE;
  }

  @parseCredentials({})
  @validatePayload({
    'id': Joi.string().required(),
    'calibrationPayload': Joi.object().unknown().required()
    })
  async CalibrateRobot(request) {
    if (!this.isManufacturing(request)) {
      throw Boom.createWithCode(Errors.MANUFACTURING_ONLY);
    }
    let calibrateRobotHandler = new RobotCalibrateCommandHandler();
    await calibrateRobotHandler.handle({
      objectId: request.payload.id,
      payload: request.payload.calibrationPayload
    });
    return COMMAND_ACCEPTED_RESPONSE;
  }
}
