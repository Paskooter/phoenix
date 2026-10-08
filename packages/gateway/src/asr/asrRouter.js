// Which recognizer a turn uses, and the state shared between turns.
//
//   PHOENIX_ASR_PROVIDER=parakeet  (default) Parakeet only. The factory does not
//                                  even construct this router: sessions are built
//                                  exactly as before and Google is never touched.
//   PHOENIX_ASR_PROVIDER=auto      Parakeet first; Google while Parakeet cannot
//                                  answer (failoverTransport.js), within budget.
//   PHOENIX_ASR_PROVIDER=google    Google only, within budget. Frees the GPU.
//
// In every mode the turn itself -- decoding, endpointing, relisten, FAST_EOS,
// timeouts -- is ParakeetASRSession's; only the recognizer behind it changes.
//
// Google needs a project, a service-account key file on the server and a
// writable usage ledger (googleUsage.js). Missing any of them, Google is
// reported "not configured" and is never called; auto mode then behaves like
// Parakeet alone. A configuration or credential error from Google pauses it
// for a few minutes instead of failing every turn the same way.

import { logger } from '@phoenix/common';
import { Timeouts } from '@phoenix/contracts';
import { ParakeetASRSession } from './parakeetSession.js';
import { createParakeetTransport } from './parakeetTransport.js';
import { createGoogleTransport, streamSlots } from './googleTransport.js';
import { googleModelLocationSupported, classifyGoogleError, createGoogleSpeechClient } from './googleSpeech.js';
import { GoogleUsageMeter, googleUsageFile } from './googleUsage.js';
import { FAILOVER_DEFAULTS, ParakeetHealth, createFailoverTransport } from './failoverTransport.js';

export const ASR_MODES = ['parakeet', 'auto', 'google'];
export const DEFAULT_PARAKEET_URL = 'http://192.168.1.252:6972';
/** $10 of credit buys 625 minutes at $0.016/min; keep a 10% margin. */
export const DEFAULT_MONTHLY_MINUTES = 560;
export const DEFAULT_MODEL = 'chirp_3';
export const DEFAULT_LOCATION = 'us';
const CONFIG_PAUSE_MS = 5 * 60 * 1000;
const PAUSING_FAILURES = new Set(['configuration', 'credentials', 'client-missing']);
const PROCESS_GOOGLE_SLOTS = streamSlots(8);

/** The mode a value selects; anything unknown is the default. */
export function asrMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return ASR_MODES.includes(mode) ? mode : 'parakeet';
}

function number(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function budgetMinutes(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n * 60 <= Number.MAX_SAFE_INTEGER ? n : null;
}

/** Everything the router needs, read from the environment the launcher gave the hub. */
export function asrSettingsFromEnv(env = process.env) {
  const monthlyMinutes = budgetMinutes(env.PHOENIX_GOOGLE_STT_MONTHLY_MINUTES, DEFAULT_MONTHLY_MINUTES);
  const dailyMinutes = budgetMinutes(env.PHOENIX_GOOGLE_STT_DAILY_MINUTES, Math.ceil((monthlyMinutes || 0) / 10));
  const model = String(env.PHOENIX_GOOGLE_STT_MODEL || DEFAULT_MODEL).trim();
  const location = String(env.PHOENIX_GOOGLE_STT_LOCATION || DEFAULT_LOCATION).trim();
  return {
    mode: asrMode(env.PHOENIX_ASR_PROVIDER),
    parakeetUrl: () => env.ETCO_server_parakeetUrl || env.PARAKEET_URL || DEFAULT_PARAKEET_URL,
    google: {
      projectId: String(env.PHOENIX_GOOGLE_STT_PROJECT || '').trim(),
      credentialsFile: String(env.PHOENIX_GOOGLE_STT_CREDENTIALS_FILE || env.GOOGLE_APPLICATION_CREDENTIALS || '').trim(),
      location,
      model,
      configurationProblem: !googleModelLocationSupported(model, location)
        ? 'invalid-model-or-location' : monthlyMinutes === null || dailyMinutes === null ? 'invalid-budget' : null,
      denoise: env.PHOENIX_GOOGLE_STT_DENOISE === 'true',
      hintBoost: number(env.PHOENIX_GOOGLE_STT_HINT_BOOST, null),
      monthlyLimitSeconds: monthlyMinutes === null || dailyMinutes === null ? 0 : Math.floor(monthlyMinutes * 60),
      dailyLimitSeconds: Math.floor((dailyMinutes || 0) * 60),
      usageFile: googleUsageFile(env),
      maxStreams: Math.max(1, Math.floor(number(env.PHOENIX_GOOGLE_STT_MAX_STREAMS, 8))),
      chunkMs: 200,
      finalTimeoutMs: 5000,
      recognizeTimeoutMs: 10000,
      connectTimeoutMs: 2000,
    },
    failover: { ...FAILOVER_DEFAULTS },
  };
}

export class AsrRouter {
  /**
   * @param {ReturnType<typeof asrSettingsFromEnv>} settings
   * @param {object} [deps]  injectable for tests: createClient, meter, now, log
   */
  constructor(settings, { createClient = createGoogleSpeechClient, meter = null, now = Date.now, log = null } = {}) {
    this.settings = settings;
    this.createClient = createClient;
    this.now = now;
    this.log = log;
    this.meter = meter;
    this.slots = {
      acquire: () => PROCESS_GOOGLE_SLOTS.acquire(Math.min(8, settings.google.maxStreams)),
      release: () => PROCESS_GOOGLE_SLOTS.release(),
      get active() { return PROCESS_GOOGLE_SLOTS.active; },
    };
    this.healthByUrl = new Map();
    this.clientPromise = null;
    this.lastFailure = null;
    this.announced = false;
    this.sessions = new Set();
    this.retired = false;
  }

  get mode() { return this.settings.mode; }

  /** Google has what it needs to be called at all. */
  googleConfigured() {
    const google = this.settings.google;
    return !!(google.projectId && google.credentialsFile && google.monthlyLimitSeconds > 0 && !google.configurationProblem);
  }

  _meter() {
    if (!this.meter) {
      this.meter = new GoogleUsageMeter({
        file: this.settings.google.usageFile,
        monthlyLimitSeconds: this.settings.google.monthlyLimitSeconds,
        dailyLimitSeconds: this.settings.google.dailyLimitSeconds,
        now: this.now,
        log: this.log,
      });
    }
    return this.meter;
  }

  /** Null when Google may be called now, else why not (budget is checked separately). */
  googleUnavailable() {
    const google = this.settings.google;
    if (google.configurationProblem) return google.configurationProblem;
    if (!google.projectId || !google.credentialsFile) return 'not-configured';
    if (google.monthlyLimitSeconds <= 0) return 'disabled';
    const meterProblem = this._meter().status().problem;
    if (meterProblem) return meterProblem;
    if (this.lastFailure && PAUSING_FAILURES.has(this.lastFailure.kind)
      && this.now() - this.lastFailure.at < CONFIG_PAUSE_MS) return this.lastFailure.kind;
    return null;
  }

  _client() {
    if (!this.clientPromise) {
      const google = this.settings.google;
      this.clientPromise = Promise.resolve()
        .then(() => this.createClient({
          location: google.location, credentialsFile: google.credentialsFile, projectId: google.projectId,
        }))
        .catch((err) => {
          this.clientPromise = null; // retry after the pause
          throw err;
        });
    }
    return this.clientPromise;
  }

  _recordGoogleFailure(kind, err) {
    this.lastFailure = { kind, at: this.now(), grpcCode: classifyGoogleError(err).grpcCode };
    const fields = { kind, grpcCode: this.lastFailure.grpcCode };
    if (PAUSING_FAILURES.has(kind)) {
      this.log?.error?.('[asr] Google speech is misconfigured; pausing it', { ...fields, pauseMs: CONFIG_PAUSE_MS });
    } else {
      this.log?.warn?.('[asr] Google speech request failed', fields);
    }
  }

  _googleTransport(config, log) {
    return createGoogleTransport({
      config,
      settings: this.settings.google,
      client: () => this._client(),
      meter: this._meter(),
      slots: this.slots,
      unavailable: () => this.googleUnavailable(),
      onFailure: (kind, err) => this._recordGoogleFailure(kind, err),
      deadlineAt: this.now() + Timeouts.asr - 250,
      now: this.now,
      log,
    });
  }

  health(parakeetUrl) {
    let health = this.healthByUrl.get(parakeetUrl);
    if (!health) {
      const probeTransport = createParakeetTransport(parakeetUrl, { probeTimeoutMs: this.settings.failover.probeTimeoutMs });
      health = new ParakeetHealth({
        probe: () => probeTransport.probe(),
        recoveryIntervalMs: this.settings.failover.recoveryIntervalMs,
        maxRecoveryIntervalMs: this.settings.failover.maxRecoveryIntervalMs,
        recoverySuccesses: this.settings.failover.recoverySuccesses,
        flapWindowMs: this.settings.failover.flapWindowMs,
        now: this.now,
        log: this.log,
      });
      this.healthByUrl.set(parakeetUrl, health);
    }
    return health;
  }

  _announce() {
    if (this.announced) return;
    this.announced = true;
    this.log?.info?.('[asr] recognizer selection', {
      mode: this.mode,
      google: this.googleConfigured() ? 'configured' : 'not-configured',
      model: this.settings.google.model,
      location: this.settings.google.location,
    });
  }

  /** A session for one turn. */
  startSession(config, log) {
    if (this.retired) throw new Error('ASR router is retired');
    this._announce();
    const parakeetUrl = this.settings.parakeetUrl();
    if (this.mode === 'google') {
      return this._lease(new ParakeetASRSession(null, config, log, { transport: this._googleTransport(config, log) }));
    }
    if (this.mode === 'auto') {
      const failover = this.settings.failover;
      const transport = createFailoverTransport({
        primary: createParakeetTransport(parakeetUrl, {
          probeTimeoutMs: failover.probeTimeoutMs,
          postTimeoutMs: failover.batchTimeoutMs,
        }),
        secondary: this.googleConfigured() ? this._googleTransport(config, log) : null,
        health: this.health(parakeetUrl),
        timeouts: failover,
        log,
      });
      return this._lease(new ParakeetASRSession(parakeetUrl, config, log, { transport }));
    }
    return this._lease(new ParakeetASRSession(parakeetUrl, config, log));
  }

  /** Changing a mode affects new turns; the old client's active turns drain. */
  _lease(session) {
    this.sessions.add(session);
    const release = () => { this.sessions.delete(session); this._closeRetiredClient(); };
    const start = session.start.bind(session);
    let tracked = null;
    session.start = () => {
      if (!tracked) {
        try { tracked = start().finally(release); }
        catch (error) { release(); throw error; }
      }
      return tracked;
    };
    const abort = session.abort.bind(session);
    session.abort = () => { try { return abort(); } finally { release(); } };
    const stop = session.stop.bind(session);
    session.stop = () => { const result = stop(); if (session.state === 'DONE') release(); return result; };
    return session;
  }

  /** Allow-listed state for the admin console: no URLs, keys, project IDs or text. */
  status() {
    const google = this.settings.google;
    const configured = this.googleConfigured();
    const parakeet = this.mode === 'auto' ? this.health(this.settings.parakeetUrl()).status() : null;
    const usage = configured || google.usageFile ? this._meter().status() : null;
    return {
      mode: this.mode,
      parakeet,
      google: {
        configured,
        unavailable: this.mode === 'parakeet' ? null : this.googleUnavailable(),
        model: google.model,
        location: google.location,
        activeStreams: this.slots.active,
        lastFailure: this.lastFailure ? { kind: this.lastFailure.kind, at: this.lastFailure.at } : null,
        usage: usage ? {
          month: usage.month,
          usedSeconds: usage.usedSeconds,
          limitSeconds: usage.limitSeconds,
          day: usage.day,
          dayUsedSeconds: usage.dayUsedSeconds,
          dayLimitSeconds: usage.dayLimitSeconds,
          exhausted: usage.exhausted,
          reservedSeconds: usage.reservedSeconds,
          problem: usage.problem,
        } : null,
      },
    };
  }

  close() {
    this.retired = true;
    for (const health of this.healthByUrl.values()) health.close();
    this.healthByUrl.clear();
    this._closeRetiredClient();
  }

  _closeRetiredClient() {
    if (!this.retired || this.sessions.size) return;
    const pending = this.clientPromise;
    this.clientPromise = null;
    pending?.then((client) => client.close?.()).catch(() => {});
  }
}

let current = null;
let pinned = false;

/**
 * The process router, created from the environment on first use (and again if
 * the configured mode changed). A router installed with setAsrRouter is kept.
 */
export function getAsrRouter() {
  if (!current || (!pinned && current.mode !== asrMode(process.env.PHOENIX_ASR_PROVIDER))) {
    current?.close();
    current = new AsrRouter(asrSettingsFromEnv(process.env), { log: logger('gateway.asr') });
  }
  return current;
}

/** Install a router (tests) or, with null, return to the environment's. */
export function setAsrRouter(router) {
  if (current && current !== router) current.close();
  current = router || null;
  pinned = !!router;
}

/** The current router's status without creating one in Parakeet-only mode. */
export function asrStatus(env = process.env) {
  if (!current && asrMode(env.PHOENIX_ASR_PROVIDER) === 'parakeet') {
    return { mode: 'parakeet', parakeet: null, google: null };
  }
  return getAsrRouter().status();
}
