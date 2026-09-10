# jiborobot/srv-robots-ws:src/controllers/event.ctrl.js@4c8b1b75f3e0ccb90fab160019637704ba62d36a

import Event from '../schemes/event';

export default class EventController {
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
  async create({ name, objectId, payload }) {
    objectId = this.convertId(objectId);
    return await Event.create({ name, objectId, payload });
  }
  async findByObjectId(objectId) {
    objectId = this.convertId(objectId);
    return await Event.find({ objectId }).sort({ created: 1 }).exec();
  }
  async find(condition) {
    if (condition.objectId) {
      condition.objectId = this.convertId(condition.objectId);
    }
    return await Event.find(condition).exec();
  }
  async remove(id) {
    id = this.convertId(id);
    await Event.findByIdAndRemove(id).exec();
  }
}
