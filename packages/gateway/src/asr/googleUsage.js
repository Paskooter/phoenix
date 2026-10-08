// Conservative Speech-to-Text usage ledger. Reserve durably before contacting
// Google; an interrupted request keeps its full reservation after a crash.
// Missing, damaged or unwritable state fails closed. Calendar periods use
// Cloud Billing's Pacific reporting time zone; in-flight reservations count
// against both periods when they cross midnight. See ASR-GOOGLE-FALLBACK.md.

import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const USAGE_FILE_VERSION = 2;
export const BILLING_TIME_ZONE = 'America/Los_Angeles';
const WARN_FRACTIONS = [0.5, 0.8, 1];
const nonnegativeInteger = (n) => Number.isSafeInteger(n) && n >= 0;

export class GoogleBudgetError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = 'GoogleBudgetError';
    this.code = 'GOOGLE_STT_BUDGET';
    this.reason = reason;
  }
}

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

/** Explicit first-install step; never replaces an existing ledger. */
export function initializeGoogleUsageFile(file, { now = Date.now(), timeZone = BILLING_TIME_ZONE } = {}) {
  if (!file) throw new Error('A Google speech usage file is required');
  const keys = periodKeys(now, timeZone);
  const state = {
    version: USAGE_FILE_VERSION, month: keys.month, monthSeconds: 0,
    day: keys.day, daySeconds: 0, requests: 0, warned: [], pending: {}, updatedAt: now,
  };
  fs.mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(state)}\n`); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  const directory = fs.openSync(dirname(file), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

export class GoogleUsageMeter {
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
    this.error = null;
    const keys = periodKeys(this.now(), this.timeZone);
    this.state = { month: keys.month, monthSeconds: 0, day: keys.day, daySeconds: 0, requests: 0, warned: [], pending: {} };
    this._load();
  }

  _load() {
    if (!this.file) { this.error = 'no-usage-file'; return; }
    let raw;
    try { raw = this.fs.readFileSync(this.file, 'utf8'); }
    catch (err) {
      this.error = err?.code === 'ENOENT' ? 'usage-file-missing' : 'usage-file-unreadable';
      this.log?.error?.('Google speech usage file cannot be read; Google stays off', { code: err?.code || 'EIO' });
      return;
    }
    try {
      const saved = JSON.parse(raw);
      // Preserve valid v1 counters when upgrading an already initialized meter.
      if (![1, USAGE_FILE_VERSION].includes(saved?.version)
        || !/^\d{4}-(0[1-9]|1[0-2])$/.test(saved.month || '')
        || !/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(saved.day || '')
        || !saved.day.startsWith(`${saved.month}-`)
        || !nonnegativeInteger(saved.monthSeconds) || !nonnegativeInteger(saved.daySeconds)
        || !nonnegativeInteger(saved.requests) || saved.daySeconds > saved.monthSeconds
        || !Array.isArray(saved.warned) || saved.warned.some((n) => !WARN_FRACTIONS.includes(n))) throw new Error('invalid');
      const pending = saved.version === 1 ? {} : saved.pending;
      if (!pending || typeof pending !== 'object' || Array.isArray(pending)) throw new Error('pending');
      let reserved = 0;
      for (const [id, item] of Object.entries(pending)) {
        if (!/^[a-f0-9]{32}$/.test(id) || !item || !nonnegativeInteger(item.seconds)
          || item.seconds === 0 || item.month !== saved.month || item.day !== saved.day) throw new Error('reservation');
        reserved += item.seconds;
      }
      if (reserved > saved.daySeconds || Object.keys(pending).length > 512) throw new Error('reserved');
      this.state = {
        month: saved.month, monthSeconds: saved.monthSeconds, day: saved.day, daySeconds: saved.daySeconds,
        requests: saved.requests, warned: saved.warned, pending,
      };
    } catch {
      this.error = 'usage-file-invalid';
      this.log?.error?.('Google speech usage file is invalid; Google stays off until it is reconciled');
    }
  }

  get reservedSeconds() { return Object.values(this.state.pending).reduce((sum, item) => sum + item.seconds, 0); }

  _roll() {
    const keys = periodKeys(this.now(), this.timeZone);
    if (keys.month < this.state.month || keys.day < this.state.day) {
      this.error = 'usage-clock-backwards';
      return;
    }
    if (keys.month !== this.state.month) {
      this.state.month = keys.month;
      this.state.monthSeconds = this.reservedSeconds;
      this.state.requests = 0;
      this.state.warned = [];
      for (const item of Object.values(this.state.pending)) item.month = keys.month;
    }
    if (keys.day !== this.state.day) {
      this.state.day = keys.day;
      this.state.daySeconds = this.reservedSeconds;
      for (const item of Object.values(this.state.pending)) item.day = keys.day;
    }
  }

  _persist() {
    const body = `${JSON.stringify({ version: USAGE_FILE_VERSION, ...this.state, updatedAt: this.now() })}\n`;
    const temporary = join(dirname(this.file), `.google-stt-usage.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    let fd;
    try {
      fd = this.fs.openSync(temporary, 'wx', 0o600);
      this.fs.writeFileSync(fd, body);
      this.fs.fsyncSync(fd);
      this.fs.closeSync(fd); fd = undefined;
      this.fs.renameSync(temporary, this.file);
      const directory = this.fs.openSync(dirname(this.file), 'r');
      try { this.fs.fsyncSync(directory); } finally { this.fs.closeSync(directory); }
      return true;
    } catch (err) {
      if (fd !== undefined) { try { this.fs.closeSync(fd); } catch { /* already closed */ } }
      try { this.fs.unlinkSync(temporary); } catch { /* never created */ }
      this.error = 'usage-file-unwritable';
      this.log?.error?.('Google speech usage could not be saved; Google stays off', { code: err?.code || 'EIO' });
      return false;
    }
  }

  /** Serialize counters across meters/processes. A stale lock fails closed. */
  _change(update) {
    if (this.error) return null;
    const lock = `${this.file}.lock`;
    let fd;
    try { fd = this.fs.openSync(lock, 'wx', 0o600); }
    catch (err) {
      this.error = err?.code === 'EEXIST' ? 'usage-file-busy' : 'usage-file-unwritable';
      return null;
    }
    try {
      this._load();
      if (this.error) return null;
      this._roll();
      if (this.error) return null;
      const result = update();
      return this._persist() ? result : null;
    } finally {
      try { this.fs.closeSync(fd); } catch { /* already closed */ }
      try { this.fs.unlinkSync(lock); } catch { this.error = 'usage-file-busy'; }
    }
  }

  refusal(seconds = 0) {
    if (this.error) return this.error;
    if (this.monthlyLimitSeconds <= 0) return 'disabled';
    this._roll();
    if (this.error) return this.error;
    if (this.state.monthSeconds + seconds > this.monthlyLimitSeconds) return 'monthly-limit';
    if (this.dailyLimitSeconds > 0 && this.state.daySeconds + seconds > this.dailyLimitSeconds) return 'daily-limit';
    if (Object.keys(this.state.pending).length >= 512) return 'too-many-reservations';
    return null;
  }

  reserve(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    const wanted = Math.ceil(seconds);
    return this._change(() => {
      if (this.refusal(wanted)) return null;
      const id = randomBytes(16).toString('hex');
      this.state.monthSeconds += wanted;
      this.state.daySeconds += wanted;
      this.state.pending[id] = { seconds: wanted, month: this.state.month, day: this.state.day };
      return { id, seconds: wanted, settled: false };
    });
  }

  commit(reservation, billedSeconds) {
    if (!reservation || reservation.settled) return;
    reservation.settled = true;
    this._change(() => {
      const pending = this.state.pending[reservation.id];
      if (!pending) return null;
      const billed = Number.isFinite(billedSeconds) && billedSeconds >= 0 ? Math.ceil(billedSeconds) : pending.seconds;
      this.state.monthSeconds += billed - pending.seconds;
      this.state.daySeconds += billed - pending.seconds;
      delete this.state.pending[reservation.id];
      if (billed) this.state.requests += 1;
      this._warnOnThresholds();
      return true;
    });
  }

  _warnOnThresholds() {
    if (!this.monthlyLimitSeconds) return;
    const fraction = (this.state.monthSeconds - this.reservedSeconds) / this.monthlyLimitSeconds;
    for (const threshold of WARN_FRACTIONS) {
      if (fraction >= threshold && !this.state.warned.includes(threshold)) {
        this.state.warned.push(threshold);
        const fields = { month: this.state.month,
          usedMinutes: Math.round((this.state.monthSeconds - this.reservedSeconds) / 6) / 10,
          limitMinutes: Math.round(this.monthlyLimitSeconds / 6) / 10 };
        if (threshold >= 1) this.log?.error?.('Google speech monthly limit reached; Google is off until next month', fields);
        else this.log?.warn?.(`Google speech has used ${Math.round(threshold * 100)}% of its monthly limit`, fields);
      }
    }
  }

  status() {
    if (!this.error) this._load();
    this._roll();
    return {
      persistent: !!this.file && !this.error, problem: this.error, month: this.state.month,
      usedSeconds: this.state.monthSeconds - this.reservedSeconds, limitSeconds: this.monthlyLimitSeconds,
      day: this.state.day, dayUsedSeconds: this.state.daySeconds - this.reservedSeconds,
      dayLimitSeconds: this.dailyLimitSeconds, requests: this.state.requests, reservedSeconds: this.reservedSeconds,
      exhausted: this.error ? null : this.monthlyLimitSeconds > 0 && this.state.monthSeconds >= this.monthlyLimitSeconds ? 'month'
        : this.dailyLimitSeconds > 0 && this.state.daySeconds >= this.dailyLimitSeconds ? 'day' : null,
    };
  }
}
