// Weather subskill — port of report-skill/src/subskills/weather/{WeatherFactory,WeatherData,
// WeatherParse,WeatherMimLogic}.ts. The MimLogic condition tables decide which comment/change/
// high-low MIMs join the mega-MAN: yesterday-vs-today condition changes (cloudy→clear etc.),
// ±10 °F temperature swings against hot/cold thresholds, wet-now-dry-later, day/night icon fixes.

import { Graph } from '../graph/graph.js';
import { DefaultNode, DefaultTransition } from '../graph/nodes.js';
import { Names, fToCelsius, onlyActiveSubskill, randFromArray, getJSON, addMimPathsToLocalData, tempThresholds, askedForTomorrow } from './utils.js';
import { LassoClient } from './lassoClient.js';

const hoursToMs = (h) => h * 3600 * 1000;

const Icon = Object.freeze({
  clearDay: 'clear-day', clearNight: 'clear-night', rain: 'rain', snow: 'snow', sleet: 'sleet',
  fog: 'fog', wind: 'wind', cloudy: 'cloudy', partlyCloudyDay: 'partly-cloudy-day', partlyCloudyNight: 'partly-cloudy-night',
});

export const MimPath = Object.freeze({
  Intro: 'Intro', IntroTomorrow: 'IntroTomorrow', DarkSkySummary: 'DarkSkySummary',
  WetNowDryLater: 'WetNowDryLater', ServiceDown: 'ServiceDown',
  ChangeCloudyClear: 'ChangeCloudyClear', ChangeCloudyWet: 'ChangeCloudyWet',
  ChangeWetClear: 'ChangeWetClear', ChangeClearWet: 'ChangeClearWet',
  TodayHighLow: 'TodayHighLow', TomorrowHighLow: 'TomorrowHighLow',
  TodayColder: 'TodayColder', TodayCooler: 'TodayCooler', TodayWarmer: 'TodayWarmer', TodayHotter: 'TodayHotter',
  Comment: 'Comment', Basic: 'Basic',
  ClearDay: 'ClearDay', ClearNight: 'ClearNight', Rain: 'Rain', Snow: 'Snow', Sleet: 'Sleet',
  Fog: 'Fog', Wind: 'Wind', Cloudy: 'Cloudy', PartlyCloudyDay: 'PartlyCloudyDay', PartlyCloudyNight: 'PartlyCloudyNight',
});

// --- WeatherData -------------------------------------------------------------

/** Fetch [yesterday, today] DarkSky data; null on failure (caller degrades). */
export async function getData(userPrefs, data) {
  const log = data.log;
  const todayUTC = data.skill.session.data.darkSkyPrefetchUTC || Date.now();
  const yestUTC = todayUTC - hoursToMs(24);

  let weatherData = null;
  try {
    weatherData = await Promise.all([
      LassoClient.fetchDarkSky(data, yestUTC),
      // No timestamp for "today" or we lose forecast data; cache expiry keeps nows distinct.
      LassoClient.fetchDarkSky(data),
    ]);
  } catch (err) {
    log?.error?.(`Error getting weather data: ${err.message}`);
  }
  return [Names.weather, weatherData];
}

// --- WeatherParse ------------------------------------------------------------

export function weatherParse(responseData, prefs) {
  if (!responseData) return undefined;
  const [yesterData, todayData] = responseData;
  if (!todayData) return undefined;
  const useCelsius = prefs.weather.useCelsius;

  const yest = parseDarkSkyDaily(yesterData, 0, useCelsius);
  const today = parseDarkSkyDaily(todayData, 0, useCelsius);
  const tomorrow = parseDarkSkyDaily(todayData, 1, useCelsius);
  const current = parseDarkSkyCurrent(todayData, useCelsius);

  const promptText = getJSON('report-mimPromptText');
  const prefix = randFromArray(promptText.weather.prefix) || 'It looks like';

  return { yest, today, tomorrow, current, prefix, useCelsius, onlyWeatherActive: onlyActiveSubskill(Names.weather, prefs) };
}

function parseDarkSkyDaily(response, daysFromToday, useCelsius = false) {
  if (!response) return undefined;
  const daily = response.daily && response.daily.data && response.daily.data[daysFromToday];
  if (!daily) return undefined;
  const { temperatureHigh, temperatureLow, summary, icon } = daily;
  return {
    highTemp: useCelsius ? fToCelsius(temperatureHigh) : Math.round(temperatureHigh),
    lowTemp: useCelsius ? fToCelsius(temperatureLow) : Math.round(temperatureLow),
    icon,
    summary: summary != null ? sanitizeSummary(summary) : summary,
  };
}

function parseDarkSkyCurrent(response, useCelsius = false) {
  if (!response || !response.currently) return { temp: null, icon: null, summary: '' };
  const { temperature, summary, icon } = response.currently;
  return {
    temp: useCelsius ? fToCelsius(temperature) : Math.round(temperature),
    icon,
    summary: summary != null ? sanitizeSummary(summary) : '',
  };
}

/** '<' -> 'less than', '5 in.' -> '5 inches' etc, for TTS. */
export function sanitizeSummary(summary) {
  return String(summary)
    .replace(/</g, 'less than')
    .replace(/>/g, 'more than')
    .replace(/(\d+)\s?(in\.|ft\.)/g, (match, group1, group2) => {
      if (group2 === 'in.') group2 = (parseInt(group1, 10) === 1) ? 'inch' : 'inches';
      else if (group2 === 'ft.') group2 = (parseInt(group1, 10) === 1) ? 'foot' : 'feet';
      return `${group1} ${group2}`;
    });
}

// --- WeatherMimLogic ----------------------------------------------------------

export class WeatherMimLogic extends DefaultNode {
  async exit(data) {
    const weatherData = data.local.weather || {};
    const { yest, current, tomorrow } = weatherData;
    const today = weatherData.today;

    const iso = (data.runtime.location && data.runtime.location.iso) || undefined;
    const hour = new Date(iso || Date.now()).getHours();
    const isDaytime = (hour > 2 && hour < 18);

    if (today) today.icon = matchIconToTime(today, isDaytime);
    if (current) current.icon = matchIconToTime(current, isDaytime);

    const weatherSingleSkill = (data.skill.session.data._personalReport.singleSkill === Names.weather);

    // Single skill: today unless the user asked for tomorrow. Full report: today unless evening.
    const useToday = weatherSingleSkill ? !askedForTomorrow(data) : isDaytime;
    const dayData = useToday ? today : tomorrow;

    const mimPaths = [];

    if (dayData && dayData.highTemp && dayData.lowTemp && dayData.icon && dayData.summary) {
      mimPaths.push(useToday ? MimPath.Intro : MimPath.IntroTomorrow);

      // Avoid branching on today/tomorrow inside the mims.
      data.local.weather.icon = dayData.icon;
      data.local.weather.summary = dayData.summary;

      // Change MIMs only apply when speaking about today.
      const yestIcon = useToday && yest && yest.icon;
      const yestHigh = useToday && yest && yest.highTemp;
      const condChangePath = yestIcon && conditionChanged(yestIcon, dayData.icon);
      const tempChangePath = yestHigh && tempChanged(yestHigh, dayData.highTemp, weatherData.useCelsius);

      // Comment MIM only when no Condition Change MIM played.
      mimPaths.push(condChangePath || getCommentMim(dayData.icon));

      if (useToday && isWet(current.icon) && !isWet(today.icon)) {
        mimPaths.push(MimPath.WetNowDryLater);
      }

      // HighLow MIM only when no Temperature Change MIM played.
      mimPaths.push(tempChangePath || (useToday ? MimPath.TodayHighLow : MimPath.TomorrowHighLow));

      data.local.views.weatherHiLo = {}; // GUI view config (display layer) — not rendered in Phoenix sim
    } else if (dayData && dayData.icon) {
      mimPaths.push(useToday ? MimPath.Intro : MimPath.IntroTomorrow);
      mimPaths.push(MimPath.Basic + getMimFromIcon(dayData.icon));
    } else {
      mimPaths.push(MimPath.ServiceDown);
    }

    data.local.mimPaths = addMimPathsToLocalData(Names.weather, mimPaths, data.local);

    return { transition: DefaultTransition.Done };
  }
}

/** DarkSky sometimes hands out night icons during the day and vice versa. */
function matchIconToTime(weatherData, isDaytime) {
  if (isDaytime) {
    return (weatherData.icon === Icon.partlyCloudyNight) ? Icon.partlyCloudyDay
      : (weatherData.icon === Icon.clearNight) ? Icon.clearDay
        : weatherData.icon;
  }
  return (weatherData.icon === Icon.partlyCloudyDay) ? Icon.partlyCloudyNight
    : (weatherData.icon === Icon.clearDay) ? Icon.clearNight
      : weatherData.icon;
}

function conditionChanged(yesterday, today) {
  if (isClear(today)) {
    if (isCloudy(yesterday)) return MimPath.ChangeCloudyClear;
    if (isWet(yesterday)) return MimPath.ChangeWetClear;
  } else if (isWet(today)) {
    if (isCloudy(yesterday)) return MimPath.ChangeCloudyWet;
    if (isClear(yesterday)) return MimPath.ChangeClearWet;
  }
  return undefined;
}

function tempChanged(yestHigh, todayHigh, useCelsius) {
  const CHANGE_DEGREES = useCelsius ? 6 : 10;
  const { hotThreshold, coldThreshold } = tempThresholds(useCelsius);
  if (typeof yestHigh === 'number') {
    if ((todayHigh - yestHigh) >= CHANGE_DEGREES) {
      return todayHigh >= hotThreshold ? MimPath.TodayHotter : MimPath.TodayWarmer;
    }
    if ((todayHigh - yestHigh) <= -CHANGE_DEGREES) {
      return todayHigh <= coldThreshold ? MimPath.TodayColder : MimPath.TodayCooler;
    }
  }
  return undefined;
}

function getCommentMim(icon) { return MimPath.Comment + getMimFromIcon(icon); }
const isWet = (icon) => icon === Icon.snow || icon === Icon.rain || icon === Icon.sleet;
const isClear = (icon) => icon === Icon.clearDay || icon === Icon.clearNight;
const isCloudy = (icon) => icon === Icon.cloudy;

function getMimFromIcon(icon) {
  switch (icon) {
    case Icon.clearDay: return MimPath.ClearDay;
    case Icon.clearNight: return MimPath.ClearNight;
    case Icon.rain: return MimPath.Rain;
    case Icon.snow: return MimPath.Snow;
    case Icon.sleet: return MimPath.Sleet;
    case Icon.fog: return MimPath.Fog;
    case Icon.wind: return MimPath.Wind;
    case Icon.cloudy: return MimPath.Cloudy;
    case Icon.partlyCloudyDay: return MimPath.PartlyCloudyDay;
    case Icon.partlyCloudyNight: return MimPath.PartlyCloudyNight;
    default: return '';
  }
}

// --- WeatherFactory -------------------------------------------------------------

export const WeatherTransition = Object.freeze({ Done: 'Done' });

export class WeatherFactory {
  createGraph(gm) {
    const g = new Graph(gm, 'Weather', Object.values(WeatherTransition));
    const weatherLogicNode = new WeatherMimLogic('Weather Logic');
    const outroNode = new DefaultNode('Weather Outro');
    g.addNode(weatherLogicNode, [[DefaultTransition.Done, outroNode]]);
    g.addNode(outroNode, [[DefaultTransition.Done, WeatherTransition.Done]]);
    g.finalize();
    return g;
  }
}
