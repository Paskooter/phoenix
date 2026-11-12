// Which recognizer a turn uses, and the state shared between turns.
//
//   PHOENIX_ASR_PROVIDER=parakeet  (default) Parakeet only. The factory does not
//                                  even construct this router: sessions are built
//                                  exactly as before and Google is never touched.
//   PHOENIX_ASR_PROVIDER=auto      Parakeet first; Google while Parakeet cannot
//                                  answer (failoverTransport.js), within budget.
//   PHOENIX_ASR_PROVIDER=google    Google only, within budget. Frees the GPU.
//   PHOENIX_ASR_PROVIDER=openrouter  OpenRouter's /audio/transcriptions only, with
//                                  the one shared OpenRouter key, within budget.
//   PHOENIX_ASR_PROVIDER=custom    A custom OpenAI-compatible
//                                  /v1/audio/transcriptions URL only.
//
// In auto mode PHOENIX_ASR_FALLBACK_ORDER (default parakeet,openrouter,google)
// says who takes over from Parakeet, in order; only configured providers take
// part (fallbackChain.js). OpenRouter and custom are batch recognizers
// (openAiCompatibleTransport.js) metered by transcriptionUsage.js.
//
// In every mode the turn itself -- decoding, endpointing, relisten, FAST_EOS,
// timeouts -- is ParakeetASRSession's; only the recognizer behind it changes.
//
// Google needs a project, a service-account key file on the server and a
// writable usage ledger (googleUsage.js). Missing any of them, Google is
// reported "not configured" and is never called; auto mode then behaves like
// Parakeet alone. A configuration or credential error from Google pauses it
// for a few minutes instead of failing every turn the same way.
//
// OpenRouter needs the shared OpenRouter key, a monthly dollar cap and an
// initialized usage ledger; a custom URL needs only its URL (and a ledger when
// a cap is set). Every OpenRouter/custom error is logged and pauses that
// provider: five minutes for a key, payment or configuration problem, the
// provider's Retry-After for 429, thirty seconds otherwise.

import { logger, asrFailureFields } from '@phoenix/common';
import { Timeouts } from '@phoenix/contracts';
import { ParakeetASRSession } from './parakeetSession.js';
import { createParakeetTransport } from './parakeetTransport.js';
import { createGoogleTransport, streamSlots } from './googleTransport.js';
import { googleModelLocationSupported, classifyGoogleError, createGoogleSpeechClient } from './googleSpeech.js';
import { GoogleUsageMeter, googleUsageFile } from './googleUsage.js';
import { FAILOVER_DEFAULTS, ParakeetHealth, createFailoverTransport } from './failoverTransport.js';
import { isOpenRouterUrl, openRouterKey, sharedKeyForOpenRouter } from '@phoenix/contracts';
import {
  DEFAULT_STT_LANGUAGE, DEFAULT_STT_TIMEOUT_MS, OPENROUTER_DEFAULT_STT_MODEL, OPENROUTER_TRANSCRIPTIONS_URL, PAUSE_MS,
  createOpenAiCompatibleTransport, customTranscriptionsUrl,
} from './openAiCompatibleTransport.js';
import { TranscriptionUsageMeter, transcriptionUsageFile } from './transcriptionUsage.js';
import { createFallbackChain } from './fallbackChain.js';

export const ASR_MODES = ['parakeet', 'auto', 'google', 'openrouter', 'custom'];
/** Who takes over from Parakeet in auto mode, in order. */
export const FALLBACK_PROVIDERS = ['openrouter', 'custom', 'google'];
export const DEFAULT_FALLBACK_ORDER = Object.freeze(['openrouter', 'google']);
/** About 20-30 hours of audio a month with Parakeet-TDT on OpenRouter. */
export const DEFAULT_OPENROUTER_MONTHLY_USD = 2;
const OPENAI_PRESETS = ['openrouter', 'custom'];
const PRESET_LABELS = { openrouter: 'OpenRouter', custom: 'Custom endpoint' };
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

/** Dollars -> integer micro-USD; '' is the fallback, anything invalid is null. */
function microUsd(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n * 1e6 <= Number.MAX_SAFE_INTEGER ? Math.round(n * 1e6) : null;
}

const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');

/** 'en' unless set; 'auto' lets the provider detect the language. */
function language(value) {
  const text = trimmed(value).toLowerCase();
  if (!text) return DEFAULT_STT_LANGUAGE;
  return text === 'auto' ? '' : text;
}

function timeoutMs(value) {
  const n = number(value, DEFAULT_STT_TIMEOUT_MS);
  return Math.min(30000, Math.max(100, Math.floor(n)));
}

/** PHOENIX_ASR_FALLBACK_ORDER, without the leading 'parakeet'. */
export function fallbackOrderFrom(value) {
  const raw = trimmed(value === undefined || value === null ? '' : String(value));
  if (!raw) return { order: [...DEFAULT_FALLBACK_ORDER], problem: null };
  const tokens = raw.toLowerCase().split(',').map((token) => token.trim()).filter(Boolean);
  if (tokens[0] === 'parakeet') tokens.shift();
  if (!tokens.length || tokens.some((token) => !FALLBACK_PROVIDERS.includes(token)) || new Set(tokens).size !== tokens.length) {
    return { order: [...DEFAULT_FALLBACK_ORDER], problem: 'invalid-fallback-order' };
  }
  return { order: tokens, problem: null };
}

function openRouterSettingsFromEnv(env) {
  // Keys are read through functions so that no settings dump carries them.
  const apiKey = () => openRouterKey(env) || sharedKeyForOpenRouter(env);
  const monthly = microUsd(env.PHOENIX_OPENROUTER_STT_MONTHLY_USD, DEFAULT_OPENROUTER_MONTHLY_USD * 1e6);
  const daily = microUsd(env.PHOENIX_OPENROUTER_STT_DAILY_USD, monthly === null ? 0 : Math.ceil(monthly / 10));
  const minutes = budgetMinutes(env.PHOENIX_OPENROUTER_STT_MONTHLY_MINUTES, 0);
  return {
    endpoint: OPENROUTER_TRANSCRIPTIONS_URL,
    apiKey,
    model: trimmed(env.PHOENIX_OPENROUTER_STT_MODEL) || OPENROUTER_DEFAULT_STT_MODEL,
    language: language(env.PHOENIX_OPENROUTER_STT_LANGUAGE),
    timeoutMs: timeoutMs(env.PHOENIX_OPENROUTER_STT_TIMEOUT_MS),
    monthlyLimitMicroUsd: monthly === null || daily === null || minutes === null ? 0 : monthly,
    dailyLimitMicroUsd: daily || 0,
    monthlyLimitSeconds: Math.floor((minutes || 0) * 60),
    usageFile: transcriptionUsageFile(env, 'openrouter'),
    configurationProblem: !apiKey() ? 'no-key'
      : monthly === null || daily === null || minutes === null ? 'invalid-budget' : null,
  };
}

function customSettingsFromEnv(env) {
  const raw = trimmed(env.PHOENIX_CUSTOM_STT_URL);
  const endpoint = raw ? customTranscriptionsUrl(raw) : null;
  const monthly = microUsd(env.PHOENIX_CUSTOM_STT_MONTHLY_USD, 0);
  const minutes = budgetMinutes(env.PHOENIX_CUSTOM_STT_MONTHLY_MINUTES, 0);
  const perHour = microUsd(env.PHOENIX_CUSTOM_STT_USD_PER_HOUR, 0);
  const invalidBudget = monthly === null || minutes === null || perHour === null;
  return {
    endpoint,
    // Its own key only. Never the OpenRouter key.
    apiKey: () => trimmed(env.PHOENIX_CUSTOM_STT_API_KEY),
    model: trimmed(env.PHOENIX_CUSTOM_STT_MODEL),
    language: language(env.PHOENIX_CUSTOM_STT_LANGUAGE),
    timeoutMs: timeoutMs(env.PHOENIX_CUSTOM_STT_TIMEOUT_MS),
    monthlyLimitMicroUsd: invalidBudget ? 0 : monthly,
    dailyLimitMicroUsd: 0,
    monthlyLimitSeconds: invalidBudget ? 0 : Math.floor((minutes || 0) * 60),
    microUsdPerSecond: invalidBudget ? 0 : (perHour || 0) / 3600,
    /** A self-hosted endpoint with no cap runs unmetered and needs no ledger. */
    metered: !invalidBudget && (monthly > 0 || minutes > 0),
    usageFile: transcriptionUsageFile(env, 'custom'),
    configurationProblem: !raw ? 'no-url' : !endpoint ? 'invalid-url' : invalidBudget ? 'invalid-budget' : null,
  };
}

/** Everything the router needs, read from the environment the launcher gave the hub. */
export function asrSettingsFromEnv(env = process.env) {
  const monthlyMinutes = budgetMinutes(env.PHOENIX_GOOGLE_STT_MONTHLY_MINUTES, DEFAULT_MONTHLY_MINUTES);
  const dailyMinutes = budgetMinutes(env.PHOENIX_GOOGLE_STT_DAILY_MINUTES, Math.ceil((monthlyMinutes || 0) / 10));
  const model = String(env.PHOENIX_GOOGLE_STT_MODEL || DEFAULT_MODEL).trim();
  const location = String(env.PHOENIX_GOOGLE_STT_LOCATION || DEFAULT_LOCATION).trim();
  const fallback = fallbackOrderFrom(env.PHOENIX_ASR_FALLBACK_ORDER);
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
    openrouter: openRouterSettingsFromEnv(env),
    custom: customSettingsFromEnv(env),
    fallbackOrder: fallback.order,
    fallbackOrderProblem: fallback.problem,
  };
}

export class AsrRouter {
  /**
   * @param {ReturnType<typeof asrSettingsFromEnv>} settings
   * @param {object} [deps]  injectable for tests: createClient, meter, now, log, fetch
   */
  constructor(settings, {
    createClient = createGoogleSpeechClient, meter = null, now = Date.now, log = null,
    fetch = (...args) => globalThis.fetch(...args),
  } = {}) {
    this.settings = settings;
    this.fetch = fetch;
    this.sttMeters = {};
    this.sttFailures = { openrouter: null, custom: null };
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

  _recordGoogleFailure(kind, err, log = this.log) {
    this.lastFailure = { kind, at: this.now(), grpcCode: classifyGoogleError(err).grpcCode };
    const fields = { ...asrFailureFields(err, { provider: 'google' }), kind, grpcCode: this.lastFailure.grpcCode };
    if (PAUSING_FAILURES.has(kind)) {
      log?.error?.('[asr] Google speech is misconfigured; pausing it', { ...fields, pauseMs: CONFIG_PAUSE_MS });
    } else {
      log?.warn?.('[asr] Google speech request failed', fields);
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
      onFailure: (kind, err) => this._recordGoogleFailure(kind, err, log),
      deadlineAt: this.now() + Timeouts.asr - 250,
      now: this.now,
      log,
    });
  }

  // --- OpenRouter / custom (OpenAI-compatible batch transcription) ----------

  /** The provider has what it needs to be called at all. */
  openAiConfigured(preset) {
    const settings = this.settings[preset];
    if (!settings || settings.configurationProblem) return false;
    return preset === 'custom' || settings.monthlyLimitMicroUsd > 0 || settings.monthlyLimitSeconds > 0;
  }

  /** The ledger for a preset; null for an unmetered custom endpoint. */
  _sttMeter(preset) {
    const settings = this.settings[preset];
    if (preset === 'custom' && !settings.metered) return null;
    if (!this.sttMeters[preset]) {
      this.sttMeters[preset] = new TranscriptionUsageMeter({
        file: settings.usageFile,
        monthlyLimitMicroUsd: settings.monthlyLimitMicroUsd,
        dailyLimitMicroUsd: settings.dailyLimitMicroUsd,
        monthlyLimitSeconds: settings.monthlyLimitSeconds,
        label: PRESET_LABELS[preset],
        now: this.now,
        log: this.log,
      });
    }
    return this.sttMeters[preset];
  }

  /** Null when the provider may be called now, else why not (budget is checked per request). */
  providerUnavailable(preset) {
    const settings = this.settings[preset];
    if (settings.configurationProblem) return settings.configurationProblem;
    if (!this.openAiConfigured(preset)) return 'disabled';
    if (preset === 'openrouter' && !isOpenRouterUrl(settings.endpoint)) return 'not-openrouter';
    const meter = this._sttMeter(preset);
    const problem = meter ? meter.status().problem : null;
    if (problem) return problem;
    const failure = this.sttFailures[preset];
    if (failure && this.now() < failure.until) return failure.kind;
    return null;
  }

  _recordSttFailure(preset, kind, err, pauseMs, log = this.log) {
    const at = this.now();
    const previous = this.sttFailures[preset];
    this.sttFailures[preset] = { kind, at, until: Math.max(at + pauseMs, previous && previous.until > at ? previous.until : 0) };
    const fields = { ...asrFailureFields(err, { provider: preset }), kind, pauseMs };
    if (pauseMs >= PAUSE_MS.long) {
      log?.error?.(`[asr] ${PRESET_LABELS[preset]} speech recognition failed; pausing it`, fields);
    } else {
      log?.warn?.(`[asr] ${PRESET_LABELS[preset]} speech recognition failed${pauseMs ? '; pausing it briefly' : ''}`, fields);
    }
  }

  _openAiTransport(preset, config, log) {
    return createOpenAiCompatibleTransport({
      preset,
      settings: this.settings[preset],
      meter: this._sttMeter(preset),
      unavailable: () => this.providerUnavailable(preset),
      onFailure: (kind, err, pauseMs) => this._recordSttFailure(preset, kind, err, pauseMs, log),
      fetchImpl: this.fetch,
      deadlineAt: this.now() + Timeouts.asr - 250,
      now: this.now,
    });
  }

  /** Who takes over from Parakeet in auto mode, or null when nobody is configured. */
  _fallbackTransport(config, log) {
    const members = [];
    for (const name of this.settings.fallbackOrder || DEFAULT_FALLBACK_ORDER) {
      if (name === 'google' && this.googleConfigured()) members.push(this._googleTransport(config, log));
      else if (OPENAI_PRESETS.includes(name) && this.openAiConfigured(name)) members.push(this._openAiTransport(name, config, log));
    }
    if (!members.length) return null;
    // One member (today's Parakeet + Google) is used exactly as before.
    return members.length === 1 ? members[0] : createFallbackChain(members, { log });
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
      openrouter: this.openAiConfigured('openrouter') ? 'configured' : 'not-configured',
      openrouterModel: this.settings.openrouter?.model,
      custom: this.openAiConfigured('custom') ? 'configured' : 'not-configured',
      fallbackOrder: this.settings.fallbackOrder,
      ...(this.settings.fallbackOrderProblem ? { fallbackOrderProblem: this.settings.fallbackOrderProblem } : {}),
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
    if (OPENAI_PRESETS.includes(this.mode)) {
      return this._lease(new ParakeetASRSession(null, config, log, { transport: this._openAiTransport(this.mode, config, log) }));
    }
    if (this.mode === 'auto') {
      const failover = this.settings.failover;
      const transport = createFailoverTransport({
        primary: createParakeetTransport(parakeetUrl, {
          probeTimeoutMs: failover.probeTimeoutMs,
          postTimeoutMs: failover.batchTimeoutMs,
        }),
        secondary: this._fallbackTransport(config, log),
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
      fallbackOrder: this.mode === 'auto' ? this.settings.fallbackOrder : null,
      fallbackOrderProblem: this.settings.fallbackOrderProblem || null,
      openrouter: this._openAiStatus('openrouter'),
      custom: this._openAiStatus('custom'),
    };
  }

  /** Allow-listed: no URL, key or text. */
  _openAiStatus(preset) {
    const settings = this.settings[preset];
    if (!settings) return null;
    const configured = this.openAiConfigured(preset);
    const inUse = this.mode === preset || (this.mode === 'auto' && (this.settings.fallbackOrder || []).includes(preset));
    const meter = (configured || (preset === 'openrouter' && settings.usageFile)) ? this._sttMeter(preset) : null;
    const usage = meter ? meter.status() : null;
    const failure = this.sttFailures[preset];
    return {
      configured,
      unavailable: inUse ? this.providerUnavailable(preset) : null,
      model: settings.model || null,
      language: settings.language || null,
      lastFailure: failure ? { kind: failure.kind, at: failure.at, until: failure.until } : null,
      usage: usage ? {
        month: usage.month,
        usedMicroUsd: usage.usedMicroUsd,
        limitMicroUsd: usage.limitMicroUsd,
        day: usage.day,
        dayUsedMicroUsd: usage.dayUsedMicroUsd,
        dayLimitMicroUsd: usage.dayLimitMicroUsd,
        usedSeconds: usage.usedSeconds,
        limitSeconds: usage.limitSeconds,
        requests: usage.requests,
        reservedMicroUsd: usage.reservedMicroUsd,
        exhausted: usage.exhausted,
        problem: usage.problem,
      } : null,
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
