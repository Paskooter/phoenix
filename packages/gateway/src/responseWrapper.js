// ResponseWrapper — faithful port of utils/service/handlers/BaseWebsocketHandler.ts:19-145.
//
// Robot-compatibility-critical behaviors preserved exactly:
//   - every written message gets `timings.total = Date.now() - startTime` if absent
//   - writeFinal sets final:true
//   - a final write ends the response: further writes are dropped (warned)
//   - the socket is NOT closed by this wrapper. The reference initializes
//     `closed = true` (BaseWebsocketHandler.ts:26) while only `socket.onclose`
//     ever sets it (line 42), so its guarded `closeBecauseOfTimeout` (line 133)
//     is dead code: neither TIMEOUT_CLOSE_AFTER_FINAL nor TIMEOUT_MAX_DURATION
//     can close a socket. The captured original confirms it — hub-listen-launch
//     records `connectionOpenAfterFinal: true` at 50 ms and the client, not the
//     hub, closes (`clientCloseAfterFinal: true`). The original client is
//     responsible for closing: it does so as soon as it sees the final frame
//     (hub-client/src/session/ClientSession.ts:21-26,49-51).
//   - error() writes {type:'ERROR', msgID, ts, final:true, data:{message, code, ...extra}}

import { newMsgId, now } from '@phoenix/contracts';

const TIMEOUT_MAX_DURATION = 3 * 60 * 1000;
const TIMEOUT_CLOSE_AFTER_FINAL = 2 * 1000;

export class ResponseWrapper {
  /** @param {import('ws').WebSocket} socket @param {import('@phoenix/common').logger} log */
  constructor(socket, log) {
    this.socket = socket;
    this.log = log;
    this.startTime = now();
    this.ended = false;
    // Matches the pinned initial value. `closed` only ever becomes true when the
    // peer closes, so `_closeBecauseOfTimeout` never fires (see header comment).
    this.closed = true;

    this._onEnd = null;
    this.donePromise = new Promise((resolve) => { this._onEnd = resolve; });

    this.maxDurationTimer = setTimeout(() => {
      this._done();
      this._closeBecauseOfTimeout(TIMEOUT_MAX_DURATION);
    }, TIMEOUT_MAX_DURATION);
    this.maxDurationTimer.unref?.();

    socket.on('close', () => {
      this._done();
      this._clearCloseAfterFinal();
      this.closed = true;
    });
  }

  /** Write a message; fills timings.total if missing; schedules close on final. */
  write(data) {
    if (this.ended) {
      this.log?.warn("can't write after response ended", { type: data?.type });
      return false;
    }
    if (!data.timings) data.timings = { total: now() - this.startTime };
    if (this.socket.readyState === this.socket.OPEN) this.socket.send(JSON.stringify(data));

    if (data.final) {
      this._done();
      this._clearCloseAfterFinal();
      this.closeAfterFinalTimer = setTimeout(() => this._closeBecauseOfTimeout(TIMEOUT_CLOSE_AFTER_FINAL), TIMEOUT_CLOSE_AFTER_FINAL);
      this.closeAfterFinalTimer.unref?.();
    }
    return true;
  }

  writeFinal(data) {
    data.final = true;
    return this.write(data);
  }

  /** Write the standard final ERROR envelope. */
  error(err, extra = {}) {
    const message = err instanceof Error ? err.message : String(err);
    const code = err && err.code;
    return this.write({ type: 'ERROR', msgID: newMsgId(), ts: now(), final: true, data: { message, code, ...extra } });
  }

  _clearMaxDuration() {
    if (this.maxDurationTimer) { clearTimeout(this.maxDurationTimer); this.maxDurationTimer = null; }
  }
  _clearCloseAfterFinal() {
    if (this.closeAfterFinalTimer) { clearTimeout(this.closeAfterFinalTimer); this.closeAfterFinalTimer = null; }
  }
  _closeBecauseOfTimeout(ms) {
    if (!this.closed) {
      this.log?.debug('closing socket', { afterMs: ms });
      this.socket.close();
      this.closed = true;
    }
  }
  _done() {
    if (this.ended) return;
    this.ended = true;
    this._clearMaxDuration();
    this._onEnd?.();
  }
}
