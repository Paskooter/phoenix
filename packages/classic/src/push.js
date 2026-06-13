// `push` service (Push_20160729) — mobile push registration. The phone app registered its
// APNs/FCM token here (CreateDevice) so the cloud could push notifications to it; RemoveDevice
// unregistered. There is no real APNs/FCM and no surviving mobile app, so Phoenix records the
// registrations in-memory and returns success — delivery is a no-op (the robot-facing push goes
// over the entrypoint-socket instead). Build-to-spec; unverified without the app (DIVERGENCES).

import { sendAmz, sendAmzError, accessKeyIdFromAuth, ValidationException } from './awsJson.js';

export class DeviceRegistry {
  constructor() { this.devices = new Map(); } // name -> { name, pushToken, type, accountId }
  register(d) { this.devices.set(d.name, d); return d; }
  remove(name) { return this.devices.delete(name); }
}

export function makePushHandler(registry = new DeviceRegistry()) {
  return function pushHandler({ req, res, body, op, log }) {
    const accountId = accessKeyIdFromAuth(req) || 'anon';
    const b = body || {};
    switch (op.toLowerCase()) {
      case 'createdevice':
        if (!b.name) return void sendAmzError(res, ValidationException, 'name required');
        registry.register({ name: b.name, pushToken: b.pushToken, type: b.type, accountId });
        log?.info?.('push device registered (delivery is a no-op — no APNs/FCM)', { name: b.name, type: b.type });
        return void sendAmz(res, 200, {}); // empty output shape
      case 'removedevice':
        registry.remove(b.name);
        return void sendAmz(res, 200, {});
      default:
        return void sendAmzError(res, ValidationException, `unknown Push operation: ${op}`);
    }
  };
}
