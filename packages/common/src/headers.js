// Trace-header plumbing (docs/atlas/message-protocol.md §2). x-jibo-transid is the only
// cross-service correlation mechanism and MUST be forwarded verbatim on every internal
// HTTP call (gotcha #12), or distributed logs decohere.

import { TraceHeaders } from '@phoenix/contracts';

/**
 * Extract the Jibo trace headers from an incoming request.
 * @param {import('node:http').IncomingMessage} req
 * @returns {{ transId?: string, robotId?: string, loggingConfig?: string }}
 */
export function readTrace(req) {
  const h = req.headers || {};
  return {
    transId: h[TraceHeaders.transId],
    robotId: h[TraceHeaders.robotId],
    loggingConfig: h[TraceHeaders.loggingConfig],
  };
}

/**
 * Render a trace object back into outbound HTTP headers for a downstream call.
 * @param {{ transId?: string, robotId?: string, loggingConfig?: string }} trace
 * @returns {Record<string,string>}
 */
export function writeTrace(trace = {}) {
  const out = {};
  if (trace.transId) out[TraceHeaders.transId] = trace.transId;
  if (trace.robotId) out[TraceHeaders.robotId] = trace.robotId;
  if (trace.loggingConfig) out[TraceHeaders.loggingConfig] = trace.loggingConfig;
  return out;
}
