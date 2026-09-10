# jiborobot/srv-notification-ws:src/schemes/token.ts

import { mongoose } from "@jibo/server";

const tokenSchema = new mongoose.Schema({
  accountId: { type: String, index: true },
  created: { type: Date, default: Date.now },
  lastConnected: { type: Date, default: new Date(2000, 0, 1) },
  tokenKey: { type: String, index: true },
  updated: { type: Date, default: Date.now },
});

tokenSchema.pre("save", function(next) {
  this.updated = Date.now();
  next();
});

export default mongoose.model("Token", tokenSchema);
