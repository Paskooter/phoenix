# jiborobot/srv-robots-ws:src/schemes/event.js@4c8b1b75f3e0ccb90fab160019637704ba62d36a

import {mongoose} from '@jibo/server';

const eventSchema = new mongoose.Schema({
  name: String,
  objectId: String,
  created: { type: Date, default: Date.now },
  payload: mongoose.Schema.Types.Mixed
});

eventSchema.index({ objectId: 1, created: -1 });

export default mongoose.model('Event', eventSchema);
