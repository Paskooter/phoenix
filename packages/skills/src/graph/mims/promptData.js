// PromptData — the standard sandbox supplied to baseskill MIM conditions and
// templates. The original implementation is PromptData.ts plus LooperData,
// JiboData, NLData and jibo-data-utils. Phoenix keeps this API dependency free
// while retaining the source's values, missing-field behavior and fixed
// runtime timezone.

import { loadMimFile } from './loadMim.js';
import { DateTime, Timezone, dateTimeConstants, parseIsoOffset } from './dateTime.js';
import { NLAge, NLZodiac } from './nlData.js';
import { PromptLocation } from './locationData.js';

const { localeWeekOfYear } = dateTimeConstants;
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// jibo-data-utils Timezone.isoStringParser is narrower than Moment.parseZone:
// only uppercase Z or a colon-separated offset, and exactly three fractional
// digits when present. PromptData's guarded DateTime construction retains that
// distinction from the independently calculated currentMoment offset.
const SOURCE_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(([+-])(\d\d):(\d\d)|Z)$/;

// Moment's English locale appends an ordinal suffix even to zero (`0th`),
// unlike jibo-data-utils' verbal-number helper used by DateTime.toString.
function promptOrdinal(number) {
  const lastTwo = number % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${number}th`;
  switch (number % 10) {
    case 1: return `${number}st`;
    case 2: return `${number}nd`;
    case 3: return `${number}rd`;
    default: return `${number}th`;
  }
}

/**
 * Build the standard PromptData object from a runtime context.
 *
 * Date/location and loop data follow the source's separate guarded blocks.
 * Incomplete contexts retain source null/empty defaults instead of being
 * filled from guessed values.
 */
export function buildPromptData(runtime = {}, skillData) {
  const context = runtime && typeof runtime === 'object' ? runtime : {};
  const hasSkillArgument = arguments.length > 1 && skillData !== undefined;
  const rawSkill = skillData && typeof skillData === 'object' ? skillData : {};
  // Slimmer's provider path supplies `{...skillData, skill: skillData}` so
  // root compatibility fields and the source nested `skill` object can both
  // be retained.
  const hasNestedSkill = Object.prototype.hasOwnProperty.call(rawSkill, 'skill');
  const skill = hasNestedSkill ? rawSkill.skill : hasSkillArgument ? skillData : undefined;
  const promptData = {
    ...rawSkill,
    speaker: null,
    referent: null,
    jibo: null,
    dt: {},
    location: {},
    loop: {},
    skill,
  };

  const location = context.location;
  if (!location) return promptData;

  // PromptData has two independent guarded blocks. A bad location date clears
  // only dt/location; the loop block still runs with the current UTC moment.
  // Missing/null location ISO values are accepted by the source DateTime as
  // "now", while a non-empty malformed string fails its date block.
  const currentInstant = new Date(Date.now());
  let loopOffset = 0;
  try {
    const iso = location.iso;
    loopOffset = locationOffset(iso);
    const timezone = new Timezone(loopOffset);
    const currentLocal = new Date(Date.now() + loopOffset);
    promptData.dt = buildDateTimeData(iso, timezone, currentLocal);
    promptData.location = buildLocationData(location, timezone);
  } catch {
    promptData.dt = {};
    promptData.location = {};
    // The source keeps currentMoment when the later DateTime constructor
    // fails, so birthday/loop calculations retain its successfully set offset.
  }

  // PromptData only populates loop data when all four runtime sections exist.
  // Its loop try block is independent from the date/location try block and
  // keeps fields assigned before malformed user data throws.
  if (context.perception && context.loop && context.character && context.dialog) {
    const currentLocal = new Date(Date.now() + loopOffset);
    try {
      buildLoopData(context, currentInstant, currentLocal, promptData);
    } catch {
      promptData.loop = {};
    }
  }

  return promptData;
}

function locationOffset(iso) {
  if (iso === undefined || iso === null || iso === '' || iso === 'null') return 0;
  if (typeof iso === 'number') {
    if (!Number.isFinite(iso)) throw new RangeError('invalid location ISO');
    return 0;
  }
  if (iso instanceof Date) {
    if (!Number.isFinite(iso.getTime())) throw new RangeError('invalid location ISO');
    return 0;
  }
  if (typeof iso !== 'string') return 0;
  const offset = parseIsoOffset(iso);
  if (offset === null || !Number.isFinite(Date.parse(iso))) throw new RangeError('invalid location ISO');
  return offset;
}

function buildDateTimeData(iso, timezone, currentLocal) {
  // The source DateTime parser rejects these non-date inputs inside its
  // guarded block; do not silently turn them into the current time.
  if (iso && iso !== 'null' && typeof iso !== 'number' && !(iso instanceof Date) &&
      (typeof iso !== 'string' || !SOURCE_ISO.test(iso))) {
    throw new TypeError('Invalid runtime DateTime input');
  }
  const month = currentLocal.getUTCMonth();
  const date = currentLocal.getUTCDate();
  const dayOfYear = Math.floor((Date.UTC(currentLocal.getUTCFullYear(), month, date) - Date.UTC(currentLocal.getUTCFullYear(), 0, 1)) / (24 * 60 * 60 * 1000)) + 1;
  const week = localeWeekOfYear(currentLocal);
  return {
    now: new DateTime(iso, timezone),
    date: `${MONTHS[month]} ${promptOrdinal(date)}`,
    day: DAYS[currentLocal.getUTCDay()],
    dayOfWeek: promptOrdinal(currentLocal.getUTCDay()),
    dayOfMonth: promptOrdinal(date),
    dayOfYear: promptOrdinal(dayOfYear),
    weekOfYear: promptOrdinal(week),
    month: MONTHS[month],
    monthOfYear: promptOrdinal(month + 1),
    quarterOfYear: promptOrdinal(Math.floor(month / 3) + 1),
    year: String(currentLocal.getUTCFullYear()),
  };
}

function buildLocationData(runtimeLocation, timezone) {
  const home = new PromptLocation(runtimeLocation, timezone);
  return {
    home,
    city: home.city,
    state: home.state,
    stateAbbr: home.stateAbbr,
    country: home.country,
    countryCode: home.countryCode,
    lat: home.lat,
    lng: home.lng,
  };
}

function buildLoopData(context, currentInstant, currentLocal, promptData) {
  const users = context.loop.users;
  if (context.loop.jibo) {
    // Assign before walking users, matching the source's partial-state behavior
    // when a later malformed user record throws.
    promptData.jibo = buildJiboData(context.loop.jibo, context.character.emotion, currentInstant, currentLocal);
  }
  const loopNames = [];
  let owner = null;
  users.forEach(user => {
    // The source pushes the name before resolving speaker/referent/owner. Keep
    // that ordering and let malformed entries enter the guarded catch.
    loopNames.push(user.phoneticName);
    if (context.perception.speaker && user.id === context.perception.speaker) {
      promptData.speaker = buildLooperData(user, currentInstant, currentLocal);
    }
    if (context.dialog.referent && user.id === context.dialog.referent) {
      promptData.referent = buildLooperData(user, currentInstant, currentLocal);
    }
    if (context.loop.owner && user.id === context.loop.owner) {
      owner = buildLooperData(user, currentInstant, currentLocal);
    }
  });
  promptData.loop = {
    owner,
    list: makePronounceable(loopNames),
    count: loopNames.length,
  };
}

function buildLooperData(info = {}, currentInstant, currentLocal) {
  const birthdate = birthdateAtUtcStart(info.birthdate);
  const data = {
    id: info.id,
    firstName: info.firstName,
    lastName: info.lastName,
    gender: info.gender,
    birthdate: formatLongDate(birthdate),
    birthday: formatMonthDay(birthdate),
    isBirthday: isBirthday(currentLocal, birthdate),
    age: new NLAge(currentInstant, birthdate),
    zodiac: new NLZodiac(getHoroscopeSignFromDate(birthdate)),
  };
  data.toString = () => info.phoneticName;
  return data;
}

function buildJiboData(info = {}, emotionInfo, currentInstant, currentLocal) {
  const birthdate = birthdateAtUtcStart(info.birthdate);
  // EmotionData reads these fields directly. Preserve the source throw when
  // the runtime supplies no emotion object so the guarded loop remains empty.
  const name = emotionInfo.name;
  const emotion = {
    valence: emotionInfo.valence,
    confidence: emotionInfo.confidence,
    toString: () => name,
  };
  return {
    id: info.id,
    color: info.color,
    birthdate: formatLongDate(birthdate),
    birthday: formatMonthDay(birthdate),
    isBirthday: isBirthday(currentLocal, birthdate),
    age: new NLAge(currentInstant, birthdate),
    zodiac: new NLZodiac(getHoroscopeSignFromDate(birthdate)),
    emotion,
    toString: () => 'Jibo',
  };
}

function birthdateAtUtcStart(value) {
  // moment(undefined) means "now" in the source implementation; null and
  // other invalid values remain invalid instead of silently becoming epoch.
  if (value === null || value === '' || value === false || value === true) return new Date(NaN);
  const parsed = value === undefined
    ? new Date(Date.now())
    : value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(parsed.getTime())) return new Date(NaN);
  return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
}

function formatMonthDay(date) {
  if (Number.isNaN(date.getTime())) return 'Invalid date';
  return `${MONTHS[date.getUTCMonth()]} ${promptOrdinal(date.getUTCDate())}`;
}

function formatLongDate(date) {
  if (Number.isNaN(date.getTime())) return 'Invalid date';
  return `${formatMonthDay(date)} ${date.getUTCFullYear()}`;
}

function isBirthday(currentLocal, birthdate) {
  return !Number.isNaN(birthdate.getTime()) && currentLocal.getUTCDate() === birthdate.getUTCDate() && currentLocal.getUTCMonth() === birthdate.getUTCMonth();
}

function getHoroscopeSignFromDate(date) {
  if (Number.isNaN(date.getTime())) return 'Ophiuchus';
  const month = date.getUTCMonth() + 1;
  // Preserve the source helper's +1 behavior; source tests and generated
  // prompts rely on its Aquarius boundary.
  const day = date.getUTCDate() + 1;
  if (month <= 0) return 'Ophiuchus';
  if ((month === 12 && day > 21) || (month === 1 && day <= 20)) return 'Capricorn';
  if ((month === 1 && day > 20) || (month === 2 && day <= 19)) return 'Aquarius';
  if ((month === 2 && day > 19) || (month === 3 && day <= 20)) return 'Pisces';
  if ((month === 3 && day > 20) || (month === 4 && day <= 20)) return 'Aries';
  if ((month === 4 && day > 20) || (month === 5 && day <= 21)) return 'Taurus';
  if ((month === 5 && day > 21) || (month === 6 && day <= 21)) return 'Gemini';
  if ((month === 6 && day > 21) || (month === 7 && day <= 22)) return 'Cancer';
  if ((month === 7 && day > 22) || (month === 8 && day <= 22)) return 'Leo';
  if ((month === 8 && day > 22) || (month === 9 && day <= 22)) return 'Virgo';
  if ((month === 9 && day > 22) || (month === 10 && day <= 22)) return 'Libra';
  if ((month === 10 && day > 22) || (month === 11 && day <= 21)) return 'Scorpio';
  if ((month === 11 && day > 21) || (month === 12 && day <= 21)) return 'Sagittarius';
  return 'Ophiuchus';
}

function makePronounceable(values) {
  const copy = values.slice();
  let last = '';
  if (copy.length > 1) last = ` and ${copy.pop()}`;
  return copy.join(', ') + last;
}

export { loadMimFile };
