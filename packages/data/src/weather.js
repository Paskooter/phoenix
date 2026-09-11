// Weather relay — Phoenix port of lasso/relay/DarkSkyHandler.ts (the Open-Meteo shim).
// Fetches from Open-Meteo (free, keyless) and re-shapes into the Dark Sky `DarkSkyData` schema
// the report-skill weather subskill reads (daily.data[N].temperatureHigh/Low, summary, icon).
//
// Two pinned contracts are reproduced here, not re-derived:
//
// 1. Input validation (DarkSkyHandler.validateAndExtractInputs + lasso/src/utils/LatLon.ts).
//    `lat`/`lon` are tested as raw strings against /^\-?\d+\.?\d*$/ and range-checked to
//    [-90,90] / [-180,180]; a missing or malformed value throws RangeError and the relay answers
//    400 with the message as the body ("Invalid latitude undefined", "Invalid longitude asdf", ...).
//    `secondsSinceEpoch` must match /^\d+$/ when present ("Invalid timestamp: '...'").
//
// 2. The day index (pinned report-skill/src/subskills/weather/WeatherParse.ts reads today at
//    daily.data[0] and tomorrow at daily.data[1]; the yesterday request reads data[0]). Open-Meteo
//    is asked for `past_days=1`, so the raw window is [yesterday, today, tomorrow, ...] and today
//    sits at index 1; the shim slices from the requested day so `daily.data[0]` is that day.
//    COMPATIBILITY.md B1 ("weather day index") classifies the old behaviour as a required repair
//    owned by D-05/S-09/X-01.
//
// Cache keys follow DarkSkyHandler.createRedisKey: `dark_sky:<lat>;<lon>[;<YYYY-MM-DD>]`. The date
// segment is appended when the RAW `secondsSinceEpoch` query string is truthy, so the literal "0"
// adds ";1970-01-01" (a non-empty string is truthy) while an absent or empty value does not.

const FLOAT = /^-?\d+\.?\d*$/;

/**
 * Port of `LatLon.make_from_strings` plus the `LatLon` constructor range checks
 * (pegasus packages/lasso/src/utils/LatLon.ts). The float test runs on the raw string before
 * parsing, so `undefined`, `null`, "abc" and out-of-range numbers all throw RangeError carrying
 * the file's exact messages.
 * @param {string|undefined|null} lat
 * @param {string|undefined|null} lon
 * @returns {{lat: number, lon: number}}
 */
export function makeLatLon(lat, lon) {
  if (!FLOAT.test(lat)) throw new RangeError(`Invalid latitude ${lat}`);
  if (!FLOAT.test(lon)) throw new RangeError(`Invalid longitude ${lon}`);
  const latNum = parseFloat(lat);
  const lonNum = parseFloat(lon);
  if (latNum < -90 || latNum > 90) throw new RangeError(`Invalid latitude ${latNum}`);
  if (lonNum < -180 || lonNum > 180) throw new RangeError(`Invalid longitude ${lonNum}`);
  return { lat: latNum, lon: lonNum };
}

/**
 * Reference `DarkSkyHandler.validateAndExtractInputs`. `secondsSinceEpoch` is returned as the raw
 * query string when present (never coerced to a number), because `createRedisKey` tests it for
 * truthiness — the string "0" is truthy and therefore adds a ";1970-01-01" date segment.
 */
export function validateWeather(q) {
  // URLSearchParams reports an absent key as null; the original read the raw query object, where
  // it is undefined, and the message carries that value ("Invalid latitude undefined").
  const { lat, lon } = makeLatLon(q.get('lat') ?? undefined, q.get('lon') ?? undefined);
  const raw = q.get('secondsSinceEpoch');
  let secondsSinceEpoch = 0;
  if (raw) {
    if (!/^\d+$/.test(raw)) throw new RangeError(`Invalid timestamp: '${raw}'`);
    secondsSinceEpoch = raw;
  }
  return { lat, lon, secondsSinceEpoch };
}

/** Reference `DarkSkyHandler.createRedisKey`. */
export function weatherKey({ lat, lon, secondsSinceEpoch }) {
  let k = `dark_sky:${lat};${lon}`;
  if (secondsSinceEpoch) k += `;${new Date(Number(secondsSinceEpoch) * 1000).toISOString().substr(0, 10)}`;
  return k;
}

/** Default Open-Meteo fetch (overridable for tests). */
export async function openMeteoGet(lat, lon) {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    daily: 'weathercode,temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_sum,precipitation_probability_max',
    current_weather: 'true',
    temperature_unit: 'fahrenheit',
    windspeed_unit: 'mph',
    precipitation_unit: 'inch',
    timezone: 'auto',
    past_days: '1',
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
  if (!res.ok) { const e = new Error(`Open-Meteo ${res.status}`); e.status = 502; throw e; }
  return res.json();
}

/** fetchExternal for the relay: returns DarkSkyData. opts.get overrides the Open-Meteo call. */
export async function fetchWeather(input, { get = openMeteoGet } = {}) {
  const om = await get(input.lat, input.lon);
  if (!om) throw new Error('Empty reply from Open-Meteo');
  return openMeteoToDarkSky(om, input);
}

/**
 * Index of the requested day inside Open-Meteo's raw window: the timestamp's own day when one was
 * supplied, otherwise "today". Open-Meteo is asked for `past_days=1`, which puts today at index 1;
 * the clamp keeps a single-entry (or empty) window from over-slicing.
 */
function requestedDayIndex(times, requestedTime) {
  const todayIndex = Math.min(1, Math.max(0, times.length - 1));
  if (!requestedTime) return todayIndex;
  for (let i = 0; i < times.length; i++) {
    const start = Math.floor(new Date(times[i]).getTime() / 1000);
    if (requestedTime >= start && requestedTime < start + 86400) return i;
  }
  // The day is outside the fetched window (Open-Meteo only has the recent past here). Dark Sky
  // would have time-machined to it; the shim cannot, so it falls back to the window's base day.
  return todayIndex;
}

/** Map Open-Meteo onto the Dark Sky subset downstream reads. Ported from DarkSkyHandler.ts. */
export function openMeteoToDarkSky(om, input) {
  const { lat, lon, secondsSinceEpoch: requestedTime } = input;
  const daily = om.daily || {};
  const times = daily.time || [];
  const tmax = daily.temperature_2m_max || [];
  const tmin = daily.temperature_2m_min || [];
  const codes = daily.weathercode || [];
  const sunrises = daily.sunrise || [];
  const sunsets = daily.sunset || [];
  const precip = daily.precipitation_sum || [];
  const precipProb = daily.precipitation_probability_max || [];

  const dataPoints = times.map((iso, i) => ({
    time: Math.floor(new Date(iso).getTime() / 1000),
    temperatureHigh: tmax[i],
    temperatureLow: tmin[i],
    apparentTemperatureHigh: tmax[i],
    apparentTemperatureLow: tmin[i],
    sunriseTime: sunrises[i] ? Math.floor(new Date(sunrises[i]).getTime() / 1000) : undefined,
    sunsetTime: sunsets[i] ? Math.floor(new Date(sunsets[i]).getTime() / 1000) : undefined,
    precipIntensity: typeof precip[i] === 'number' ? precip[i] / 24 : 0,
    precipProbability: typeof precipProb[i] === 'number' ? precipProb[i] / 100 : 0,
    icon: weatherCodeToIcon(codes[i]),
    summary: weatherCodeToSummary(codes[i]),
  }));

  // Dark Sky indexes daily.data from the requested day: `data[0]` is that day and `data[1]` the
  // next. Slice the raw [.., yesterday, today, ..] window from the requested day accordingly.
  const dailyData = dataPoints.slice(requestedDayIndex(times, requestedTime));
  const cur = dailyData[0] || null;

  // A forecast request reports the provider's current conditions (Open-Meteo `current_weather`,
  // which openMeteoGet already asks for); a time-machine request is about its own day, which
  // current_weather cannot speak to, so that path keeps the requested day's high/low.
  const cw = !requestedTime ? om.current_weather : undefined;
  const currently = cw
    ? {
      time: cur ? cur.time : undefined,
      temperature: cw.temperature,
      apparentTemperature: typeof cw.apparent_temperature === 'number' ? cw.apparent_temperature : cw.temperature,
      icon: weatherCodeToIcon(cw.weathercode),
      summary: weatherCodeToSummary(cw.weathercode),
    }
    : (cur ? { time: cur.time, temperature: cur.temperatureHigh, apparentTemperature: cur.apparentTemperatureHigh, icon: cur.icon, summary: cur.summary } : undefined);

  return {
    latitude: lat,
    longitude: lon,
    timezone: om.timezone || 'UTC',
    currently,
    daily: { summary: cur ? cur.summary : '', icon: cur ? cur.icon : 'cloudy', data: dailyData },
    flags: { 'darksky-unavailable': false, sources: ['open-meteo'], units: 'us' },
  };
}

export function weatherCodeToIcon(code) {
  if (code === undefined || code === null) return 'cloudy';
  if (code === 0) return 'clear-day';
  if (code === 1 || code === 2) return 'partly-cloudy-day';
  if (code === 3) return 'cloudy';
  if (code === 45 || code === 48) return 'fog';
  if (code >= 51 && code <= 67) return 'rain';
  if (code >= 71 && code <= 77) return 'snow';
  if (code >= 80 && code <= 82) return 'rain';
  if (code === 85 || code === 86) return 'snow';
  if (code >= 95) return 'rain';
  return 'cloudy';
}

export function weatherCodeToSummary(code) {
  const m = {
    0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Foggy', 48: 'Foggy',
    51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Heavy freezing drizzle',
    61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Heavy freezing rain',
    71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
    80: 'Light rain showers', 81: 'Rain showers', 82: 'Heavy rain showers', 85: 'Light snow showers', 86: 'Heavy snow showers',
    95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Heavy thunderstorm with hail',
  };
  return m[code] || 'Mixed weather';
}
