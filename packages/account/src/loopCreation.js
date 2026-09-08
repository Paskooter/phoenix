// srv-account-ws@6cea434: RobotClient and the post-save LoopCreated event.
import { normalizeInvitationProviders } from './invitationProviders.js';
import { resolve as resolveUrl } from 'node:url';

const JSON_MIME = /^application\/([a-z0-9.]*[+-]json|json)$/;

function transportError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function timeoutError() {
  const error = transportError(504, 'Client request timeout');
  error.code = 'ETIMEDOUT';
  return error;
}

export class RobotReadClient {
  constructor(endpoint = process.env.NET_robotread) { this.endpoint = endpoint; }
  async getRobot(friendlyId) {
    if (!this.endpoint) throw new Error('Robot read service is not configured');
    const endpoint = /^https?:/i.test(this.endpoint) ? this.endpoint : `http://${this.endpoint}`;
    let url = `${endpoint.replace(/\/$/, '')}/`;
    // @jibo/server BaseClient uses these exact defaults for every Wreck request.
    // The request timer is cleared when response headers arrive; Wreck.read does not
    // apply this timer to a slow response body.
    let redirects = Number(process.env.ETCO_server_http_maxredirects || 3);
    if (!Number.isFinite(redirects) || redirects < 0) redirects = 3;
    // A string body makes WHATWG fetch synthesize text/plain. Wreck writes the
    // JSON string directly and leaves Content-Type absent, so pass its bytes.
    const payload = Buffer.from(JSON.stringify({ id: friendlyId }));

    // Wreck starts one header timer for the complete redirect chain. Intermediate
    // 3xx responses recurse without calling the shared finish callback, so that
    // timer remains active until the final response headers arrive.
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, process.env.ETCO_server_http_timeout || 60000);
    try {
      while (true) {
        let response;
        try {
          response = await fetch(url, {
            method: 'POST',
            // RobotClient passes a string payload to Wreck. Wreck therefore adds
            // content-length but does not add content-type; byte payloads preserve
            // that wire shape with WHATWG fetch.
            headers: {
              'x-amz-credentials': JSON.stringify({ isAdmin: true }),
              'x-amz-target': 'Robot_20160225.GetRobot',
            },
            body: payload,
            redirect: 'manual',
            signal: controller.signal,
          });
        } catch (error) {
          if (timedOut) throw timeoutError();
          throw error;
        }

        const redirect = response.status === 301 || response.status === 302
          || response.status === 307 || response.status === 308;
        if (redirect) {
          if (redirects === 0) {
            try { await response.body?.cancel(); } catch {}
            throw transportError(502, 'Maximum redirections reached');
          }
          const location = response.headers.get('location');
          try { await response.body?.cancel(); } catch {}
          if (!location) throw transportError(502, 'Received redirection without location');
          url = resolveUrl(url, location);
          redirects -= 1;
          continue;
        }

        // Source Wreck clears its request timer as soon as final headers arrive;
        // a slow body is consumed by Wreck.read without that header deadline.
        clearTimeout(timeout);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length === 0) {
          if (!response.ok) throw new Error(`Robot read service returned ${response.status}`);
          return null;
        }
        const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        // Wreck json:true only decodes JSON MIME; a text response remains a Buffer.
        const value = JSON_MIME.test(mime) ? JSON.parse(bytes.toString()) : bytes;
        if (!response.ok) throw new Error(`Robot read service returned ${response.status}`);
        return value;
      }
    } finally {
      clearTimeout(timeout);
    }
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
