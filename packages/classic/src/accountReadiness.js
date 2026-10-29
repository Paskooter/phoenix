// Native composition readiness only: never retry or replay an authenticated
// request. Keep Classic's public socket closed until its Account peer listens.
import { setTimeout as sleep } from 'node:timers/promises';

export const ACCOUNT_READY_TIMEOUT_MS = 30_000;

export async function waitForAccountReady(base, { timeoutMs = ACCOUNT_READY_TIMEOUT_MS } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    throw new Error('Account readiness timeout must be 1..60000ms');
  }
  const signal = AbortSignal.timeout(timeoutMs);
  const url = new URL('/healthcheck', base);
  try {
    while (!signal.aborted) {
      try {
        const response = await fetch(url, { signal, redirect: 'error' });
        await response.body?.cancel();
        if (response.status === 200) return;
      } catch { /* refused, unavailable, or still starting; one shared deadline */ }
      await sleep(100, undefined, { signal });
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  }
  throw new Error(`Account readiness deadline exceeded after ${timeoutMs}ms`);
}
