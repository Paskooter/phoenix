# jiborobot/srv-robots-read-ws:src/controllers/robot.ctrl.js@decbbf7e959af3dabe2384940cb316b0689a18b4

import Robot from '../schemes/robot';
import extend from 'extend';
import deepEqual from 'deep-equal';
import { Boom } from '@jibo/server';
import * as Errors from '../errors/robot';

class RobotController {
  convertId(id) {
    if (!id) return id;
    const idParts = id.split('-');
    if (idParts.length !== 4) { // Not our usual robot id
      return id;
    }
    const idPartsPascalCased = idParts.map(idPart => {
      if (idPart.length === 0) {
        return idPart;
      }
      return idPart[0].toUpperCase() + idPart.substr(1).toLowerCase();
    });
    return idPartsPascalCased.join('-');
  }
  async create(event) {
    await Robot.create({
      _id: this.convertId(event.objectId),
      payload: event.payload,
      created: event.created,
      events: [event]
    });
  }
  async update(event) {
    let robot = await this.findById(event.objectId);
    robot.updated = event.created;
    robot.payload = robot.payload || {};
    extend(true, robot.payload, event.payload);
    robot.markModified('payload');
    robot.events.push(event);
    await robot.save();
  }
  async remove(event) {
    await Robot.findByIdAndRemove(this.convertId(event.objectId));
  }
  async calibrate(event) {
    let robot = await this.findById(event.objectId);
    robot.updated = event.created;
    robot.calibrationPayload = robot.calibrationPayload || {};
    extend(true, robot.calibrationPayload, event.payload);
    robot.markModified('calibrationPayload');
    robot.events.push(event);
    await robot.save();
  }
  async getById(objectId) {
    const robot = await this.findById(objectId);
    if (!robot) {
      throw Boom.createWithCode(Errors.ROBOT_NOT_FOUND);
    }
    return robot;
  }
  async findById(objectId) {
    return await Robot.findById(this.convertId(objectId));
  }
  async isEventDuplicated(event) {
    let robot = await this.findById(event.objectId);
    if(robot && robot.events) {
      return robot.events.some(robotEvent => {
        return robotEvent.name === event.name
          && robotEvent.objectId === event.objectId
          && robotEvent.created.getTime() === new Date(event.created).getTime()
          && deepEqual(robotEvent.payload, event.payload);
      });
    }
    return false;
  }
}

export default RobotController;
