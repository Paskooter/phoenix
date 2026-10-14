// Lean DateTime — the slice of jibo-data-utils DateTime the report subskills use:
// utc get/set, clone, setTime, isFuture, getRelativeDays, getLocalTime,
// and toString({timeOnly}/{prefixOnAt}) for MIM prompt rendering.
// An explicit display zone changes wall time, never the supplied instant.

const DAY_IN_MS = 24 * 3600 * 1000;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export class DateTime {
  /** @param {string|number} iso ISO-8601 string or UTC ms; displayZone is an offset in ms or IANA zone. */
  constructor(iso, displayZone = null) {
    this._utc = typeof iso === 'number' ? iso : Date.parse(iso);
    if (typeof displayZone === 'string') {
      this._timeZone = displayZone;
      this._formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: displayZone, calendar: 'gregory', numberingSystem: 'latn', hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
      this._offset = this._offsetAt(this._utc);
    } else if (displayZone != null) {
      this._offset = displayZone;
    } else if (typeof iso === 'number') {
      this._offset = 0;
    } else {
      const m = /([+-])(\d{2}):?(\d{2})\s*$/.exec(String(iso));
      if (m) this._offset = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60000;
      else if (/[zZ]\s*$/.test(String(iso))) this._offset = 0;
      else this._offset = -new Date().getTimezoneOffset() * 60000; // bare local string
    }
  }

  _offsetAt(timestamp) {
    if (!this._formatter || !Number.isFinite(timestamp)) return this._offset || 0;
    const parts = Object.fromEntries(this._formatter.formatToParts(new Date(timestamp))
      .filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
    const wallUTC = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    return wallUTC - Math.floor(timestamp / 1000) * 1000;
  }

  _localDate(timestamp) { return new Date(timestamp + this._offsetAt(timestamp)); }

  get utc() { return this._utc; }
  set utc(value) { this._utc = value; }

  clone() { return new DateTime(this._utc, this._timeZone || this._offset); }

  setTime(hours, minutes = 0, seconds = 0, ms = 0) {
    const date = this._localDate(this._utc);
    date.setUTCHours(hours, minutes || 0, seconds, ms);
    const wallUTC = date.getTime();
    let utc = wallUTC - this._offsetAt(this._utc);
    // The target wall time can have a different offset from the starting instant.
    for (let i = 0; i < 4; i += 1) utc = wallUTC - this._offsetAt(utc);
    this._utc = utc;
  }

  isFuture() { return this._utc > Date.now(); }

  /** Whole days between this date and today, in this DateTime's timezone (0=today, 1=tomorrow). */
  getRelativeDays() {
    const thisDate = this._localDate(this._utc);
    const utc1 = Date.UTC(thisDate.getUTCFullYear(), thisDate.getUTCMonth(), thisDate.getUTCDate());
    const now = this._localDate(Date.now());
    const utc2 = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    return Math.floor((utc1 - utc2) / DAY_IN_MS + 0.1);
  }

  getLocalTime() {
    const d = this._localDate(this._utc);
    return {
      year: d.getUTCFullYear(), monthNum: d.getUTCMonth(), date: d.getUTCDate(),
      dayOfWeek: DAYS[d.getUTCDay()], hour: d.getUTCHours(), minute: d.getUTCMinutes(),
    };
  }

  _timeString() {
    const { hour, minute } = this.getLocalTime();
    const period = hour < 12 ? 'AM' : 'PM';
    const h12 = hour % 12 === 0 ? 12 : hour % 12;
    return `${h12}:${String(minute).padStart(2, '0')} ${period}`;
  }

  /** @param {{timeOnly?:boolean, prefixOnAt?:boolean}} [opts] */
  toString(opts = {}) {
    const time = this._timeString();
    if (opts.timeOnly) return time;
    if (opts.prefixOnAt) {
      const rel = this.getRelativeDays();
      if (rel === 0) return `at ${time}`;
      if (rel === 1) return `tomorrow at ${time}`;
      return `on ${this.getLocalTime().dayOfWeek} at ${time}`;
    }
    return time;
  }
}
