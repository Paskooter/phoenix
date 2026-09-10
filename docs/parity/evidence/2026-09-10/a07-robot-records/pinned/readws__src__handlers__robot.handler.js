# jiborobot/srv-robots-read-ws:src/handlers/robot.handler.js@decbbf7e959af3dabe2384940cb316b0689a18b4

import { Joi, Boom, parseCredentials, validatePayload } from '@jibo/server';
import RobotFriendlyIdsQueryHandler from '../query.handlers/robot.friendly.ids';
import RobotHistoryQueryHandler from '../query.handlers/robot.history';
import RobotReadQueryHandler from '../query.handlers/robot.read';
import RobotCalibrateQueryHandler from '../query.handlers/robot.calibrate';
import * as Errors from '../errors/robot';
import AccountClient from '../clients/account.client';

/**
 * Attaches query handlers to passed object
 */
class RobotHandler {
  constructor({ registry }) {
    this.friendlyIdsQueryHandler = new RobotFriendlyIdsQueryHandler();
    this.robotHistoryQueryHandler = new RobotHistoryQueryHandler();
    this.robotReadQueryHandler = new RobotReadQueryHandler();
    this.robotCalibrateQueryHandler = new RobotCalibrateQueryHandler();
    this.accountClient = new AccountClient({ registry });

    this.mapping = {
      getRobotHistory: { method: this.GetRobotHistory },
      getRobot: { method: this.GetRobot },
      getCalibrationData: { method: this.GetCalibrationData },
      getFriendlyIds: { method: this.GetFriendlyIds }
    };
  }

  isManufacturingOrAdmin(request) {
    return request.auth && request.auth.credentials &&
      (request.auth.credentials.email === 'manufacturing@jibo.com' || request.auth.credentials.isAdmin);
  }

  async hasRobot(request) {
    const ownerId = request.auth.credentials.id;
    const robotId = request.payload.id;
    const robotIds = await this.accountClient.listRobots(ownerId);
    return robotIds.includes(robotId);
  }

  @parseCredentials({})
  @validatePayload({
    'id': Joi.string().required(),
    'serialNumber': Joi.string()
  })
  async GetRobotHistory(request) {
    if (!this.isManufacturingOrAdmin(request) && !(await this.hasRobot(request))) {
      throw Boom.createWithCode(Errors.MANUFACTURING_OR_OWNER_ONLY);
    }
    return await this.robotHistoryQueryHandler.handle({
      objectId: request.payload.id,
      options: { serialNumber: request.payload.serialNumber }
    });
  }

  @parseCredentials({})
  @validatePayload({
    'id': Joi.string().required(),
    'serialNumber': Joi.string()
  })
  async GetRobot(request) {
    if (!this.isManufacturingOrAdmin(request) && !(await this.hasRobot(request))) {
      throw Boom.createWithCode(Errors.MANUFACTURING_OR_OWNER_ONLY);
    }
    return await this.robotReadQueryHandler.handle({
      objectId: request.payload.id,
      options: { serialNumber: request.payload.serialNumber }
    });
  }

  @parseCredentials({})
  @validatePayload({
    'id': Joi.string().required(),
    'serialNumber': Joi.string()
  })
  async GetCalibrationData(request) {
    if (!this.isManufacturingOrAdmin(request) && !(await this.hasRobot(request))) {
      throw Boom.createWithCode(Errors.MANUFACTURING_OR_OWNER_ONLY);
    }
    return await this.robotCalibrateQueryHandler.handle({
      objectId: request.payload.id,
      options: { serialNumber: request.payload.serialNumber }
    });
  }

  @parseCredentials({})
  @validatePayload({
    'count': Joi.number().required()
  })
  async GetFriendlyIds (request) {
    if (!this.isManufacturingOrAdmin(request)) {
      throw Boom.createWithCode(Errors.MANUFACTURING_ONLY);
    }
    return await this.friendlyIdsQueryHandler.handle({ count: request.payload.count });
  }
}

export default RobotHandler;
