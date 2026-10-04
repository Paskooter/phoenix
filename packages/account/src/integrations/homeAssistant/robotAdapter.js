// Account asserts a live, owner-bound identity to the private Gateway peer.
// This transport never queues, retries, or substitutes delivery for spoken ack.
const offline = () => ({ online: false, busy: false, announcements_supported: false });
const unavailable = () => ({ outcome: 'error', code: 'robot_offline' });
const uncertain = () => ({ outcome: 'uncertain', code: 'confirmation_lost' });
const MAX_TIMEOUT_MS = 45_000;

function adapterUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed = new URL(/^https?:\/\//.test(value) ? value : `http://${value}`);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
      || parsed.search || parsed.hash || (parsed.pathname !== '/' && parsed.pathname !== '')) return null;
    return parsed.origin;
  } catch { return null; }
}

export function createRobotAnnouncementAdapter({
  env = process.env, url = env.NET_hub || env.ETCO_account_hubUrl,
  classicUrl = env.NET_classic || env.ETCO_account_classicUrl,
  token = env.ETCO_account_internalPeerToken, fetchImpl = fetch, now = Date.now,
} = {}) {
  const base = adapterUrl(url);
  const classic = adapterUrl(classicUrl);
  const enabled = !!base && typeof token === 'string' && !!token;
  const presenceEnabled = !!classic && typeof token === 'string' && !!token;
  const headers = { 'content-type': 'application/json', 'x-phoenix-internal-token': token || '' };
  const statusFrom = async (target, identity) => {
    if (!target) return null;
    try {
      const response = await fetchImpl(target, { method: 'POST', headers,
        body: JSON.stringify({ identity }), signal: AbortSignal.timeout(1000) });
      return response.ok ? await response.json() : null;
    } catch { return null; }
  };
  return {
    async status(identity) {
      if (!enabled && !presenceEnabled) return offline();
      const [native, presence] = await Promise.all([
        statusFrom(enabled ? `${base}/internal/home-assistant/robot-action/status` : null, identity),
        statusFrom(presenceEnabled ? `${classic}/internal/home-assistant/robot-presence` : null, identity),
      ]);
      return { online: native?.online === true || presence?.online === true,
        busy: native?.busy === true, announcements_supported: native?.announcements_supported === true };
    },
    async announce(input) {
      if (input && Object.hasOwn(input, 'volume')) return { outcome: 'error', code: 'unsupported_volume' };
      if (!enabled) return unavailable();
      const remaining = input?.deadline - now();
      if (!Number.isSafeInteger(input?.deadline) || remaining > MAX_TIMEOUT_MS) {
        return { outcome: 'error', code: 'invalid_request' };
      }
      if (remaining <= 0) return { outcome: 'error', code: 'expired' };
      try {
        const response = await fetchImpl(`${base}/internal/home-assistant/robot-action/announce`, {
          method: 'POST', headers, body: JSON.stringify(input), signal: AbortSignal.timeout(remaining + 1000),
        });
        const result = await response.json();
        if (!response.ok) {
          // The admission barrier can prove that no native job was sent. Its
          // Retry-After header is informational; this transport never retries.
          if (response.status === 503 && result.outcome === 'error' && result.code === 'server_draining') {
            return { outcome: 'error', code: 'server_draining' };
          }
          return uncertain();
        }
        if (result.outcome === 'success' && result.confirmed === true) return { outcome: 'success', confirmed: true };
        if (['error', 'uncertain'].includes(result.outcome)
          && typeof result.code === 'string' && /^[a-z_]{1,40}$/.test(result.code)) {
          return { outcome: result.outcome, code: result.code };
        }
        return uncertain();
      } catch { return uncertain(); }
    },
  };
}
