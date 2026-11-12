// Usage ledger for paid batch transcription (OpenRouter, or a custom endpoint
// with a cap). Counts dollars (as integer micro-USD, from each response's
// `usage.cost`) and seconds of audio, and enforces a monthly dollar cap, an
// optional daily dollar cap and an optional monthly minutes cap.
//
// Same rules as the Google ledger (googleUsage.js): reserve durably before a
// request leaves the server and settle with the real cost afterwards, so a
// crash keeps the full reservation; missing, damaged, busy or unwritable state
// fails closed; the file is created once by an explicit initializer
// (scripts/init-openai-stt-usage.mjs) and is never recreated to reset a cap.
// Periods are calendar months/days in UTC, the time zone OpenRouter reports in.

import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const TRANSCRIPTION_USAGE_VERSION = 1;
export const TRANSCRIPTION_USAGE_TIME_ZONE = 'UTC';
const WARN_FRACTIONS = [0.5, 0.8, 1];
const MAX_PENDING = 512;
const nonnegativeInteger = (n) => Number.isSafeInteger(n) && n >= 0;

export class TranscriptionBudgetError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = 'TranscriptionBudgetError';
    this.code = 'OPENAI_STT_BUDGET';
    this.reason = reason;
  }
}

const FILE_NAMES = { openrouter: 'openrouter-stt-usage.json', custom: 'custom-stt-usage.json' };
const FILE_SETTINGS = { openrouter: 'PHOENIX_OPENROUTER_STT_USAGE_FILE', custom: 'PHOENIX_CUSTOM_STT_USAGE_FILE' };

/** The ledger path for a preset ('openrouter' | 'custom'), or null. */
export function transcriptionUsageFile(env = process.env, preset = 'openrouter') {
  const explicit = String(env[FILE_SETTINGS[preset]] || '').trim();
  if (explicit) return explicit;
  if (env.PHOENIX_DATA_DIR) return join(env.PHOENIX_DATA_DIR, 'asr', FILE_NAMES[preset]);
  return null;
}

function periodKeys(timestamp, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]));
  return { month: `${parts.year}-${parts.month}`, day: `${parts.year}-${parts.month}-${parts.day}` };
}

function emptyState(keys) {
  return { month: keys.month, monthMicroUsd: 0, monthSeconds: 0, day: keys.day, dayMicroUsd: 0, requests: 0, warned: [], pending: {} };
}

/** Explicit first-install step; never replaces an existing ledger. */
export function initializeTranscriptionUsageFile(file, { now = Date.now(), timeZone = TRANSCRIPTION_USAGE_TIME_ZONE } = {}) {
  if (!file) throw new Error('A transcription usage file is required');
  const state = { version: TRANSCRIPTION_USAGE_VERSION, ...emptyState(periodKeys(now, timeZone)), updatedAt: now };
  fs.mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(state)}\n`); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  const directory = fs.openSync(dirname(file), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

export class TranscriptionUsageMeter {
  /**
   * @param {object} options
   * @param {string|null} options.file
   * @param {number} options.monthlyLimitMicroUsd  0 = no dollar cap
   * @param {number} [options.dailyLimitMicroUsd]  0 = no daily cap
   * @param {number} [options.monthlyLimitSeconds] 0 = no minutes cap
   * A meter with no cap at all refuses everything ('disabled').
   */
  constructor({
    file, monthlyLimitMicroUsd = 0, dailyLimitMicroUsd = 0, monthlyLimitSeconds = 0, label = 'Transcription',
    timeZone = TRANSCRIPTION_USAGE_TIME_ZONE, now = Date.now, log = null, fsImpl = fs,
  }) {
    this.file = file || null;
    this.monthlyLimitMicroUsd = Math.max(0, Math.floor(monthlyLimitMicroUsd || 0));
    this.dailyLimitMicroUsd = Math.max(0, Math.floor(dailyLimitMicroUsd || 0));
    this.monthlyLimitSeconds = Math.max(0, Math.floor(monthlyLimitSeconds || 0));
    this.label = label;
    this.timeZone = timeZone;
    this.now = now;
    this.log = log;
    this.fs = fsImpl;
    this.error = null;
    this.state = emptyState(periodKeys(this.now(), this.timeZone));
    this._load();
  }

  _load() {
    if (!this.file) { this.error = 'no-usage-file'; return; }
    let raw;
    try { raw = this.fs.readFileSync(this.file, 'utf8'); }
    catch (err) {
      this.error = err?.code === 'ENOENT' ? 'usage-file-missing' : 'usage-file-unreadable';
      this.log?.error?.(`${this.label} speech usage file cannot be read; it stays off`, { code: err?.code || 'EIO' });
      return;
    }
    try {
      const saved = JSON.parse(raw);
      if (saved?.version !== TRANSCRIPTION_USAGE_VERSION
        || !/^\d{4}-(0[1-9]|1[0-2])$/.test(saved.month || '')
        || !/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(saved.day || '')
        || !saved.day.startsWith(`${saved.month}-`)
        || !nonnegativeInteger(saved.monthMicroUsd) || !nonnegativeInteger(saved.dayMicroUsd)
        || !nonnegativeInteger(saved.monthSeconds) || !nonnegativeInteger(saved.requests)
        || saved.dayMicroUsd > saved.monthMicroUsd
        || !Array.isArray(saved.warned) || saved.warned.some((n) => !WARN_FRACTIONS.includes(n))) throw new Error('invalid');
      const pending = saved.pending;
      if (!pending || typeof pending !== 'object' || Array.isArray(pending)) throw new Error('pending');
      let reservedMicroUsd = 0;
      let reservedSeconds = 0;
      for (const [id, item] of Object.entries(pending)) {
        if (!/^[a-f0-9]{32}$/.test(id) || !item || !nonnegativeInteger(item.microUsd) || !nonnegativeInteger(item.seconds)
          || item.month !== saved.month || item.day !== saved.day) throw new Error('reservation');
        reservedMicroUsd += item.microUsd;
        reservedSeconds += item.seconds;
      }
      if (reservedMicroUsd > saved.dayMicroUsd || reservedSeconds > saved.monthSeconds
        || Object.keys(pending).length > MAX_PENDING) throw new Error('reserved');
      this.state = {
        month: saved.month, monthMicroUsd: saved.monthMicroUsd, monthSeconds: saved.monthSeconds,
        day: saved.day, dayMicroUsd: saved.dayMicroUsd, requests: saved.requests, warned: saved.warned, pending,
      };
    } catch {
      this.error = 'usage-file-invalid';
      this.log?.error?.(`${this.label} speech usage file is invalid; it stays off until it is reconciled`);
    }
  }

  get reservedMicroUsd() { return Object.values(this.state.pending).reduce((sum, item) => sum + item.microUsd, 0); }

  get reservedSeconds() { return Object.values(this.state.pending).reduce((sum, item) => sum + item.seconds, 0); }

  _roll() {
    const keys = periodKeys(this.now(), this.timeZone);
    if (keys.month < this.state.month || keys.day < this.state.day) {
      this.error = 'usage-clock-backwards';
      return;
    }
    if (keys.month !== this.state.month) {
      this.state.month = keys.month;
      this.state.monthMicroUsd = this.reservedMicroUsd;
      this.state.monthSeconds = this.reservedSeconds;
      this.state.requests = 0;
      this.state.warned = [];
      for (const item of Object.values(this.state.pending)) item.month = keys.month;
    }
    if (keys.day !== this.state.day) {
      this.state.day = keys.day;
      this.state.dayMicroUsd = this.reservedMicroUsd;
      for (const item of Object.values(this.state.pending)) item.day = keys.day;
    }
  }

  _persist() {
    const body = `${JSON.stringify({ version: TRANSCRIPTION_USAGE_VERSION, ...this.state, updatedAt: this.now() })}\n`;
    const temporary = join(dirname(this.file), `.stt-usage.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
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
      this.log?.error?.(`${this.label} speech usage could not be saved; it stays off`, { code: err?.code || 'EIO' });
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

  /** Null when a request of this size may be sent now, else why not. */
  refusal({ microUsd = 0, seconds = 0 } = {}) {
    if (this.error) return this.error;
    if (!this.monthlyLimitMicroUsd && !this.monthlyLimitSeconds) return 'disabled';
    this._roll();
    if (this.error) return this.error;
    if (this.monthlyLimitMicroUsd && this.state.monthMicroUsd + microUsd > this.monthlyLimitMicroUsd) return 'monthly-limit';
    if (this.dailyLimitMicroUsd && this.state.dayMicroUsd + microUsd > this.dailyLimitMicroUsd) return 'daily-limit';
    if (this.monthlyLimitSeconds && this.state.monthSeconds + seconds > this.monthlyLimitSeconds) return 'monthly-minutes';
    if (Object.keys(this.state.pending).length >= MAX_PENDING) return 'too-many-reservations';
    return null;
  }

  reserve({ microUsd = 0, seconds = 0 } = {}) {
    const wantedUsd = Math.ceil(Number(microUsd));
    const wantedSeconds = Math.ceil(Number(seconds));
    if (!nonnegativeInteger(wantedUsd) || !nonnegativeInteger(wantedSeconds)) return null;
    return this._change(() => {
      if (this.refusal({ microUsd: wantedUsd, seconds: wantedSeconds })) return null;
      const id = randomBytes(16).toString('hex');
      this.state.monthMicroUsd += wantedUsd;
      this.state.dayMicroUsd += wantedUsd;
      this.state.monthSeconds += wantedSeconds;
      this.state.pending[id] = { microUsd: wantedUsd, seconds: wantedSeconds, month: this.state.month, day: this.state.day };
      return { id, microUsd: wantedUsd, seconds: wantedSeconds, settled: false };
    });
  }

  /** Settle a reservation with what was actually billed (reserved amounts when unknown). */
  commit(reservation, { microUsd, seconds } = {}) {
    if (!reservation || reservation.settled) return;
    reservation.settled = true;
    this._change(() => {
      const pending = this.state.pending[reservation.id];
      if (!pending) return null;
      const usd = Number.isFinite(microUsd) && microUsd >= 0 ? Math.ceil(microUsd) : pending.microUsd;
      const secs = Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : pending.seconds;
      this.state.monthMicroUsd += usd - pending.microUsd;
      this.state.dayMicroUsd += usd - pending.microUsd;
      this.state.monthSeconds += secs - pending.seconds;
      delete this.state.pending[reservation.id];
      if (usd || secs) this.state.requests += 1;
      this._warnOnThresholds();
      return true;
    });
  }

  _usedFraction() {
    const usd = this.monthlyLimitMicroUsd ? (this.state.monthMicroUsd - this.reservedMicroUsd) / this.monthlyLimitMicroUsd : 0;
    const secs = this.monthlyLimitSeconds ? (this.state.monthSeconds - this.reservedSeconds) / this.monthlyLimitSeconds : 0;
    return Math.max(usd, secs);
  }

  _warnOnThresholds() {
    const fraction = this._usedFraction();
    for (const threshold of WARN_FRACTIONS) {
      if (fraction >= threshold && !this.state.warned.includes(threshold)) {
        this.state.warned.push(threshold);
        const fields = {
          month: this.state.month,
          usedUsd: (this.state.monthMicroUsd - this.reservedMicroUsd) / 1e6,
          limitUsd: this.monthlyLimitMicroUsd / 1e6,
          usedMinutes: Math.round((this.state.monthSeconds - this.reservedSeconds) / 6) / 10,
          limitMinutes: Math.round(this.monthlyLimitSeconds / 6) / 10,
        };
        if (threshold >= 1) this.log?.error?.(`${this.label} speech monthly limit reached; it is off until next month`, fields);
        else this.log?.warn?.(`${this.label} speech has used ${Math.round(threshold * 100)}% of its monthly limit`, fields);
      }
    }
  }

  status() {
    if (!this.error) this._load();
    if (!this.error) this._roll();
    const exhausted = this.error ? null
      : this.monthlyLimitMicroUsd && this.state.monthMicroUsd >= this.monthlyLimitMicroUsd ? 'month'
        : this.monthlyLimitSeconds && this.state.monthSeconds >= this.monthlyLimitSeconds ? 'minutes'
          : this.dailyLimitMicroUsd && this.state.dayMicroUsd >= this.dailyLimitMicroUsd ? 'day' : null;
    return {
      persistent: !!this.file && !this.error, problem: this.error, month: this.state.month,
      usedMicroUsd: this.state.monthMicroUsd - this.reservedMicroUsd, limitMicroUsd: this.monthlyLimitMicroUsd,
      day: this.state.day, dayUsedMicroUsd: this.state.dayMicroUsd - this.reservedMicroUsd, dayLimitMicroUsd: this.dailyLimitMicroUsd,
      usedSeconds: this.state.monthSeconds - this.reservedSeconds, limitSeconds: this.monthlyLimitSeconds,
      requests: this.state.requests, reservedMicroUsd: this.reservedMicroUsd, exhausted,
    };
  }
}
