// Source-backed natural-language wrappers used by LooperData/JiboData.
// Keeping these as objects (rather than flattening numbers into strings) is
// important: MIM expressions use both `.value` and `.supplemented`.

export class NLData {
  constructor(value) { this._value = value; }
  get supplemented() { return this.supplement(this._value); }
  toString() { return `${this._value}`; }
}
export class NLTimeData extends NLData {
  constructor(value, singular, plural) {
    super(Math.floor(value));
    this.singular = singular;
    this.plural = plural;
  }

  get value() { return this._value; }
  supplement(value) { return `${value} ${value === 1 ? this.singular : this.plural}`; }
  toString() { return `${this._value}`; }
}

export class NLMilliseconds extends NLTimeData {
  constructor(value) { super(value, 'milllisecond', 'milliseconds'); }
}
export class NLSeconds extends NLTimeData {
  constructor(value) { super(value, 'second', 'seconds'); }
}
export class NLMinutes extends NLTimeData {
  constructor(value) { super(value, 'minute', 'minutes'); }
}
export class NLHours extends NLTimeData {
  constructor(value) { super(value, 'hour', 'hours'); }
}
export class NLDays extends NLTimeData {
  constructor(value) { super(value, 'day', 'days'); }
}
export class NLWeeks extends NLTimeData {
  constructor(value) { super(value, 'week', 'weeks'); }
}
export class NLMonths extends NLTimeData {
  constructor(value) { super(value, 'month', 'months'); }
}
export class NLYears extends NLTimeData {
  constructor(value) { super(value, 'year', 'years'); }
}

/**
 * Moment's duration conversion uses the average Gregorian month/year when a
 * duration is converted to months or years.  These are the constants used by
 * moment 2.22 (the pinned Pegasus dependency).
 */
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const MS_PER_WEEK = 7 * MS_PER_DAY;
const DAYS_PER_MONTH = 146097 / 4800;
const DAYS_PER_YEAR = 146097 / 400;

export class NLAge {
  constructor(currentDate, birthdateDate) {
    const rawMilliseconds = currentDate.getTime() - birthdateDate.getTime();
    this.milliseconds = new NLMilliseconds(rawMilliseconds);
    this.seconds = new NLSeconds(rawMilliseconds / MS_PER_SECOND);
    this.minutes = new NLMinutes(rawMilliseconds / MS_PER_MINUTE);
    this.hours = new NLHours(rawMilliseconds / MS_PER_HOUR);
    this.days = new NLDays(rawMilliseconds / MS_PER_DAY);
    this.weeks = new NLWeeks(rawMilliseconds / MS_PER_WEEK);
    this.months = new NLMonths(rawMilliseconds / (DAYS_PER_MONTH * MS_PER_DAY));
    this.years = new NLYears(rawMilliseconds / (DAYS_PER_YEAR * MS_PER_DAY));
  }

  get value() { return this.years.value; }
  get supplemented() { return this.years.supplemented; }
  toString() { return this.years.toString(); }
}

export class NLZodiac extends NLData {
  constructor(value) {
    super(value);
    this.value = value;
  }

  supplement(value) {
    const prefix = value === 'Aquarius' || value === 'Aries' ? 'an' : 'a';
    return `${prefix} ${value}`;
  }
}
