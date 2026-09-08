// srv-account-ws@6cea434: RobotClient and the post-save LoopCreated event.
import { normalizeInvitationProviders } from './invitationProviders.js';

export class RobotReadClient {
  constructor(endpoint = process.env.NET_robotread) { this.endpoint = endpoint; }
  async getRobot(friendlyId) {
    if (!this.endpoint) throw new Error('Robot read service is not configured');
    const endpoint = /^https?:/.test(this.endpoint) ? this.endpoint : `http://${this.endpoint}`;
    const response = await fetch(`${endpoint.replace(/\/$/, '')}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-amz-credentials': JSON.stringify({ isAdmin: true }), 'x-amz-target': 'Robot_20160225.GetRobot' },
      body: JSON.stringify({ id: friendlyId }),
    });
    if (!response.ok) throw new Error(`Robot read service returned ${response.status}`);
    const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    // Wreck json:true only decodes JSON MIME; a text response is not a robot object.
    if (!/^application\/([a-z0-9.]*[+-]json|json)$/.test(mime)) return Buffer.from(await response.arrayBuffer());
    return response.json();
  }
}
export class LoopCreated {
  constructor(payload) { this.payload = { ...payload, eventKey: 'LoopCreated' }; this.validate(); }
  validate() {
    for (const field of ['loopId', 'ownerId', 'robotId']) if (typeof this.payload[field] !== 'string' || !this.payload[field]) throw new TypeError(`${field} is required`);
  }
}
export function dispatchLoopCreated(loop, inputProviders) {
  const event = new LoopCreated({ loopId: String(loop._id), ownerId: String(loop.owner), robotId: String(loop.robot) });
  const providers = normalizeInvitationProviders(inputProviders), sender = providers.eventSender;
  const sent = typeof sender === 'function' ? sender(event) : sender?.send ? sender.send(event)
    : Promise.reject(new Error('LoopCreated transport unavailable'));
  Promise.resolve(sent).catch(error => { try { providers.onError?.(error, 'LoopCreated'); } catch {} });
}
