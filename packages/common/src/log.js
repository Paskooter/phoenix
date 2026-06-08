// Minimal structured logger. Honors the per-request x-jibo-logging-config header
// ({ namespace: level }) so a single transaction can be made verbose without a redeploy
// (docs/atlas/message-protocol.md §2).

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const GLOBAL_LEVEL = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

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
    const sink = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    sink.write(JSON.stringify(line) + '\n');
  };

  return { error: emit('error'), warn: emit('warn'), info: emit('info'), debug: emit('debug') };
}
