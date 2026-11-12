// Admin-only fixed-target proxy for recognizer health and audio usage counts.
// The second allow-list prevents upstream text, credentials, URLs or project IDs
// from reaching the console even if a future gateway adds them to its status object.
import { randomBytes } from 'node:crypto';
import { voiceTurnTelemetryProof } from '@phoenix/common';
import { voiceTurnHubUrl } from './voiceTurnRoutes.js';

const MODES = new Set(['parakeet', 'auto', 'google', 'openrouter', 'custom']);
const FALLBACKS = new Set(['openrouter', 'custom', 'google']);
const MODELS = new Set(['chirp_3', 'chirp_2', 'short', 'long', 'telephony', 'telephony_short']);
const LOCATIONS = new Set(['us', 'eu', 'global', 'us-central1', 'europe-west4', 'asia-southeast1']);
const FAILURES = new Set(['configuration', 'credentials', 'client-missing', 'quota', 'transient', 'budget', 'busy', 'audio-limit']);
const USAGE_PROBLEMS = ['no-usage-file', 'usage-file-missing', 'usage-file-unreadable', 'usage-file-invalid',
  'usage-file-unwritable', 'usage-file-busy', 'usage-clock-backwards'];
const PROBLEMS = new Set(['not-configured', 'disabled', 'invalid-model-or-location', 'invalid-budget',
  ...USAGE_PROBLEMS, ...FAILURES]);
/** OpenRouter / your own speech server (gateway openAiCompatibleTransport.js, transcriptionUsage.js). */
const STT_FAILURES = new Set(['credentials', 'payment', 'configuration', 'too-long', 'rate-limited', 'server',
  'timeout', 'invalid-response', 'unreachable']);
const STT_PROBLEMS = new Set(['no-key', 'no-url', 'invalid-url', 'invalid-budget', 'disabled', 'not-openrouter',
  'monthly-limit', 'daily-limit', 'monthly-minutes', 'too-many-reservations', ...USAGE_PROBLEMS, ...STT_FAILURES]);
const number = (v) => Number.isSafeInteger(v) && v >= 0 ? v : null;
const allowed = (set, value) => set.has(value) ? value : null;
/** A model name, as an administrator typed or chose it: printable, no spaces. */
const modelName = (v) => typeof v === 'string' && /^[\x21-\x7e]{1,200}$/.test(v) && !/^[a-z]+:\/\//i.test(v) ? v : null;
const languageCode = (v) => typeof v === 'string' && /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/i.test(v) ? v : null;

function safeSttStatus(p) {
  if (!p || typeof p !== 'object') return null;
  const u = p.usage; const f = p.lastFailure;
  return {
    configured: p.configured === true,
    unavailable: allowed(STT_PROBLEMS, p.unavailable),
    model: modelName(p.model),
    language: languageCode(p.language),
    lastFailure: f ? { kind: allowed(STT_FAILURES, f.kind), at: number(f.at), until: number(f.until) } : null,
    usage: u ? {
      month: /^\d{4}-\d{2}$/.test(u.month || '') ? u.month : null,
      day: /^\d{4}-\d{2}-\d{2}$/.test(u.day || '') ? u.day : null,
      usedMicroUsd: number(u.usedMicroUsd), limitMicroUsd: number(u.limitMicroUsd),
      dayUsedMicroUsd: number(u.dayUsedMicroUsd), dayLimitMicroUsd: number(u.dayLimitMicroUsd),
      usedSeconds: number(u.usedSeconds), limitSeconds: number(u.limitSeconds),
      requests: number(u.requests), reservedMicroUsd: number(u.reservedMicroUsd),
      exhausted: allowed(new Set(['month', 'day', 'minutes']), u.exhausted),
      problem: allowed(STT_PROBLEMS, u.problem),
    } : null,
  };
}

export function safeAsrStatus(source) {
  if (!source || !MODES.has(source.mode)) return null;
  const g = source.google; const u = g?.usage; const p = source.parakeet;
  const out = {
    mode: source.mode,
    parakeet: p ? { state: allowed(new Set(['unknown', 'up', 'down']), p.state), since: number(p.since), recheckMs: number(p.recheckMs) } : null,
    google: g ? {
      configured: g.configured === true, unavailable: allowed(PROBLEMS, g.unavailable),
      model: allowed(MODELS, g.model), location: allowed(LOCATIONS, g.location), activeStreams: number(g.activeStreams),
      lastFailure: g.lastFailure ? { kind: allowed(FAILURES, g.lastFailure.kind), at: number(g.lastFailure.at) } : null,
      usage: u ? {
        month: /^\d{4}-\d{2}$/.test(u.month || '') ? u.month : null,
        day: /^\d{4}-\d{2}-\d{2}$/.test(u.day || '') ? u.day : null,
        usedSeconds: number(u.usedSeconds), limitSeconds: number(u.limitSeconds),
        dayUsedSeconds: number(u.dayUsedSeconds), dayLimitSeconds: number(u.dayLimitSeconds),
        reservedSeconds: number(u.reservedSeconds), problem: allowed(PROBLEMS, u.problem),
        exhausted: allowed(new Set(['month', 'day']), u.exhausted),
      } : null,
    } : null,
  };
  // Older voice gateways report none of these; leave them out rather than guess.
  if (source.fallbackOrder !== undefined) {
    out.fallbackOrder = Array.isArray(source.fallbackOrder)
      ? [...new Set(source.fallbackOrder.filter((name) => FALLBACKS.has(name)))] : null;
  }
  if (source.openrouter !== undefined) out.openrouter = safeSttStatus(source.openrouter);
  if (source.custom !== undefined) out.custom = safeSttStatus(source.custom);
  return out;
}

export async function fetchAsrStatus({ env = process.env, fetchImpl = fetch } = {}) {
  const base = voiceTurnHubUrl(env);
  const secret = env.HUB_TOKEN_SECRET || env.ETCO_server_hubTokenSecret || '';
  if (!base || !secret) return null;
  const target = new URL('/v1/admin/asr', base);
  const timestamp = String(Date.now()); const nonce = randomBytes(24).toString('base64url');
  const proof = voiceTurnTelemetryProof(secret, { method: 'GET', target: target.pathname, timestamp, nonce });
  try {
    const response = await fetchImpl(target, {
      headers: { 'x-phoenix-voice-turn-proof': proof, 'x-phoenix-voice-turn-timestamp': timestamp, 'x-phoenix-voice-turn-nonce': nonce },
      signal: AbortSignal.timeout(2500),
    });
    return response.ok ? safeAsrStatus(await response.json()) : null;
  } catch { return null; }
}

export function adminAsrStatusRoutes(store, { requireAdmin, sendJson, env = process.env, fetchImpl = fetch }) {
  return {
    'GET /api/admin/asr': async ({ req, res }) => {
      if (!requireAdmin(store, req, res)) return;
      const status = await fetchAsrStatus({ env, fetchImpl });
      return status || sendJson(res, 503, { error: 'speech recognition status is unavailable' });
    },
  };
}
