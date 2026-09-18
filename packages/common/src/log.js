// Minimal structured logger. Honors the per-request x-jibo-logging-config header
// ({ namespace: level }) so a single transaction can be made verbose without a redeploy
// (docs/atlas/message-protocol.md §2).

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const GLOBAL_LEVEL = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

/**
 * The admin console's live view. Every line that passes this logger's threshold
 * is appended to a bounded ring buffer with a monotonic sequence number, which
 * GET /api/admin/logs reads with a `since` cursor.
 *
 * Why a buffer rather than a stream: the shared service boundary serialises a
 * route's return value, so a hanging server-sent-event response would have to
 * change that boundary for one admin screen. A cursor poll is a few hundred
 * bytes a second and cannot regress the request path.
 *
 * Cost when nobody is looking: one array push and a length check per line.
 *
 * Note on level: this records what the logger was willing to emit, so `debug`
 * lines only appear when the service runs at LOG_LEVEL=debug. The console's
 * level selector filters what it shows; it cannot resurrect suppressed lines.
 */
const LOG_BUFFER_MAX = Math.max(50, Number(process.env.PHOENIX_LOG_BUFFER_MAX) || 1000);
const logBuffer = [];
let logSeq = 0;
let logDropped = 0;

/** The most recent lines, oldest first. `since` is a cursor from a previous call. */
export function recentLogs({ since = 0, limit = 200, level = null, ns = null } = {}) {
  const min = LEVELS[level] ?? -1;
  const out = [];
  for (const line of logBuffer) {
    if (line.seq <= since) continue;
    if (min >= 0 && LEVELS[line.level] > min) continue;
    if (ns && !String(line.ns || '').startsWith(ns)) continue;
    out.push(line);
  }
  const capped = Math.max(0, Math.min(Number(limit) || 200, LOG_BUFFER_MAX));
  return {
    events: out.length > capped ? out.slice(-capped) : out,
    cursor: logBuffer.length ? logBuffer[logBuffer.length - 1].seq : since,
    dropped: logDropped,
    buffered: logBuffer.length,
  };
}

function bufferLog(line) {
  const record = { ...line, seq: ++logSeq };
  logBuffer.push(record);
  if (logBuffer.length > LOG_BUFFER_MAX) {
    const excess = logBuffer.length - LOG_BUFFER_MAX;
    logBuffer.splice(0, excess);
    logDropped += excess;
  }
  return record;
}

/**
 * @param {string} namespace e.g. 'gateway', 'gateway.listen'
 * @param {{ transId?: string, loggingConfig?: string }} [trace]
 */
export function logger(namespace, trace = {}) {
  let perRequest = {};
  if (trace.loggingConfig) {
    try {
      perRequest = JSON.parse(trace.loggingConfig);
    } catch {
      /* malformed header: ignore, fall back to global level */
    }
  }
  const threshold = LEVELS[perRequest[namespace]] ?? GLOBAL_LEVEL;

  const emit = (level) => (msg, fields) => {
    if (LEVELS[level] > threshold) return;
    const line = { t: new Date().toISOString(), level, ns: namespace, msg };
    if (trace.transId) line.transId = trace.transId;
    if (fields) Object.assign(line, fields);
    bufferLog(line);
    const sink = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    sink.write(JSON.stringify(line) + '\n');
  };

  // `transId` is exposed so a component holding only the logger can label its
  // own diagnostics with the transaction it belongs to.
  return { error: emit('error'), warn: emit('warn'), info: emit('info'), debug: emit('debug'), transId: trace.transId };
}
