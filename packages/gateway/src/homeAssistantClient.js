const uncertain = () => ({ outcome: 'uncertain', response_type: 'error', code: 'confirmation_lost', speech: '' });
const invalid = () => ({ outcome: 'error', response_type: 'error', code: 'invalid_command', speech: '' });
const CAPABILITIES = new Set(['room_context', 'state_queries', 'follow_up', 'routine_shortcuts']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function verifiedClaims(identity) {
  if (!identity || !['id', 'accessKeyId', 'friendlyId'].every((key) => typeof identity[key] === 'string' && identity[key])) return null;
  return { id: identity.id, accessKeyId: identity.accessKeyId, friendlyId: identity.friendlyId };
}

function commandRoute(route) {
  if (!route || !['command', 'query', 'follow_up', 'routine'].includes(route.kind)) return null;
  if (route.kind === 'routine') return typeof route.shortcut_id === 'string' && UUID.test(route.shortcut_id)
    ? { kind: route.kind, shortcut_id: route.shortcut_id } : null;
  return route.shortcut_id === undefined ? { kind: route.kind } : null;
}

export class HomeAssistantClient {
  constructor({ url, token, fetchImpl = fetch }) {
    this.url = url.replace(/\/$/, ''); this.token = token; this.fetch = fetchImpl;
  }

  async selection(identity) {
    const claims = verifiedClaims(identity);
    if (!claims) return false;
    try {
      const response = await this.fetch(`${this.url}/internal/home-assistant/selection`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-phoenix-internal-token': this.token },
        body: JSON.stringify({ identity: claims }), signal: AbortSignal.timeout(1000),
      });
      if (!response.ok) return false;
      const result = await response.json();
      if (result?.enabled !== true) return false;
      // Preferences and follow-up availability are non-executing hints from
      // Account's live binding. Keep neither hints nor conversation IDs here.
      return {
        enabled: true,
        capabilities: Array.isArray(result.capabilities)
          ? [...new Set(result.capabilities.filter((item) => CAPABILITIES.has(item)))] : [],
        shortcuts: Array.isArray(result.shortcuts) ? result.shortcuts.slice(0, 16).filter((item) =>
          typeof item?.id === 'string' && UUID.test(item.id) && typeof item.phrase === 'string'
          && item.phrase.trim() && item.phrase.length <= 80).map((item) => ({ id: item.id, phrase: item.phrase })) : [],
        follow_up: result.follow_up?.available === true && Number.isSafeInteger(result.follow_up.expires_at_ms)
          ? { available: true, expires_at_ms: result.follow_up.expires_at_ms } : { available: false },
      };
    } catch { return false; }
  }

  async command(identity, text, route = { kind: 'command' }) {
    // Only the socket's verified claims cross this private boundary. Do not
    // copy robot context, household IDs, or tracing headers into this request.
    const claims = verifiedClaims(identity);
    const metadata = commandRoute(route);
    if (!claims || !metadata || typeof text !== 'string' || !text.trim() || text.length > 500) return invalid();
    try {
      const response = await this.fetch(`${this.url}/internal/home-assistant/command`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-phoenix-internal-token': this.token },
        body: JSON.stringify({ identity: claims, text, language: 'en', route: metadata }), signal: AbortSignal.timeout(8500),
      });
      if (!response.ok) return uncertain();
      return await response.json();
    } catch { return uncertain(); }
  }
}
