// Admin-only voice-turn telemetry proxy.
//
// The useful turn ring lives in the gateway process, not Account: querying it
// here via a fixed, server-held proof keeps the browser on the normal
// session-gated /api/admin boundary. This route does not proxy arbitrary hub
// paths, headers, or responses.

import { randomBytes } from 'node:crypto';
import { voiceTurnTelemetryProof } from '@phoenix/common';

const QUERY_KEYS = ['turnId', 'from', 'to', 'outcome', 'stage', 'limit'];
const TIMEOUT_MS = 2500;
const TURN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STAGES = new Set(['context_wait', 'asr', 'nlu', 'route', 'skill', 'skill_redirect', 'history_launch', 'history_speech', 'response_ready', 'http_request']);
const OUTCOMES = new Set(['ok', 'matched', 'unmatched', 'remote_error', 'timeout', 'error', 'cancelled', 'abandoned', 'listen', 'skill', 'redirect']);

const safeNumber = (value) => Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
function safeTurn(value) {
  if (!value || !TURN_ID.test(value.turnId || '')) return null;
  const stages = Array.isArray(value.stages) ? value.stages
    .filter((stage) => STAGES.has(stage?.stage) && OUTCOMES.has(stage?.outcome))
    // Timestamp bounds are allow-listed numeric timing metadata.  Keep the
    // second projection here so Account never relays arbitrary hub fields.
    .map((stage) => ({
      stage: stage.stage,
      startedAt: safeNumber(stage.startedAt),
      endedAt: safeNumber(stage.endedAt),
      durationMs: safeNumber(stage.durationMs),
      outcome: stage.outcome,
    })) : [];
  const asr = value.asr && typeof value.asr === 'object' ? {
    audioMs: safeNumber(value.asr.audioMs),
    silenceWaitMs: safeNumber(value.asr.silenceWaitMs),
    recognizeMs: safeNumber(value.asr.recognizeMs),
  } : null;
  return {
    turnId: value.turnId,
    startedAt: safeNumber(value.startedAt),
    completedAt: safeNumber(value.completedAt),
    totalMs: safeNumber(value.totalMs),
    outcome: OUTCOMES.has(value.outcome) ? value.outcome : null,
    stages,
    asr,
  };
}
function safePage(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    turns: (Array.isArray(source.turns) ? source.turns : []).map(safeTurn).filter(Boolean).slice(0, 100),
    retained: safeNumber(source.retained) || 0,
    maxRetained: safeNumber(source.maxRetained) || 0,
    retentionMs: safeNumber(source.retentionMs) || 0,
    outcomes: (Array.isArray(source.outcomes) ? source.outcomes : []).filter((item) => OUTCOMES.has(item)),
    stages: (Array.isArray(source.stages) ? source.stages : []).filter((item) => STAGES.has(item)),
    scope: source.scope === 'gateway-process' ? source.scope : 'gateway-process',
  };
}

function hubUrl(env = process.env) {
  const raw = env.NET_hub || env.ETCO_account_hubUrl || '';
  if (!raw) return null;
  const base = /^https?:\/\//.test(raw) ? raw : `http://${raw}`;
  try { return new URL(base); } catch { return null; }
}

function copySafeQuery(source) {
  const target = new URLSearchParams();
  for (const key of QUERY_KEYS) {
    const value = source.get(key);
    if (value !== null) target.set(key, value);
  }
  return target;
}

/**
 * The Account service owns browser authentication. The hub only accepts an
 * HMAC proof derived from the deployment's HUB_TOKEN_SECRET; it sees neither
 * cookies nor user/account identity.
 */
export function adminVoiceTurnRoutes(store, { requireAdmin, sendJson, env = process.env, fetchImpl = fetch } = {}) {
  return {
    'GET /api/admin/voice-turns': async ({ req, res, url }) => {
      if (!requireAdmin(store, req, res)) return;
      const base = hubUrl(env);
      const secret = env.HUB_TOKEN_SECRET || env.ETCO_server_hubTokenSecret || '';
      if (!base || !secret) return sendJson(res, 503, { error: 'voice turn telemetry is unavailable' });

      const target = new URL('/v1/admin/voice-turns', base);
      target.search = copySafeQuery(url.searchParams).toString();
      const timestamp = String(Date.now());
      const nonce = randomBytes(24).toString('base64url');
      const proof = voiceTurnTelemetryProof(secret, {
        method: 'GET', target: `${target.pathname}${target.search}`, timestamp, nonce,
      });
      if (!proof) return sendJson(res, 503, { error: 'voice turn telemetry is unavailable' });
      try {
        const peer = await fetchImpl(target, {
          headers: {
            'x-phoenix-voice-turn-proof': proof,
            'x-phoenix-voice-turn-timestamp': timestamp,
            'x-phoenix-voice-turn-nonce': nonce,
          },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!peer.ok) return sendJson(res, peer.status === 400 ? 400 : 503, {
          error: peer.status === 400 ? 'invalid voice turn filter' : 'voice turn telemetry is unavailable',
        });
        // The hub endpoint is already an allow-listed projection. Do not pass
        // through an arbitrary upstream diagnostic body on a bad response.
        return safePage(await peer.json());
      } catch {
        return sendJson(res, 503, { error: 'voice turn telemetry is unavailable' });
      }
    },
  };
}

export { hubUrl as voiceTurnHubUrl };
