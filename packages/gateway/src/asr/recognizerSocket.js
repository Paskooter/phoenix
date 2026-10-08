// The recognizer socket contract.
//
// ParakeetASRSession streams a recognition window to Parakeet's `/stream`
// WebSocket. A transport that is not Parakeet (Google, or a failover between
// the two) hands the session an object that behaves like that WebSocket, so
// the session's streaming, FAST_EOS, final-wait and fallback-to-batch logic
// runs unchanged whichever recognizer answers:
//
//   readyState       CONNECTING(0) -> OPEN(1) -> CLOSING(2) -> CLOSED(3), the ws values
//   send(string)     a JSON control: {"type":"start",...} then {"type":"eos"}
//   send(Buffer)     16 kHz mono PCM16LE audio
//   close() / terminate()
//   'open'           ready for start + audio
//   'message'        (data, isBinary=false) with JSON
//                      {"type":"interim","text":...,"confidence":...|null}
//                      {"type":"final","text":...,"confidence":...|null}
//   'error' (err), then 'close'
//
// Events are never emitted synchronously from the constructor: the session
// attaches its listeners right after openStream() returns.

import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';

export const CONNECTING = WebSocket.CONNECTING;
export const OPEN = WebSocket.OPEN;
export const CLOSING = WebSocket.CLOSING;
export const CLOSED = WebSocket.CLOSED;

export class RecognizerSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = CONNECTING;
  }

  _emitOpen() {
    if (this.readyState !== CONNECTING) return;
    this.readyState = OPEN;
    this.emit('open');
  }

  /** Deliver a protocol message ({type:'interim'|'final', text, confidence}). */
  _emitMessage(message) {
    if (this.readyState === CLOSED) return;
    this.emit('message', Buffer.from(JSON.stringify(message)), false);
  }

  /** An 'error' with no listener would throw; the session always listens. */
  _emitError(err) {
    if (this.listenerCount('error') > 0) this.emit('error', err);
  }

  _emitClose() {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.emit('close');
  }
}

/**
 * Parse a text protocol message: a control the session sent (always a string)
 * or a non-binary message a recognizer delivered (often a Buffer of JSON).
 * Callers only pass text; audio is never parsed. Null when it is not JSON.
 */
export function parseControl(text) {
  try {
    const message = JSON.parse(Buffer.isBuffer(text) ? text.toString('utf8') : String(text));
    return message && typeof message === 'object' ? message : null;
  } catch {
    return null;
  }
}
