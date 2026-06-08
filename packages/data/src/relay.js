// Relay framework — port of lasso/relay/AbstractRelayRequestHandler.ts.
//
// GET/HEAD on a relay route: validate inputs -> build cache key -> (HEAD: empty 200 then warm
// cache) -> cache hit returns the cached envelope -> miss fetches the third party, responds
// { relayData, lassoDataFromRedis:false }, then caches { relayData, lassoDataFromRedis:true,
// lassoInsertedIntoRedisAt } with a per-relay TTL. `?skipCache=1` bypasses the read.

import { sendJson, sendText } from '@phoenix/common';

class ClientError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export { ClientError };

/**
 * @param {{
 *   name: string, ttlSeconds: number, cache: import('./cache.js').TTLCache,
 *   validate: (q: URLSearchParams) => any,    // throws on bad input (-> 400)
 *   key: (input: any) => string,
 *   fetchExternal: (input: any, log: any) => Promise<any>,  // returns relayData (or throws)
 * }} opts
 * @returns {(ctx: any) => Promise<void>} a service route handler
 */
export function createRelay({ name, ttlSeconds, cache, validate, key, fetchExternal }) {
  return async ({ req, res, url, log }) => {
    let input;
    try {
      input = validate(url.searchParams);
    } catch (e) {
      sendText(res, 400, e.message);
      return;
    }
    const k = key(input);
    const isHead = req.method === 'HEAD';
    if (isHead) sendText(res, 200, ''); // empty 200; keep going to warm the cache (prefetch)

    if (!url.searchParams.get('skipCache')) {
      const cached = cache.get(k);
      if (cached) { if (!isHead) sendJson(res, 200, cached); return; }
    }

    let relayData;
    try {
      relayData = await fetchExternal(input, log);
    } catch (e) {
      if (!isHead && !res.writableEnded) sendText(res, e.status || 502, `Error getting ${name} data: ${e.message}`);
      return;
    }
    if (relayData == null) {
      if (!isHead && !res.writableEnded) sendText(res, 502, `Empty reply from ${name}`);
      return;
    }

    if (!isHead) sendJson(res, 200, { relayData, lassoDataFromRedis: false });
    cache.set(k, { relayData, lassoDataFromRedis: true, lassoInsertedIntoRedisAt: new Date().toISOString() }, ttlSeconds);
  };
}
