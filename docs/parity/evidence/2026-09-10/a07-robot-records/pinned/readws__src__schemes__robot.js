# jiborobot/srv-robots-read-ws:src/schemes/robot.js@decbbf7e959af3dabe2384940cb316b0689a18b4

import {mongoose} from '@jibo/server';

let robotSchema = new mongoose.Schema({
  _id: String,
  created: Date,
  updated: Date,
  payload: mongoose.Schema.Types.Mixed,
  calibrationPayload: mongoose.Schema.Types.Mixed,
  events: [{
    name: String,
    objectId: String,
    created: Date,
    payload: mongoose.Schema.Types.Mixed
  }]
});

robotSchema.postSave = function (doc, next) {
  next();
};

robotSchema.post('save', function (doc, next) {
  robotSchema.postSave(doc, next);
});

export default mongoose.model('Robot', robotSchema);
export {robotSchema};
