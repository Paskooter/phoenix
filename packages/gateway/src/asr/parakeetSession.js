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

import http from 'node:http';
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

    this.sosFired = false;
    this.eosFired = false;
    this.stopped = false;

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
    return this.startPromise;
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.state !== 'FINALIZING' && this.state !== 'DONE') {
      if (this.sosFired) {
        if (!this.eosFired) {
          this.eosFired = true;
          if (this.eosHandler) this.eosHandler(null);
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
        if (this.resolveStart) this.resolveStart(undefined);
      }
    }
  }

  _fireEOSAndFinalize(reason) {
    if (this.eosFired) return;
    this.eosFired = true;
    this.state = 'FINALIZING';
    this.finalizeReason = reason;
    this.pcmPending = Buffer.alloc(0);
    this.log.debug?.(`EOS detected (${reason}), finalizing with ${this.chunks.length} chunks`);
    if (this.eosHandler) this.eosHandler(null);
    this._finalize({ mode: 'cancel' }).catch((err) => {
      this.log.error?.('Parakeet finalize failed: ' + err.message);
      this.state = 'DONE';
      if (this.rejectStart) this.rejectStart(err);
    });
  }

  async _finalize({ mode = 'cancel' } = {}) {
    // A caller stop is the encoded stream's end-of-input: retain complete
    // frames already accepted by the session, and let the decoder discard an
    // incomplete container tail.  VAD/max-buffer EOS is a cancellation point;
    // audio after the detected EOS must not be appended while the POST starts.
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
    const transcript = await this._postToParakeet(wav);
    const result = { text: transcript || '', confidence: transcript ? 1.0 : 0.0 };
    this.lastResult = result;
    if (this.resultHandler) this.resultHandler(result);
    this.state = 'DONE';
    if (this.resolveStart) this.resolveStart(result);
  }

  _handleAudioError(err) {
    if (this.decoderError || this.state === 'DONE') return;
    this.decoderError = err instanceof AudioFormatError
      ? err
      : new AudioDecodeError(err?.message || String(err), err);
    this.stopped = true;
    this.state = 'DONE';
    this._closeDecoder();
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
            if (transcript && typeof transcript === 'object') transcript = transcript.text;
            if (typeof transcript !== 'string') transcript = '';
            resolve(transcript);
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
