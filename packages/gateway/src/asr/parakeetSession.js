// Parakeet ASR session — faithful port of hub/src/asr/parakeet/ParakeetASRSession.ts.
//
// Batch recognizer behind a REST API: raw 16 kHz 16-bit mono PCM chunks stream in
// (provideAudio), an energy VAD detects start/end of speech, and on EOS the whole
// buffer is wrapped in a WAV header and POSTed multipart to `${parakeetUrl}/transcribe`.
// Reference constants and state machine preserved exactly:
//   RMS > 400 counts as speech; SOS after ≥150 ms cumulative speech; EOS after
//   700 ms continuous trailing silence (or 30 s total buffer); states
//   WAITING → SPEAKING → TRAILING_SILENCE → FINALIZING → DONE.
// stop() before SOS resolves start() with undefined; after SOS it fires EOS (if
// needed) and finalizes. Response JSON `{transcript}` may be a plain string or a
// NeMo Hypothesis object {text, ...} — unwrapped to a string.

import http from 'node:http';

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;
const BYTES_PER_SEC = SAMPLE_RATE * BYTES_PER_SAMPLE;

const SPEECH_RMS_THRESHOLD = 400;
const SPEECH_MIN_MS = 150;
const SILENCE_TO_EOS_MS = 700;
const MAX_BUFFER_MS = 30000;

const POST_TIMEOUT_MS = 30000;

const bytesToMs = (bytes) => (bytes / BYTES_PER_SEC) * 1000;

export class ParakeetASRSession {
  /** @param {string} parakeetUrl @param {{lang:string, hints?:string[], earlyEOS?:string[]}} config @param {object} log */
  constructor(parakeetUrl, config, log) {
    this.parakeetUrl = parakeetUrl;
    this.config = config || {};
    this.log = log || console;

    this.chunks = [];
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
  }

  onStartOfSpeech(handler) { this.sosHandler = handler; }
  onEndOfSpeech(handler) { this.eosHandler = handler; }
  onResult(handler) { this.resultHandler = handler; }

  /** Last transcript — null until finalize() completes (Parakeet is batch). */
  getLastIncremental() { return this.lastResult; }

  provideAudio(audioBuffer) {
    if (this.stopped || this.state === 'FINALIZING' || this.state === 'DONE') return;
    this.chunks.push(audioBuffer);
    this.totalBytes += audioBuffer.length;

    const rms = ParakeetASRSession.computeRMS(audioBuffer);
    if (rms > SPEECH_RMS_THRESHOLD) {
      this.speechBytes += audioBuffer.length;
      this.silenceBytes = 0;
      if (!this.sosFired && bytesToMs(this.speechBytes) >= SPEECH_MIN_MS) {
        this.sosFired = true;
        if (this.sosHandler) this.sosHandler(null);
      }
      if (this.sosFired) this.state = 'SPEAKING';
    } else {
      this.silenceBytes += audioBuffer.length;
      if (this.state === 'SPEAKING') this.state = 'TRAILING_SILENCE';
      if (this.state === 'TRAILING_SILENCE' && bytesToMs(this.silenceBytes) >= SILENCE_TO_EOS_MS) {
        this._fireEOSAndFinalize('silence');
        return;
      }
    }

    if (bytesToMs(this.totalBytes) >= MAX_BUFFER_MS) this._fireEOSAndFinalize('max-buffer');
  }

  start() {
    return new Promise((resolve, reject) => {
      this.resolveStart = resolve;
      this.rejectStart = reject;
    });
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
        this._finalize().catch((err) => {
          this.log.error?.('Parakeet finalize on stop failed: ' + err.message);
          if (this.rejectStart) this.rejectStart(err);
        });
      } else {
        this.state = 'DONE';
        if (this.resolveStart) this.resolveStart(undefined);
      }
    }
  }

  _fireEOSAndFinalize(reason) {
    if (this.eosFired) return;
    this.eosFired = true;
    this.state = 'FINALIZING';
    this.log.debug?.(`EOS detected (${reason}), finalizing with ${this.chunks.length} chunks`);
    if (this.eosHandler) this.eosHandler(null);
    this._finalize().catch((err) => {
      this.log.error?.('Parakeet finalize failed: ' + err.message);
      this.state = 'DONE';
      if (this.rejectStart) this.rejectStart(err);
    });
  }

  async _finalize() {
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
