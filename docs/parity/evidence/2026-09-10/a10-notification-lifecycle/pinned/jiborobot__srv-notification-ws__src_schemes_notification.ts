# jiborobot/srv-notification-ws:src/schemes/notification.ts

import { mongoose } from "@jibo/server";

const notificationSchema = new mongoose.Schema({
  created: { type: Date, default: Date.now, index: { expireAfterSeconds: 300 } },
  payload: mongoose.Schema.Types.Mixed,
  skillId: String,
  tokenId: { type: mongoose.Schema.Types.ObjectId, ref: "Token" },
});

notificationSchema.index({ tokenId: 1, created: 1 });

export default mongoose.model("Notification", notificationSchema);
