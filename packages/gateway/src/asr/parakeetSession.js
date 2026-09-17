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
//
// Streaming upgrade (DIVERGENCES H07b): a streaming-capable server (API >= 0.2.0)
// advertises `GET /healthz` and offers `WS /stream`. When it does, accepted PCM
// is fed to the socket as it arrives and each `interim` transcript updates the
// same incremental result seam (`lastResult` / `getLastIncremental()` / onResult)
// that the Google session uses, so `fastEOSRegex` can match an interim and
// `_fireEOSAndFinalize` truncates the utterance at the trigger word instead of
// waiting for a whole-utterance batch hypothesis. On `eos` the server answers
// with a `final` transcript/confidence. A server without the streaming endpoint
// (no `/healthz`, API 0.1.0), or one whose socket fails mid-session, falls back
// to the unchanged `/transcribe` batch path.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { WebSocket } from 'ws';
import { FastEOS } from './fastEOS.js';
import {
  AUDIO_ENCODINGS,
  openCapture,
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
// How much trailing silence ends the turn. The reference never endpointed here
// (Google's recognizer reported END_OF_SINGLE_UTTERANCE itself), so this is a
// Phoenix choice, and it is the dominant cost in the pause a person feels after
// they stop talking. An encoded robot pays it twice: OGG_OPUS arrives in ~500 ms
// pages, so the silence is not even visible until the page that carries it lands.
const SILENCE_TO_EOS_MS = Number(process.env.PHOENIX_ASR_SILENCE_EOS_MS || 400);

// Exported so tests derive the window instead of restating it: a test that
// asserts a literal keeps passing when the constant changes, and then pins the
// wrong behaviour. This is the value the endpointer actually uses.
export const ASR_SILENCE_TO_EOS_MS = SILENCE_TO_EOS_MS;

// Adaptive endpointing.
//
// The reference cloud never endpointed locally: Google's recognizer reported
// END_OF_SINGLE_UTTERANCE itself (GoogleASRSession.ts:106).  Parakeet is a batch
// recognizer, so this session has to decide end-of-speech on its own, and a bare
// `rms > 400` gate is wrong in any room whose noise floor approaches 400 -- a
// single 10 ms window above the line resets the whole silence run, so the 700 ms
// EOS is never reached and the robot streams until its own max-speech cap.
// Measured on a real robot: floor p25 260-280, median 310-340, and turns of 12,
// 16 and 19.45 s for a two-second question.
//
// Two corrections, both no-ops on clean audio (a floor near zero keeps the
// effective threshold at exactly SPEECH_RMS_THRESHOLD):
//   * track the room's noise floor and lift the speech gate above it;
//   * require a sustained burst to re-open speech, so one noisy window no longer
//     discards an otherwise-quiet run.
const NOISE_FLOOR_MARGIN = Number(process.env.PHOENIX_ASR_NOISE_MARGIN || 1.8);
const NOISE_FLOOR_ATTACK = 0.05;   // EMA weight while the floor is rising
const NOISE_FLOOR_DECAY = 0.25;    // faster when it drops, so a quiet room recovers
const SPEECH_DEBOUNCE_MS = 30;     // consecutive ms over the gate before speech resumes
const MAX_BUFFER_MS = 30000;
const MAX_BUFFER_BYTES = (BYTES_PER_SEC * MAX_BUFFER_MS) / 1000;

const POST_TIMEOUT_MS = 30000;

// Streaming transport: `/healthz` is the capability probe (present only on API
// >= 0.2.0), `/stream` the WebSocket recognizer. Bounded like the batch path so a
// wedged socket cannot hold a turn open, and a mid-flight failure falls back to
// batch rather than dropping the turn.
const STREAMING_API_VERSION = '0.2.0';
const HEALTH_TIMEOUT_MS = 3000;
const STREAM_FINAL_TIMEOUT_MS = 30000;
const STREAM_PENDING_MAX_BYTES = 2 * 1024 * 1024;

/** True when `version` (e.g. "0.2.0") is at least `minimum` (e.g. "0.2.0"). */
function apiVersionAtLeast(version, minimum) {
  const parse = (value) => String(value).split('.').map((part) => parseInt(part, 10) || 0);
  const actual = parse(version);
  const required = parse(minimum);
  for (let i = 0; i < Math.max(actual.length, required.length); i += 1) {
    const a = actual[i] || 0;
    const b = required[i] || 0;
    if (a !== b) return a > b;
  }
  return true;
}

// A silence endpoint that recognizes no words is treated as a false endpoint
// (see the header note): keep listening instead of ending the turn. Bounded so a
// quiet stream cannot hold a turn open with recognition after recognition.
const EMPTY_ENDPOINT_RELISTEN_LIMIT = 3;

// A wake-phrase tail is a short energy burst (observed 150-300 ms of the "-bo" in
// "Hey Jibo"). On a hotphrase turn the turn's audio always opens with it, so an
// endpoint that follows a run shorter than this cannot be an utterance: keep
// listening. Local (non-hotphrase) turns have no wake tail, so short answers such
// as "no" are unaffected. Cumulative speech still ends the turn, so several short
// bursts converge on a real endpoint.
const MIN_ENDPOINT_SPEECH_MS = 400;
const WAKE_TAIL_IGNORE_LIMIT = 2;

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

    this.noiseFloor = null;      // EMA of non-speech window RMS, null until measured
    this.speechRunMs = 0;        // consecutive ms currently over the gate
    this.sosFired = false;
    this.eosFired = false;
    this.eosAt = null;           // wall clock at EOS, for silence-vs-recognition timing
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
    this.lastResult = null;
    this.startPromise = null;
    this.started = false;
    this.decoder = null;
    this.decoderError = null;
    this.pcmPending = Buffer.alloc(0);
    this.pcmCarry = null;
    this.finalizeReason = null;

    // Streaming state. `streamingSupported` is set once `/healthz` confirms a
    // streaming endpoint; `streamingReady` once the socket is open and `start`
    // was sent; `streamingFailed` latches a socket failure and forces the batch
    // path for the rest of the session. Audio accepted before the socket is open
    // is queued (bounded); the batch buffer keeps its own copy for fallback.
    this.streamingSupported = false;
    this.streamingUnsupported = false;
    this.streamingReady = false;
    this.streamingFailed = false;
    this.streamSocket = null;
    this.streamPending = [];
    this.streamPendingBytes = 0;
    this.streamFinalWaiter = null;
    this.streamFinalTimer = null;
    this.streamEosSent = false;
    this.streamClosing = false;
    this.fastEosResult = null;

    // The regex is applied to each interim when streaming and post-hoc to the
    // final batch transcript otherwise; the client-visible FAST_EOS annotation
    // is never silently dropped.
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
    if (this.stopped || this.state === 'FINALIZING' || this.state === 'DONE') return;
    if (!Buffer.isBuffer(audioBuffer)) throw new AudioFormatError('ASR audio frames must be Buffers');
    if (audioBuffer.length === 0) return;
    // LINEAR16 never reaches StreamingAudioDecoder, so its capture lives here;
    // encoded turns are teed inside the decoder instead.
    if (this.audio.encoding === AUDIO_ENCODINGS.LINEAR16 && process.env.PHOENIX_ASR_CAPTURE_DIR) {
      if (this.pcmCapture === undefined) this.pcmCapture = openCapture(AUDIO_ENCODINGS.LINEAR16, this.log && this.log.transId);
      if (this.pcmCapture) {
        try { fs.writeSync(this.pcmCapture.fd, audioBuffer); } catch { this.pcmCapture = null; }
      }
    }
    if (this.audio.encoding !== AUDIO_ENCODINGS.LINEAR16) {
      if (this.started) {
        try {
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

  _consumePcm(audioBuffer) {
    // A caller stop is an end-of-input drain; VAD/max-buffer EOS is a
    // cancellation boundary and drops PCM arriving after that boundary.
    if (this.state === 'FINALIZING') {
      if (this.finalizeReason === 'stop') this._appendEndOfInputPcm(audioBuffer);
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

    // An SOS callback may synchronously call stop(). Preserve the partial
    // window already accepted by that caller stop before finalization runs.
    if (this.state === 'FINALIZING' && this.finalizeReason === 'stop') {
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
    this._sendStreamAudio(pcm);
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

  /**
   * The speech gate for the current room: never below the reference constant,
   * and lifted clear of the measured noise floor when that floor runs hot.
   */
  _speechGate() {
    if (this.noiseFloor === null) return SPEECH_RMS_THRESHOLD;
    return Math.max(SPEECH_RMS_THRESHOLD, this.noiseFloor * NOISE_FLOOR_MARGIN);
  }

  _trackNoiseFloor(rms) {
    if (this.noiseFloor === null) { this.noiseFloor = rms; return; }
    const alpha = rms > this.noiseFloor ? NOISE_FLOOR_ATTACK : NOISE_FLOOR_DECAY;
    this.noiseFloor += alpha * (rms - this.noiseFloor);
  }

  _consumeVadWindow(window) {
    const rms = ParakeetASRSession.computeRMS(window);
    const gate = this._speechGate();
    if (rms <= gate) {
      // Only windows the gate calls silence feed the floor estimate, so speech
      // can never drag the gate up after itself.
      this._trackNoiseFloor(rms);
      this.speechRunMs = 0;
    } else {
      this.speechRunMs += VAD_WINDOW_MS;
    }
    // A burst shorter than the debounce is noise, not the speaker resuming: it
    // must not discard a silence run that is on its way to the EOS threshold.
    const isSpeech = rms > gate
      && (this.speechRunMs >= SPEECH_DEBOUNCE_MS || this.state === 'SPEAKING');
    if (isSpeech) {
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
        if (this._isWakeTailBurst()) {
          // The wake phrase's own tail: not an utterance. Drop the endpoint and
          // keep listening for the request the speaker has not made yet.
          this.wakeTailIgnored += 1;
          this.silenceBytes = 0;
          this.state = 'WAITING';
          this.log.debug?.('[asr] short burst after the wake phrase: not an endpoint, continuing to listen', {
            speechMs: Math.round(bytesToMs(this.speechBytes)),
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
      if (this.decoderError) {
        const reject = this.rejectStart;
        this.rejectStart = null;
        reject(this.decoderError);
      } else {
        const resolve = this.resolveStart;
        this.resolveStart = null;
        resolve(undefined);
      }
      return this.startPromise;
    }
    this.started = true;
    if (this.decoderError) {
      const reject = this.rejectStart;
      this.rejectStart = null;
      reject(this.decoderError);
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
        for (const chunk of this.pendingEncodedChunks) this.decoder.write(chunk);
        this.pendingEncodedChunks = [];
        this.pendingEncodedBytes = 0;
      } catch (err) {
        this._handleAudioError(err);
      }
    }
    // Probe for the streaming endpoint in the background; audio accepted while
    // the probe/socket is in flight is queued and flushed on open. A server
    // without it (or a probe failure) leaves the batch path untouched.
    this._initStreaming();
    return this.startPromise;
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.state !== 'FINALIZING' && this.state !== 'DONE') {
      if (this.sosFired) {
        if (!this.eosFired) {
          this.eosFired = true;
          this._emitEOS();
        }
        this.state = 'FINALIZING';
        this.finalizeReason = 'stop';
        this._finalize({ mode: 'end-of-input' }).catch((err) => {
          this.log.error?.('Parakeet finalize on stop failed: ' + err.message);
          this.state = 'DONE';
          if (this.rejectStart) this.rejectStart(err);
        });
      } else {
        this.state = 'DONE';
        this._closeDecoder();
        this._closeStream();
        if (this.resolveStart) this.resolveStart(undefined);
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
    if (this.aborted || this.state === 'DONE') { this.aborted = true; return; }
    this.aborted = true;
    this.stopped = true;
    this.state = 'DONE';
    this.chunks = [];
    this.totalBytes = 0;
    this.pcmPending = Buffer.alloc(0);
    this.pcmCarry = null;
    this._closeDecoder();
    this._closeStream();
    if (this.resolveStart) {
      const resolve = this.resolveStart;
      this.resolveStart = null;
      resolve(undefined);
    }
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
    this.eosAt = Date.now();
    this.state = 'FINALIZING';
    this.finalizeReason = reason;
    this.pcmPending = Buffer.alloc(0);
    this.log.debug?.(`EOS detected (${reason}), finalizing with ${this.chunks.length} chunks`);
    this._emitEOS();
    this._finalize({ mode: 'cancel' }).catch((err) => {
      this.log.error?.('Parakeet finalize failed: ' + err.message);
      this.state = 'DONE';
      if (this.rejectStart) this.rejectStart(err);
    });
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
    this.eosAt = Date.now();
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
      && bytesToMs(this.speechBytes) < MIN_ENDPOINT_SPEECH_MS;
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
    this.state = this.sosFired ? 'TRAILING_SILENCE' : 'WAITING';
    this.finalizeReason = null;
    this.log.debug?.('[asr] empty silence endpoint: no words recognized, continuing to listen', {
      relisten: this.relistenCount,
    });
  }

  /**
   * True while the streaming socket can answer this finalization. A latched
   * socket failure, or a socket that is no longer open, sends the turn to the
   * batch path; a FastEOS result obtained from an interim needs no live socket.
   */
  _shouldUseStream() {
    if (this.streamingFailed) return false;
    if (this.fastEosResult) return true;
    return this.streamingReady
      && !!this.streamSocket
      && this.streamSocket.readyState === WebSocket.OPEN;
  }

  async _finalize({ mode = 'cancel' } = {}) {
    if (this._shouldUseStream()) return this._finalizeViaStream(mode);
    return this._finalizeViaBatch(mode);
  }

  /** Drain the decoder for an explicit end-of-input, then run the batch POST. */
  async _finalizeViaBatch(mode) {
    if (mode === 'end-of-input' && this.decoder) {
      const decoder = this.decoder;
      try {
        // An explicit stop is end-of-input for the bytes already accepted by
        // the session.  Let complete decoder frames drain so accepted speech
        // reaches the WAV; an incomplete final container frame is discarded.
        await decoder.finish({ allowTruncated: true });
      } finally {
        if (this.decoder === decoder) this._closeDecoder();
      }
    } else {
      this._closeDecoder();
    }
    // The streaming socket (if one was opening) has no part in a batch POST.
    this._closeStream();
    return this._finalizeBatchWork(mode);
  }

  async _finalizeBatchWork(mode) {
    // A caller stop is the encoded stream's end-of-input: retain complete
    // frames already accepted by the session, and let the decoder discard an
    // incomplete container tail.  VAD/max-buffer EOS is a cancellation point;
    // audio after the detected EOS must not be appended while the POST starts.
    if (mode === 'end-of-input') this._appendEndOfInputPcm();
    else this.pcmPending = Buffer.alloc(0);
    if (this.decoderError) throw this.decoderError;
    if (this.pcmCarry) throw new AudioFormatError('ASR PCM ended on an odd byte boundary');
    const pcm = Buffer.concat(this.chunks);
    if (pcm.length === 0) {
      this.state = 'DONE';
      if (this.resolveStart) this.resolveStart(undefined);
      return;
    }
    const wav = ParakeetASRSession.makeWav(pcm);
    const posted = await this._postToParakeet(wav);
    const transcript = posted.text;
    // An empty silence endpoint heard no utterance (typically the wake-phrase
    // tail before the speaker's pause): keep listening for the real request
    // instead of ending the turn with an empty no-match result.
    if (!transcript && this._shouldRelisten()) {
      this._resetForRelisten();
      return;
    }
    // Prefer the server's confidence; fall back to the historical synthetic
    // value only when the deployment cannot supply one, so an old server keeps
    // working unchanged.
    this._emitFinalResult(transcript, posted.confidence);
  }

  /** End the recognizer stream and settle with the `final` transcript. */
  async _finalizeViaStream(mode) {
    if (mode === 'end-of-input' && this.decoder) {
      const decoder = this.decoder;
      try {
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

    // FastEOS fired on an interim: that interim is the truncated transcript and
    // the trigger word has already cut the utterance, exactly like the original
    // Google session. Do not wait for a server final (it would include audio the
    // speaker said after the trigger).
    if (this.fastEosResult) {
      const result = this.fastEosResult;
      this._sendStreamEos();
      this._closeStream();
      this._emitFinalResult(result.text, result.confidence);
      return;
    }

    let final;
    try {
      final = await this._requestStreamFinal();
    } catch (err) {
      // The socket failed while we waited for the final: the buffered PCM is
      // still good, so recognize it over the unchanged batch path instead of
      // losing the turn.
      this.log.warn?.('Parakeet /stream final failed; falling back to batch: ' + err.message);
      this._streamFailed(err);
      this._closeStream();
      return this._finalizeBatchWork(mode);
    }
    this._closeStream();
    if (!final.text && this._shouldRelisten()) {
      this._resetForRelisten();
      this._restartStream();
      return;
    }
    this._emitFinalResult(final.text, final.confidence);
  }

  /**
   * Settle the session with a transcript/confidence. Prefers the recognizer's
   * confidence and only synthesizes the historical 1.0/0.0 when the server
   * supplied none; annotates FAST_EOS when the text matches earlyEOS (post-hoc,
   * the reference's batch behavior).
   */
  _emitFinalResult(transcript, confidence) {
    const text = transcript || '';
    const result = {
      text,
      confidence: confidence !== null && confidence !== undefined
        ? confidence
        : (text ? 1.0 : 0.0),
    };
    if (text && this.fastEOSRegex && this.fastEOSRegex.test(text)) {
      result.annotation = 'FAST_EOS';
    }
    this.lastResult = result;
    // Where a turn's wall clock actually goes. The pause a speaker notices is the
    // silence wait plus the recognition round trip; logging only a total leaves
    // the two indistinguishable, so record both halves on every real turn.
    if (this.eosAt) {
      this.log.info?.('ASR turn', {
        reason: this.finalizeReason,
        audioMs: Math.round(bytesToMs(this.totalBytes)),
        silenceWaitMs: SILENCE_TO_EOS_MS,
        recognizeMs: Date.now() - this.eosAt,
        relistens: this.relistenCount,
        chars: text.length,
      });
    }
    if (this.resultHandler) this.resultHandler(result);
    this.state = 'DONE';
    if (this.resolveStart) this.resolveStart(result);
  }

  // --- Streaming transport ---------------------------------------------------

  /** Probe `/healthz` once; resolves true only for a streaming-capable server. */
  _probeStreamingSupport() {
    return new Promise((resolve) => {
      let parsed;
      try {
        parsed = new URL(this.parakeetUrl);
      } catch {
        resolve(false);
        return;
      }
      const secure = parsed.protocol === 'https:';
      const transport = secure ? https : http;
      const port = parsed.port ? parseInt(parsed.port, 10) : (secure ? 443 : 80);
      const req = transport.request({
        method: 'GET',
        host: parsed.hostname,
        port,
        path: '/healthz',
        timeout: HEALTH_TIMEOUT_MS,
        agent: false,
        headers: { connection: 'close' },
      }, (res) => {
        const bufs = [];
        res.on('data', (c) => bufs.push(c));
        res.on('end', () => {
          if (res.statusCode !== 200) { resolve(false); return; }
          try {
            const json = JSON.parse(Buffer.concat(bufs).toString('utf8'));
            resolve(
              json?.ok === true
              && typeof json?.api_version === 'string'
              && apiVersionAtLeast(json.api_version, STREAMING_API_VERSION),
            );
          } catch {
            resolve(false);
          }
        });
      });
      req.on('timeout', () => { req.destroy(new Error('Parakeet /healthz timed out')); });
      req.on('error', () => resolve(false));
      req.end();
    });
  }

  _initStreaming() {
    this._probeStreamingSupport()
      .then((supported) => {
        if (!supported) {
          this.streamingUnsupported = true;
          this.streamPending = [];
          this.streamPendingBytes = 0;
          return;
        }
        if (this.stopped || this.aborted || this.state === 'DONE') return;
        this.streamingSupported = true;
        this._openStream();
      })
      .catch(() => { this.streamingUnsupported = true; });
  }

  _openStream() {
    if (!this.streamingSupported || this.streamingFailed || this.streamSocket) return;
    if (this.stopped || this.aborted || this.state === 'DONE') return;
    let url;
    try {
      url = new URL(this.parakeetUrl);
    } catch {
      this.streamingFailed = true;
      return;
    }
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/stream';
    url.search = '';
    url.hash = '';
    let socket;
    try {
      socket = new WebSocket(url.toString());
    } catch (err) {
      this.streamingFailed = true;
      this.log.warn?.('[asr] Parakeet streaming socket could not be created; using batch: ' + err.message);
      return;
    }
    this.streamSocket = socket;
    this.streamEosSent = false;
    this.streamClosing = false;
    socket.on('open', () => {
      if (this.streamSocket !== socket) return;
      if (this.stopped || this.aborted || this.state === 'DONE') { this._closeStream(); return; }
      this.streamingReady = true;
      try {
        socket.send(JSON.stringify({ type: 'start', sampleRate: SAMPLE_RATE, normalize: false }));
      } catch (err) {
        this._streamFailed(err);
        return;
      }
      const pending = this.streamPending;
      this.streamPending = [];
      this.streamPendingBytes = 0;
      for (const chunk of pending) {
        try {
          socket.send(chunk);
        } catch (err) {
          this._streamFailed(err);
          return;
        }
      }
    });
    socket.on('message', (data, isBinary) => {
      if (this.streamSocket !== socket || isBinary) return;
      this._handleStreamMessage(data.toString());
    });
    socket.on('error', (err) => this._streamFailed(err));
    socket.on('close', () => {
      if (this.streamSocket !== socket) return;
      this.streamingReady = false;
      if (this.streamFinalWaiter) {
        const waiter = this.streamFinalWaiter;
        this.streamFinalWaiter = null;
        if (this.streamFinalTimer) { clearTimeout(this.streamFinalTimer); this.streamFinalTimer = null; }
        waiter.reject(new Error('Parakeet stream closed before a final result'));
      } else if (!this.streamClosing && this.state !== 'DONE') {
        // A close we did not ask for is a mid-session failure: latch it so the
        // rest of the turn (and its buffered PCM) goes through batch instead.
        this._streamFailed(new Error('Parakeet stream closed unexpectedly'));
      }
    });
  }

  _handleStreamMessage(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'interim') {
      this._handleStreamInterim(this._parseStreamPayload(msg));
    } else if (msg.type === 'final') {
      const result = this._parseStreamPayload(msg);
      // The recognizer answered; a following socket close is routine, not a
      // mid-session failure.
      this.streamClosing = true;
      if (this.streamFinalWaiter) {
        const waiter = this.streamFinalWaiter;
        this.streamFinalWaiter = null;
        if (this.streamFinalTimer) { clearTimeout(this.streamFinalTimer); this.streamFinalTimer = null; }
        waiter.resolve(result);
      } else {
        this.lastResult = result;
      }
    }
  }

  /**
   * The server contract puts `text`/`confidence` at the top level; the deployed
   * 0.2.0 server also nests a NeMo hypothesis under `transcript`, so accept both.
   */
  _parseStreamPayload(msg) {
    let text = typeof msg.text === 'string' ? msg.text : null;
    let confidence = typeof msg.confidence === 'number' ? msg.confidence : null;
    if (text === null && msg.transcript !== undefined && msg.transcript !== null) {
      if (typeof msg.transcript === 'string') {
        text = msg.transcript;
      } else if (typeof msg.transcript === 'object') {
        text = typeof msg.transcript.text === 'string' ? msg.transcript.text : null;
        if (confidence === null && typeof msg.transcript.confidence === 'number') {
          confidence = msg.transcript.confidence;
        }
      }
    }
    return { text: text || '', confidence };
  }

  /**
   * Surface an interim through the incremental seam. On an earlyEOS match the
   * utterance is truncated here (H07b): annotate the interim FAST_EOS and end
   * the turn through the same `_fireEOSAndFinalize` used by VAD endpoints.
   */
  _handleStreamInterim(result) {
    if (this.stopped || this.aborted || this.state === 'FINALIZING' || this.state === 'DONE') return;
    if (!result.text) return;
    if (this.fastEOSRegex && this.fastEOSRegex.test(result.text)) {
      const annotated = { text: result.text, confidence: result.confidence, annotation: 'FAST_EOS' };
      this.lastResult = annotated;
      this.fastEosResult = annotated;
      this.log.info?.('Incremental transcription contains a FastEOS trigger word/phrase. Stopping ASR and returning.');
      this._fireEOSAndFinalize('fast-eos');
      return;
    }
    this.lastResult = result;
    if (this.resultHandler) this.resultHandler(result);
  }

  _sendStreamAudio(pcm) {
    if (this.streamingFailed || this.streamEosSent || !pcm || pcm.length === 0) return;
    if (this.streamingReady && this.streamSocket && this.streamSocket.readyState === WebSocket.OPEN) {
      try {
        this.streamSocket.send(pcm);
      } catch (err) {
        this._streamFailed(err);
      }
      return;
    }
    if (this.streamingUnsupported) return;
    // The probe/socket is still in flight (or the socket just opened): hold the
    // audio so the recognizer hears the beginning of the utterance too.
    if (this.streamPendingBytes + pcm.length > STREAM_PENDING_MAX_BYTES) {
      if (this.streamingSupported) this._streamFailed(new Error('Parakeet stream audio queue overflowed before the socket was ready'));
      return;
    }
    this.streamPending.push(Buffer.from(pcm));
    this.streamPendingBytes += pcm.length;
  }

  _requestStreamFinal() {
    return new Promise((resolve, reject) => {
      const socket = this.streamSocket;
      if (!socket || !this.streamingReady || socket.readyState !== WebSocket.OPEN) {
        reject(new Error('Parakeet stream is not open'));
        return;
      }
      this.streamEosSent = true;
      this.streamFinalWaiter = { resolve, reject };
      if (this.streamFinalTimer) clearTimeout(this.streamFinalTimer);
      this.streamFinalTimer = setTimeout(() => {
        if (this.streamFinalWaiter) {
          const waiter = this.streamFinalWaiter;
          this.streamFinalWaiter = null;
          this.streamFinalTimer = null;
          waiter.reject(new Error('Parakeet stream final timed out'));
        }
      }, STREAM_FINAL_TIMEOUT_MS);
      this.streamFinalTimer.unref?.();
      try {
        socket.send(JSON.stringify({ type: 'eos' }));
      } catch (err) {
        if (this.streamFinalWaiter) {
          const waiter = this.streamFinalWaiter;
          this.streamFinalWaiter = null;
          if (this.streamFinalTimer) { clearTimeout(this.streamFinalTimer); this.streamFinalTimer = null; }
          waiter.reject(err);
        }
      }
    });
  }

  _sendStreamEos() {
    const socket = this.streamSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      this.streamEosSent = true;
      socket.send(JSON.stringify({ type: 'eos' }));
    } catch {
      /* best effort: the socket is about to be closed */
    }
  }

  /** Latch a socket failure so the rest of the session uses the batch path. */
  _streamFailed(err) {
    if (this.streamingFailed) return;
    this.streamingFailed = true;
    this.streamingReady = false;
    const socket = this.streamSocket;
    this.streamSocket = null;
    this.streamPending = [];
    this.streamPendingBytes = 0;
    if (socket) {
      try { socket.terminate(); } catch { /* already gone */ }
    }
    if (this.streamFinalWaiter) {
      const waiter = this.streamFinalWaiter;
      this.streamFinalWaiter = null;
      if (this.streamFinalTimer) { clearTimeout(this.streamFinalTimer); this.streamFinalTimer = null; }
      waiter.reject(err instanceof Error ? err : new Error(String(err)));
    }
    if (!this.stopped && this.state !== 'DONE') {
      this.log.warn?.('[asr] Parakeet /stream failed; falling back to batch: ' + (err?.message || err));
    }
  }

  _restartStream() {
    if (!this.streamingSupported || this.streamingFailed || this.aborted || this.stopped) return;
    this.streamEosSent = false;
    this._openStream();
  }

  _closeStream() {
    const socket = this.streamSocket;
    this.streamClosing = true;
    this.streamSocket = null;
    this.streamingReady = false;
    this.streamPending = [];
    this.streamPendingBytes = 0;
    if (this.streamFinalTimer) { clearTimeout(this.streamFinalTimer); this.streamFinalTimer = null; }
    this.streamFinalWaiter = null;
    if (!socket) return;
    socket.on('error', () => { /* teardown races must not throw */ });
    try {
      if (socket.readyState === WebSocket.OPEN) socket.close();
      else socket.terminate();
    } catch { /* already gone */ }
  }

  _handleAudioError(err) {
    if (this.decoderError || this.state === 'DONE') return;
    this.decoderError = err instanceof AudioFormatError
      ? err
      : new AudioDecodeError(err?.message || String(err), err);
    this.stopped = true;
    this.state = 'DONE';
    this._closeDecoder();
    this._closeStream();
    if (this.rejectStart) {
      const reject = this.rejectStart;
      this.rejectStart = null;
      reject(this.decoderError);
    }
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
      const parsed = new URL(this.parakeetUrl);
      const boundary = '----jiboparakeet' + Date.now() + Math.floor(Math.random() * 1e9).toString(16);
      const head = Buffer.from(
        `--${boundary}\r\n`
        + 'Content-Disposition: form-data; name="file"; filename="audio.wav"\r\n'
        + 'Content-Type: audio/wav\r\n\r\n');
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
      const body = Buffer.concat([head, wav, tail]);

      const req = http.request({
        method: 'POST',
        host: parsed.hostname,
        port: parsed.port ? parseInt(parsed.port, 10) : 80,
        path: '/transcribe',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
      }, (res) => {
        const bufs = [];
        res.on('data', (c) => bufs.push(c));
        res.on('end', () => {
          const text = Buffer.concat(bufs).toString('utf8');
          if (res.statusCode !== 200) return reject(new Error(`Parakeet returned ${res.statusCode}: ${text}`));
          try {
            const json = JSON.parse(text);
            let transcript = json.transcript;
            // The server may report a real decoder confidence. Older
            // deployments (API 0.1.0) do not, and NeMo leaves every confidence
            // field null unless the decoding config asks for them, which is why
            // this client used to invent 1.0 -- a constant that reached the
            // robot looking like a measurement (DIVERGENCES H07c).
            let confidence = typeof json.confidence === 'number' ? json.confidence : null;
            if (transcript && typeof transcript === 'object') {
              if (confidence === null && typeof transcript.confidence === 'number') {
                confidence = transcript.confidence;
              }
              transcript = transcript.text;
            }
            if (typeof transcript !== 'string') transcript = '';
            resolve({ text: transcript, confidence });
          } catch (e) {
            reject(new Error('Could not parse Parakeet response: ' + e));
          }
        });
      });
      req.setTimeout(POST_TIMEOUT_MS, () => { req.destroy(new Error('Parakeet request timed out')); });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }
}
