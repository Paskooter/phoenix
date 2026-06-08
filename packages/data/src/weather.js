// Weather relay — Phoenix port of lasso/relay/DarkSkyHandler.ts (the 2026 Open-Meteo shim).
// Fetches from Open-Meteo (free, keyless) and re-shapes into the Dark Sky `DarkSkyData` schema
// the report-skill weather subskill reads (daily.data[N].temperatureHigh/Low, summary, icon).
// past_days=1 includes yesterday for the report's yesterday/today comparison.

export function validateWeather(q) {
  const lat = Number(q.get('lat'));
  const lon = Number(q.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('lat and lon are required');
  const sse = q.get('secondsSinceEpoch');
  if (sse && !/^\d+$/.test(sse)) throw new Error(`Invalid timestamp: '${sse}'`);
  return { lat, lon, secondsSinceEpoch: sse ? Number(sse) : 0 };
}

export function weatherKey({ lat, lon, secondsSinceEpoch }) {
  let k = `dark_sky:${lat};${lon}`;
  if (secondsSinceEpoch) k += `;${new Date(secondsSinceEpoch * 1000).toISOString().substr(0, 10)}`;
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

  // Daily entry covering requestedTime; else "today" (idx 1 with past_days=1, else 0).
  let currentDayIndex = Math.min(1, times.length - 1);
  if (requestedTime) {
    for (let i = 0; i < times.length; i++) {
      const start = Math.floor(new Date(times[i]).getTime() / 1000);
      if (requestedTime >= start && requestedTime < start + 86400) { currentDayIndex = i; break; }
    }
  }
  const cur = dataPoints[currentDayIndex] || null;

  return {
    latitude: lat,
    longitude: lon,
    timezone: om.timezone || 'UTC',
    currently: cur ? { time: cur.time, temperature: cur.temperatureHigh, apparentTemperature: cur.apparentTemperatureHigh, icon: cur.icon, summary: cur.summary } : undefined,
    daily: { summary: cur ? cur.summary : '', icon: cur ? cur.icon : 'cloudy', data: dataPoints },
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
