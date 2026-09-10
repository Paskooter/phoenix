// Relay framework — port of lasso/relay/AbstractRelayRequestHandler.ts
// (pegasus d682547a31511cd164db0913b6104eb1786455a2).
//
// GET/HEAD on a relay route: validate inputs (-> 400 text/html with the raw
// message) -> build the Redis key -> HEAD: empty 200 with no entity headers,
// then carry on to warm the cache -> unless `skipCache` is truthy, read the
// cache and, on a hit, return the stored bytes verbatim (Express `res.send`
// of the stored string => text/html) -> on a miss fetch the third party,
// respond `{ relayData, lassoDataFromRedis:false }` as JSON, then cache
// `{ relayData, lassoDataFromRedis:true, lassoInsertedIntoRedisAt }` with a
// per-relay TTL.
//
// Reference line map (AbstractRelayRequestHandler.ts):
//   56-62   validate -> 400
//   64      redisKey
//   69-73   HEAD empty 200, keep going
//   77-98   skipCache truthiness; cache read; hit returns the stored string
//   100-110 fetchData error mapping (see fetchError below)
//   112-117 miss response json({relayData, lassoDataFromRedis:false})
//   119-131 cache SET regardless of method
//   132-134 outer catch -> next(err)
//
// Two original behaviours are easy to get wrong and are pinned by tests here:
//   * a cache hit is served by `response.send(<stored string>)`, so it carries
//     `text/html; charset=utf-8`, unlike the JSON miss;
//   * `?skipCache=false` is the *string* "false", which is truthy, so it skips
//     the cache read exactly like `skipCache=1`; a bracketed or repeated
//     `skipCache` is an Array in Express's qs output and is truthy even when
//     empty (`?skipCache[]=` skips).

import { sendJson, sendText } from '@phoenix/common';

class ClientError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export { ClientError };

/**
 * Reference `AbstractRelayRequestHandler#fetchData` (lines 153-173): wrap a
 * provider error into the envelope the handler sends with
 * `response.status(err.status); response.send(err.message)`.
 *   - an axios-style error carries `.response`; the upstream status is
 *     reproduced and the upstream body is JSON-stringified into the message;
 *   - anything else becomes a 502 and the message is string-concatenated, so
 *     `Error` renders as "Error: <message>" (line 163 `+ err`).
 * @param {string} name
 * @param {any} err
 * @returns {ClientError}
 */
export function fetchError(name, err) {
  if (err && err.response) {
    return new ClientError(err.response.status, `Error getting ${name} data: ` + JSON.stringify(err.response.data));
  }
  return new ClientError(502, `Error getting ${name} data: ` + err);
}

/**
 * Reference `request.query.skipCache` is Express's qs-parsed value, not a bare
 * string (pegasus pins express ^4.16.2, whose default parser is qs). A bracket
 * form (`?skipCache[]=`) or a repeated key makes qs hand back an Array, and an
 * Array is truthy even when every member is the empty string. `URLSearchParams`
 * collapses all of those to null/'' and would read the cache exactly where the
 * original skipped it, so the qs truthiness has to be reconstructed.
 * @param {URLSearchParams} searchParams
 * @returns {boolean}
 */
function skipCacheRequested(searchParams) {
  let occurrences = 0;
  let single = '';
  for (const [key, value] of searchParams) {
    if (key === 'skipCache') { occurrences += 1; single = value; }
    // Any bracketed key makes qs produce an Array (or a plain object), both of
    // which are truthy regardless of their contents.
    else if (key.startsWith('skipCache[')) occurrences += 2;
  }
  if (occurrences === 0) return false;
  return occurrences > 1 ? true : !!single;
}

/** Express `response.send()` with no argument: empty 200, no entity headers. */
function sendEmptyOk(res) {
  if (typeof res.status === 'function' && typeof res.send === 'function') return res.status(200).send();
  res.writeHead(200, { 'x-powered-by': 'Express' });
  res.end();
}

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
    if (isHead) sendEmptyOk(res); // empty 200; keep going to warm the cache (prefetch)

    // `request.query.skipCache` is a truthiness test, not a parse: "false" skips.
    if (!skipCacheRequested(url.searchParams)) {
      let cached = null;
      // A cache read failure is non-fatal: log and fall through to the live
      // fetch (reference lines 84-86).
      try {
        cached = cache.get(k);
      } catch (e) {
        log?.error?.('Cache GET error, fetching live data instead', e);
      }
      if (cached) { if (!isHead) sendText(res, 200, JSON.stringify(cached)); return; }
    }

    let relayData;
    try {
      relayData = await fetchExternal(input, log);
    } catch (e) {
      if (!isHead && !res.writableEnded) {
        const ce = fetchError(name, e);
        sendText(res, ce.status, ce.message);
      }
      return;
    }
    if (!relayData) { // reference line 167: any falsy provider result is "empty"
      if (!isHead && !res.writableEnded) sendText(res, 502, `Empty reply from ${name}`);
      return;
    }

    if (!isHead) sendJson(res, 200, { relayData, lassoDataFromRedis: false });
    // Cache write failures are non-fatal too: the next request is a miss and
    // refetches (reference lines 121-131). Respond first, then write.
    try {
      cache.set(k, { relayData, lassoDataFromRedis: true, lassoInsertedIntoRedisAt: new Date().toISOString() }, ttlSeconds);
    } catch (e) {
      log?.error?.(`Cache SET error (key=${k}): ${e}`);
    }
  };
}
