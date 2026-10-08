// Google Speech-to-Text V2 as a ParakeetASRSession transport.
//
// The session keeps doing everything a turn needs -- decoding OGG_OPUS/FLAC,
// local endpointing, wake-tail and empty-endpoint relistens, FAST_EOS on
// interims, max-speech, cancellation -- and Google only replaces the recognizer
// behind it. GoogleStreamSocket therefore speaks the Parakeet `/stream`
// protocol (recognizerSocket.js) on top of a V2 StreamingRecognize stream:
//
//   session                      GoogleStreamSocket            Google V2
//   'open' <-------------------- config written ------------> {recognizer, streamingConfig}
//   send({"type":"start"})       (configuration already sent)
//   send(PCM)  ----------------> coalesced to ~200 ms -------> {audio}  (<= 25 KB)
//                <-- 'interim' - normalized hypothesis <------ results (isFinal=false)
//   send({"type":"eos"}) ------> flush, half-close ---------> end of audio
//                <-- 'final' --- normalized finals <---------- results (isFinal=true), end
//
// Every transcript is normalized to the Parakeet format before the session
// sees it (transcriptNormalizer.js), so FAST_EOS, NLU and routing are fed the
// same text either recognizer would produce.
//
// Budget: each stream reserves a full window (30 s) before connecting and
// commits what was actually sent when it ends (googleUsage.js).

import {
  GOOGLE_BYTES_PER_SECOND,
  GOOGLE_MAX_AUDIO_BYTES_PER_REQUEST,
  GOOGLE_MAX_SYNC_SECONDS,
  GoogleSttError,
  billedSecondsOf,
  buildRecognitionConfig,
  buildRecognizeRequest,
  buildStreamingRequest,
  classifyGoogleError,
  combineConfidence,
  googleRecognizerPath,
  modelReportsConfidence,
  topAlternative,
} from './googleSpeech.js';
import { GoogleBudgetError } from './googleUsage.js';
import { CLOSED, OPEN, RecognizerSocket, parseControl } from './recognizerSocket.js';
import { normalizeGoogleTranscript } from './transcriptNormalizer.js';

/** A recognition window never holds more than 30 s of audio (MAX_BUFFER_MS). */
export const GOOGLE_STREAM_RESERVATION_SECONDS = 31;
export const DEFAULT_CHUNK_MS = 200;
export const DEFAULT_FINAL_TIMEOUT_MS = 5000;
export const DEFAULT_RECOGNIZE_TIMEOUT_MS = 10000;

const billedEstimate = (bytes) => Math.ceil(bytes / GOOGLE_BYTES_PER_SECOND);

export class GoogleStreamSocket extends RecognizerSocket {
  /**
   * @param {object} options
   * @param {() => Promise<object>} options.client   resolves the V2 client adapter
   * @param {object} options.request                 the first StreamingRecognizeRequest
   * @param {object} options.meter                   GoogleUsageMeter
   * @param {{acquire():boolean, release():void}} options.slots  concurrent stream limit
   * @param {boolean} options.reportsConfidence
   * @param {(kind:string, err:Error)=>void} [options.onFailure]
   */
  constructor({
    client, request, meter, slots, reportsConfidence, normalize = normalizeGoogleTranscript,
    chunkBytes = (GOOGLE_BYTES_PER_SECOND * DEFAULT_CHUNK_MS) / 1000,
    finalTimeoutMs = DEFAULT_FINAL_TIMEOUT_MS, log = null, onFailure = null,
  }) {
    super();
    this.client = client;
    this.request = request;
    this.meter = meter;
    this.slots = slots;
    this.reportsConfidence = reportsConfidence;
    this.normalize = normalize;
    this.chunkBytes = Math.max(320, Math.min(GOOGLE_MAX_AUDIO_BYTES_PER_REQUEST, Math.floor(chunkBytes / 2) * 2));
    this.finalTimeoutMs = finalTimeoutMs;
    this.log = log;
    this.onFailure = onFailure;

    this.stream = null;
    this.reservation = null;
    this.holdsSlot = false;
    this.pending = [];
    this.pendingBytes = 0;
    this.bytesSent = 0;
    this.googleBilledSeconds = null;
    this.finals = [];          // [{transcript, confidence}]
    this.interim = '';         // the current non-final hypothesis
    this.lastInterimText = null;
    this.eosSent = false;
    this.settled = false;
    this.finalTimer = null;
    setImmediate(() => this._connect());
  }

  async _connect() {
    if (this.readyState !== 0) return; // closed before connecting
    this.reservation = this.meter.reserve(GOOGLE_STREAM_RESERVATION_SECONDS);
    if (!this.reservation) {
      const reason = this.meter.refusal(GOOGLE_STREAM_RESERVATION_SECONDS) || 'monthly-limit';
      this._fail(new GoogleBudgetError(`Google speech is over its ${reason.replace('-', ' ')}`, reason), 'budget');
      return;
    }
    if (!this.slots.acquire()) {
      this._fail(new GoogleSttError('Too many concurrent Google speech streams', { code: 'GOOGLE_STT_BUSY' }), 'busy');
      return;
    }
    this.holdsSlot = true;
    let client;
    try {
      client = await this.client();
    } catch (err) {
      this._fail(err, classifyGoogleError(err).kind);
      return;
    }
    if (this.readyState !== 0) { this._release(); return; }
    let stream;
    try {
      stream = client.streamingRecognize(this.request);
    } catch (err) {
      this._fail(err, classifyGoogleError(err).kind);
      return;
    }
    this.stream = stream;
    stream.on('data', (response) => this._onResponse(response));
    stream.on('error', (err) => this._onStreamError(err));
    stream.on('end', () => this._settle('end'));
    this._emitOpen();
  }

  send(data) {
    if (this.readyState !== OPEN || this.eosSent || this.settled) return;
    if (typeof data === 'string') {
      const control = parseControl(data);
      // The configuration went out with the first request; `start` only marks
      // the beginning of the window for Parakeet. `eos` ends the audio.
      if (control?.type === 'eos') this._finishAudio();
      return;
    }
    const pcm = Buffer.from(data);
    if (!pcm.length) return;
    this.pending.push(pcm);
    this.pendingBytes += pcm.length;
    while (this.pendingBytes >= this.chunkBytes) this._writeAudio(this.chunkBytes);
  }

  _writeAudio(bytes) {
    const all = this.pending.length === 1 ? this.pending[0] : Buffer.concat(this.pending, this.pendingBytes);
    const size = Math.min(bytes, all.length);
    const chunk = all.subarray(0, size);
    const rest = all.subarray(size);
    this.pending = rest.length ? [rest] : [];
    this.pendingBytes = rest.length;
    try {
      this.stream.write({ audio: chunk });
      this.bytesSent += chunk.length;
    } catch (err) {
      this._onStreamError(err);
    }
  }

  _finishAudio() {
    this.eosSent = true;
    while (this.pendingBytes > 0 && !this.settled) this._writeAudio(Math.min(this.pendingBytes, this.chunkBytes));
    if (this.settled) return;
    try {
      this.stream.end();
    } catch (err) {
      this._onStreamError(err);
      return;
    }
    this.finalTimer = setTimeout(() => {
      this.finalTimer = null;
      this.log?.warn?.('[asr] Google final result timed out; using the best hypothesis so far');
      this._settle('timeout');
    }, this.finalTimeoutMs);
    this.finalTimer.unref?.();
  }

  _onResponse(response) {
    if (this.settled) return;
    const billed = billedSecondsOf(response);
    if (billed !== null) this.googleBilledSeconds = Math.max(this.googleBilledSeconds || 0, billed);
    const results = Array.isArray(response?.results) ? response.results : [];
    if (!results.length) return;
    const interimParts = [];
    for (const result of results) {
      const alternative = topAlternative(result);
      if (result.isFinal) this.finals.push(alternative);
      else interimParts.push(alternative.transcript);
    }
    this.interim = interimParts.join(' ');
    const text = this._text(true);
    if (text && text !== this.lastInterimText) {
      this.lastInterimText = text;
      // Google's interim confidence is the 0.0 "not set" sentinel.
      this._emitMessage({ type: 'interim', text, confidence: null });
    }
  }

  /** Finals so far (plus the live hypothesis when asked), in Parakeet format. */
  _text(withInterim) {
    const parts = this.finals.map((f) => f.transcript);
    if (withInterim && this.interim) parts.push(this.interim);
    return this.normalize(parts.join(' '));
  }

  _onStreamError(err) {
    if (this.settled) return;
    const { kind } = classifyGoogleError(err);
    // After end-of-audio the audio is already billed: a hypothesis in hand is
    // better than re-sending the window elsewhere.
    if (this.eosSent && (this.finals.length || this.interim)) {
      this.log?.warn?.('[asr] Google stream failed after end of audio; using the best hypothesis so far', { kind });
      this._settle('error');
      return;
    }
    this._fail(err, kind);
  }

  _settle(how) {
    if (this.settled) return;
    this.settled = true;
    if (this.finalTimer) { clearTimeout(this.finalTimer); this.finalTimer = null; }
    // A stream that ends without finals still had a hypothesis; the original
    // session returned its last good incremental in the same situation.
    const text = this.finals.length ? this._text(false) : this._text(true);
    const confidence = this.reportsConfidence && this.finals.length ? combineConfidence(this.finals) : null;
    if (how !== 'end') this._cancelStream();
    this._release();
    this._emitMessage({ type: 'final', text, confidence });
    setImmediate(() => this._emitClose());
  }

  _fail(err, kind) {
    if (this.settled) return;
    this.settled = true;
    if (this.finalTimer) { clearTimeout(this.finalTimer); this.finalTimer = null; }
    this._cancelStream();
    this._release();
    try { this.onFailure?.(kind, err); } catch { /* reporting must not break the turn */ }
    const error = err instanceof Error ? err : new Error(String(err));
    setImmediate(() => {
      this._emitError(error);
      this._emitClose();
    });
  }

  _cancelStream() {
    const stream = this.stream;
    if (!stream) return;
    stream.removeAllListeners?.('data');
    stream.on?.('error', () => { /* teardown races must not throw */ });
    try {
      if (typeof stream.cancel === 'function') stream.cancel();
      else stream.destroy?.();
    } catch { /* already gone */ }
  }

  _release() {
    if (this.holdsSlot) { this.holdsSlot = false; this.slots.release(); }
    if (this.reservation) {
      const reservation = this.reservation;
      this.reservation = null;
      const billed = Math.max(this.googleBilledSeconds || 0, this.bytesSent ? billedEstimate(this.bytesSent) : 0);
      this.meter.commit(reservation, billed);
    }
  }

  close() { this._closeByCaller(); }

  terminate() { this._closeByCaller(); }

  _closeByCaller() {
    if (this.readyState === CLOSED) return;
    if (!this.settled) {
      this.settled = true;
      if (this.finalTimer) { clearTimeout(this.finalTimer); this.finalTimer = null; }
      this._cancelStream();
      this._release();
    }
    this.readyState = 2; // CLOSING
    setImmediate(() => this._emitClose());
  }
}

/** A process-wide limit on concurrent Google streams (quota: 3,000 audio requests/min). */
export function streamSlots(max) {
  let active = 0;
  return {
    acquire() { if (active >= max) return false; active += 1; return true; },
    release() { active = Math.max(0, active - 1); },
    get active() { return active; },
  };
}

/**
 * The Google transport for one session.
 * @param {object} options
 * @param {{lang?:string, hints?:string[]}} options.config  the session's LISTEN config
 * @param {object} options.settings  {projectId, location, model, denoise, hintBoost, chunkMs, finalTimeoutMs, recognizeTimeoutMs}
 * @param {() => Promise<object>} options.client
 * @param {object} options.meter
 * @param {object} options.slots
 * @param {() => string|null} [options.unavailable]  a reason Google must not be used now
 * @param {(kind:string, err:Error)=>void} [options.onFailure]
 */
export function createGoogleTransport({
  config = {}, settings, client, meter, slots, unavailable = () => null, onFailure = null, log = null,
}) {
  const recognizer = googleRecognizerPath(settings.projectId, settings.location);
  const recognitionConfig = buildRecognitionConfig({
    model: settings.model,
    lang: config.lang,
    hints: config.hints,
    denoise: settings.denoise,
    hintBoost: settings.hintBoost,
  });
  const reportsConfidence = modelReportsConfidence(settings.model);
  const chunkBytes = (GOOGLE_BYTES_PER_SECOND * (settings.chunkMs || DEFAULT_CHUNK_MS)) / 1000;

  const transport = {
    name: 'google',
    /** Null when Google may take a request now, else why not. */
    unavailableReason(seconds = GOOGLE_STREAM_RESERVATION_SECONDS) {
      return unavailable() || meter.refusal(seconds);
    },
    available(seconds) {
      return transport.unavailableReason(seconds) === null;
    },
    async probeStreaming() {
      return transport.available();
    },
    openStream() {
      return new GoogleStreamSocket({
        client,
        request: buildStreamingRequest({ recognizer, config: recognitionConfig }),
        meter,
        slots,
        reportsConfidence,
        chunkBytes,
        finalTimeoutMs: settings.finalTimeoutMs || DEFAULT_FINAL_TIMEOUT_MS,
        log,
        onFailure,
      });
    },
    /** Synchronous Recognize of a whole window (the batch path). */
    async recognizeWav(wav) {
      const pcm = pcmFromWav(wav);
      const seconds = Math.ceil(pcm.length / GOOGLE_BYTES_PER_SECOND);
      if (seconds > GOOGLE_MAX_SYNC_SECONDS) {
        throw new GoogleSttError('Audio is longer than Google synchronous recognition accepts', { code: 'GOOGLE_STT_TOO_LONG' });
      }
      const reason = unavailable();
      if (reason) throw new GoogleSttError(`Google speech is unavailable: ${reason}`, { code: 'GOOGLE_STT_UNAVAILABLE' });
      const reservation = meter.reserve(seconds);
      if (!reservation) {
        const refusal = meter.refusal(seconds) || 'monthly-limit';
        throw new GoogleBudgetError(`Google speech is over its ${refusal.replace('-', ' ')}`, refusal);
      }
      let response;
      try {
        const speech = await client();
        response = await speech.recognize(
          buildRecognizeRequest({ recognizer, config: recognitionConfig, content: pcm }),
          { timeoutMs: settings.recognizeTimeoutMs || DEFAULT_RECOGNIZE_TIMEOUT_MS },
        );
      } catch (err) {
        // Conservative: count the audio even though a server error is not billed.
        meter.commit(reservation, seconds);
        try { onFailure?.(classifyGoogleError(err).kind, err); } catch { /* reporting only */ }
        throw err;
      }
      meter.commit(reservation, Math.max(billedSecondsOf(response) || 0, seconds));
      const segments = (Array.isArray(response?.results) ? response.results : []).map(topAlternative);
      return {
        text: normalizeGoogleTranscript(segments.map((s) => s.transcript).join(' ')),
        confidence: reportsConfidence ? combineConfidence(segments) : null,
      };
    },
    describe() {
      return { provider: 'google', model: settings.model };
    },
  };
  return transport;
}

/** The session always posts its own canonical 44-byte-header WAV. */
export function pcmFromWav(wav) {
  const buffer = Buffer.from(wav);
  if (buffer.length >= 44 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 36, 40) === 'data') {
    return buffer.subarray(44, 44 + buffer.readUInt32LE(40));
  }
  return buffer;
}
