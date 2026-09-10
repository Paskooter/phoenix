# jiborobot/srv-robots-ws:src/aggregates/robot.js@4c8b1b75f3e0ccb90fab160019637704ba62d36a

import AbstractAggregate from './abstract.aggregate';
import extend from 'extend';

class Robot extends AbstractAggregate {
  constructor(id, payload) {
    super(id);
    this.payload = payload || {};
    this.events = {
      RobotCreated: event => {
        this.payload = event.payload || {};
        this.created = event.created;
      },
      RobotUpdated: event => {
        extend(true, this.payload, event.payload);
        this.updated = event.created;
      },
      RobotDeleted: () => {
        this._deleted = true;
      },
      RobotCalibrated: event => {
        this.calibrationPayload = event.payload || {};
        this.updated = event.created;
      }
    };
  }
  toJs() {
    let result = {
      id: this.id,
      payload: this.payload,
      calibrationPayload: this.calibrationPayload
    };
    if (this.created) {
      result.created = new Date(this.created).getTime();
    }
    if (this.updated) {
      result.updated = new Date(this.updated).getTime();
    }
    return result;
  }
}

export default Robot;
