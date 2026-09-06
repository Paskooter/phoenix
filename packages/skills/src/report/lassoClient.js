// LassoClient — port of report-skill/src/LassoClient.ts + LassoClientUtils.ts against the
// Phoenix data service. Source deployments use NET_lasso; NET_data remains a documented
// Phoenix alias when the source name is absent. Every relay response wraps payload in `relayData`.

import { parseXml } from './xml.js';
import { getAccountFromLooper } from './utils.js';
import { reportLassoURL } from './env.js';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';

const msToSeconds = (ms) => ms / 1000;

// Node 8 reported null/undefined property receivers as "Cannot read property
// ...", while Node 22 uses "Cannot read properties of ...". Keep the source
// observable error at the handful of direct Lasso boundary reads without
// translating errors thrown by provider methods or response handling.
function requireLegacyPropertyReceiver(receiver, property) {
  if (receiver === undefined || receiver === null) {
    const kind = receiver === null ? 'null' : 'undefined';
    throw new TypeError(`Cannot read property '${property}' of ${kind}`);
  }
}

function requestHeaders(data) {
  requireLegacyPropertyReceiver(data, 'req');
  const req = data.req;
  requireLegacyPropertyReceiver(req, 'jibo');
  const jibo = req.jibo;
  requireLegacyPropertyReceiver(jibo, 'toHeader');
  const toHeader = jibo.toHeader;
  if (typeof toHeader !== 'function') throw new TypeError('data.req.jibo.toHeader is not a function');
  return toHeader.call(jibo);
}

// BaseService supplies a Phoenix logger object without the source logger's
// createChild method. Keep that deployment adapter usable while retaining the
// source TypeError when the log itself is absent or a primitive.
function isPhoenixLogger(log) {
  return log && typeof log === 'object' && !('createChild' in log)
    && ['debug', 'info', 'warn', 'error'].every((method) => typeof log[method] === 'function');
}

function lassoLog(data) {
  requireLegacyPropertyReceiver(data, 'log');
  if (isPhoenixLogger(data.log)) return data.log;
  requireLegacyPropertyReceiver(data.log, 'createChild');
  return data.log.createChild('LassoClient');
}

function childLog(log, name) {
  if (isPhoenixLogger(log)) return log;
  requireLegacyPropertyReceiver(log, 'createChild');
  return log.createChild(name);
}

// interfaces/src/personalreport/apnews.ts CATEGORIES
export const NEWS_CATEGORIES = Object.freeze({
  42200: 'business', 42201: 'entertainment', 42202: 'international', 42203: 'health',
  42204: 'strange', 42205: 'politics', 42206: 'science', 42207: 'sports',
  42208: 'technology', 42209: 'general', 42210: 'national',
});

export function findCategoryID(categoryName, log) {
  childLog(log, 'findID');
  const entry = Object.entries(NEWS_CATEGORIES).find(([, name]) => name === categoryName);
  if (entry) return parseInt(entry[0], 10);
  log.error(`News source not found: ${categoryName}`);
  return undefined;
}

export function extractResponseData(response, categoryName) {
  if (response && response.data && response.data.relayData) return response.data.relayData;
  throw new Error(`Incomplete Lasso data from: ${categoryName}`);
}

function lassoBase() {
  return reportLassoURL();
}

// Axios 0.17.1's default buildURL serializer keeps top-level insertion order,
// JSON-stringifies nested objects, omits null/undefined values, and leaves
// brackets, colon, comma and dollar signs readable after encoding. URLSearchParams
// uses a different wire format for every one of those cases.
function axiosEncode(value) {
  return encodeURIComponent(value)
    .replace(/%40/gi, '@')
    .replace(/%3A/gi, ':')
    .replace(/%24/g, '$')
    .replace(/%2C/gi, ',')
    .replace(/%20/g, '+')
    .replace(/%5B/gi, '[')
    .replace(/%5D/gi, ']');
}

function serializeParams(params) {
  if (!params) return '';
  const parts = [];
  for (const [key, original] of Object.entries(params)) {
    if (original === null || original === undefined) continue;
    const values = Array.isArray(original) ? original : [original];
    const encodedKey = Array.isArray(original) ? `${key}[]` : key;
    for (let value of values) {
      if (value instanceof Date) value = value.toISOString();
      else if (value && typeof value === 'object') value = JSON.stringify(value);
      parts.push(`${axiosEncode(encodedKey)}=${axiosEncode(value)}`);
    }
  }
  return parts.join('&');
}

function responseData(raw) {
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return raw; }
}

function requestError(status, response) {
  const error = new Error(`Request failed with status code ${status}`);
  error.response = response;
  return error;
}

const NO_HEADER_SNAPSHOT = Symbol('no Lasso header snapshot');

function requestLasso(pathname, params, data, method = 'GET', redirectCount = 0, absoluteURL = null, headerSnapshot = NO_HEADER_SNAPSHOT) {
  const query = serializeParams(params);
  const url = absoluteURL || `${lassoBase()}${pathname}${query ? `?${query}` : ''}`;
  const target = new URL(url);
  const transport = target.protocol === 'https:' ? https : http;
  // Axios evaluates the source Jibo headers once while creating the request.
  // follow-redirects reuses that snapshot; only Host follows the destination.
  const sourceHeaders = headerSnapshot === NO_HEADER_SNAPSHOT
    ? (() => {
      const returnedHeaders = requestHeaders(data);
      // Axios merges the returned object into request options immediately;
      // redirect hops reuse that copied map even if the caller mutates the
      // object returned by toHeader() after the first request.
      return returnedHeaders === undefined ? undefined : { ...returnedHeaders };
    })()
    : headerSnapshot;
  const headers = {
    ...(sourceHeaders === undefined ? {} : { Accept: 'application/json, text/plain, */*', ...sourceHeaders }),
    'User-Agent': 'axios/0.17.1',
    Host: target.host,
    Connection: 'close',
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      path: `${target.pathname}${target.search}`,
      method,
      headers,
      agent: false,
    }, (response) => {
      const chunks = [];
      let responseFinished = false;
      const finishResponse = () => {
        if (responseFinished || settled) return;
        responseFinished = true;
        if (settled) return;
        const location = response.headers.location;
        if (location && response.statusCode >= 300 && response.statusCode < 400) {
          if (redirectCount >= 21) {
            fail(new Error('Max redirects exceeded.'));
            return;
          }
          // Axios lower-cases the method before passing it to the pinned
          // follow-redirects release. That release's SAFE_METHODS table uses
          // uppercase names, so source HEAD requests become GET on every
          // redirect except 307 (GET remains GET either way).
          const nextMethod = response.statusCode === 307 ? method : 'GET';
          settled = true;
          requestLasso('', null, data, nextMethod, redirectCount + 1, new URL(location, target).toString(), sourceHeaders).then(resolve, reject);
          return;
        }

        let body = Buffer.concat(chunks);
        try {
          switch (response.headers['content-encoding']) {
            case 'gzip':
            case 'compress':
            case 'deflate':
              body = zlib.unzipSync(body);
              delete response.headers['content-encoding'];
              break;
            default:
              break;
          }
        } catch (error) {
          fail(error);
          return;
        }
        const result = {
          status: response.statusCode,
          statusText: response.statusMessage,
          headers: response.headers,
          data: responseData(body.toString('utf8')),
        };
        settled = true;
        if (response.statusCode < 200 || response.statusCode >= 300) reject(requestError(response.statusCode, result));
        else resolve(result);
      };
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('aborted', finishResponse);
      response.on('end', finishResponse);
      response.on('error', fail);
    });
    request.on('error', fail);
    request.end();
  });
}

export class LassoClient {
  /** GET /v1/dark_sky (HEAD when prefetch — fire-and-forget cache warm). */
  static async fetchDarkSky(data, utc = null, prefetch = false) {
    lassoLog(data);
    requireLegacyPropertyReceiver(data.runtime.location, 'lat');
    const params = {
      lat: data.runtime.location.lat.toFixed(4),
      lon: data.runtime.location.lng.toFixed(4),
      secondsSinceEpoch: utc ? Math.round(msToSeconds(utc)) : null,
    };
    if (prefetch) {
      requestLasso('/v1/dark_sky', params, data, 'HEAD').catch(() => {});
      return undefined;
    }
    const res = await requestLasso('/v1/dark_sky', params, data);
    return extractResponseData(res, 'DarkSky');
  }

  /** GET /v1/google_maps for the commute. */
  static async fetchGoogleMaps(data, commutePrefs) {
    lassoLog(data);
    const params = {
      origin: { lat: commutePrefs.origin.lat, lon: commutePrefs.origin.lng },
      destination: { lat: commutePrefs.destination.lat, lon: commutePrefs.destination.lng },
      mode: commutePrefs.mode,
    };
    const res = await requestLasso('/v1/google_maps', params, data);
    return extractResponseData(res, 'Google Maps');
  }

  /** GET /v1/ap_news per active category; XML parsed xml2js-style. Per-category errors ride the item. */
  static async fetchAPNews(data, newsPrefs) {
    const log = lassoLog(data);
    const activeCatArr = Object.keys(newsPrefs.activeNewsCategories)
      .filter((cat) => newsPrefs.activeNewsCategories[cat]);

    const baseNewsItems = activeCatArr.map((name) => ({ category: { name, sourceID: findCategoryID(name, log) } }));

    return Promise.all(baseNewsItems.map(async (newsBase) => {
      const { sourceID } = newsBase.category;
      try {
        const res = await requestLasso('/v1/ap_news', { sourceID }, data);
        const newsXML = extractResponseData(res, 'AP News');
        newsBase.data = parseXml(newsXML);
      } catch (err) {
        newsBase.error = err;
      }
      return newsBase;
    }));
  }

  /** GET /v1/{google|outlook}_calendar. */
  static async fetchCalendarEvents(data, serviceName, calendar, endDate) {
    lassoLog(data);
    const params = {
      skillId: data.skill.id,
      accountId: getAccountFromLooper(data.runtime.loop, data.runtime.perception.speaker),
      calendar,
      endDate,
    };
    const res = await requestLasso(`/v1/${serviceName}_calendar`, params, data);
    return extractResponseData(res, `${serviceName} calendar`);
  }
}
