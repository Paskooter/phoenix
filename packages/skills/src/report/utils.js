// report-skill utils — port of report-skill/src/utils.ts (the parts the live subskills use).

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const RESOURCES = join(dirname(fileURLToPath(import.meta.url)), '../../resources');
const MIM_DIR = join(RESOURCES, 'mims/report/en-us');

export const Names = Object.freeze({
  personalReport: 'personalReport',
  calendar: 'calendar',
  commute: 'commute',
  news: 'news',
  weather: 'weather',
  optIn: 'optIn',
});

export const yearsToMs = (years) => 1000 * 60 * 60 * 24 * 365 * years;

export function secondsToMinutes(seconds) { return seconds >= 60 ? Math.floor(seconds / 60) : 0; }

export const titleCase = (str) => str.slice(0, 1).toUpperCase().concat(str.slice(1));

/** True if two Sets intersect. */
export const areIntersecting = (a, b) => [...a].some((word) => b.has(word));

/** Full path of a vendored report MIM: composeMimPath('weather', 'Intro') -> .../WeatherIntro.mim */
export function composeMimPath(catName, mimPath) {
  const prefix = titleCase(catName) || '';
  return join(MIM_DIR, `${prefix}${mimPath}.mim`);
}

/** Append composed MIM paths to data.local.mimPaths (creating it if needed). */
export function addMimPathsToLocalData(catName, mimPaths, localData = {}) {
  return mimPaths.reduce((session, p) => session.concat(composeMimPath(catName, p)), (localData.mimPaths || []));
}

/** True if `subskill` is the only active category in userPrefs. */
export function onlyActiveSubskill(subskill, userPrefs) {
  for (const category in userPrefs) {
    if (userPrefs[category].active && category !== subskill) return false;
  }
  return true;
}

/** Load a JSON file under resources/ ('report-mimPromptText' etc). */
export function getJSON(name) {
  return JSON.parse(readFileSync(join(RESOURCES, `${name}.json`), 'utf8'));
}

/** Speaker's accountId from the loop context. */
export function getAccountFromLooper(loop, looperID) {
  if (!loop || !loop.users) throw new Error(`Missing loop data. loop: ${!!loop}, loop.users ${!!(loop && loop.users)}`);
  const looperNode = loop.users.find((u) => u.id === looperID);
  if (!looperNode) throw new Error('Could not get accountID from looperID');
  return looperNode.accountId;
}

/** User asked about tomorrow (nlu entities.date === 'tomorrow'). */
export function askedForTomorrow(data) {
  const personalReportData = data.skill.session.data._personalReport;
  const nlu = personalReportData && personalReportData.nlu;
  return !!(nlu && nlu.entities && nlu.entities.date === 'tomorrow');
}

/** True if the speaker is IDed and at least 13 years old. */
export function speakerIsAdult(data) {
  const runtime = data.runtime || {};
  if (!runtime.perception || !runtime.perception.speaker) return false;
  const users = (runtime.loop && runtime.loop.users) || [];
  const speakerInfo = users.find((user) => user.id === runtime.perception.speaker);
  if (speakerInfo && speakerInfo.birthdate) {
    const now = new Date((runtime.location && runtime.location.iso) || Date.now()).valueOf();
    return (now - new Date(speakerInfo.birthdate).valueOf()) >= yearsToMs(13);
  }
  return false;
}

export function fToCelsius(temp, round = true) {
  const celsiusTemp = (temp - 32) * (5 / 9);
  return round ? Math.round(celsiusTemp) : celsiusTemp;
}

export function tempThresholds(useCelsius) {
  const HOT_F = 85;
  const COLD_F = 40;
  return {
    hotThreshold: useCelsius ? fToCelsius(HOT_F) : HOT_F,
    coldThreshold: useCelsius ? fToCelsius(COLD_F) : COLD_F,
  };
}

export function randFromArray(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
