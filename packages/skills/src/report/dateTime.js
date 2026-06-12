// Lean DateTime — the slice of jibo-data-utils DateTime the report subskills use:
// utc get/set, clone, setTime, isFuture, getRelativeDays (vs now, in the original timezone),
// getLocalTime, and toString({timeOnly}/{prefixOnAt}) for MIM prompt rendering
// ("at 3:15 PM", "tomorrow at 9:00 AM").

const DAY_IN_MS = 24 * 3600 * 1000;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export class DateTime {
  /** @param {string|number} iso ISO-8601 string (offset honored) or a UTC ms timestamp */
  constructor(iso, offsetMs = null) {
    if (typeof iso === 'number') {
      this._utc = iso;
      this._offset = offsetMs || 0;
      return;
    }
    this._utc = Date.parse(iso);
    if (offsetMs != null) {
      this._offset = offsetMs;
    } else {
      const m = /([+-])(\d{2}):?(\d{2})\s*$/.exec(String(iso));
      if (m) this._offset = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60000;
      else if (/[zZ]\s*$/.test(String(iso))) this._offset = 0;
      else this._offset = -new Date().getTimezoneOffset() * 60000; // bare local string
    }
  }

  get utc() { return this._utc; }
  set utc(value) { this._utc = value; }

  clone() { return new DateTime(this._utc, this._offset); }

  setTime(hours, minutes = 0, seconds = 0, ms = 0) {
    const date = new Date(this._utc + this._offset);
    date.setUTCHours(hours, minutes || 0, seconds, ms);
    this._utc = date.getTime() - this._offset;
  }

  isFuture() { return this._utc > Date.now(); }

  /** Whole days between this date and today, in this DateTime's timezone (0=today, 1=tomorrow). */
  getRelativeDays() {
    const thisDate = new Date(this._utc + this._offset);
    const utc1 = Date.UTC(thisDate.getUTCFullYear(), thisDate.getUTCMonth(), thisDate.getUTCDate());
    const now = new Date(Date.now() + this._offset);
    const utc2 = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    return Math.floor((utc1 - utc2) / DAY_IN_MS + 0.1);
  }

  getLocalTime() {
    const d = new Date(this._utc + this._offset);
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
