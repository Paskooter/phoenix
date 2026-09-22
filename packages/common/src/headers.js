// Trace-header plumbing (docs/atlas/message-protocol.md §2). x-jibo-transid is the only
// cross-service correlation mechanism and MUST be forwarded verbatim on every internal
// HTTP call (gotcha #12), or distributed logs decohere.

import { TraceHeaders } from '@phoenix/contracts';

// Do not let an arbitrary caller turn an internal correlation header into a
// log field. Gateway-generated IDs are UUIDs; anything else is ignored.
const TURN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Extract the Jibo trace headers from an incoming request.
 * @param {import('node:http').IncomingMessage} req
 * @returns {{ transId?: string, robotId?: string, loggingConfig?: string, turnId?: string }}
 */
export function readTrace(req) {
  const h = req.headers || {};
  const turnId = h[TraceHeaders.turnId];
  return {
    transId: h[TraceHeaders.transId],
    robotId: h[TraceHeaders.robotId],
    loggingConfig: h[TraceHeaders.loggingConfig],
    turnId: typeof turnId === 'string' && TURN_ID.test(turnId) ? turnId : undefined,
  };
}

/**
 * Render a trace object back into outbound HTTP headers for a downstream call.
 * @param {{ transId?: string, robotId?: string, loggingConfig?: string, turnId?: string }} trace
 * @returns {Record<string,string>}
 */
export function writeTrace(trace = {}) {
  const out = {};
  if (trace.transId) out[TraceHeaders.transId] = trace.transId;
  if (trace.robotId) out[TraceHeaders.robotId] = trace.robotId;
  if (trace.loggingConfig) out[TraceHeaders.loggingConfig] = trace.loggingConfig;
  if (typeof trace.turnId === 'string' && TURN_ID.test(trace.turnId)) out[TraceHeaders.turnId] = trace.turnId;
  return out;
}
