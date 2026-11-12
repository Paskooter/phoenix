// OpenAI-compatible batch speech recognition as a ParakeetASRSession transport.
//
// Two presets share one transport:
//
//   openrouter  POST https://openrouter.ai/api/v1/audio/transcriptions with a
//               JSON body {model, language, input_audio:{data:<base64 WAV>,
//               format:'wav'}}. Authenticated with the one shared Phoenix
//               OpenRouter key (OPENROUTER_API_KEY, packages/contracts
//               openRouter.js). The endpoint is a constant and the key is only
//               attached when the destination is https://openrouter.ai.
//   custom      POST <PHOENIX_CUSTOM_STT_URL>/v1/audio/transcriptions as OpenAI
//               multipart (file, model, language, response_format=json), with
//               the endpoint's own optional key (PHOENIX_CUSTOM_STT_API_KEY).
//               Never the OpenRouter key, and never an openrouter.ai URL.
//
// Both answer {text, usage?:{seconds, cost}}. The session does everything else
// (decoding, endpointing, relisten, FAST_EOS, timeouts): this transport only
// recognizes a finished window. It cannot stream, so probeStreaming() is false
// and the session posts the window at end of speech, like Parakeet's
// /transcribe. openStream() exists for failover (fallbackChain.js), which may
// need a socket: it buffers the window and recognizes it at `eos`.
//
// Recognition hints (Jibo's ASR hints, $YESNO lists) are NOT sent: OpenRouter
// drops `prompt` without an error, and a Whisper-style prompt can be echoed as
// if it were speech.
//
// Text: every transcript goes through the same normalizer as Google
// (transcriptNormalizer.js), after dropping bracketed non-speech annotations
// such as whisper.cpp's "[BLANK_AUDIO]". A 200 answer whose text normalizes to
// nothing is a real "no speech" result, which the session relistens on. A
// missing or non-string text, a non-JSON body or any HTTP error is an error
// (never an empty success); errors are reported through onFailure, which the
// router uses to log them and pause the provider.

import { isOpenRouterHost, isOpenRouterUrl } from '@phoenix/contracts';
import { normalizeGoogleTranscript } from './transcriptNormalizer.js';
import { pcmFromWav } from './googleTransport.js';
import { BatchRecognizerSocket } from './batchSocket.js';
import { TranscriptionBudgetError } from './transcriptionUsage.js';

export const OPENROUTER_TRANSCRIPTIONS_URL = 'https://openrouter.ai/api/v1/audio/transcriptions';
export const OPENROUTER_DEFAULT_STT_MODEL = 'nvidia/parakeet-tdt-0.6b-v3';
export const DEFAULT_STT_LANGUAGE = 'en';
export const DEFAULT_STT_TIMEOUT_MS = 8000;
/** Before a request: hold $1.00/hour of audio, above every model we offer. */
export const RESERVE_MICRO_USD_PER_SECOND = Math.ceil(1e6 / 3600);
export const MAX_WINDOW_SECONDS = 31;
const BYTES_PER_SECOND = 32000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const OPENROUTER_HEADERS = Object.freeze({ 'HTTP-Referer': 'https://pvindex.org/phoenix', 'X-Title': 'Phoenix' });

/** How long a failure keeps a provider out of rotation. */
export const PAUSE_MS = Object.freeze({ long: 5 * 60 * 1000, short: 30 * 1000, maxRetryAfter: 5 * 60 * 1000 });

export class OpenAiSttError extends Error {
  constructor(message, { code = 'OPENAI_STT_ERROR', httpStatus, retryAfterMs, cause } = {}) {
    super(message);
    this.name = 'OpenAiSttError';
    this.code = code;
    if (httpStatus !== undefined) this.httpStatus = httpStatus;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * The transcription URL for a custom endpoint: a base URL gets
 * /v1/audio/transcriptions, a /v1 URL gets /audio/transcriptions, a full path
 * is kept. Null for anything that is not plain http(s), carries credentials,
 * or points at openrouter.ai (use the OpenRouter preset for that).
 */
export function customTranscriptionsUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  if (isOpenRouterHost(url.href)) return null;
  url.hash = '';
  const path = url.pathname.replace(/\/+$/, '');
  if (/\/audio\/transcriptions$/.test(path)) url.pathname = path;
  else if (/\/v1$/.test(path)) url.pathname = `${path}/audio/transcriptions`;
  else url.pathname = `${path}/v1/audio/transcriptions`;
  return url.href;
}

/** OpenRouter: JSON with base64 audio. */
export function openRouterRequest({ wav, model, language, apiKey }) {
  const body = { model, input_audio: { data: Buffer.from(wav).toString('base64'), format: 'wav' } };
  if (language) body.language = language;
  return {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, ...OPENROUTER_HEADERS },
    body: JSON.stringify(body),
  };
}

/** OpenAI multipart: file, model (when set), language, response_format=json. */
export function multipartRequest({ wav, model, language, apiKey }) {
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
  if (model) form.append('model', model);
  if (language) form.append('language', language);
  form.append('response_format', 'json');
  return { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, body: form };
}

/** What a failure means for the provider: a kind and how long to pause it (0 = not at all). */
export function classifySttFailure(err) {
  const status = err?.httpStatus;
  if (status === 401 || status === 403) return { kind: 'credentials', pauseMs: PAUSE_MS.long };
  if (status === 402) return { kind: 'payment', pauseMs: PAUSE_MS.long };
  if (status === 400 || status === 404 || status === 405 || status === 415 || status === 422) return { kind: 'configuration', pauseMs: PAUSE_MS.long };
  if (status === 413) return { kind: 'too-long', pauseMs: 0 };
  if (status === 429) {
    const retry = Number.isFinite(err?.retryAfterMs) ? Math.min(PAUSE_MS.maxRetryAfter, Math.max(1000, err.retryAfterMs)) : PAUSE_MS.short;
    return { kind: 'rate-limited', pauseMs: retry };
  }
  if (Number.isInteger(status)) return { kind: 'server', pauseMs: PAUSE_MS.short };
  if (err?.code === 'OPENAI_STT_TIMEOUT') return { kind: 'timeout', pauseMs: PAUSE_MS.short };
  if (err?.code === 'OPENAI_STT_INVALID_RESPONSE') return { kind: 'invalid-response', pauseMs: PAUSE_MS.short };
  if (err?.code === 'OPENAI_STT_TOO_LONG') return { kind: 'too-long', pauseMs: 0 };
  return { kind: 'unreachable', pauseMs: PAUSE_MS.short };
}

function retryAfterMs(value) {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

async function readBounded(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isSafeInteger(declared) && declared > MAX_RESPONSE_BYTES) {
    try { await response.body?.cancel(); } catch { /* already closed */ }
    throw new OpenAiSttError('Transcription response is too large', { code: 'OPENAI_STT_INVALID_RESPONSE' });
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_RESPONSE_BYTES) {
      try { await reader.cancel(); } catch { /* already closed */ }
      throw new OpenAiSttError('Transcription response is too large', { code: 'OPENAI_STT_INVALID_RESPONSE' });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Bracketed non-speech annotations: [BLANK_AUDIO], [Music], [inaudible]. */
export function dropAnnotations(text) {
  return String(text).replace(/\[[^\]]*\]/g, ' ');
}

/** {text, costMicroUsd|null, seconds|null} from a 200 body, or an invalid-response error. */
export function parseTranscription(raw) {
  let json;
  try { json = JSON.parse(raw); } catch { json = null; }
  if (!json || typeof json !== 'object' || typeof json.text !== 'string') {
    throw new OpenAiSttError('Transcription response has no text', { code: 'OPENAI_STT_INVALID_RESPONSE' });
  }
  const cost = json.usage?.cost;
  const seconds = json.usage?.seconds;
  return {
    text: normalizeGoogleTranscript(dropAnnotations(json.text)),
    costMicroUsd: typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? Math.ceil(Math.round(cost * 1e12) / 1e6) : null,
    seconds: typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 ? seconds : null,
  };
}

function networkError(err) {
  const code = err?.cause?.code || err?.code;
  return new OpenAiSttError('Transcription endpoint could not be reached', {
    code: typeof code === 'string' && /^E[A-Z]+$/.test(code) ? code : 'OPENAI_STT_ERROR',
  });
}

/**
 * The transport for one session.
 * @param {object} options
 * @param {'openrouter'|'custom'} options.preset
 * @param {object} options.settings  asrSettingsFromEnv().openrouter or .custom
 * @param {import('./transcriptionUsage.js').TranscriptionUsageMeter|null} options.meter  null = unmetered
 * @param {() => string|null} [options.unavailable]  a reason the provider must not be used now
 * @param {(kind:string, err:Error, pauseMs:number)=>void} [options.onFailure]
 * @param {typeof fetch} [options.fetchImpl]
 */
export function createOpenAiCompatibleTransport({
  preset, settings, meter = null, unavailable = () => null, onFailure = null,
  fetchImpl = globalThis.fetch, deadlineAt = null, now = Date.now,
}) {
  const controllers = new Set();
  let cancelled = false;
  const cancellationError = () => new OpenAiSttError('Speech recognition was cancelled', { code: 'OPENAI_STT_CANCELLED' });
  const unavailableError = (reason) => new OpenAiSttError(`Speech recognizer is unavailable: ${reason}`, { code: 'OPENAI_STT_UNAVAILABLE' });

  /** The URL and key for this preset, or the reason it cannot be used. */
  const destination = () => {
    if (preset === 'openrouter') {
      const url = settings.endpoint || OPENROUTER_TRANSCRIPTIONS_URL;
      if (!isOpenRouterUrl(url)) return { problem: 'not-openrouter' };
      const apiKey = settings.apiKey?.() || '';
      return apiKey ? { url, apiKey } : { problem: 'no-key' };
    }
    const url = customTranscriptionsUrl(settings.endpoint);
    return url ? { url, apiKey: settings.apiKey?.() || '' } : { problem: 'invalid-url' };
  };

  const reserveFor = (seconds) => ({
    microUsd: preset === 'openrouter' ? Math.ceil(seconds * RESERVE_MICRO_USD_PER_SECOND) : Math.ceil(seconds * (settings.microUsdPerSecond || 0)),
    seconds: Math.ceil(seconds),
  });

  const transport = {
    name: preset,
    streams: false,
    /** Null when a window of this length may be sent now, else why not. */
    unavailableReason(seconds = MAX_WINDOW_SECONDS) {
      const reason = unavailable() || destination().problem || null;
      if (reason) return reason;
      return meter ? meter.refusal(reserveFor(seconds)) : null;
    },
    available(seconds) { return transport.unavailableReason(seconds) === null; },
    async probeStreaming() { return false; },
    openStream() {
      if (cancelled) throw cancellationError();
      return new BatchRecognizerSocket({ recognize: (wav) => transport.recognizeWav(wav) });
    },
    async recognizeWav(wav) {
      if (cancelled) throw cancellationError();
      const pcm = pcmFromWav(wav);
      const seconds = pcm.length / BYTES_PER_SECOND;
      if (seconds > MAX_WINDOW_SECONDS) throw new OpenAiSttError('Audio is longer than one recognition window', { code: 'OPENAI_STT_TOO_LONG' });
      const reason = unavailable();
      if (reason) throw unavailableError(reason);
      const target = destination();
      if (target.problem) throw unavailableError(target.problem);
      const remaining = deadlineAt === null ? Infinity : deadlineAt - now();
      if (remaining < 1000) throw new OpenAiSttError('Speech recognition turn deadline expired', { code: 'OPENAI_STT_TIMEOUT' });
      const wanted = reserveFor(seconds);
      let reservation = null;
      if (meter) {
        reservation = meter.reserve(wanted);
        if (!reservation) {
          const refusal = meter.refusal(wanted) || 'monthly-limit';
          throw new TranscriptionBudgetError(`Speech recognizer is over its ${refusal.replace(/-/g, ' ')}`, refusal);
        }
      }
      const request = preset === 'openrouter'
        ? openRouterRequest({ wav, model: settings.model, language: settings.language, apiKey: target.apiKey })
        : multipartRequest({ wav, model: settings.model, language: settings.language, apiKey: target.apiKey });
      const timeoutMs = Math.min(settings.timeoutMs || DEFAULT_STT_TIMEOUT_MS, remaining);
      const controller = new AbortController();
      controllers.add(controller);
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      let parsed;
      let answered = false;
      try {
        let response;
        try {
          response = await fetchImpl(target.url, { method: 'POST', headers: request.headers, body: request.body, signal: controller.signal, redirect: 'error' });
        } catch (err) {
          throw cancelled ? cancellationError()
            : timedOut ? new OpenAiSttError('Speech recognition request timed out', { code: 'OPENAI_STT_TIMEOUT' })
              : networkError(err);
        }
        let raw;
        try {
          raw = await readBounded(response);
        } catch (err) {
          if (err instanceof OpenAiSttError) { answered = true; throw err; }
          throw cancelled ? cancellationError()
            : timedOut ? new OpenAiSttError('Speech recognition request timed out', { code: 'OPENAI_STT_TIMEOUT' })
              : networkError(err);
        }
        answered = true;
        if (response.status !== 200) {
          throw new OpenAiSttError(`Speech recognizer returned HTTP ${response.status}`, {
            httpStatus: response.status, retryAfterMs: retryAfterMs(response.headers.get('retry-after')),
          });
        }
        parsed = parseTranscription(raw);
      } catch (err) {
        // An HTTP error answer is not billed; an unanswered request may have
        // been, so it keeps its reservation.
        meter?.commit(reservation, answered ? { microUsd: 0, seconds: 0 } : wanted);
        if (!cancelled && err?.code !== 'OPENAI_STT_CANCELLED') {
          try { onFailure?.(classifySttFailure(err).kind, err, classifySttFailure(err).pauseMs); } catch { /* reporting only */ }
        }
        throw err;
      } finally {
        clearTimeout(timer);
        controllers.delete(controller);
      }
      meter?.commit(reservation, {
        microUsd: parsed.costMicroUsd ?? wanted.microUsd,
        seconds: parsed.seconds ?? seconds,
      });
      // A ready response and abort can race: accounting is owed, delivery is not.
      if (cancelled) throw cancellationError();
      return { text: parsed.text, confidence: null };
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      for (const controller of controllers) controller.abort();
    },
    describe() {
      return settings.model ? { provider: preset, model: settings.model } : { provider: preset };
    },
  };
  return transport;
}
