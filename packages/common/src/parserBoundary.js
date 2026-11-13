// Parser-only, request-scoped diagnostics. Never bind the logger to the caller's
// trace: legacy transId/robotId and even valid-looking identity UUIDs are not
// privacy-safe diagnostic correlation. This token is random, not an identity hash.
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { logger } from './log.js';

export const PARSER_REQUEST_HEADER = 'x-phoenix-parser-request-id';
const REQUEST_ID = /^p1_[0-9a-f]{32}$/;
const OUTCOMES = new Set(['pending', 'ok', 'http_error', 'transport_error', 'decode_error', 'aborted', 'error', 'sent']);
const INTERRUPTIONS = new Set(['wait_timeout', 'cancelled', 'request_deadline', 'peer_disconnect']);
const MAX_ELAPSED_MS = 2_147_483_647;
const gatewayBoundaries = new WeakSet();

// incomingId is a strictly formatted peer token, or the private immutable
// observer shared by one Gateway wait and its ParserClient call. Each event
// slot is emitted once: at most three client records, four peer records.
export function createParserBoundary(side, incomingId) {
  side = side === 'parser' ? 'parser' : 'gateway';
  // Only an immutable observer minted here may be shared with the owning
  // Gateway wait. An arbitrary options/trace object cannot supply a token.
  if (side === 'gateway' && gatewayBoundaries.has(incomingId)) return incomingId;
  const requestId = side === 'parser' && typeof incomingId === 'string' && REQUEST_ID.test(incomingId)
    ? incomingId : `p1_${randomBytes(16).toString('hex')}`;
  const log = logger(side === 'gateway' ? 'gateway.parser' : 'nlu.parser');
  const started = performance.now();
  let completed = false;
  let responded = false;
  let interruption = 'none';

  function emit(phase, outcome, status = 0) {
    const elapsed = performance.now() - started;
    try {
      log.info('parser_boundary', {
        requestId, side, phase,
        outcome: OUTCOMES.has(outcome) ? outcome : 'error',
        interruption,
        elapsedMs: Number.isFinite(elapsed) ? Math.max(0, Math.min(MAX_ELAPSED_MS, Math.floor(elapsed))) : 0,
        status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0,
        late: phase === 'complete' && interruption !== 'none' ? 1 : 0,
      });
    } catch { /* Diagnostic sink failure must not change the parser result. */ }
  }

  emit('start', 'pending');
  const boundary = Object.freeze({
    requestId,
    interrupt(reason) {
      // Preserve the first observation: transaction cleanup after the 10s wait
      // must not relabel that timeout as an ordinary cancellation.
      if (interruption !== 'none' || !INTERRUPTIONS.has(reason)) return;
      interruption = reason;
      emit('interrupt', 'pending');
    },
    complete(outcome, status = 0) {
      if (completed) return;
      completed = true;
      emit('complete', outcome, status);
    },
    response(status) {
      if (responded) return;
      responded = true;
      // ServerResponse.finish is local transport completion, not a delivery ACK.
      emit('response', 'sent', status);
    },
  });
  if (side === 'gateway') gatewayBoundaries.add(boundary);
  return boundary;
}
