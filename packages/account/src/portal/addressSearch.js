// Human-initiated address lookup for the portal's map picker. The public
// Nominatim service forbids autocomplete and limits an entire application to
// one request per second. Keep the upstream call here, behind a shared pace,
// rather than letting every browser independently query it while typing.

import { sendJson } from '@phoenix/common';
import { requireUser } from './session.js';

const ENDPOINT = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'Phoenix-Jibo-Portal/1.0 (https://github.com/Paskooter/phoenix)';
const MIN_INTERVAL_MS = 1100;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const ACCOUNT_WINDOW_MS = 60 * 1000;
const ACCOUNT_LIMIT = 12;
const MAX_CACHE_ENTRIES = 500;
const MAX_PENDING_LOOKUPS = 4;

export class AddressSearchError extends Error {
  constructor(status, message, retryAfterMs = 0) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function normalizeQuery(value) {
  if (typeof value !== 'string') throw new AddressSearchError(400, 'Enter an address to search.');
  const query = value.trim().replace(/\s+/g, ' ');
  if (query.length < 3 || query.length > 200 || /[\u0000-\u001f\u007f]/.test(query)) {
    throw new AddressSearchError(400, 'Enter an address between 3 and 200 characters.');
  }
  return query;
}

function normalizeResults(body) {
  if (!Array.isArray(body)) throw new Error('Unexpected address search response');
  return body.slice(0, 5).flatMap((row) => {
    if (row?.lat == null || row?.lon == null || row.lat === '' || row.lon === '') return [];
    const lat = Number(row?.lat);
    const lng = Number(row?.lon);
    if (typeof row?.display_name !== 'string' || !Number.isFinite(lat) || !Number.isFinite(lng)
      || lat < -90 || lat > 90 || lng < -180 || lng > 180) return [];
    return [{ label: row.display_name.slice(0, 300), lat, lng }];
  });
}

async function readBoundedJson(response) {
  const limit = 256_000;
  const length = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(length) && length > limit) throw new Error('Address search response too large');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Address search response has no body');
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error('Address search response too large');
    }
    chunks.push(Buffer.from(value));
  }
  return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
}

/** One instance per Account process: a global provider pace and bounded cache. */
export function createAddressSearchService({
  fetcher = globalThis.fetch,
  now = Date.now,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  minIntervalMs = MIN_INTERVAL_MS,
} = {}) {
  const cache = new Map();
  const accountWindows = new Map();
  let nextRequestAt = 0;
  let pending = 0;
  let upstreamChain = Promise.resolve();

  function checkAccountRate(accountId) {
    const current = now();
    if (accountWindows.size > 5000) {
      for (const [id, window] of accountWindows) {
        if (current - window.started >= ACCOUNT_WINDOW_MS) accountWindows.delete(id);
      }
      while (accountWindows.size > 5000) accountWindows.delete(accountWindows.keys().next().value);
    }
    let window = accountWindows.get(accountId);
    if (!window || current - window.started >= ACCOUNT_WINDOW_MS) {
      window = { started: current, count: 0 };
      accountWindows.set(accountId, window);
    }
    if (window.count >= ACCOUNT_LIMIT) {
      throw new AddressSearchError(429, 'Too many address searches. Try again in a minute.',
        ACCOUNT_WINDOW_MS - (current - window.started));
    }
    window.count += 1;
  }

  async function lookup(query) {
    const pause = Math.max(0, nextRequestAt - now());
    if (pause) await wait(pause);
    nextRequestAt = now() + minIntervalMs;

    const url = new URL(ENDPOINT);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', '5');
    url.searchParams.set('q', query);
    const response = await fetcher(url.toString(), {
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    });
    if (response.status === 429) {
      nextRequestAt = Math.max(nextRequestAt, now() + 60_000);
      throw new AddressSearchError(503, 'Address search is busy. Try again shortly.', 60_000);
    }
    if (!response.ok) throw new Error(`Address search provider returned ${response.status}`);
    return normalizeResults(await readBoundedJson(response));
  }

  return {
    async search(rawQuery, accountId) {
      const query = normalizeQuery(rawQuery);
      checkAccountRate(accountId);
      const key = query.toLocaleLowerCase('en-US');
      const cached = cache.get(key);
      if (cached && (cached.promise || cached.expiresAt > now())) {
        cache.delete(key);
        cache.set(key, cached); // LRU for the bounded cache
        return cached.promise || cached.results;
      }
      if (cached) cache.delete(key);
      if (pending >= MAX_PENDING_LOOKUPS) {
        throw new AddressSearchError(429, 'Address search is busy. Try again shortly.', 5000);
      }

      pending += 1;
      const task = upstreamChain.then(() => lookup(query));
      upstreamChain = task.catch(() => {});
      cache.set(key, { promise: task });
      try {
        const results = await task;
        cache.delete(key);
        cache.set(key, { results, expiresAt: now() + CACHE_TTL_MS });
        while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
        return results;
      } catch (error) {
        cache.delete(key);
        throw error;
      } finally {
        pending -= 1;
      }
    },
  };
}

export function portalAddressSearchRoutes(store, searchService = createAddressSearchService()) {
  return {
    'POST /api/address-search': async ({ req, res, body }) => {
      const account = requireUser(store, req, res);
      if (!account) return;
      res.setHeader('cache-control', 'no-store');
      try {
        return { results: await searchService.search(body?.query, account._id) };
      } catch (error) {
        if (error instanceof AddressSearchError) {
          if (error.retryAfterMs) res.setHeader('retry-after', String(Math.ceil(error.retryAfterMs / 1000)));
          return sendJson(res, error.status, { error: error.message });
        }
        return sendJson(res, 502, { error: 'Address search is unavailable right now.' });
      }
    },
  };
}
