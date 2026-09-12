// Parakeet ASR session — faithful port of hub/src/asr/parakeet/ParakeetASRSession.ts.
//
// Batch recognizer behind a REST API: declared LINEAR16, OGG_OPUS, or FLAC chunks
// stream in (provideAudio), encoded formats are decoded to 16 kHz 16-bit mono PCM,
// an energy VAD detects start/end of speech, and on EOS the whole PCM buffer is
// wrapped in a WAV header and POSTed multipart to `${parakeetUrl}/transcribe`.
// Reference constants and state machine preserved exactly:
//   RMS > 400 counts as speech; SOS after ≥150 ms cumulative speech; EOS after
//   700 ms continuous trailing silence (or 30 s total buffer); states
//   WAITING → SPEAKING → TRAILING_SILENCE → FINALIZING → DONE.
// stop() before SOS resolves start() with undefined; after SOS it fires EOS (if
// needed) and finalizes. Response JSON `{transcript}` may be a plain string or a
// NeMo Hypothesis object {text, ...} — unwrapped to a string.
//
// Phoenix fix (robot-observed): a silence endpoint that recognizes NO words must
// not end the turn. The robot streams audio into the turn from the moment its
// wake-phrase spotter fires, so the first energy run is the tail of the wake
// phrase and the speaker's natural pause after it satisfies the 700 ms
// trailing-silence endpoint. Finalizing there posts ~1 s of wake-phrase tail
// (transcript '' or a fragment), the hub routes a no-match LISTEN result, the
// turn ends, and the user's actual request — arriving after the pause — is
// streamed into an already-ended response and discarded. The reference's
// incremental seam could not see this because it reports whatever it has at
// every endpoint; a batch recognizer reports exactly nothing there. So an empty
// silence endpoint keeps listening (bounded) and only a recognized utterance —
// or the caller's budget — ends the ASR phase.

import http from 'node:http';
import { FastEOS } from './fastEOS.js';
import {
  AUDIO_ENCODINGS,
  AudioDecodeError,
  AudioFormatError,
  StreamingAudioDecoder,
  normalizeAudioConfig,
} from './audioDecoder.js';

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;
const BYTES_PER_SEC = SAMPLE_RATE * BYTES_PER_SAMPLE;
const VAD_WINDOW_MS = 10;
const VAD_WINDOW_BYTES = (BYTES_PER_SEC * VAD_WINDOW_MS) / 1000;

const SPEECH_RMS_THRESHOLD = 400;
const SPEECH_MIN_MS = 150;
const SILENCE_TO_EOS_MS = 700;
const MAX_BUFFER_MS = 30000;
const MAX_BUFFER_BYTES = (BYTES_PER_SEC * MAX_BUFFER_MS) / 1000;

const POST_TIMEOUT_MS = 30000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_RESPONSE_DIAGNOSTIC_BYTES = 1024;
const UTF8_ELLIPSIS = '…';
const UTF8_ELLIPSIS_BYTES = Buffer.byteLength(UTF8_ELLIPSIS, 'utf8');

export const PARAKEET_RESPONSE_LIMITS = Object.freeze({
  maxBytes: MAX_RESPONSE_BYTES,
  maxDiagnosticBytes: MAX_RESPONSE_DIAGNOSTIC_BYTES,
});

/**
 * Return a diagnostic prefix whose UTF-8 encoding is no larger than maxBytes.
 * Decode Buffer input before measuring so malformed response bytes become the
 * same bounded replacement characters Node would expose in an Error message.
 * The cut is made on the encoded representation, never in the middle of a
 * multibyte code point.
 */
export function truncateUtf8ByBytes(value, maxBytes) {
  const limit = Math.max(0, Math.floor(Number(maxBytes)) || 0);
  if (limit === 0) return '';
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '');
  const encoded = Buffer.from(text, 'utf8');
  if (encoded.length <= limit) return text;

  let end = limit;
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1;
  return encoded.subarray(0, end).toString('utf8');
}

// A silence endpoint that recognizes no words is treated as a false endpoint
// (see the header note): keep listening instead of ending the turn. Bounded so a
// quiet stream cannot hold a turn open with recognition after recognition.
const EMPTY_ENDPOINT_RELISTEN_LIMIT = 3;

// A wake-phrase tail is a short energy burst (the deterministic fixture is 200 ms
// of the "-bo" in "Hey Jibo"). On a hotphrase turn the turn's audio always opens
// with it, so only that conservative, verified tail window is suppressed at its
// first endpoint. Longer bursts are submitted intact: VAD cannot otherwise
// distinguish a wake tail followed continuously by a short command from the
// command itself. A longer tail-only candidate follows the normal empty-result
// relisten path. Local (non-hotphrase) turns have no wake tail.
const WAKE_TAIL_MAX_SPEECH_MS = 200;
const WAKE_TAIL_IGNORE_LIMIT = 1;

const bytesToMs = (bytes) => (bytes / BYTES_PER_SEC) * 1000;

export class ParakeetASRSession {
  /** @param {string} parakeetUrl @param {{lang:string, hints?:string[], earlyEOS?:string[], encoding?:string, sampleRate?:number}} config @param {object} log */
  constructor(parakeetUrl, config, log) {
    this.parakeetUrl = parakeetUrl;
    this.config = config || {};
    this.log = log || console;
    this.audio = normalizeAudioConfig(this.config);

    this.chunks = [];
    this.pendingEncodedChunks = [];
    this.pendingEncodedBytes = 0;
    this.totalBytes = 0;
    this.speechBytes = 0;
    this.silenceBytes = 0;
    this.state = 'WAITING';

    // A silence endpoint is only a recognition candidate: the recognizer may
    // answer empty while the robot is already sending the real request. Keep
    // decoded PCM that arrives after the candidate boundary until that answer
    // decides whether the turn is actually over. This queue is also where the
    // tail of a single caller buffer lands when VAD finds EOS mid-buffer.
    this.deferredPcm = Buffer.alloc(0);
    this.candidate = null;
    this.activeRequests = new Set();
    this.activeResponses = new Set();

    this.sosFired = false;
    this.eosFired = false;
    this.eosEmitted = false;
    this.stopped = false;
    this.aborted = false;
    this.relistenCount = 0;
    this.wakeTailIgnored = 0;

    this.sosHandler = null;
    this.eosHandler = null;
    this.resultHandler = null;

    this.resolveStart = null;
    this.rejectStart = null;
    this.startSettled = false;
    this.lastResult = null;
    this.startPromise = null;
    this.started = false;
    this.decoder = null;
    this.decoderError = null;
    this.pcmPending = Buffer.alloc(0);
    this.pcmCarry = null;
    this.finalizeReason = null;

    // Parakeet is a batch recognizer, so earlyEOS cannot interrupt an interim
    // stream. The reference still builds the regex here and (per its comment)
    // applies it post-hoc in finalize() so the client-visible FAST_EOS
    // annotation is not silently dropped by the batch replacement.
    this.fastEOSRegex = null;
    if (this.config.earlyEOS && this.config.earlyEOS.length > 0) {
      this.fastEOSRegex = FastEOS.buildRegex(this.config.earlyEOS);
    }
  }

  onStartOfSpeech(handler) { this.sosHandler = handler; }
  onEndOfSpeech(handler) { this.eosHandler = handler; }
  onResult(handler) { this.resultHandler = handler; }

  /** Last transcript — null until finalize() completes (Parakeet is batch). */
  getLastIncremental() { return this.lastResult; }

  provideAudio(audioBuffer) {
    if (this.stopped || this.state === 'DONE') return;
    if (!Buffer.isBuffer(audioBuffer)) throw new AudioFormatError('ASR audio frames must be Buffers');
    if (audioBuffer.length === 0) return;
    if (this.audio.encoding !== AUDIO_ENCODINGS.LINEAR16) {
      if (this.started) {
        if (!this.decoder) {
          this._handleAudioError(new AudioDecodeError('Encoded audio arrived after the decoder was closed'));
          return;
        }
        try {
          // Keep the encoded stream alive while a silence candidate is being
          // recognized. Its PCM callback queues post-boundary audio below.
          this.decoder.write(audioBuffer);
        } catch (err) {
          this._handleAudioError(err);
        }
      } else {
        this._queueEncodedBeforeStart(audioBuffer);
      }
      return;
    }
    this._consumePcm(audioBuffer);
  }

  _queueEncodedBeforeStart(audioBuffer) {
    const maxPending = 2 * 1024 * 1024;
    if (this.pendingEncodedBytes + audioBuffer.length > maxPending) {
      this._handleAudioError(new AudioDecodeError(`Audio decoder input queue exceeded ${maxPending} bytes`));
      return;
    }
    this.pendingEncodedChunks.push(audioBuffer);
    this.pendingEncodedBytes += audioBuffer.length;
  }

  _queueDeferredPcm(pcm) {
    if (!pcm || pcm.length === 0) return;
    if (this.deferredPcm.length + pcm.length > MAX_BUFFER_BYTES) {
      this._handleAudioError(new AudioDecodeError(`Deferred ASR audio exceeded ${MAX_BUFFER_BYTES} bytes`));
      return;
    }
    this.deferredPcm = this.deferredPcm.length === 0
      ? Buffer.from(pcm)
      : Buffer.concat([this.deferredPcm, pcm]);
  }

  _consumePcm(audioBuffer) {
    // A silence candidate is still live: preserve audio that arrives after its
    // boundary until its response says whether relisten is needed. Caller stop
    // and max-buffer are terminal boundaries and intentionally drop later PCM.
    if (this.state === 'FINALIZING') {
      if (this.finalizeReason === 'silence' && this.candidate) this._queueDeferredPcm(audioBuffer);
      else if (this.finalizeReason === 'stop') this._appendEndOfInputPcm(audioBuffer);
      return;
    }
    if (this.state === 'DONE' || audioBuffer.length === 0) return;

    this.pcmPending = this.pcmPending.length === 0
      ? Buffer.from(audioBuffer)
      : Buffer.concat([this.pcmPending, audioBuffer]);
    while (this.pcmPending.length >= VAD_WINDOW_BYTES
      && this.state !== 'FINALIZING' && this.state !== 'DONE') {
      const window = this.pcmPending.subarray(0, VAD_WINDOW_BYTES);
      this.pcmPending = this.pcmPending.subarray(VAD_WINDOW_BYTES);
      this._appendAcceptedPcm(window);
      this._consumeVadWindow(window);
    }

    // An endpoint can be found in the middle of one caller buffer. Do not throw
    // away the unprocessed tail; it belongs to the next listening window.
    if (this.state === 'FINALIZING' && this.finalizeReason === 'silence') {
      this._queueDeferredPcm(this.pcmPending);
      this.pcmPending = Buffer.alloc(0);
    } else if (this.state === 'FINALIZING' && this.finalizeReason === 'stop') {
      // An SOS callback may synchronously call stop(). Preserve the partial
      // window already accepted by that caller stop before finalization runs.
      this._appendEndOfInputPcm();
    }
  }

  _appendAcceptedPcm(pcm) {
    if (!pcm || pcm.length === 0) return;
    this.chunks.push(pcm);
    this.totalBytes += pcm.length;
    this.pcmCarry = this.totalBytes % BYTES_PER_SAMPLE === 0
      ? null
      : pcm.subarray(pcm.length - 1);
  }

  _appendEndOfInputPcm(audioBuffer = Buffer.alloc(0)) {
    const pending = this.pcmPending;
    this.pcmPending = Buffer.alloc(0);
    const pcm = pending.length === 0
      ? audioBuffer
      : audioBuffer.length === 0
        ? pending
        : Buffer.concat([pending, audioBuffer]);
    if (pcm.length === 0) return;
    const remaining = Math.max(0, MAX_BUFFER_BYTES - this.totalBytes);
    this._appendAcceptedPcm(pcm.subarray(0, remaining));
  }

  _consumeVadWindow(window) {
    const rms = ParakeetASRSession.computeRMS(window);
    if (rms > SPEECH_RMS_THRESHOLD) {
      this.speechBytes += window.length;
      this.silenceBytes = 0;
      if (!this.sosFired && bytesToMs(this.speechBytes) >= SPEECH_MIN_MS) {
        this.sosFired = true;
        if (this.sosHandler) this.sosHandler(null);
      }
      if (this.sosFired && this.state !== 'FINALIZING') this.state = 'SPEAKING';
    } else {
      this.silenceBytes += window.length;
      if (this.state === 'SPEAKING') this.state = 'TRAILING_SILENCE';
      if (this.state === 'TRAILING_SILENCE' && bytesToMs(this.silenceBytes) >= SILENCE_TO_EOS_MS) {
        const speechMs = bytesToMs(this.speechBytes);
        if (this._isWakeTailBurst()) {
          // Discard only the initial wake tail and start a fresh VAD window.
          // Resetting speechBytes is important: otherwise a short real request
          // is added to the tail and can be misclassified as another tail.
          this.wakeTailIgnored += 1;
          this.chunks = [];
          this.totalBytes = 0;
          this.speechBytes = 0;
          this.silenceBytes = 0;
          this.pcmCarry = null;
          this.eosFired = false;
          this.state = 'WAITING';
          this.log.debug?.('[asr] short burst after the wake phrase: not an endpoint, continuing to listen', {
            speechMs: Math.round(speechMs),
            ignored: this.wakeTailIgnored,
          });
          return;
        }
        this._fireEOSAndFinalize('silence');
        return;
      }
    }

    if (this.totalBytes >= MAX_BUFFER_BYTES) this._fireEOSAndFinalize('max-buffer');
  }

  start() {
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise((resolve, reject) => {
      this.resolveStart = resolve;
      this.rejectStart = reject;
    });
    if (this.stopped || this.state === 'DONE') {
      if (this.decoderError) this._rejectStart(this.decoderError);
      else this._resolveStart(undefined, { close: false });
      return this.startPromise;
    }
    this.started = true;
    if (this.decoderError) {
      this._rejectStart(this.decoderError);
      return this.startPromise;
    }
    if (this.audio.encoding !== AUDIO_ENCODINGS.LINEAR16) {
      try {
        this.decoder = new StreamingAudioDecoder({
          encoding: this.audio.encoding,
          sampleRate: this.audio.sampleRate,
          ffmpegPath: this.config.ffmpegPath,
          onPcm: (pcm) => this._consumePcm(pcm),
          onError: (err) => this._handleAudioError(err),
          log: this.log,
        });
        this.decoder.start();
        for (const chunk of this.pendingEncodedChunks) {
          if (this.decoderError || !this.decoder) break;
          this.decoder.write(chunk);
        }
        this.pendingEncodedChunks = [];
        this.pendingEncodedBytes = 0;
      } catch (err) {
        this._handleAudioError(err);
      }
    }
    return this.startPromise;
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    // A silence candidate is already being recognized. Stop means no more input,
    // not "discard the candidate"; its response still determines the result.
    if (this.state === 'FINALIZING') return;
    if (this.state !== 'DONE') {
      if (this.sosFired) {
        if (!this.eosFired) {
          this.eosFired = true;
          this._emitEOS();
        }
        this.state = 'FINALIZING';
        this.finalizeReason = 'stop';
        this._finalize({ mode: 'end-of-input' }).catch((err) => {
          this.log.error?.('Parakeet finalize on stop failed: ' + err.message);
          if (this.aborted) return;
          this.state = 'DONE';
          this._rejectStart(err);
        });
      } else {
        this.state = 'DONE';
        this._closeDecoder();
        this._resolveStart(undefined);
      }
    }
  }

  /**
   * Caller no longer needs a result (peer gone / phase superseded): end the
   * session, drop the buffered audio and recognize nothing. Without this the
   * cooperative stop() path still posts a full WAV for a response that can no
   * longer be delivered.
   */
  abort() {
    if (this.aborted) return;
    this.aborted = true;
    this.stopped = true;
    this.state = 'DONE';
    this.candidate = null;
    this.chunks = [];
    this.deferredPcm = Buffer.alloc(0);
    this.totalBytes = 0;
    this.pcmPending = Buffer.alloc(0);
    this.pcmCarry = null;
    this._abortRequests();
    this._closeDecoder();
    this._resolveStart(undefined, { close: false });
  }

  _resolveStart(value, { close = true } = {}) {
    if (this.startSettled || !this.resolveStart) return;
    this.startSettled = true;
    const resolve = this.resolveStart;
    this.resolveStart = null;
    this.rejectStart = null;
    if (close && !this.stopped) {
      this.stopped = true;
      this._closeDecoder();
    }
    resolve(value);
  }

  _rejectStart(error) {
    if (this.startSettled || !this.rejectStart) return;
    this.startSettled = true;
    const reject = this.rejectStart;
    this.resolveStart = null;
    this.rejectStart = null;
    reject(error);
  }

  _abortRequests() {
    const error = new Error('Parakeet request aborted');
    for (const response of this.activeResponses) {
      try { response.destroy(error); } catch { /* already closed */ }
    }
    for (const request of this.activeRequests) {
      try { request.destroy(error); } catch { /* already closed */ }
    }
    this.activeResponses.clear();
    this.activeRequests.clear();
  }

  /** Emit the wire EOS at most once, even across empty-endpoint re-listens. */
  _emitEOS() {
    if (this.eosEmitted) return;
    this.eosEmitted = true;
    if (this.eosHandler) this.eosHandler(null);
  }

  _fireEOSAndFinalize(reason) {
    if (this.eosFired) return;
    this.eosFired = true;

    if (reason === 'silence') {
      // This is a candidate, not yet a wire endpoint. Snapshot only the audio
      // that led to this boundary, then keep the decoder and queue all later PCM
      // while Parakeet decides whether the candidate contains words.
      const candidatePcm = Buffer.concat(this.chunks);
      const pending = this.pcmPending;
      this.chunks = [];
      this.totalBytes = 0;
      this.speechBytes = 0;
      this.silenceBytes = 0;
      this.pcmCarry = null;
      this.pcmPending = Buffer.alloc(0);
      this._queueDeferredPcm(pending);
      this.state = 'FINALIZING';
      this.finalizeReason = 'silence';
      const candidate = { pcm: candidatePcm };
      this.candidate = candidate;
      this.log.debug?.(`EOS candidate detected (${reason}), recognizing ${candidatePcm.length} bytes`);
      this._postToParakeet(ParakeetASRSession.makeWav(candidatePcm)).then(
        (transcript) => this._completeCandidate(candidate, transcript),
        (err) => this._failCandidate(candidate, err),
      );
      return;
    }

    this.state = 'FINALIZING';
    this.finalizeReason = reason;
    this.pcmPending = Buffer.alloc(0);
    this.log.debug?.(`EOS detected (${reason}), finalizing with ${this.chunks.length} chunks`);
    this._emitEOS();
    this._finalize({ mode: 'cancel' }).catch((err) => {
      this.log.error?.('Parakeet finalize failed: ' + err.message);
      if (this.aborted) return;
      this.state = 'DONE';
      this._rejectStart(err);
    });
  }

  _completeCandidate(candidate, transcript) {
    if (!candidate || this.candidate !== candidate || this.aborted) return;
    if (!transcript && this._shouldRelisten()) {
      this.candidate = null;
      this._resetForRelisten();
      this._drainDeferredPcm();
      return;
    }
    const annotation = transcript && this.fastEOSRegex && this.fastEOSRegex.test(transcript)
      ? 'FAST_EOS'
      : undefined;
    this.candidate = null;
    this._completeResult(transcript || '', annotation, { emitEOS: true });
  }

  _failCandidate(candidate, err) {
    if (!candidate || this.candidate !== candidate || this.aborted) return;
    this.candidate = null;
    this.log.error?.('Parakeet candidate failed: ' + err.message);
    this.state = 'DONE';
    this._closeDecoder();
    this._rejectStart(err);
  }

  _drainDeferredPcm() {
    if (this.deferredPcm.length === 0 || this.stopped || this.aborted || this.state === 'DONE') return;
    const pcm = this.deferredPcm;
    this.deferredPcm = Buffer.alloc(0);
    this._consumePcm(pcm);
  }

  _completeResult(transcript, annotation, { emitEOS = false } = {}) {
    if (this.aborted || this.state === 'DONE') return;
    const result = { text: transcript || '', confidence: transcript ? 1.0 : 0.0 };
    if (annotation) result.annotation = annotation;
    this.lastResult = result;
    // Silence candidates defer EOS until the recognizer accepts one. Stop and
    // max-buffer paths already emitted it, so this is idempotent.
    if (emitEOS) this._emitEOS();
    if (this.resultHandler) this.resultHandler(result);
    this.state = 'DONE';
    this._closeDecoder();
    this._resolveStart(result);
  }

  /**
   * Recognize the audio buffered so far, on demand. A batch recognizer can answer
   * a max-speech timeout with the words it actually holds, which the reference's
   * incremental `getLastIncremental()` seam cannot. Resolves the transcript text
   * ('' when the buffer holds no words) or undefined when there is nothing to
   * recognize.
   */
  async finalizeNow() {
    if (this.aborted || this.stopped || this.state === 'FINALIZING' || this.state === 'DONE') return undefined;
    this.state = 'FINALIZING';
    this.finalizeReason = 'max-speech';
    this.pcmPending = Buffer.alloc(0);
    await this._finalize({ mode: 'cancel' });
    // The reference reports MAX_SPEECH_TIMEOUT when its incremental seam supplies
    // the words at this point; the batch result this session resolves with carries
    // the same annotation so the robot sees the same turn shape.
    if (this.lastResult && !this.lastResult.annotation) this.lastResult.annotation = 'MAX_SPEECH_TIMEOUT';
    return this.lastResult ? this.lastResult.text : undefined;
  }

  /**
   * An endpoint that produced no transcript on a silence boundary did not hear an
   * utterance: keep the session open for the real one (bounded, and never for a
   * caller stop or a max-buffer cut).
   */
  _shouldRelisten() {
    return !this.stopped
      && !this.aborted
      && this.finalizeReason === 'silence'
      && this.relistenCount < EMPTY_ENDPOINT_RELISTEN_LIMIT;
  }

  /**
   * True when the endpoint in flight only followed the wake phrase's own tail: a
   * hotphrase turn's audio always opens with it (the robot starts streaming as
   * soon as its spotter fires), and it is far shorter than any utterance.
   */
  _isWakeTailBurst() {
    return this.config.hotphrase === true
      && !this.eosFired
      && this.wakeTailIgnored < WAKE_TAIL_IGNORE_LIMIT
      && bytesToMs(this.speechBytes) <= WAKE_TAIL_MAX_SPEECH_MS;
  }

  /** Restart the recognition window after an empty endpoint, keeping SOS state. */
  _resetForRelisten() {
    this.relistenCount += 1;
    this.chunks = [];
    this.totalBytes = 0;
    this.speechBytes = 0;
    this.silenceBytes = 0;
    this.pcmPending = Buffer.alloc(0);
    this.pcmCarry = null;
    this.eosFired = false;      // the next endpoint ends this window (wire EOS stays single)
    this.state = 'WAITING';
    this.finalizeReason = null;
    this.log.debug?.('[asr] empty silence endpoint: no words recognized, continuing to listen', {
      relisten: this.relistenCount,
    });
  }

  async _finalize({ mode = 'cancel' } = {}) {
    // A caller stop is the encoded stream's end-of-input: retain complete
    // frames already accepted by the session, and let the decoder discard an
    // incomplete container tail. VAD/max-buffer EOS is a cancellation point;
    // audio after the detected EOS must not be appended while the POST starts.
    if (mode === 'end-of-input' && this.decoder) {
      const decoder = this.decoder;
      try {
        // An explicit stop is end-of-input for the bytes already accepted by
        // the session. Let complete decoder frames drain so accepted speech
        // reaches the WAV; an incomplete final container frame is discarded.
        await decoder.finish({ allowTruncated: true });
      } finally {
        if (this.decoder === decoder) this._closeDecoder();
      }
    } else {
      this._closeDecoder();
    }
    if (mode === 'end-of-input') this._appendEndOfInputPcm();
    else this.pcmPending = Buffer.alloc(0);
    if (this.decoderError) throw this.decoderError;
    if (this.pcmCarry) throw new AudioFormatError('ASR PCM ended on an odd byte boundary');
    const pcm = Buffer.concat(this.chunks);
    if (pcm.length === 0) {
      const emptyResult = { text: '', confidence: 0 };
      if (this.finalizeReason === 'max-speech') emptyResult.annotation = 'MAX_SPEECH_TIMEOUT';
      this.lastResult = emptyResult;
      this.state = 'DONE';
      this._resolveStart(emptyResult);
      return emptyResult;
    }
    const wav = ParakeetASRSession.makeWav(pcm);
    const transcript = await this._postToParakeet(wav);
    if (this.aborted) return;
    // Post-hoc earlyEOS: annotate the final transcript when it matches the
    // cleaned earlyEOS phrases (the reference's stated batch behavior).
    const annotation = this.finalizeReason === 'max-speech'
      ? 'MAX_SPEECH_TIMEOUT'
      : (transcript && this.fastEOSRegex && this.fastEOSRegex.test(transcript) ? 'FAST_EOS' : undefined);
    this._completeResult(transcript || '', annotation);
  }

  _handleAudioError(err) {
    if (this.decoderError || this.state === 'DONE') return;
    this.decoderError = err instanceof AudioFormatError
      ? err
      : new AudioDecodeError(err?.message || String(err), err);
    this.stopped = true;
    this.state = 'DONE';
    this.candidate = null;
    this.deferredPcm = Buffer.alloc(0);
    this._abortRequests();
    this._closeDecoder();
    this._rejectStart(this.decoderError);
  }

  _closeDecoder() {
    this.pendingEncodedChunks = [];
    this.pendingEncodedBytes = 0;
    if (this.decoder) {
      this.decoder.abort();
      this.decoder = null;
    }
  }

  static computeRMS(buf) {
    const numSamples = Math.floor(buf.length / 2);
    if (numSamples === 0) return 0;
    let sumSq = 0;
    for (let i = 0; i + 1 < buf.length; i += 2) {
      const sample = buf.readInt16LE(i);
      sumSq += sample * sample;
    }
    return Math.sqrt(sumSq / numSamples);
  }

  static makeWav(pcm) {
    const dataSize = pcm.length;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);              // format = PCM
    header.writeUInt16LE(1, 22);              // mono
    header.writeUInt32LE(SAMPLE_RATE, 24);
    header.writeUInt32LE(BYTES_PER_SEC, 28);  // byte rate
    header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
    header.writeUInt16LE(16, 34);             // bits per sample
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);
    return Buffer.concat([header, pcm]);
  }

  _postToParakeet(wav) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let req = null;
      let res = null;
      const cleanup = () => {
        if (req) this.activeRequests.delete(req);
        if (res) this.activeResponses.delete(res);
      };
      const settle = (handler, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        handler(value);
      };
      const fail = (err) => settle(reject, err);

      try {
        const parsed = new URL(this.parakeetUrl);
        const boundary = '----jiboparakeet' + Date.now() + Math.floor(Math.random() * 1e9).toString(16);
        const head = Buffer.from(
          `--${boundary}\r\n`
          + 'Content-Disposition: form-data; name="file"; filename="audio.wav"\r\n'
          + 'Content-Type: audio/wav\r\n\r\n');
        const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
        const body = Buffer.concat([head, wav, tail]);

        req = http.request({
          method: 'POST',
          host: parsed.hostname,
          port: parsed.port ? parseInt(parsed.port, 10) : 80,
          path: '/transcribe',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': body.length,
          },
        }, (response) => {
          res = response;
          this.activeResponses.add(res);
          const bufs = [];
          let responseBytes = 0;
          let responseEnded = false;
          const rejectOversized = (declaredBytes) => {
            const detail = Number.isSafeInteger(declaredBytes) ? ` (declared ${declaredBytes} bytes)` : '';
            const error = new Error(`Parakeet response exceeded ${MAX_RESPONSE_BYTES} bytes${detail}`);
            error.code = 'ERR_PARAKEET_RESPONSE_TOO_LARGE';
            // Stop both directions. In particular, destroying only the response
            // leaves the request/socket alive until the peer times out.
            fail(error);
            try { req?.destroy(error); } catch { /* already closed */ }
            try { res?.destroy(error); } catch { /* already closed */ }
          };
          res.on('data', (chunk) => {
            responseBytes += chunk.length;
            if (responseBytes > MAX_RESPONSE_BYTES) {
              rejectOversized(responseBytes);
              return;
            }
            bufs.push(chunk);
          });
          res.on('error', fail);
          res.on('aborted', () => fail(new Error('Parakeet response was aborted')));
          res.on('close', () => {
            if (!responseEnded && !settled) fail(new Error('Parakeet response closed before completion'));
          });
          res.on('end', () => {
            responseEnded = true;
            const text = Buffer.concat(bufs).toString('utf8');
            if (res.statusCode !== 200) {
              const textBytes = Buffer.byteLength(text, 'utf8');
              const truncated = textBytes > MAX_RESPONSE_DIAGNOSTIC_BYTES;
              const diagnostic = truncateUtf8ByBytes(
                text,
                truncated ? MAX_RESPONSE_DIAGNOSTIC_BYTES - UTF8_ELLIPSIS_BYTES : MAX_RESPONSE_DIAGNOSTIC_BYTES,
              );
              const suffix = truncated ? UTF8_ELLIPSIS : '';
              fail(new Error(`Parakeet returned ${res.statusCode}: ${diagnostic}${suffix}`));
              return;
            }
            try {
              const json = JSON.parse(text);
              let transcript = json.transcript;
              if (transcript && typeof transcript === 'object') transcript = transcript.text;
              if (typeof transcript !== 'string') transcript = '';
              settle(resolve, transcript);
            } catch (error) {
              fail(new Error('Could not parse Parakeet response: ' + error));
            }
          });
          const declaredLength = Number(response.headers['content-length']);
          if (Number.isSafeInteger(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
            rejectOversized(declaredLength);
          }
        });
        this.activeRequests.add(req);
        req.setTimeout(POST_TIMEOUT_MS, () => { req.destroy(new Error('Parakeet request timed out')); });
        req.on('error', fail);
        req.write(body);
        req.end();
      } catch (error) {
        // A synchronous write/setup failure can otherwise leave the request
        // socket alive even though the promise has rejected.
        try { if (req) req.destroy(error); } catch { /* already closed */ }
        try { if (res) res.destroy(error); } catch { /* already closed */ }
        fail(error);
      }
    });
  }
}
