const uncertain = () => ({ outcome: 'uncertain', response_type: 'error', code: 'confirmation_lost', speech: '' });

export class HomeAssistantClient {
  constructor({ url, token, fetchImpl = fetch }) {
    this.url = url.replace(/\/$/, ''); this.token = token; this.fetch = fetchImpl;
  }

  async selection(identity) {
    if (!identity?.id || !identity.accessKeyId || !identity.friendlyId) return false;
    try {
      const response = await this.fetch(`${this.url}/internal/home-assistant/selection`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-phoenix-internal-token': this.token },
        body: JSON.stringify({ identity }), signal: AbortSignal.timeout(1000),
      });
      return response.ok && (await response.json()).enabled === true;
    } catch { return false; }
  }

  async command(identity, text) {
    // Only the socket's verified claims cross this private boundary. Do not
    // copy robot context, household IDs, or tracing headers into this request.
    try {
      const response = await this.fetch(`${this.url}/internal/home-assistant/command`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-phoenix-internal-token': this.token },
        body: JSON.stringify({ identity, text, language: 'en' }), signal: AbortSignal.timeout(8500),
      });
      if (!response.ok) return uncertain();
      return await response.json();
    } catch { return uncertain(); }
  }
}
