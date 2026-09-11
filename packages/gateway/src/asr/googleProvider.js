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
import { GoogleASRSession } from './googleSession.js';

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
  let ended = false;

  const stream = {
    write(chunk) {
      if (socket.destroyed || !socket.writable) return;
      socket.write(JSON.stringify({ type: 'audio', data: Buffer.from(chunk).toString('base64') }) + '\n');
    },
    end() {
      if (!socket.destroyed) socket.end();
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
      return stream;
    },
    emit(event, arg) {
      for (const handler of listeners.get(event) || []) handler(arg);
    },
    destroy() {
      if (!socket.destroyed) socket.destroy();
    },
  };

  let buffer = Buffer.alloc(0);
  const emitEnd = () => { if (!ended) { ended = true; stream.emit('end'); } };

  socket.on('connect', () => {
    socket.write(JSON.stringify({ type: 'config', config: requestOptions }) + '\n');
  });
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    let idx;
    while ((idx = buffer.indexOf(0x0a)) !== -1) {
      const line = buffer.subarray(0, idx).toString('utf8');
      buffer = buffer.subarray(idx + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch (err) { stream.emit('error', err); continue; }
      stream.emit('data', message);
    }
  });
  socket.on('error', (err) => stream.emit('error', err));
  socket.on('close', emitEnd);
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
    let stream;
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
  },
};

export function startSession(config, log) {
  return GoogleASRProvider.startSession(config, log);
}
