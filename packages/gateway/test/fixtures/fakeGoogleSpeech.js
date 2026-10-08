// An in-process stand-in for the Google Speech-to-Text V2 client adapter
// (googleSpeech.js createGoogleSpeechClient). Nothing here touches a network:
// it records every request and lets a test script the responses.
//
//   const google = fakeGoogleSpeech({ onHalfClose: (s) => s.final('Set a timer.').end() });
//   router = new AsrRouter(settings, { createClient: async () => google.client, meter });
//
// Response objects use the shape the Node client returns (camelCase fields).

import { EventEmitter } from 'node:events';

export class FakeRecognizeStream extends EventEmitter {
  constructor(firstRequest, { onHalfClose = null, onAudio = null } = {}) {
    super();
    this.firstRequest = firstRequest;
    this.audio = [];
    this.halfClosed = false;
    this.cancelled = false;
    this.onHalfClose = onHalfClose;
    this.onAudio = onAudio;
  }

  get bytes() { return this.audio.reduce((total, chunk) => total + chunk.length, 0); }

  get pcm() { return Buffer.concat(this.audio); }

  write(request) {
    if (this.halfClosed) throw new Error('write after end');
    if (request?.audio) {
      this.audio.push(Buffer.from(request.audio));
      this.onAudio?.(this);
    }
    return true;
  }

  end() {
    this.halfClosed = true;
    if (this.onHalfClose) setImmediate(() => this.onHalfClose(this));
  }

  cancel() { this.cancelled = true; }

  respond(results, extra = {}) {
    this.emit('data', { results, ...extra });
    return this;
  }

  interim(transcript) {
    return this.respond([{ alternatives: [{ transcript, confidence: 0 }], isFinal: false, stability: 0.4 }]);
  }

  final(transcript, confidence = 0, extra = {}) {
    return this.respond([{ alternatives: [{ transcript, confidence }], isFinal: true, stability: 0 }], extra);
  }

  billed(seconds) {
    return this.respond([], { metadata: { totalBilledDuration: { seconds: String(seconds), nanos: 0 } } });
  }

  finish() {
    setImmediate(() => this.emit('end'));
    return this;
  }

  fail(code = 14, message = 'unavailable') {
    this.emit('error', Object.assign(new Error(message), { code }));
    return this;
  }
}

export function fakeGoogleSpeech({ onStream = null, onHalfClose = null, onAudio = null, recognize = null } = {}) {
  const calls = { streams: [], recognize: [], closed: 0 };
  const client = {
    streamingRecognize(firstRequest) {
      const stream = new FakeRecognizeStream(firstRequest, { onHalfClose, onAudio });
      calls.streams.push(stream);
      onStream?.(stream);
      return stream;
    },
    async recognize(request, options) {
      calls.recognize.push({ request, options });
      if (typeof recognize === 'function') return recognize(request, calls.recognize.length);
      return { results: [] };
    },
    async close() { calls.closed += 1; },
  };
  return { client, calls };
}

/** Google-style final response for a whole window (synchronous Recognize). */
export function recognizeResponse(transcript, confidence = 0, billedSeconds = null) {
  return {
    results: transcript ? [{ alternatives: [{ transcript, confidence }] }] : [],
    ...(billedSeconds === null ? {} : { metadata: { totalBilledDuration: { seconds: String(billedSeconds), nanos: 0 } } }),
  };
}
