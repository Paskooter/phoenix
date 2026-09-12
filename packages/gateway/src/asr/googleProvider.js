// Google ASR provider — faithful port of
// pegasus:packages/hub/src/asr/google/GoogleASRProvider.ts.
//
// The provider builds the recognizer request from the robot's LISTEN config and
// opens a full-duplex recognizer stream that GoogleASRSession drives:
//
//   createGoogleRequest(config) -> {
//     config: { encoding, languageCode, sampleRateHertz: 16000,
//               speechContexts: hints?.length ? [{phrases: hints}] : [] },
//     singleUtterance: true,
//     interimResults: true
//   }
//
// The pinned provider also has an explicit test seam: when
// ETCO_server_gspeechMockAddress and ETCO_server_gspeechMockPort are set it
// points the speech client at a local mock instead of the real cloud.  Phoenix
// keeps those exact environment names for the recognizer transport, so the
// original ASR behavior can be exercised against a recorded/fake recognizer
// stream with no live vendor dependence.
//
// Real Google Cloud STT is dead-era infrastructure (the credentials file is
// gone).  When no recognizer seam is configured startSession throws loudly
// rather than silently degrading the client-visible contract.

import net from 'node:net';
import { FastEOS } from './fastEOS.js';
import { GOOGLE_STREAM_LIMITS, GoogleASRSession } from './googleSession.js';

export const GOOGLE_SAMPLE_RATE_HZ = 16000;

/** @type {null | ((requestOptions:object, config:object, log:object) => object)} */
let recognizerFactory = null;

/**
 * Test/transport seam: replace how a recognizer stream is created. Passing
 * null restores the default (mock target from env, or a loud failure).
 */
export function setRecognizerFactory(factory) {
  recognizerFactory = factory || null;
}

/** Mock/config target from the original env names, or null when unset. */
export function getRecognizerTarget() {
  const address = process.env.ETCO_server_gspeechMockAddress;
  const port = process.env.ETCO_server_gspeechMockPort;
  if (address && port) return { address, port: Number(port) };
  return null;
}

/**
 * Build the recognizer request exactly as the pinned provider does.
 * @param {{lang?:string, encoding?:string, hints?:string[]}} config
 */
export function createGoogleRequest(config = {}) {
  const hints = config.hints;
  return {
    config: {
      encoding: config.encoding || 'LINEAR16',
      languageCode: config.lang || 'en-US',
      sampleRateHertz: GOOGLE_SAMPLE_RATE_HZ,
      speechContexts: (hints && hints.length > 0) ? [{ phrases: hints }] : [],
    },
    singleUtterance: true,
    interimResults: true,
  };
}

/**
 * Default recognizer transport: a real TCP stream to the configured mock speech
 * endpoint.  Protocol (line-delimited JSON over a real socket):
 *   client -> server: {"type":"config","config":{...}}  once on connect, then
 *                     {"type":"audio","data":"<base64 PCM/container>"} per frame
 *   server -> client: one ASROutput JSON object per line
 * The audio bytes are the robot's real frames; the framing only makes the
 * test-double stream inspectable and deterministic.
 */
export function createMockRecognizerStream(target, requestOptions) {
  const socket = net.connect({ host: target.address, port: target.port });
  const listeners = new Map();
  let streamEnded = false;
  let streamDestroyed = false;
  let transportFailed = false;
  let connected = false;
  let waitingDrain = false;
  let endWhenDrained = false;
  let outboundQueue = [];
  let outboundQueuedBytes = 0;
  let totalAudioBytes = 0;
  let inboundBuffer = Buffer.alloc(0);
  let pendingError = null;
  const configPayload = Buffer.from(JSON.stringify({ type: 'config', config: requestOptions }) + '\n');

  const listenerFor = (event) => listeners.get(event) || [];
  const emit = (event, arg) => {
    for (const handler of [...listenerFor(event)]) handler(arg);
  };
  const hasListener = (event) => listenerFor(event).length > 0;
  const emitError = (error) => {
    if (hasListener('error')) emit('error', error);
    else pendingError = error;
  };
  const destroySocket = (error) => {
    if (streamDestroyed) return;
    streamDestroyed = true;
    outboundQueue = [];
    outboundQueuedBytes = 0;
    waitingDrain = false;
    if (!socket.destroyed) socket.destroy(error);
  };
  const fail = (error) => {
    if (transportFailed || streamDestroyed) return;
    transportFailed = true;
    emitError(error);
    destroySocket(error);
  };

  const flushOutbound = () => {
    if (streamDestroyed || transportFailed || !connected || waitingDrain || socket.destroyed) return;
    while (outboundQueue.length > 0) {
      const payload = outboundQueue[0];
      const transportLength = Number(socket.writableLength) || 0;
      if (transportLength + payload.length > GOOGLE_STREAM_LIMITS.maxOutboundBufferBytes) {
        fail(Object.assign(
          new Error(`Google recognizer outbound buffer exceeds ${GOOGLE_STREAM_LIMITS.maxOutboundBufferBytes} bytes`),
          { code: 'ERR_GOOGLE_OUTBOUND_LIMIT' },
        ));
        return;
      }
      outboundQueue.shift();
      outboundQueuedBytes -= payload.length;
      try {
        if (!socket.write(payload)) {
          waitingDrain = true;
          return;
        }
      } catch (error) {
        fail(error);
        return;
      }
    }
    if (endWhenDrained && !streamEnded && !waitingDrain && !socket.destroyed) {
      streamEnded = true;
      socket.end();
    }
  };
  const enqueueOutbound = (payload) => {
    if (streamDestroyed || transportFailed || streamEnded) return false;
    const transportLength = Number(socket.writableLength) || 0;
    const reservedConfig = connected ? 0 : configPayload.length;
    if (transportLength + outboundQueuedBytes + reservedConfig + payload.length > GOOGLE_STREAM_LIMITS.maxOutboundBufferBytes) {
      const error = Object.assign(
        new Error(`Google recognizer outbound buffer exceeds ${GOOGLE_STREAM_LIMITS.maxOutboundBufferBytes} bytes`),
        { code: 'ERR_GOOGLE_OUTBOUND_LIMIT' },
      );
      fail(error);
      throw error;
    }
    outboundQueue.push(payload);
    outboundQueuedBytes += payload.length;
    flushOutbound();
    // Queuing before connect is successful from the caller's perspective: the
    // bounded provider queue now owns the payload. Return false only when the
    // underlying socket has actually applied backpressure, so GoogleASRSession
    // does not retain a second copy of the same frame.
    return !waitingDrain;
  };

  const stream = {
    socket,
    get writableLength() {
      return (Number(socket.writableLength) || 0) + outboundQueuedBytes;
    },
    write(chunk) {
      if (streamDestroyed || transportFailed || streamEnded) return false;
      if (!Buffer.isBuffer(chunk)) throw new TypeError('Google recognizer audio must be a Buffer');
      if (chunk.length > GOOGLE_STREAM_LIMITS.maxAudioFrameBytes) {
        const error = Object.assign(
          new Error(`Google recognizer audio frame exceeds ${GOOGLE_STREAM_LIMITS.maxAudioFrameBytes} bytes`),
          { code: 'ERR_GOOGLE_AUDIO_LIMIT' },
        );
        fail(error);
        throw error;
      }
      if (totalAudioBytes + chunk.length > GOOGLE_STREAM_LIMITS.maxTotalAudioBytes) {
        const error = Object.assign(
          new Error(`Google recognizer total audio exceeds ${GOOGLE_STREAM_LIMITS.maxTotalAudioBytes} bytes`),
          { code: 'ERR_GOOGLE_AUDIO_LIMIT' },
        );
        fail(error);
        throw error;
      }
      totalAudioBytes += chunk.length;
      const payload = Buffer.from(JSON.stringify({
        type: 'audio',
        data: Buffer.from(chunk).toString('base64'),
      }) + '\n');
      return enqueueOutbound(payload);
    },
    end() {
      if (streamDestroyed || transportFailed || streamEnded) return;
      endWhenDrained = true;
      flushOutbound();
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
      if (event === 'error' && pendingError) {
        const error = pendingError;
        pendingError = null;
        queueMicrotask(() => emit('error', error));
      }
      return stream;
    },
    once(event, handler) {
      const onceHandler = (arg) => {
        stream.removeListener(event, onceHandler);
        handler(arg);
      };
      onceHandler.listener = handler;
      return stream.on(event, onceHandler);
    },
    removeListener(event, handler) {
      const handlers = listeners.get(event);
      if (!handlers) return stream;
      const index = handlers.findIndex((candidate) => candidate === handler || candidate.listener === handler);
      if (index >= 0) handlers.splice(index, 1);
      if (handlers.length === 0) listeners.delete(event);
      return stream;
    },
    off(event, handler) { return stream.removeListener(event, handler); },
    listenerCount(event) { return listenerFor(event).length; },
    emit,
    destroy(error) { destroySocket(error); },
  };

  socket.on('connect', () => {
    connected = true;
    try {
      // Audio can arrive before TCP connect. Put config at the front so the
      // line-delimited recognizer always sees its protocol preamble first.
      outboundQueue.unshift(configPayload);
      outboundQueuedBytes += configPayload.length;
      flushOutbound();
    } catch (error) { fail(error); }
  });
  socket.on('drain', () => {
    waitingDrain = false;
    flushOutbound();
    emit('drain');
  });
  socket.on('data', (chunk) => {
    if (streamDestroyed || transportFailed) return;
    if (inboundBuffer.length + chunk.length > GOOGLE_STREAM_LIMITS.maxInboundBufferBytes) {
      fail(Object.assign(
        new Error(`Google recognizer inbound buffer exceeds ${GOOGLE_STREAM_LIMITS.maxInboundBufferBytes} bytes`),
        { code: 'ERR_GOOGLE_INBOUND_LIMIT' },
      ));
      return;
    }
    inboundBuffer = inboundBuffer.length === 0
      ? Buffer.from(chunk)
      : Buffer.concat([inboundBuffer, chunk]);
    let idx;
    while ((idx = inboundBuffer.indexOf(0x0a)) !== -1) {
      if (idx > GOOGLE_STREAM_LIMITS.maxInboundLineBytes) {
        fail(Object.assign(
          new Error(`Google recognizer inbound frame exceeds ${GOOGLE_STREAM_LIMITS.maxInboundLineBytes} bytes`),
          { code: 'ERR_GOOGLE_INBOUND_LIMIT' },
        ));
        return;
      }
      const line = inboundBuffer.subarray(0, idx).toString('utf8');
      inboundBuffer = inboundBuffer.subarray(idx + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch (error) { emitError(error); continue; }
      emit('data', message);
    }
    if (inboundBuffer.length > GOOGLE_STREAM_LIMITS.maxInboundLineBytes) {
      fail(Object.assign(
        new Error(`Google recognizer inbound frame exceeds ${GOOGLE_STREAM_LIMITS.maxInboundLineBytes} bytes`),
        { code: 'ERR_GOOGLE_INBOUND_LIMIT' },
      ));
    }
  });
  socket.on('error', (error) => {
    if (!streamDestroyed && !transportFailed) emitError(error);
  });
  socket.on('close', () => {
    connected = false;
    streamDestroyed = true;
    outboundQueue = [];
    outboundQueuedBytes = 0;
    waitingDrain = false;
    inboundBuffer = Buffer.alloc(0);
    if (!streamEnded) {
      streamEnded = true;
      emit('end');
    }
  });
  return stream;
}

/**
 * GoogleASRProvider.startSession — build the request and open a recognizer
 * stream, then hand both to GoogleASRSession.
 */
export const GoogleASRProvider = {
  createGoogleRequest,
  getRecognizerTarget,

  startSession(config, log) {
    const requestOptions = createGoogleRequest(config);
    // FastEOS is compiled into a RegExp by the session constructor. Validate it
    // before opening a socket so malformed earlyEOS cannot create an unowned
    // recognizer stream. The constructor repeats the validation for direct use.
    if (config?.earlyEOS && config.earlyEOS.length > 0) FastEOS.buildRegex(config.earlyEOS);

    let stream;
    try {
      if (recognizerFactory) {
        stream = recognizerFactory(requestOptions, config, log);
      } else {
        const target = getRecognizerTarget();
        if (!target) {
          throw new Error('Google STT provider is not available in phoenix (dead-era credentials); set ETCO_server_gspeechMockAddress/ETCO_server_gspeechMockPort to use a mock recognizer');
        }
        stream = createMockRecognizerStream(target, requestOptions);
      }
      return new GoogleASRSession(stream, config, log);
    } catch (error) {
      // Constructor or factory failures happen before the transaction owns the
      // session. Destroy the stream here rather than leaking its transport.
      try { stream?.destroy?.(error); } catch { /* preserve the original error */ }
      throw error;
    }
  },
};

export function startSession(config, log) {
  return GoogleASRProvider.startSession(config, log);
}
