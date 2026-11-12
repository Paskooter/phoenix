// A recognizer socket over a batch-only recognizer.
//
// ParakeetASRSession and FailoverSocket can hand a recognition window to a
// streaming socket (recognizerSocket.js). A batch recognizer (an
// OpenAI-compatible /audio/transcriptions endpoint) has no stream, so this
// socket stands in for one: it opens at once, keeps the PCM it is sent, and on
// `eos` recognizes the whole window as one WAV and answers with a single
// `final`. It never sends interims. A failed recognition is an `error` then
// `close`, exactly like a failed stream, so the session falls back as usual.

import { CLOSED, CLOSING, OPEN, RecognizerSocket, parseControl } from './recognizerSocket.js';

/** A recognition window never holds more than 30 s (+1 s margin) of 16 kHz PCM16. */
export const BATCH_SOCKET_MAX_BYTES = 31 * 32000;

/** The canonical 44-byte-header 16 kHz mono PCM16 WAV the session also builds. */
export function wavFromPcm(pcm, sampleRate = 16000) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export class BatchRecognizerSocket extends RecognizerSocket {
  /** @param {{recognize:(wav:Buffer)=>Promise<{text:string, confidence:number|null}>}} options */
  constructor({ recognize, maxBytes = BATCH_SOCKET_MAX_BYTES }) {
    super();
    this.recognize = recognize;
    this.maxBytes = maxBytes;
    this.pcm = [];
    this.bytes = 0;
    this.eos = false;
    this.done = false;
    setImmediate(() => { if (!this.done) this._emitOpen(); });
  }

  send(data) {
    if (this.readyState !== OPEN || this.eos || this.done) return;
    if (typeof data === 'string') {
      if (parseControl(data)?.type === 'eos') this._finish();
      return;
    }
    const chunk = Buffer.from(data);
    if (this.bytes + chunk.length > this.maxBytes) {
      this._fail(Object.assign(new Error('Recognition window is longer than a batch request allows'), { code: 'OPENAI_STT_TOO_LONG' }));
      return;
    }
    this.pcm.push(chunk);
    this.bytes += chunk.length;
  }

  async _finish() {
    this.eos = true;
    let result;
    try {
      result = await this.recognize(wavFromPcm(Buffer.concat(this.pcm, this.bytes)));
    } catch (err) {
      this._fail(err);
      return;
    }
    if (this.done) return;
    this.done = true;
    this._emitMessage({ type: 'final', text: result?.text ?? '', confidence: result?.confidence ?? null });
    setImmediate(() => this._emitClose());
  }

  _fail(err) {
    if (this.done) return;
    this.done = true;
    this.pcm = [];
    setImmediate(() => {
      this._emitError(err instanceof Error ? err : new Error(String(err)));
      this._emitClose();
    });
  }

  close() { this._closeByCaller(); }

  terminate() { this._closeByCaller(); }

  _closeByCaller() {
    if (this.readyState === CLOSED || this.readyState === CLOSING) return;
    this.done = true;
    this.pcm = [];
    this.readyState = CLOSING;
    setImmediate(() => this._emitClose());
  }
}
