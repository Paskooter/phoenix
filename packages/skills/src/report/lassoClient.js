// LassoClient — port of report-skill/src/LassoClient.ts + LassoClientUtils.ts against the
// Phoenix data service (lasso port, NET_data). Same endpoints, same envelope: every relay
// response wraps payload in `relayData`.

import { parseXml } from './xml.js';
import { getAccountFromLooper } from './utils.js';

const msToSeconds = (ms) => ms / 1000;

// interfaces/src/personalreport/apnews.ts CATEGORIES
export const NEWS_CATEGORIES = Object.freeze({
  42200: 'business', 42201: 'entertainment', 42202: 'international', 42203: 'health',
  42204: 'strange', 42205: 'politics', 42206: 'science', 42207: 'sports',
  42208: 'technology', 42209: 'general', 42210: 'national',
});

export function findCategoryID(categoryName, log) {
  const entry = Object.entries(NEWS_CATEGORIES).find(([, name]) => name === categoryName);
  if (entry) return parseInt(entry[0], 10);
  log?.error?.(`News source not found: ${categoryName}`);
  return undefined;
}

export function extractResponseData(body, categoryName) {
  if (body && body.relayData != null) return body.relayData;
  throw new Error(`Incomplete Lasso data from: ${categoryName}`);
}

function lassoBase() {
  const net = process.env.NET_data;
  if (!net) throw new Error('NET_data not configured');
  return /^https?:\/\//.test(net) ? net : `http://${net}`;
}

export class LassoClient {
  /** GET /v1/dark_sky (HEAD when prefetch — fire-and-forget cache warm). */
  static async fetchDarkSky(data, utc = null, prefetch = false) {
    const loc = data.runtime.location || {};
    const params = new URLSearchParams({ lat: Number(loc.lat).toFixed(4), lon: Number(loc.lng).toFixed(4) });
    if (utc) params.set('secondsSinceEpoch', String(Math.round(msToSeconds(utc))));
    const url = `${lassoBase()}/v1/dark_sky?${params}`;
    if (prefetch) {
      fetch(url, { method: 'HEAD' }).catch(() => {});
      return undefined;
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`dark_sky ${res.status}`);
    return extractResponseData(await res.json(), 'DarkSky');
  }

  /** GET /v1/google_maps for the commute. */
  static async fetchGoogleMaps(data, commutePrefs) {
    const params = new URLSearchParams({
      'origin[lat]': commutePrefs.origin.lat, 'origin[lon]': commutePrefs.origin.lng,
      'destination[lat]': commutePrefs.destination.lat, 'destination[lon]': commutePrefs.destination.lng,
      mode: commutePrefs.mode,
    });
    const res = await fetch(`${lassoBase()}/v1/google_maps?${params}`);
    if (!res.ok) throw new Error(`google_maps ${res.status}`);
    return extractResponseData(await res.json(), 'Google Maps');
  }

  /** GET /v1/ap_news per active category; XML parsed xml2js-style. Per-category errors ride the item. */
  static async fetchAPNews(data, newsPrefs) {
    const log = data.log;
    const activeCatArr = Object.keys(newsPrefs.activeNewsCategories)
      .filter((cat) => newsPrefs.activeNewsCategories[cat]);

    const baseNewsItems = activeCatArr.map((name) => ({ category: { name, sourceID: findCategoryID(name, log) } }));

    return Promise.all(baseNewsItems.map(async (newsBase) => {
      const { sourceID } = newsBase.category;
      try {
        const res = await fetch(`${lassoBase()}/v1/ap_news?sourceID=${sourceID}`);
        if (!res.ok) throw new Error(`ap_news ${res.status}`);
        const newsXML = extractResponseData(await res.json(), 'AP News');
        newsBase.data = parseXml(newsXML);
      } catch (err) {
        newsBase.error = err;
      }
      return newsBase;
    }));
  }

  /** GET /v1/{google|outlook}_calendar. */
  static async fetchCalendarEvents(data, serviceName, calendar, endDate) {
    const params = new URLSearchParams({
      skillId: data.skill.id,
      accountId: getAccountFromLooper(data.runtime.loop, data.runtime.perception.speaker),
      calendar,
      endDate,
    });
    const res = await fetch(`${lassoBase()}/v1/${serviceName}_calendar?${params}`);
    if (!res.ok) throw new Error(`${serviceName}_calendar ${res.status}`);
    return extractResponseData(await res.json(), `${serviceName} calendar`);
  }
}
