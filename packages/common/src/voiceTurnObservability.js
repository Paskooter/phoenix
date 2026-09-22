// Privacy-safe observability primitives for a conversational turn.
//
// Keep this deliberately small and allow-listed: logs must answer "which
// phase was slow?" without becoming a second speech-history store. In
// particular, callers must not attach request bodies, ASR text, NLU entities,
// skill payloads, account/robot IDs, URLs, or error messages.

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const TURN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TURNS = Math.max(20, Math.min(1000, Number(process.env.PHOENIX_VOICE_TURN_BUFFER_MAX) || 200));
const RETAIN_MS = Math.max(60_000, Math.min(24 * 60 * 60 * 1000, Number(process.env.PHOENIX_VOICE_TURN_RETAIN_MS) || 60 * 60 * 1000));
const MAX_QUERY_LIMIT = 100;
const STAGES = new Set(['context_wait', 'asr', 'nlu', 'route', 'skill', 'skill_redirect', 'history_launch', 'history_speech', 'response_ready', 'http_request']);
const OUTCOMES = new Set(['ok', 'matched', 'unmatched', 'remote_error', 'timeout', 'error', 'cancelled', 'abandoned', 'listen', 'skill', 'redirect']);

// This is intentionally separate from the general log ring. It holds a
// purpose-built, allow-listed projection for the admin UI; no log messages or
// arbitrary logger fields ever enter it.
const turns = new Map();

function validTurnId(value) { return typeof value === 'string' && TURN_ID.test(value); }
function number(value) { return Number.isFinite(value) ? Math.max(0, Math.round(value)) : null; }
function cleanup(now = Date.now()) {
  for (const [id, turn] of turns) {
    if (now - turn.startedAt > RETAIN_MS) turns.delete(id);
  }
  while (turns.size > MAX_TURNS) turns.delete(turns.keys().next().value);
}
function getTurn(turnId, now = Date.now()) {
  if (!validTurnId(turnId)) return null;
  cleanup(now);
  let turn = turns.get(turnId);
  if (!turn) {
    turn = { turnId, startedAt: now, completedAt: null, totalMs: null, outcome: null, stages: [], asr: null };
    turns.set(turnId, turn);
    cleanup(now);
  }
  return turn;
}
function existingTurn(turnId, now = Date.now()) {
  if (!validTurnId(turnId)) return null;
  cleanup(now);
  return turns.get(turnId) || null;
}
function publicTurn(turn) {
  return {
    turnId: turn.turnId,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    totalMs: turn.totalMs,
    outcome: turn.outcome,
    stages: turn.stages.map((stage) => ({ ...stage })),
    asr: turn.asr ? { ...turn.asr } : null,
  };
}

/** Mint a non-identifying correlation ID for one gateway listen transaction. */
export function createVoiceTurnId() {
  return randomUUID();
}

/** Store the start of a gateway turn in the dedicated bounded telemetry ring. */
export function recordVoiceTurnStart(trace, startedAt = Date.now()) {
  const turn = getTurn(trace?.turnId, startedAt);
  if (turn) turn.startedAt = Math.min(turn.startedAt, startedAt);
}

function duration(startedAt) {
  return Math.max(0, Math.round(Date.now() - startedAt));
}

/**
 * Emit a completed stage span. This is intentionally a flat JSON log record:
 * it works with stdout collectors without requiring an OTEL collector.
 */
export function logVoiceTurnSpan(log, trace, stage, startedAt, outcome = 'ok') {
  if (!trace?.turnId) return;
  if (STAGES.has(stage) && OUTCOMES.has(outcome)) {
    // Only the gateway-created ListenTransaction may start a record. Trace
    // headers cross service boundaries, so an arbitrary HTTP caller must not
    // be able to allocate entries in this bounded telemetry ring.
    const turn = existingTurn(trace.turnId);
    if (turn) turn.stages.push({ stage, durationMs: duration(startedAt), outcome, endedAt: Date.now() });
  }
  log?.info?.('voice_turn_span', {
    event: 'voice_turn_span',
    turnId: trace.turnId,
    stage,
    durationMs: duration(startedAt),
    outcome,
  });
}

/** Emit exactly one end-of-turn summary, with no conversational content. */
export function logVoiceTurnComplete(log, trace, startedAt, outcome) {
  if (!trace?.turnId) return;
  if (OUTCOMES.has(outcome)) {
    const turn = existingTurn(trace.turnId);
    if (turn) {
      turn.totalMs = duration(startedAt);
      turn.completedAt = Date.now();
      turn.outcome = outcome;
    }
  }
  log?.info?.('voice_turn_complete', {
    event: 'voice_turn_complete',
    turnId: trace.turnId,
    totalMs: duration(startedAt),
    outcome,
  });
}

/** Attach only numeric ASR phase timings; no transcript or provider payload. */
export function recordVoiceTurnAsrBreakdown(trace, fields) {
  const turn = existingTurn(trace?.turnId);
  if (!turn || !fields || typeof fields !== 'object') return;
  const audioMs = number(fields.audioMs);
  const silenceWaitMs = number(fields.silenceWaitMs);
  const recognizeMs = number(fields.recognizeMs);
  if (audioMs === null && silenceWaitMs === null && recognizeMs === null) return;
  turn.asr = { audioMs, silenceWaitMs, recognizeMs };
}

/**
 * Safe, bounded query projection for an administrator-facing API.
 * Filters are deliberately limited to non-content fields.
 */
export function recentVoiceTurns({ turnId = null, from = null, to = null, outcome = null, stage = null, limit = 50 } = {}) {
  cleanup();
  const max = Math.max(1, Math.min(MAX_QUERY_LIMIT, Number(limit) || 50));
  const selected = [...turns.values()]
    .filter((turn) => !turnId || turn.turnId === turnId)
    .filter((turn) => from === null || turn.startedAt >= from)
    .filter((turn) => to === null || turn.startedAt <= to)
    .filter((turn) => !outcome || turn.outcome === outcome)
    .filter((turn) => !stage || turn.stages.some((item) => item.stage === stage))
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, max)
    .map(publicTurn);
  return {
    turns: selected,
    retained: turns.size,
    maxRetained: MAX_TURNS,
    retentionMs: RETAIN_MS,
    outcomes: [...OUTCOMES],
    stages: [...STAGES],
    scope: 'gateway-process',
  };
}

export function parseVoiceTurnQuery(params) {
  const readTime = (key) => {
    const value = params.get(key);
    if (value === null || value === '') return null;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new TypeError(`${key} must be a Unix time in milliseconds`);
    return parsed;
  };
  const turnId = params.get('turnId');
  const outcome = params.get('outcome');
  const stage = params.get('stage');
  if (turnId && !validTurnId(turnId)) throw new TypeError('turnId must be a UUID');
  if (outcome && !OUTCOMES.has(outcome)) throw new TypeError('unknown outcome');
  if (stage && !STAGES.has(stage)) throw new TypeError('unknown stage');
  const from = readTime('from');
  const to = readTime('to');
  if (from !== null && to !== null && from > to) throw new TypeError('from must not be after to');
  const limitValue = params.get('limit');
  const limit = limitValue === null || limitValue === '' ? 50 : Number(limitValue);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_QUERY_LIMIT) throw new TypeError(`limit must be 1-${MAX_QUERY_LIMIT}`);
  return { turnId: turnId || null, outcome: outcome || null, stage: stage || null, from, to, limit };
}

// Account proves its internal request to the hub with an HMAC derived from the
// deployment's existing hub secret. The proof never crosses the browser API.
const PROOF_MESSAGE = 'phoenix:voice-turn-telemetry:v2';
const PROOF_NONCE = /^[A-Za-z0-9_-]{16,128}$/;
function voiceTurnTelemetryPayload({ method, target, timestamp, nonce } = {}) {
  const verb = typeof method === 'string' ? method.toUpperCase() : '';
  const path = typeof target === 'string' ? target : '';
  const time = typeof timestamp === 'string' ? timestamp : '';
  const requestNonce = typeof nonce === 'string' ? nonce : '';
  if (!/^[A-Z]+$/.test(verb)
    || !path.startsWith('/') || /[\r\n]/.test(path)
    || !/^[0-9]{1,16}$/.test(time)
    || !PROOF_NONCE.test(requestNonce)) return null;
  return `${PROOF_MESSAGE}\n${verb}\n${path}\n${time}\n${requestNonce}`;
}

/** Sign one private Account → hub request with replay-resistant inputs. */
export function voiceTurnTelemetryProof(secret, request) {
  const payload = voiceTurnTelemetryPayload(request);
  if (typeof secret !== 'string' || !secret || !payload) return null;
  return createHmac('sha256', secret).update(payload).digest('base64url');
}
export function verifyVoiceTurnTelemetryProof(value, secret, request) {
  const expected = voiceTurnTelemetryProof(secret, request);
  if (!expected || typeof value !== 'string') return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(value);
  return left.length === right.length && timingSafeEqual(left, right);
}
