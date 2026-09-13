'use strict';

// Input and projection helpers shared by the Node 8 source runner and the
// modern candidate runner.  The source runner still obtains the actual raw
// object and preference shape from the archived TestUtils; these helpers keep
// the candidate input contract explicit and keep receipt projection identical.

const DEFAULT_WEATHER = {
  yest: { icon: 'clear-day', high: 57.7, low: 54.35, summary: 'Summer Breeze, make me feel fine...' },
  today: { icon: 'rain', high: 50.3, low: 45.83, summary: 'Raining Blood! (from a lacerated sky)' },
  tomorrow: { icon: 'fog', high: 55.3, low: 40.83, summary: "Bet your bottom dollar that tomorrow there'll be fog" },
  current: { icon: 'cloudy', temp: 65, summary: 'Cloudy with a chance of meatballs' },
};

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

// @jibo/utils-common's deepMerge preserves null and recursively merges plain
// objects.  Weather.test.js uses it to overlay each case's sparse options.
function deepMerge(base, patch) {
  if (patch === null || patch === undefined) return patch === undefined ? clone(base) : null;
  if (Array.isArray(patch)) return clone(patch);
  if (typeof patch !== 'object') return patch;
  const out = (base && typeof base === 'object' && !Array.isArray(base)) ? clone(base) : {};
  Object.keys(patch).forEach((key) => { out[key] = deepMerge(out[key], patch[key]); });
  return out;
}

function createRawWeatherData(opts) {
  if (opts === null || (opts && opts.__noData)) return undefined;
  const merged = deepMerge(DEFAULT_WEATHER, opts || {});
  return [
    { daily: { data: [{ summary: merged.yest.summary, icon: merged.yest.icon, temperatureHigh: merged.yest.high, temperatureLow: merged.yest.low }] } },
    {
      currently: { icon: merged.current.icon, temperature: merged.current.temp, summary: merged.current.summary },
      daily: { data: [
        { summary: merged.today.summary, icon: merged.today.icon, temperatureHigh: merged.today.high, temperatureLow: merged.today.low },
        { summary: merged.tomorrow.summary, icon: merged.tomorrow.icon, temperatureHigh: merged.tomorrow.high, temperatureLow: merged.tomorrow.low },
      ] },
    },
  ];
}

function applyVariant(raw, variant) {
  if (variant === 'no-data') return undefined;
  if (variant === 'null-today') { raw[1] = null; return raw; }
  if (variant === 'null-yesterday') { raw[0] = null; return raw; }
  if (variant === 'truncate-tomorrow') { raw[1].daily.data.length = 1; return raw; }
  if (variant && variant !== 'default') throw new Error(`Unknown S-09 fixture variant: ${variant}`);
  return raw;
}

function buildPrefs(run) {
  const active = run.active || ['weather', 'calendar', 'commute', 'news'];
  const prefs = {
    weather: { active: active.includes('weather'), useCelsius: !!(run.prefs && run.prefs.useCelsius) },
    calendar: { active: active.includes('calendar') },
    commute: { active: active.includes('commute') },
    news: { active: active.includes('news') },
  };
  return prefs;
}

function basenameMim(value) {
  if (typeof value !== 'string') return value;
  const name = value.split('/').pop();
  return name && name.endsWith('.mim') ? name.slice(0, -4) : name;
}

function projectDay(value) {
  if (!value) return null;
  return {
    highTemp: value.highTemp === undefined ? null : value.highTemp,
    lowTemp: value.lowTemp === undefined ? null : value.lowTemp,
    icon: value.icon === undefined ? null : value.icon,
    summary: value.summary === undefined ? null : value.summary,
  };
}

function projectCurrent(value) {
  if (!value) return null;
  return {
    temp: value.temp === undefined ? null : value.temp,
    icon: value.icon === undefined ? null : value.icon,
    summary: value.summary === undefined ? null : value.summary,
  };
}

function projectWeather(value) {
  if (!value) return null;
  return {
    yest: projectDay(value.yest),
    today: projectDay(value.today),
    tomorrow: projectDay(value.tomorrow),
    current: projectCurrent(value.current),
    icon: value.icon === undefined ? null : value.icon,
    summary: value.summary === undefined ? null : value.summary,
    prefix: value.prefix === undefined ? null : value.prefix,
    useCelsius: value.useCelsius === undefined ? null : value.useCelsius,
    onlyWeatherActive: value.onlyWeatherActive === undefined ? null : value.onlyWeatherActive,
  };
}

function projectView(value) {
  return value === undefined ? null : value;
}

function projectLocal(local) {
  return {
    mims: (local && local.mimPaths || []).map(basenameMim),
    weather: projectWeather(local && local.weather),
    view: projectView(local && local.views && local.views.weatherHiLo),
  };
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => { out[key] = stable(value[key]); return out; }, {});
  }
  if (typeof value === 'number' && Number.isNaN(value)) return 'NaN';
  return value;
}

module.exports = {
  clone,
  createRawWeatherData,
  applyVariant,
  buildPrefs,
  projectWeather,
  projectLocal,
  projectView,
  stable,
};
