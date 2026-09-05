// The baseskill PromptData contract uses jibo-data-utils' DateTime object.
// This is the small, dependency-free implementation needed by MIM evaluation.
// It deliberately keeps the timezone as the fixed offset carried by the
// runtime ISO value.  The runtime does not provide an IANA zone name, so
// consulting the host timezone would make the same prompt vary by machine.

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const HOUR_IN_MS = 60 * 60 * 1000;
const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];
const DAYS_OF_WEEK = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const TIME_PERIODS = Object.freeze({
  YEAR: 'year', MONTH: 'month', WEEK: 'week', WEEKEND: 'weekend', DAY: 'day',
  MORNING: 'morning', AFTERNOON: 'afternoon', EVENING: 'evening', NIGHT: 'night',
  HOUR: 'hour', MINUTE: 'minute', NOW: 'now',
});

function pad(value, length) {
  return String(value).padStart(length, '0');
}

/** The serializable timezone shape exposed by jibo-data-utils. */
export class Timezone {
  constructor(offsetUTC = 0, name = 'Unknown', id = 'Unknown') {
    this.offsetUTC = Number.isFinite(offsetUTC) ? offsetUTC : 0;
    this.name = name;
    this.id = id;
  }

  toISOString() {
    const minutes = Math.abs(this.offsetUTC) / 60000;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return `${this.offsetUTC < 0 ? '-' : '+'}${pad(hours, 2)}:${pad(rest, 2)}`;
  }

  toJSON() {
    return { __type: 'Timezone', offsetUTC: this.offsetUTC, name: this.name, id: this.id };
  }
}

/** Parse only an explicit ISO-8601 offset.  Bare local strings are unsafe. */
export function parseIsoOffset(iso) {
  if (typeof iso !== 'string') return null;
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso)) return null;
  const match = /([+-])(\d{2}):?(\d{2})$/i.exec(iso);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return (match[1] === '-' ? -1 : 1) * minutes * 60000;
}

function dateFromLocalUTC(utc, offset) {
  return new Date(utc + offset);
}

function ordinal(number) {
  if (number === 0) return 'zero';
  if (number % 100 >= 11 && number % 100 <= 13) return `${number}th`;
  switch (number % 10) {
    case 1: return `${number}st`;
    case 2: return `${number}nd`;
    case 3: return `${number}rd`;
    default: return `${number}th`;
  }
}

// PromptData's `Wo` token is Moment's ISO week token (Monday first, week four
// containing January 4). Keep the helper fixed to that source behavior.
function localeWeekOfYear(date) {
  const year = date.getUTCFullYear();
  const dayOfYear = Math.floor((Date.UTC(year, date.getUTCMonth(), date.getUTCDate()) - Date.UTC(year, 0, 1)) / DAY_IN_MS) + 1;
  const firstWeekOffset = targetYear => {
    const fwd = 7 + 1 - 4;
    const fwdDate = new Date(Date.UTC(targetYear, 0, fwd));
    const fwdlw = (7 + fwdDate.getUTCDay() - 1) % 7;
    return -fwdlw + fwd - 1;
  };
  const daysInYear = targetYear => new Date(Date.UTC(targetYear, 1, 29)).getUTCDate() === 29 ? 366 : 365;
  const weeksInYear = targetYear => (daysInYear(targetYear) - firstWeekOffset(targetYear) + firstWeekOffset(targetYear + 1)) / 7;
  const offset = firstWeekOffset(year);
  let week = Math.floor((dayOfYear - offset - 1) / 7) + 1;
  if (week < 1) {
    week += weeksInYear(year - 1);
  } else if (week > weeksInYear(year)) {
    week -= weeksInYear(year);
  }
  return week;
}

function verbalNumber(input) {
  if (input === 0) return 'zero';
  // DateTime.toString normally uses visual time, but retain the source
  // helper's words for callers that request dropPeriod.
  const ones = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
  const teens = ['ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty'];
  if (input < 0) return `negative ${verbalNumber(-input)}`;
  if (input < 10) return ones[input];
  if (input < 20) return teens[input - 10];
  if (input < 60) return `${tens[Math.floor(input / 10)]}${input % 10 ? ` ${ones[input % 10]}` : ''}`;
  return String(input);
}

function visualTime(hour, minute, dropPeriod = false) {
  let period = 'AM';
  if (hour >= 12) {
    period = 'PM';
    if (hour > 12) hour -= 12;
  } else if (hour === 0) {
    hour = 12;
  }
  const minuteName = minute === null ? '' : `:${pad(minute || 0, 2)}`;
  const hourName = String(hour === 0 ? 12 : hour);
  return dropPeriod ? `${hourName}${minuteName}` : `${hourName}${minuteName} ${period}`;
}

function verbalTime(hour, minute = 0, dropPeriod = false) {
  if (!dropPeriod) return visualTime(hour, minute);
  if (hour >= 12) {
    if (hour > 12) hour -= 12;
  } else if (hour === 0) {
    hour = 12;
  }
  let result = `${verbalNumber(hour)} `;
  if (minute === 0) result += "oh clock";
  else if (minute < 10) result += `oh ${verbalNumber(minute)}`;
  else result += verbalNumber(minute);
  return result;
}

function localDayNumber(utc, offset) {
  const local = dateFromLocalUTC(utc, offset);
  const now = dateFromLocalUTC(Date.now(), offset);
  const target = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const current = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.floor((target - current) / DAY_IN_MS + 0.1);
}

function daysBetweenDates(first, second) {
  const firstUTC = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate());
  const secondUTC = Date.UTC(second.getUTCFullYear(), second.getUTCMonth(), second.getUTCDate());
  return Math.floor((secondUTC - firstUTC) / DAY_IN_MS + 0.1);
}

/**
 * Fixed-offset equivalent of jibo-data-utils DateTime.  It intentionally
 * exposes the same public fields used by the source MIMs.
 */
export class DateTime {
  constructor(input, timezone = null) {
    this._utc = NaN;
    this.timezone = timezone instanceof Timezone ? timezone : new Timezone();
    this.durationDays = 0;
    this.durationHours = 0;
    this.durationMinutes = 0;
    this.timePeriod = null;
    this._localTime = null;

    if (typeof input === 'string') {
      const parsedOffset = parseIsoOffset(input);
      const parsed = Date.parse(input);
      if (parsedOffset !== null && Number.isFinite(parsed)) {
        this.timezone = timezone instanceof Timezone ? timezone : new Timezone(parsedOffset);
        this._utc = parsed;
        this.timePeriod = TIME_PERIODS.MINUTE;
        return;
      }
    } else if (input instanceof Date) {
      this._utc = input.getTime();
      this.timePeriod = TIME_PERIODS.MINUTE;
      return;
    } else if (typeof input === 'number') {
      this._utc = input;
      this.timePeriod = TIME_PERIODS.MINUTE;
      return;
    } else if (input && input.__type === 'DateTime') {
      this._utc = input.utc;
      const tz = input.timezone || {};
      this.timezone = new Timezone(tz.offsetUTC, tz.name, tz.id);
      this.durationDays = input.durationDays || 0;
      this.durationHours = input.durationHours || 0;
      this.durationMinutes = input.durationMinutes || 0;
      this.timePeriod = input.timePeriod || null;
      return;
    }

    // The source parser treats an absent date as now.  PromptData only calls
    // this constructor for a validated location ISO, but retaining this path
    // keeps direct use compatible with jibo-data-utils.
    this._utc = Date.now();
    this.timePeriod = TIME_PERIODS.NOW;
  }

  get utc() { return this._utc; }
  set utc(value) { this._utc = value; this._localTime = null; }

  clone() { return new DateTime(this.toJSON()); }

  getLocalTime() {
    if (!this._localTime) {
      const date = dateFromLocalUTC(this._utc, this.timezone.offsetUTC);
      this._localTime = {
        year: date.getUTCFullYear(),
        month: MONTHS[date.getUTCMonth()],
        monthNum: date.getUTCMonth(),
        dayOfWeek: DAYS_OF_WEEK[date.getUTCDay()],
        date: date.getUTCDate(),
        hour: date.getUTCHours(),
        minute: date.getUTCMinutes(),
        seconds: date.getUTCSeconds(),
        milliseconds: date.getUTCMilliseconds(),
      };
    }
    return this._localTime;
  }

  getLocalMMDD() {
    const date = dateFromLocalUTC(this._utc, this.timezone.offsetUTC);
    return `${pad(date.getUTCMonth() + 1, 2)}${pad(date.getUTCDate(), 2)}`;
  }

  getLocalYYYYMMDD() {
    const date = dateFromLocalUTC(this._utc, this.timezone.offsetUTC);
    return `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1, 2)}${pad(date.getUTCDate(), 2)}`;
  }

  isInRange(startDate, endDate) {
    try {
      const monthDateParser = /^(\d?\d)[/-](\d?\d)$/;
      const start = monthDateParser.exec(startDate);
      const end = monthDateParser.exec(endDate);
      const startMonth = Number.parseInt(start[1], 10) - 1;
      const startDay = Number.parseInt(start[2], 10);
      const endMonth = Number.parseInt(end[1], 10) - 1;
      const endDay = Number.parseInt(end[2], 10);
      const { monthNum, date } = this.getLocalTime();
      if (endMonth < startMonth || (endMonth === startMonth && endDay < startDay)) {
        if (startMonth > monthNum && endMonth < monthNum) return false;
        if (startMonth === endMonth && monthNum === startMonth &&
            (date > startDay || date < endDay)) return true;
        if ((monthNum === startMonth && date < startDay) ||
            (monthNum === endMonth && date > endDay)) return false;
        return true;
      }
      if (monthNum < startMonth || monthNum > endMonth) return false;
      if ((monthNum === startMonth && date < startDay) ||
          (monthNum === endMonth && date > endDay)) return false;
      return true;
    } catch {
      return false;
    }
  }

  getRelativeDays() { return localDayNumber(this._utc, this.timezone.offsetUTC); }

  getRelativeHours() {
    const local = dateFromLocalUTC(this._utc, this.timezone.offsetUTC);
    const now = dateFromLocalUTC(Date.now(), this.timezone.offsetUTC);
    const target = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), local.getUTCHours());
    const current = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours());
    return Math.floor((target - current) / HOUR_IN_MS + 0.1);
  }

  isFuture() { return this._utc > Date.now(); }

  isPast() {
    let end = this._utc;
    if (this.timePeriod === TIME_PERIODS.YEAR) end = new Date(end).setUTCFullYear(new Date(end).getUTCFullYear() + 1);
    else if (this.timePeriod === TIME_PERIODS.MONTH) end = new Date(end).setUTCMonth(new Date(end).getUTCMonth() + 1);
    else if (this.timePeriod === TIME_PERIODS.DAY) end = new Date(end).setUTCDate(new Date(end).getUTCDate() + 1);
    end += this.durationDays * DAY_IN_MS + this.durationHours * HOUR_IN_MS + this.durationMinutes * 60 * 1000;
    return end < Date.now();
  }

  addYear(years = 1) {
    const date = dateFromLocalUTC(this._utc, this.timezone.offsetUTC);
    date.setUTCFullYear(date.getUTCFullYear() + years);
    this.utc = date.getTime() - this.timezone.offsetUTC;
  }

  addDays(days, zeroHours = false) {
    const date = dateFromLocalUTC(this._utc, this.timezone.offsetUTC);
    date.setUTCDate(date.getUTCDate() + days);
    if (zeroHours) {
      date.setUTCHours(0, 0, 0, 0);
      this.timePeriod = TIME_PERIODS.DAY;
    }
    this.utc = date.getTime() - this.timezone.offsetUTC;
  }

  addHours(hours, zeroMinutes = false) {
    const date = dateFromLocalUTC(this._utc, this.timezone.offsetUTC);
    date.setUTCHours(date.getUTCHours() + hours);
    if (zeroMinutes) {
      date.setUTCMinutes(0, 0, 0);
      this.timePeriod = TIME_PERIODS.HOUR;
    }
    this.utc = date.getTime() - this.timezone.offsetUTC;
  }

  setTime(hours, minutes, seconds = 0, milliseconds = 0) {
    const date = dateFromLocalUTC(this._utc, this.timezone.offsetUTC);
    date.setUTCHours(hours, minutes || 0, seconds, milliseconds);
    this.utc = date.getTime() - this.timezone.offsetUTC;
    this.timePeriod = minutes === undefined ? TIME_PERIODS.HOUR : TIME_PERIODS.MINUTE;
  }

  stripTime() {
    const date = dateFromLocalUTC(this._utc, this.timezone.offsetUTC);
    date.setUTCHours(0, 0, 0, 0);
    this.utc = date.getTime() - this.timezone.offsetUTC;
    this.timePeriod = TIME_PERIODS.DAY;
    this.durationHours = 0;
    this.durationMinutes = 0;
  }

  toString(options = {}) {
    if (options.suppressVerbalOutput) return '';
    const local = dateFromLocalUTC(this._utc, this.timezone.offsetUTC);
    const relativeDays = this.getRelativeDays();
    let result = '';
    let usedDate = false;
    const longPeriod = [TIME_PERIODS.YEAR, TIME_PERIODS.MONTH, TIME_PERIODS.WEEK, TIME_PERIODS.WEEKEND].includes(this.timePeriod);

    if (longPeriod) {
      let targetWeek;
      let nowWeek;
      let daysDiff;
      let weeksDiff;
      switch (this.timePeriod) {
        case TIME_PERIODS.YEAR:
          result = String(local.getUTCFullYear());
          break;
        case TIME_PERIODS.MONTH:
          result = MONTHS[local.getUTCMonth()];
          break;
        case TIME_PERIODS.WEEK:
          targetWeek = new Date(this._utc + this.timezone.offsetUTC);
          targetWeek.setUTCDate(targetWeek.getUTCDate() - targetWeek.getUTCDay() + 1);
          nowWeek = new Date(Date.now() + this.timezone.offsetUTC);
          nowWeek.setUTCDate(nowWeek.getUTCDate() - nowWeek.getUTCDay() + 1);
          daysDiff = daysBetweenDates(nowWeek, targetWeek);
          weeksDiff = Math.round(daysDiff / 7);
          if (weeksDiff === 0) result = 'this week';
          else if (weeksDiff === 1) result = 'next week';
          else if (weeksDiff > 1) result = `${weeksDiff} weeks from now`;
          else if (weeksDiff === -1) result = 'last week';
          else result = `${Math.abs(weeksDiff)} weeks ago`;
          break;
        case TIME_PERIODS.WEEKEND:
          targetWeek = new Date(this._utc + this.timezone.offsetUTC);
          targetWeek.setUTCDate(targetWeek.getUTCDate() - targetWeek.getUTCDay() + 6);
          nowWeek = new Date(Date.now() + this.timezone.offsetUTC);
          nowWeek.setUTCDate(nowWeek.getUTCDate() - nowWeek.getUTCDay() + 6);
          daysDiff = daysBetweenDates(nowWeek, targetWeek);
          weeksDiff = Math.round(daysDiff / 7);
          if (weeksDiff === 0) result = 'this weekend';
          else if (weeksDiff === 1) result = 'next weekend';
          else if (weeksDiff > 1) result = `${weeksDiff} weekends from now`;
          else if (weeksDiff === -1) result = 'last weekend';
          else result = `${Math.abs(weeksDiff)} weekends ago`;
          break;
        default:
          break;
      }
    }

    if (!longPeriod && !options.timeOnly && (this.timePeriod === TIME_PERIODS.DAY || relativeDays !== 0 || options.dateOnly)) {
      if (relativeDays === 0) result = 'today';
      else if (relativeDays === -1) result = 'yesterday';
      else if (relativeDays === 1) result = 'tomorrow';
      else if (relativeDays < 7 && relativeDays > 0) result = DAYS_OF_WEEK[local.getUTCDay()];
      else {
        usedDate = true;
        result = `${MONTHS[local.getUTCMonth()]} ${ordinal(local.getUTCDate())}`;
        const now = dateFromLocalUTC(Date.now(), this.timezone.offsetUTC);
        if (now.getUTCFullYear() !== local.getUTCFullYear()) result += ` ${local.getUTCFullYear()}`;
      }
    }

    if (!longPeriod && !options.dateOnly) {
      if (this.timePeriod === TIME_PERIODS.MORNING || this.timePeriod === TIME_PERIODS.AFTERNOON ||
          this.timePeriod === TIME_PERIODS.EVENING || this.timePeriod === TIME_PERIODS.NIGHT) {
        const period = this.timePeriod;
        const word = period === TIME_PERIODS.MORNING ? 'morning' : period === TIME_PERIODS.AFTERNOON ? 'afternoon' : period === TIME_PERIODS.EVENING ? 'evening' : 'night';
        if (usedDate) result = `${word} of ${result}`;
        else if (relativeDays === 0) result = period === TIME_PERIODS.NIGHT ? 'tonight' : `this ${word}`;
        else if (period === TIME_PERIODS.NIGHT && relativeDays === -1) result = 'last night';
        else result += ` ${word}`;
      }
      if ([TIME_PERIODS.HOUR, TIME_PERIODS.MINUTE, TIME_PERIODS.NOW].includes(this.timePeriod)) {
        if (relativeDays !== 0 && !options.timeOnly) result += ' at ';
        result += options.display
          ? visualTime(local.getUTCHours(), local.getUTCMinutes(), options.dropPeriod)
          : verbalTime(local.getUTCHours(), local.getUTCMinutes(), options.dropPeriod);
      }
    }

    if (options.prefixOnAt) {
      if (this.timePeriod === TIME_PERIODS.YEAR || this.timePeriod === TIME_PERIODS.MONTH) result = `in ${result}`;
      else if (this.timePeriod === TIME_PERIODS.WEEK || this.timePeriod === TIME_PERIODS.WEEKEND) {
        // The long-period text already carries its temporal relation.
      } else if (!options.dateOnly && ([TIME_PERIODS.HOUR, TIME_PERIODS.MINUTE, TIME_PERIODS.NOW].includes(this.timePeriod) || options.timeOnly)) {
        if (relativeDays === 0 || options.timeOnly) result = `at ${result}`;
        else if (relativeDays !== -1 && relativeDays !== 1) result = `on ${result}`;
      } else if (relativeDays === 0 || relativeDays === -1 || relativeDays === 1) {
        // today, yesterday, tomorrow, and their day periods need no prefix.
      } else result = `on ${result}`;
    }
    return result;
  }

  prefixOnAt(options = {}) { return this.toString({ ...options, prefixOnAt: true }); }

  toJSON() {
    return {
      __type: 'DateTime', utc: this._utc, timezone: this.timezone.toJSON(),
      durationDays: this.durationDays, durationHours: this.durationHours,
      durationMinutes: this.durationMinutes, timePeriod: this.timePeriod,
    };
  }

  toISOString() {
    const local = this.getLocalTime();
    return `${pad(local.year, 4)}-${pad(local.monthNum + 1, 2)}-${pad(local.date, 2)}T${pad(local.hour, 2)}:${pad(local.minute, 2)}:${pad(local.seconds, 2)}.${pad(local.milliseconds, 3)}${this.timezone.toISOString()}`;
  }
}

export const dateTimeConstants = Object.freeze({ MONTHS, DAYS_OF_WEEK, TIME_PERIODS, ordinal, localeWeekOfYear });
