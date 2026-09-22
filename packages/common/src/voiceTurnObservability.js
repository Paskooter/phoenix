// Privacy-safe observability primitives for a conversational turn.
//
// Keep this deliberately small and allow-listed: logs must answer "which
// phase was slow?" without becoming a second speech-history store. In
// particular, callers must not attach request bodies, ASR text, NLU entities,
// skill payloads, account/robot IDs, URLs, or error messages.

import { randomUUID } from 'node:crypto';

/** Mint a non-identifying correlation ID for one gateway listen transaction. */
export function createVoiceTurnId() {
  return randomUUID();
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
  log?.info?.('voice_turn_complete', {
    event: 'voice_turn_complete',
    turnId: trace.turnId,
    totalMs: duration(startedAt),
    outcome,
  });
}
