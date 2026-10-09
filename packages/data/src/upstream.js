// Shared cancellation/deadline helpers for data-service upstream calls.

export const DEFAULT_UPSTREAM_TIMEOUT_MS = 10_000;

/** A stable, inspectable error for an upstream deadline. */
export class UpstreamTimeoutError extends Error {
  constructor(label, timeoutMs) {
    super(`${label} request timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
    this.code = 'ETIMEDOUT';
    this.timeoutMs = timeoutMs;
  }
}

function normalizedTimeout(timeoutMs) {
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_UPSTREAM_TIMEOUT_MS;
}

function abortError(reason) {
  if (reason instanceof Error) return reason;
  const error = new Error(reason == null ? 'The operation was aborted' : String(reason));
  error.name = 'AbortError';
  return error;
}

/**
 * Run an operation with a child AbortSignal and an absolute deadline.
 *
 * The operation receives a signal that is aborted when either the caller's
 * signal aborts or the timeout expires. The race also rejects when the
 * operation ignores that signal, so a buggy adapter cannot hold a request open
 * indefinitely.
 */
export async function withUpstreamTimeout(operation, { signal, timeoutMs, label = 'Upstream' } = {}) {
  const limit = normalizedTimeout(timeoutMs);
  const controller = new AbortController();
  let timer;
  let settled = false;
  let rejectAbort;
  const abortPromise = new Promise((_, reject) => { rejectAbort = reject; });

  const abort = (reason) => {
    if (!controller.signal.aborted) controller.abort(reason);
    if (!settled) rejectAbort(abortError(reason));
  };
  const onCallerAbort = () => abort(signal.reason);

  if (signal?.aborted) {
    onCallerAbort();
  } else if (signal) {
    signal.addEventListener('abort', onCallerAbort, { once: true });
  }
  timer = setTimeout(() => abort(new UpstreamTimeoutError(label, limit)), limit);

  try {
    const operationPromise = Promise.resolve().then(() => operation(controller.signal));
    return await Promise.race([operationPromise, abortPromise]);
  } finally {
    settled = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', onCallerAbort);
  }
}

/** Fetch wrapper that applies the same deadline to headers and the response body. */
export function upstreamFetch(fetchImpl, url, options = {}, config = {}) {
  const { signal: optionSignal, ...requestOptions } = options || {};
  return withUpstreamTimeout(
    (signal) => fetchImpl(url, { ...requestOptions, signal }),
    { ...config, signal: config.signal ?? optionSignal },
  );
}

/**
 * Link an HTTP request/response lifecycle to an AbortSignal. `close` is only
 * treated as cancellation when the request is incomplete or the response had
 * not already been ended, so HEAD prefetches and normal responses keep working.
 */
export function requestAbortSignal(req, res) {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      const error = new Error('Client disconnected');
      error.name = 'AbortError';
      controller.abort(error);
    }
  };
  const onRequestAborted = () => abort();
  const onRequestClose = () => {
    if (req && !req.complete) abort();
  };
  const onResponseClose = () => {
    if (res && !res.writableEnded) abort();
  };

  if (req?.aborted) abort();
  req?.once?.('aborted', onRequestAborted);
  req?.once?.('close', onRequestClose);
  res?.once?.('close', onResponseClose);

  return {
    signal: controller.signal,
    cleanup() {
      req?.removeListener?.('aborted', onRequestAborted);
      req?.removeListener?.('close', onRequestClose);
      res?.removeListener?.('close', onResponseClose);
    },
  };
}
