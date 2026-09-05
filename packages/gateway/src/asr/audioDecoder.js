import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { FLACDecoder } from '@wasm-audio-decoders/flac';

export const AUDIO_ENCODINGS = Object.freeze({
  LINEAR16: 'LINEAR16',
  OGG_OPUS: 'OGG_OPUS',
  FLAC: 'FLAC',
});

const DEFAULT_SAMPLE_RATE = 16_000;
const MAX_INPUT_CHUNK_BYTES = 64 * 1024;
const MAX_PENDING_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const MAX_FLAC_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_OGG_PAGE_BYTES = 27 + 255 + (255 * 255);

export class AudioFormatError extends Error {
  constructor(message, code = 'ERR_AUDIO_FORMAT') {
    super(message);
    this.name = 'AudioFormatError';
    this.code = code;
  }
}

export class UnsupportedAudioEncodingError extends AudioFormatError {
  constructor(encoding) {
    super(`Unsupported ASR audio encoding "${encoding}"`, 'ERR_UNSUPPORTED_AUDIO_ENCODING');
    this.name = 'UnsupportedAudioEncodingError';
    this.encoding = encoding;
  }
}

export class AudioDecodeError extends AudioFormatError {
  constructor(message, cause) {
    super(message, 'ERR_AUDIO_DECODE');
    this.name = 'AudioDecodeError';
    if (cause) this.cause = cause;
  }
}

/**
 * Normalize the ASR declaration at the provider boundary.  The native
 * Jetstream client declares 16 kHz mono audio; Parakeet consumes exactly that
 * PCM shape.  The decoder resamples container formats to the same shape.
 */
export function normalizeAudioConfig(config = {}) {
  const declared = config.encoding == null || config.encoding === '' ? AUDIO_ENCODINGS.LINEAR16 : String(config.encoding).toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(AUDIO_ENCODINGS, declared)) {
    throw new UnsupportedAudioEncodingError(declared);
  }

  const sampleRate = config.sampleRate == null ? DEFAULT_SAMPLE_RATE : Number(config.sampleRate);
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new AudioFormatError(`Invalid ASR sample rate "${config.sampleRate}"`);
  }
  if (sampleRate !== DEFAULT_SAMPLE_RATE) {
    throw new AudioFormatError(`Unsupported ASR sample rate ${sampleRate}; Parakeet requires ${DEFAULT_SAMPLE_RATE} Hz`);
  }

  return { encoding: declared, sampleRate };
}

function decoderArgs(sampleRate) {
  return [
    '-nostdin',
    '-hide_banner',
    '-loglevel', 'error',
    '-f', 'ogg',
    '-i', 'pipe:0',
    '-ac', '1',
    '-ar', String(sampleRate),
    '-f', 's16le',
    'pipe:1',
  ];
}

/**
 * Consume complete Ogg pages without retaining the whole encoded turn.  The
 * decoder process still owns codec validation; this small parser only tracks
 * page boundaries so end-of-input can distinguish a complete Ogg stream from
 * a prefix that ffmpeg happens to decode successfully.
 */
function parseOggPages(buffer, state, force = false) {
  let offset = 0;
  while (buffer.length - offset > 0) {
    const remaining = buffer.length - offset;
    if (remaining < 4) break;
    if (buffer.toString('ascii', offset, offset + 4) !== 'OggS') {
      throw new AudioDecodeError('OGG stream is missing the OggS marker');
    }
    if (remaining < 27) break;
    if (buffer[offset + 4] !== 0) {
      throw new AudioDecodeError(`Unsupported OGG page version ${buffer[offset + 4]}`);
    }
    const segmentCount = buffer[offset + 26];
    const segmentTableEnd = offset + 27 + segmentCount;
    if (segmentTableEnd > buffer.length) break;
    let bodyLength = 0;
    for (let i = 0; i < segmentCount; i += 1) bodyLength += buffer[offset + 27 + i];
    const pageEnd = segmentTableEnd + bodyLength;
    if (pageEnd - offset > MAX_OGG_PAGE_BYTES) {
      throw new AudioDecodeError('OGG page exceeds the decoder limit');
    }
    if (pageEnd > buffer.length) break;
    state.oggPages += 1;
    if ((buffer[offset + 5] & 0x04) !== 0) state.oggSawEos = true;
    offset = pageEnd;
  }
  if (force && buffer.length - offset > 0) {
    throw new AudioDecodeError('Truncated OGG page');
  }
  return buffer.subarray(offset);
}

function isFlacSync(buffer, offset) {
  return offset + 1 < buffer.length && buffer[offset] === 0xff && (buffer[offset + 1] & 0xfc) === 0xf8;
}

function flacCrc16(buffer, start = 0, end = buffer.length) {
  let crc = 0;
  for (let i = start; i < end; i += 1) {
    crc ^= buffer[i] << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x8005) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/**
 * Validate a FLAC stream's metadata and return its audio start offset, or
 * null while the metadata is incomplete. The persistent decoder receives the
 * original bytes; this parser only needs the STREAMINFO boundary to validate
 * frame prefixes and end-of-input behavior.
 */
function parseFlacMetadata(buffer) {
  if (buffer.length < 4) return null;
  if (buffer.toString('ascii', 0, 4) !== 'fLaC') {
    throw new AudioDecodeError('FLAC stream is missing the fLaC marker');
  }
  let offset = 4;
  let streamInfo = false;
  while (true) {
    if (offset + 4 > buffer.length) return null;
    const header = buffer[offset];
    const length = buffer.readUIntBE(offset + 1, 3);
    const blockEnd = offset + 4 + length;
    if (blockEnd > buffer.length) return null;
    const type = header & 0x7f;
    if (type === 0) {
      if (length !== 34) throw new AudioDecodeError(`Invalid FLAC STREAMINFO length ${length}`);
      streamInfo = true;
    }
    offset = blockEnd;
    if (header & 0x80) break;
  }
  if (!streamInfo) throw new AudioDecodeError('FLAC stream has no STREAMINFO metadata');
  return { end: offset };
}

function findFlacFrameEnd(buffer) {
  for (let candidate = 2; candidate + 2 <= buffer.length; candidate += 1) {
    if (!isFlacSync(buffer, candidate)) continue;
    const crcOffset = candidate - 2;
    if (crcOffset <= 0) continue;
    if (flacCrc16(buffer, 0, crcOffset) === buffer.readUInt16BE(crcOffset)) return candidate;
  }
  return -1;
}

/**
 * Bounded encoded-audio adapters. OGG_OPUS uses a persistent ffmpeg
 * stdin/stdout stream; FLAC uses the persistent WASM decoder below. `write`
 * never waits for either decoder: encoded bytes stay in bounded queues and a
 * caller-visible decode error is raised when that bound is exceeded. Neither
 * path retains a whole turn, so Parakeet VAD can run as PCM arrives.
 */
export class StreamingAudioDecoder extends EventEmitter {
  constructor({ encoding, sampleRate = DEFAULT_SAMPLE_RATE, ffmpegPath, onPcm, onError, log = console } = {}) {
    super();
    if (encoding !== AUDIO_ENCODINGS.OGG_OPUS && encoding !== AUDIO_ENCODINGS.FLAC) {
      throw new UnsupportedAudioEncodingError(encoding);
    }
    this.encoding = encoding;
    this.sampleRate = sampleRate;
    this.ffmpegPath = ffmpegPath || process.env.PHOENIX_FFMPEG || 'ffmpeg';
    this.onPcm = onPcm;
    this.onError = onError;
    this.log = log;

    this.started = false;
    this.child = null;
    this.queue = [];
    this.queuedBytes = 0;
    this.waitingDrain = false;
    this.inputEnded = false;
    this.closing = false;
    this.failed = false;
    this.failureError = null;
    this.abortError = null;
    this.decodedBytes = 0;
    this.stderr = Buffer.alloc(0);
    this.oggBuffer = Buffer.alloc(0);
    this.oggPages = 0;
    this.oggSawEos = false;
    this.flacBuffer = Buffer.alloc(0);
    this.flacMetadata = null;
    this.flacSawFrame = false;
    this.nativeFlacDecoder = null;
    this.nativeFlacReady = null;
    this.nativeFlacChain = Promise.resolve();
    this.nativeFlacError = null;
    this.nativeFlacPendingBytes = 0;
    this.nativeFlacStartupBuffer = Buffer.alloc(0);
    this.nativeFlacClosed = false;
    this.finishPromise = null;
    this.finishResolve = null;
    this.finishReject = null;
    this.finishAllowTruncated = false;
  }

  start() {
    if (this.started || this.closing) return;
    this.started = true;
    if (this.encoding === AUDIO_ENCODINGS.FLAC) {
      this._startNativeFlac();
      return;
    }
    let child;
    try {
      child = spawn(this.ffmpegPath, decoderArgs(this.sampleRate), {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      this._fail(new AudioDecodeError(`Unable to start audio decoder "${this.ffmpegPath}"`, err));
      return;
    }
    this.child = child;
    child.stdout.on('data', (chunk) => {
      if (this.closing || this.failed) return;
      try {
        this.decodedBytes += chunk.length;
        this.onPcm?.(chunk);
        this.emit('pcm', chunk);
      } catch (err) {
        this._fail(err instanceof AudioDecodeError ? err : new AudioDecodeError('PCM consumer failed', err));
      }
    });
    child.stderr.on('data', (chunk) => {
      if (this.stderr.length < MAX_STDERR_BYTES) {
        const remaining = MAX_STDERR_BYTES - this.stderr.length;
        this.stderr = Buffer.concat([this.stderr, chunk.subarray(0, remaining)]);
      }
    });
    child.stdin.on('drain', () => {
      this.waitingDrain = false;
      this._flush();
    });
    child.stdin.on('error', (err) => {
      if (!this.closing) this._fail(new AudioDecodeError('Audio decoder input failed', err));
    });
    child.on('error', (err) => {
      if (this.closing) return;
      const detail = err.code === 'ENOENT'
        ? `Audio decoder executable "${this.ffmpegPath}" was not found`
        : `Audio decoder failed to start: ${err.message}`;
      this._fail(new AudioDecodeError(detail, err));
    });
    child.on('close', (code, signal) => {
      this.child = null;
      if (this.closing) {
        this.emit('close', { code, signal });
        return;
      }
      if (this.failed) return;
      const detail = this.stderr.toString('utf8').trim();
      if (code !== 0) {
        if (this.inputEnded && this.finishAllowTruncated && this.decodedBytes > 0 && /end of file/i.test(detail)) {
          this._settleFinishSuccess();
          this.emit('finish');
          return;
        }
        const suffix = detail ? `: ${detail}` : '';
        if (this.inputEnded && !this.finishAllowTruncated && /end of file/i.test(detail)) {
          const formatError = this._oggFinishError();
          if (formatError) {
            this._fail(formatError);
            return;
          }
        }
        this._fail(new AudioDecodeError(`Audio decoder exited with code ${code ?? 'null'}${signal ? ` (${signal})` : ''}${suffix}`));
      } else if (this.inputEnded) {
        const formatError = this._oggFinishError();
        if (formatError && !this.finishAllowTruncated) {
          this._fail(formatError);
          return;
        }
        if (this.decodedBytes === 0) {
          this._fail(new AudioDecodeError('OGG stream contains no decodable audio'));
          return;
        }
        this._settleFinishSuccess();
        this.emit('finish');
      } else {
        this._fail(new AudioDecodeError('Audio decoder ended before ASR end-of-speech'));
      }
    });
    this._flush();
  }

  _startNativeFlac() {
    try {
      this.nativeFlacDecoder = new FLACDecoder();
      this.nativeFlacReady = this.nativeFlacDecoder.ready;
      // Keep initialization failures on the decoder's normal error path even
      // when no encoded bytes have been written yet.
      this.nativeFlacChain = this.nativeFlacReady.catch((err) => {
        this.nativeFlacError = err;
      });
    } catch (err) {
      this._fail(new AudioDecodeError('Unable to initialize the FLAC decoder', err));
    }
  }

  write(chunk) {
    if (this.closing || this.failed || this.inputEnded) return false;
    if (!Buffer.isBuffer(chunk)) throw new AudioFormatError('ASR audio frames must be Buffers');
    if (chunk.length === 0) return true;
    if (this.encoding === AUDIO_ENCODINGS.FLAC) return this._writeFlac(chunk);
    if (this.queuedBytes + chunk.length > MAX_PENDING_INPUT_BYTES) {
      const err = new AudioDecodeError(`Audio decoder input queue exceeded ${MAX_PENDING_INPUT_BYTES} bytes`);
      this._fail(err);
      throw err;
    }
    try {
      this.oggBuffer = this.oggBuffer.length === 0
        ? Buffer.from(chunk)
        : Buffer.concat([this.oggBuffer, chunk]);
      this.oggBuffer = parseOggPages(this.oggBuffer, this);
    } catch (err) {
      this._fail(err);
      throw err;
    }
    for (let offset = 0; offset < chunk.length; offset += MAX_INPUT_CHUNK_BYTES) {
      this.queue.push(chunk.subarray(offset, Math.min(offset + MAX_INPUT_CHUNK_BYTES, chunk.length)));
    }
    this.queuedBytes += chunk.length;
    this._flush();
    return this.queuedBytes < MAX_PENDING_INPUT_BYTES;
  }

  end() {
    this.finish().catch(() => {});
  }

  finish({ allowTruncated = false } = {}) {
    if (this.finishPromise) return this.finishPromise;
    this.finishPromise = new Promise((resolve, reject) => {
      this.finishResolve = resolve;
      this.finishReject = reject;
    });
    this.finishAllowTruncated = allowTruncated;
    if (this.closing || this.failed) {
      this._settleFinishError(this.failureError || this.abortError || new AudioDecodeError('Audio decoder is closed'));
      return this.finishPromise;
    }
    if (!this.started) {
      this._settleFinishError(new AudioDecodeError('Audio decoder has not been started'));
      return this.finishPromise;
    }
    this.inputEnded = true;
    if (this.encoding === AUDIO_ENCODINGS.FLAC) {
      try {
        this._parseFlacBuffer(true, allowTruncated);
        this._finishNativeFlac().catch((err) => this._fail(err));
      } catch (err) {
        this._fail(err);
      }
    } else {
      try {
        if (!allowTruncated) this.oggBuffer = parseOggPages(this.oggBuffer, this, true);
        this._flush();
      } catch (err) {
        this._fail(err);
      }
    }
    return this.finishPromise;
  }

  /** Stop the child and release queued encoded frames immediately. */
  abort() {
    if (this.closing) {
      this._settleFinishError(this.failureError || this.abortError || new AudioDecodeError('Audio decoder was aborted'));
      return;
    }
    if (!this.failed) this.abortError = new AudioDecodeError('Audio decoder was aborted');
    this.closing = true;
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.flacBuffer = Buffer.alloc(0);
    this.nativeFlacPendingBytes = 0;
    this.nativeFlacStartupBuffer = Buffer.alloc(0);
    this.nativeFlacClosed = true;
    this._freeNativeFlac();
    this.waitingDrain = false;
    const child = this.child;
    this.child = null;
    this._settleFinishError(this.failureError || this.abortError);
    if (!child) {
      this.emit('close', { code: null, signal: null });
      return;
    }
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.stdin?.destroy();
    child.kill();
  }

  _oggFinishError() {
    if (this.oggPages === 0) return new AudioDecodeError('OGG stream contains no complete pages');
    if (this.oggBuffer.length > 0) return new AudioDecodeError('Truncated OGG page');
    if (!this.oggSawEos) return new AudioDecodeError('OGG stream ended without an EOS page');
    return null;
  }

  _writeFlac(chunk) {
    const pendingBytes = Math.max(this.nativeFlacPendingBytes, this.flacBuffer.length);
    if (pendingBytes + chunk.length > MAX_PENDING_INPUT_BYTES) {
      const err = new AudioDecodeError(`Audio decoder input queue exceeded ${MAX_PENDING_INPUT_BYTES} bytes`);
      this._fail(err);
      throw err;
    }
    this.flacBuffer = this.flacBuffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.flacBuffer, chunk]);
    try {
      this._parseFlacBuffer(false);
    } catch (err) {
      this._fail(err);
      throw err;
    }
    try {
      this._feedNativeFlac(chunk);
    } catch (err) {
      this._fail(err);
      throw err;
    }
    return Math.max(this.nativeFlacPendingBytes, this.flacBuffer.length) < MAX_PENDING_INPUT_BYTES;
  }

  _parseFlacBuffer(force, allowTruncated = false) {
    if (!this.flacMetadata) {
      const metadata = parseFlacMetadata(this.flacBuffer);
      if (!metadata) {
        if (force) {
          throw new AudioDecodeError(this.flacBuffer.length === 0
            ? 'Empty FLAC stream'
            : 'Truncated FLAC metadata');
        }
        return;
      }
      this.flacMetadata = true;
      this.flacBuffer = this.flacBuffer.subarray(metadata.end);
    }
    while (this.flacBuffer.length > 0) {
      // A network frame may end immediately after FLAC's first sync byte.
      // Keep that valid prefix until the next write; any other one-byte
      // prefix cannot begin a FLAC frame and is rejected as corrupt input.
      if (this.flacBuffer.length === 1) {
        if (this.flacBuffer[0] === 0xff && !force) return;
        if (allowTruncated && this.flacBuffer[0] === 0xff) {
          this.flacBuffer = Buffer.alloc(0);
          return;
        }
        if (this.flacBuffer[0] === 0xff) throw new AudioDecodeError('Truncated FLAC frame');
        throw new AudioDecodeError('FLAC frame is missing its sync code');
      }
      if (!isFlacSync(this.flacBuffer, 0)) {
        throw new AudioDecodeError('FLAC frame is missing its sync code');
      }
      const frameEnd = findFlacFrameEnd(this.flacBuffer);
      if (frameEnd < 0) {
        if (!force) return;
        if (this.flacBuffer.length < 4) {
          if (allowTruncated) {
            this.flacBuffer = Buffer.alloc(0);
            return;
          }
          throw new AudioDecodeError('Truncated FLAC frame');
        }
        const crcOffset = this.flacBuffer.length - 2;
        if (flacCrc16(this.flacBuffer, 0, crcOffset) !== this.flacBuffer.readUInt16BE(crcOffset)) {
          if (allowTruncated) {
            this.flacBuffer = Buffer.alloc(0);
            return;
          }
          throw new AudioDecodeError('Truncated or corrupt FLAC frame');
        }
        this._queueFlacFrame();
        this.flacBuffer = Buffer.alloc(0);
        return;
      }
      this._queueFlacFrame();
      this.flacBuffer = this.flacBuffer.subarray(frameEnd);
    }
  }

  _queueFlacFrame() {
    this.flacSawFrame = true;
    // FLAC uses the persistent WASM decoder; this marker is only for
    // boundary/truncation validation and never starts a child process.
  }

  _feedNativeFlac(chunk) {
    if (!this.nativeFlacDecoder || this.nativeFlacClosed) {
      throw new AudioDecodeError('FLAC decoder is not initialized');
    }
    this.nativeFlacPendingBytes += chunk.length;
    this.nativeFlacStartupBuffer = this.nativeFlacStartupBuffer.length === 0
      ? Buffer.from(chunk)
      : Buffer.concat([this.nativeFlacStartupBuffer, chunk]);
    // The package's streaming API cannot initialize its codec parser from a
    // sub-four-byte fragment. Hold the marker until it has enough bytes.
    if (this.nativeFlacStartupBuffer.length < 4) return;
    const data = Uint8Array.from(this.nativeFlacStartupBuffer);
    this.nativeFlacStartupBuffer = Buffer.alloc(0);
    const dataLength = data.length;
    this.nativeFlacChain = this.nativeFlacChain
      .then(async () => {
        if (this.closing || this.failed) return;
        if (this.nativeFlacError) throw this.nativeFlacError;
        const decoded = await this.nativeFlacDecoder.decode(data);
        if (!this.closing && !this.failed) this._emitNativeFlac(decoded);
      })
      .catch((err) => {
        this._fail(err instanceof AudioDecodeError
          ? err
          : new AudioDecodeError('FLAC decoder failed', err));
      })
      .finally(() => {
        // abort() clears the public pending count immediately; do not let a
        // promise already in flight make that cleanup count negative later.
        this.nativeFlacPendingBytes = Math.max(0, this.nativeFlacPendingBytes - dataLength);
      });
  }

  _emitNativeFlac(decoded) {
    if (!decoded) return;
    if (decoded.errors?.length) {
      const detail = decoded.errors.map((item) => item.message || String(item)).join('; ');
      throw new AudioDecodeError(`FLAC decoder reported an error: ${detail}`);
    }
    if (!decoded.samplesDecoded) return;
    if (decoded.sampleRate !== this.sampleRate || decoded.channelData?.length !== 1 || decoded.bitDepth !== 16) {
      throw new AudioDecodeError(
        `Unsupported FLAC stream shape: ${decoded.sampleRate} Hz, ${decoded.channelData?.length || 0} channels, ${decoded.bitDepth || 0} bits`,
      );
    }
    const samples = decoded.samplesDecoded;
    if (!Number.isSafeInteger(samples) || samples < 0 || samples > MAX_FLAC_OUTPUT_BYTES / 2) {
      throw new AudioDecodeError(`Decoded FLAC chunk exceeded ${MAX_FLAC_OUTPUT_BYTES} bytes`);
    }
    const pcm = Buffer.alloc(samples * 2);
    const channel = decoded.channelData[0];
    for (let i = 0; i < samples; i += 1) {
      const value = Math.max(-32768, Math.min(32767, Math.round(channel[i] * 32768)));
      pcm.writeInt16LE(value, i * 2);
    }
    this.decodedBytes += pcm.length;
    this.onPcm?.(pcm);
    if (!this.closing && !this.failed) this.emit('pcm', pcm);
  }

  async _finishNativeFlac() {
    await this.nativeFlacChain;
    if (this.closing || this.failed) return;
    if (this.nativeFlacError) throw new AudioDecodeError('FLAC decoder failed to initialize', this.nativeFlacError);
    // The startup guard sends input to codec-parser in groups of at least four
    // bytes. A one-byte-at-a-time source can leave one to three validated
    // bytes in that guard; append the parser's two-byte lookahead to those
    // bytes so no tail is silently lost. The lookahead is outside the
    // validated stream and is discarded by codec-parser after the final frame
    // is emitted.
    const startupTail = this.nativeFlacStartupBuffer;
    this.nativeFlacStartupBuffer = Buffer.alloc(0);
    this.nativeFlacPendingBytes -= startupTail.length;
    const lookahead = startupTail.length > 0
      ? Buffer.concat([startupTail, Buffer.alloc(2)])
      : Buffer.alloc(2);
    this._emitNativeFlac(await this.nativeFlacDecoder.decode(Uint8Array.from(lookahead)));
    this._emitNativeFlac(await this.nativeFlacDecoder.flush());
    if (!this.flacSawFrame) throw new AudioDecodeError('FLAC stream contains no audio frames');
    if (this.decodedBytes === 0) throw new AudioDecodeError('FLAC stream contains no decodable audio');
    this.nativeFlacClosed = true;
    this._freeNativeFlac();
    this._settleFinishSuccess();
    this.emit('finish');
  }

  _freeNativeFlac() {
    const decoder = this.nativeFlacDecoder;
    if (!decoder) return;
    this.nativeFlacDecoder = null;
    const ready = this.nativeFlacReady || Promise.resolve();
    ready.then(() => decoder.free()).catch(() => {});
  }

  _flush() {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed || this.waitingDrain || this.failed || this.closing) return;
    try {
      while (this.queue.length > 0) {
        const chunk = this.queue.shift();
        this.queuedBytes -= chunk.length;
        if (!stdin.write(chunk)) {
          this.waitingDrain = true;
          break;
        }
      }
      if (this.inputEnded && this.queue.length === 0 && !this.waitingDrain) stdin.end();
    } catch (err) {
      this._fail(new AudioDecodeError('Audio decoder input failed', err));
    }
  }

  _fail(err) {
    if (this.failed || this.closing) return;
    this.failed = true;
    const wrapped = err instanceof AudioDecodeError || err instanceof AudioFormatError
      ? err
      : new AudioDecodeError(err?.message || String(err), err);
    this.failureError = wrapped;
    this._settleFinishError(wrapped);
    this.log.error?.(wrapped.message);
    this.onError?.(wrapped);
    // `error` is useful to direct decoder consumers, but EventEmitter throws
    // when it has no error listener.  The session uses onError, so only emit
    // when a caller explicitly subscribed.
    if (this.listenerCount('error') > 0) this.emit('error', wrapped);
    this.abort();
  }

  _settleFinishSuccess() {
    const resolve = this.finishResolve;
    this.finishResolve = null;
    this.finishReject = null;
    if (resolve) resolve();
  }

  _settleFinishError(err) {
    const reject = this.finishReject;
    this.finishResolve = null;
    this.finishReject = null;
    if (reject) reject(err);
  }
}

export const AUDIO_DECODER_LIMITS = Object.freeze({
  maxInputChunkBytes: MAX_INPUT_CHUNK_BYTES,
  maxPendingInputBytes: MAX_PENDING_INPUT_BYTES,
});
