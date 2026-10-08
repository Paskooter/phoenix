// Google Speech-to-Text budget guard.
//
// Google bills audio "successfully processed", each request rounded up to the
// next whole second (cloud.google.com/speech-to-text/pricing; per-second
// rounding since the 2022-11-11 release note). Google offers no spend cap for
// Speech-to-Text -- spend-cap budgets cover only Gemini API, Vertex AI, Cloud
// Run and Cloud Run functions -- so the hard stop has to live here:
//
//   * a monthly and a daily limit in billed seconds, by calendar month/day in
//     Pacific time (Cloud Billing's reporting time zone);
//   * every request RESERVES its worst case before any audio is sent (a stream
//     window is at most 30 s), and COMMITS what was actually billed afterwards,
//     so concurrent turns can never overshoot the limit;
//   * usage persists across restarts in a small 0600 JSON file. Without one, or
//     if it cannot be read, Google is refused: a counter that silently restarts
//     at zero after every restart is not a budget.
//
// The ledger is an estimate kept on the safe side: it counts what Phoenix sent,
// rounded up per request, or Google's own billed duration when that is larger.

import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const USAGE_FILE_VERSION = 1;
export const BILLING_TIME_ZONE = 'America/Los_Angeles';
const WARN_FRACTIONS = [0.5, 0.8, 1];

export class GoogleBudgetError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = 'GoogleBudgetError';
    this.code = 'GOOGLE_STT_BUDGET';
    this.reason = reason;
  }
}

/** Where usage is kept: an explicit file, else <PHOENIX_DATA_DIR>/asr/google-stt-usage.json. */
export function googleUsageFile(env = process.env) {
  if (env.PHOENIX_GOOGLE_STT_USAGE_FILE) return env.PHOENIX_GOOGLE_STT_USAGE_FILE;
  if (env.PHOENIX_DATA_DIR) return join(env.PHOENIX_DATA_DIR, 'asr', 'google-stt-usage.json');
  return null;
}

function periodKeys(timestamp, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]));
  return { month: `${parts.year}-${parts.month}`, day: `${parts.year}-${parts.month}-${parts.day}` };
}

export class GoogleUsageMeter {
  /**
   * @param {object} options
   * @param {string|null} options.file              persistence; null = refuse Google
   * @param {number} options.monthlyLimitSeconds    0 = Google off
   * @param {number} options.dailyLimitSeconds      0 = no daily limit
   */
  constructor({
    file, monthlyLimitSeconds, dailyLimitSeconds = 0, timeZone = BILLING_TIME_ZONE,
    now = Date.now, log = null, fsImpl = fs,
  }) {
    this.file = file || null;
    this.monthlyLimitSeconds = Math.max(0, Math.floor(monthlyLimitSeconds || 0));
    this.dailyLimitSeconds = Math.max(0, Math.floor(dailyLimitSeconds || 0));
    this.timeZone = timeZone;
    this.now = now;
    this.log = log;
    this.fs = fsImpl;
    this.reservedSeconds = 0;
    this.error = null;
    const keys = periodKeys(this.now(), this.timeZone);
    this.state = { month: keys.month, monthSeconds: 0, day: keys.day, daySeconds: 0, requests: 0, warned: [] };
    this._load();
  }

  _load() {
    if (!this.file) {
      this.error = 'no-usage-file';
      return;
    }
    let raw;
    try {
      raw = this.fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') return; // first use this month
      this.error = 'usage-file-unreadable';
      this.log?.error?.('Google speech usage file cannot be read; Google stays off', { code: err?.code || 'EIO' });
      return;
    }
    try {
      const saved = JSON.parse(raw);
      if (saved?.version !== USAGE_FILE_VERSION) throw new Error('version');
      const number = (value) => (Number.isFinite(value) && value >= 0 ? value : 0);
      this.state = {
        month: typeof saved.month === 'string' ? saved.month : this.state.month,
        monthSeconds: number(saved.monthSeconds),
        day: typeof saved.day === 'string' ? saved.day : this.state.day,
        daySeconds: number(saved.daySeconds),
        requests: number(saved.requests),
        warned: Array.isArray(saved.warned) ? saved.warned.filter((n) => WARN_FRACTIONS.includes(n)) : [],
      };
    } catch {
      this.error = 'usage-file-invalid';
      this.log?.error?.('Google speech usage file is not valid; Google stays off until it is fixed or removed');
    }
  }

  _roll() {
    const keys = periodKeys(this.now(), this.timeZone);
    if (keys.month !== this.state.month) {
      this.state.month = keys.month;
      this.state.monthSeconds = 0;
      this.state.requests = 0;
      this.state.warned = [];
    }
    if (keys.day !== this.state.day) {
      this.state.day = keys.day;
      this.state.daySeconds = 0;
    }
  }

  _persist() {
    if (!this.file) return;
    const body = `${JSON.stringify({ version: USAGE_FILE_VERSION, ...this.state, updatedAt: this.now() })}\n`;
    const temporary = join(dirname(this.file), `.google-stt-usage.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    try {
      this.fs.mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      this.fs.writeFileSync(temporary, body, { mode: 0o600, flag: 'wx' });
      this.fs.renameSync(temporary, this.file);
    } catch (err) {
      try { this.fs.unlinkSync(temporary); } catch { /* never created */ }
      // A ledger that cannot be written cannot be trusted after a restart.
      this.error = 'usage-file-unwritable';
      this.log?.error?.('Google speech usage could not be saved; Google stays off', { code: err?.code || 'EIO' });
    }
  }

  /** Why Google may not be used right now (null when it may). */
  refusal(seconds = 0) {
    if (this.error) return this.error;
    if (this.monthlyLimitSeconds <= 0) return 'disabled';
    this._roll();
    if (this.state.monthSeconds + this.reservedSeconds + seconds > this.monthlyLimitSeconds) return 'monthly-limit';
    if (this.dailyLimitSeconds > 0
      && this.state.daySeconds + this.reservedSeconds + seconds > this.dailyLimitSeconds) return 'daily-limit';
    return null;
  }

  /** Reserve the worst case for one request; null when that would break a limit. */
  reserve(seconds) {
    const wanted = Math.max(0, Math.ceil(seconds));
    if (this.refusal(wanted)) return null;
    this.reservedSeconds += wanted;
    return { seconds: wanted, settled: false };
  }

  /** Record what a request was billed and free the rest of its reservation. */
  commit(reservation, billedSeconds) {
    if (!reservation || reservation.settled) return;
    reservation.settled = true;
    this.reservedSeconds = Math.max(0, this.reservedSeconds - reservation.seconds);
    const billed = Math.max(0, Math.ceil(Number(billedSeconds) || 0));
    if (billed === 0) return;
    this._roll();
    this.state.monthSeconds += billed;
    this.state.daySeconds += billed;
    this.state.requests += 1;
    this._warnOnThresholds();
    this._persist();
  }

  _warnOnThresholds() {
    if (!this.monthlyLimitSeconds) return;
    const fraction = this.state.monthSeconds / this.monthlyLimitSeconds;
    for (const threshold of WARN_FRACTIONS) {
      if (fraction >= threshold && !this.state.warned.includes(threshold)) {
        this.state.warned.push(threshold);
        const fields = {
          month: this.state.month,
          usedMinutes: Math.round(this.state.monthSeconds / 6) / 10,
          limitMinutes: Math.round(this.monthlyLimitSeconds / 6) / 10,
        };
        if (threshold >= 1) this.log?.error?.('Google speech monthly limit reached; Google is off until next month', fields);
        else this.log?.warn?.(`Google speech has used ${Math.round(threshold * 100)}% of its monthly limit`, fields);
      }
    }
  }

  /** Allow-listed numbers for the admin console. */
  status() {
    this._roll();
    return {
      persistent: !!this.file && !this.error,
      problem: this.error,
      month: this.state.month,
      usedSeconds: this.state.monthSeconds,
      limitSeconds: this.monthlyLimitSeconds,
      day: this.state.day,
      dayUsedSeconds: this.state.daySeconds,
      dayLimitSeconds: this.dailyLimitSeconds,
      requests: this.state.requests,
      reservedSeconds: this.reservedSeconds,
      exhausted: this.error ? null
        : this.monthlyLimitSeconds > 0 && this.state.monthSeconds >= this.monthlyLimitSeconds ? 'month'
          : this.dailyLimitSeconds > 0 && this.state.daySeconds >= this.dailyLimitSeconds ? 'day' : null,
    };
  }
}
