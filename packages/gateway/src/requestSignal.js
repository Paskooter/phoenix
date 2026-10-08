// Shared bounded fetch signals for gateway peer clients.

export const DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Return a deadline signal, optionally joined to a transaction cancellation signal.
 * Every gateway peer request therefore has its own finite wall-clock budget even
 * when the caller does not provide a parent signal.
 */
export function boundedSignal(timeoutMs = DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS, parentSignal) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('Gateway request timeout must be a positive integer in milliseconds');
  }
  const deadline = AbortSignal.timeout(timeoutMs);
  return parentSignal ? AbortSignal.any([parentSignal, deadline]) : deadline;
}

export function signalFromOptions(options) {
  if (!options) return undefined;
  if (typeof options.aborted === 'boolean') return options;
  return options.signal;
}
